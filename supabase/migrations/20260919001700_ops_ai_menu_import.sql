-- AI Menu Studio. Documents/model output are untrusted drafts. Only explicit
-- manager apply can mutate catalog rows; all new tables are isolated in ops.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.menu_import_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id),operation_id uuid NOT NULL,
 content_sha text NOT NULL CHECK(content_sha ~ '^[0-9a-f]{64}$'),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 160),
 mime text NOT NULL CHECK(mime IN('image/jpeg','image/png','image/webp','application/pdf')),
 source_base64 text CHECK(length(source_base64)<=2796204),
 source_bytes integer NOT NULL CHECK(source_bytes BETWEEN 12 AND 2097152),
 source_expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','processing','review','failed','unknown','applied','reverted','discarded')),
 revision bigint NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,
 extracted jsonb,review_rows jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(review_rows)='array' AND jsonb_array_length(review_rows)<=100),
 catalogue_snapshot jsonb NOT NULL,model text,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 apply_digest text,apply_receipt jsonb,
 UNIQUE(business_id,branch_id,id),UNIQUE(business_id,branch_id,created_by,operation_id),UNIQUE(business_id,branch_id,content_sha),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);
CREATE TABLE ops.menu_import_runs (
 id uuid PRIMARY KEY, business_id uuid NOT NULL,branch_id uuid NOT NULL,job_id uuid NOT NULL,
 started_by uuid NOT NULL REFERENCES auth.users(id),model text NOT NULL,
 state text NOT NULL DEFAULT 'processing' CHECK(state IN('processing','finished','failed','unknown')),
 input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0),output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 FOREIGN KEY(business_id,branch_id,job_id) REFERENCES ops.menu_import_jobs(business_id,branch_id,id)
);
CREATE INDEX menu_import_quota ON ops.menu_import_runs(business_id,branch_id,started_at);
CREATE TABLE ops.menu_import_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,job_id uuid NOT NULL,
 product_id uuid NOT NULL REFERENCES public.menu_items(id),actor_user_id uuid NOT NULL REFERENCES auth.users(id),
 kind text NOT NULL CHECK(kind IN('create','update')),price_minor bigint CHECK(price_minor BETWEEN 0 AND 100000000),
 before_record jsonb,after_record jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(job_id,product_id),FOREIGN KEY(business_id,branch_id,job_id) REFERENCES ops.menu_import_jobs(business_id,branch_id,id)
);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['menu_import_jobs','menu_import_runs','menu_import_changes'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ops.%I TO service_role',t);
 EXECUTE format('CREATE POLICY no_direct_import_access ON ops.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
 END LOOP;END;$$;
CREATE FUNCTION ops.import_catalogue(p_business_id uuid,p_branch_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'categoryKey',category_key,'subcategory',subcategory,
 'description',coalesce(description,''),'serving',coalesce(quantity_label,''),'options',options,
 'priceMinor',CASE WHEN approved_price IS NOT NULL THEN ops.catalog_minor(approved_price::text)::text ELSE NULL END,
 'available',available,'updatedAt',updated_at) ORDER BY sort_order,source_id),'[]')
 FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id;
$$;
CREATE FUNCTION ops.import_assert_manager(p_business_id uuid,p_branch_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
END;$$;
CREATE FUNCTION ops.ai_menu_job(p_business_id uuid,p_branch_id uuid,p_action text,p_job_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE j ops.menu_import_jobs%ROWTYPE;row_data jsonb;p public.menu_items%ROWTYPE;before_value jsonb;after_value jsonb;ch ops.menu_import_changes%ROWTYPE;
 h text;data bytea;pid uuid;lease uuid;amount bigint;price_text text;digest text;receipt jsonb;changed integer:=0;seen uuid[]:='{}';current_catalog jsonb;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_action='list' THEN
 RETURN jsonb_build_object('jobs',(SELECT coalesce(jsonb_agg(x ORDER BY x->>'createdAt' DESC),'[]') FROM(SELECT jsonb_build_object('id',id,'name',file_name,'status',CASE WHEN status='processing' AND lease_until<clock_timestamp() THEN 'unknown' ELSE status END,'createdAt',created_at,'revision',revision::text) AS x FROM ops.menu_import_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id ORDER BY created_at DESC LIMIT 30)q),
 'categories',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'title',title) ORDER BY sort_order),'[]') FROM public.categories WHERE business_id=p_business_id),
 'catalogue',ops.import_catalogue(p_business_id,p_branch_id),
 'usedToday',(SELECT count(*) FROM ops.menu_import_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND started_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul'),'dailyLimit',5);
 END IF;
 IF p_action='create' THEN
  IF p_payload->>'operationId' IS NULL OR p_payload->>'fileName' IS NULL OR p_payload->>'data' IS NULL OR length(p_payload->>'data')>2796204 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_INPUT';END IF;
  data:=decode(p_payload->>'data','base64');IF octet_length(data) NOT BETWEEN 12 AND 2097152 THEN RAISE SQLSTATE 'PT413' USING MESSAGE='FILE_SIZE_LIMIT';END IF;
  h:=encode(sha256(data),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('menugo:import:'||p_business_id::text||p_branch_id::text,0));
  SELECT * INTO j FROM ops.menu_import_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_by=auth.uid() AND operation_id=(p_payload->>'operationId')::uuid;
  IF FOUND AND j.content_sha<>h THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
  IF j.id IS NULL THEN SELECT * INTO j FROM ops.menu_import_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND content_sha=h;END IF;
  IF j.id IS NOT NULL THEN RETURN jsonb_build_object('id',j.id,'status',j.status,'duplicate',true);END IF;
  IF (SELECT count(*) FROM ops.menu_import_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND source_base64 IS NOT NULL)>=20 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='SOURCE_QUOTA';END IF;
  INSERT INTO ops.menu_import_jobs(business_id,branch_id,created_by,operation_id,content_sha,file_name,mime,source_base64,source_bytes,catalogue_snapshot)
  VALUES(p_business_id,p_branch_id,auth.uid(),(p_payload->>'operationId')::uuid,h,left(p_payload->>'fileName',160),p_payload->>'mime',p_payload->>'data',octet_length(data),ops.import_catalogue(p_business_id,p_branch_id)) RETURNING * INTO j;
  RETURN jsonb_build_object('id',j.id,'status',j.status,'duplicate',false);
 END IF;
 SELECT * INTO j FROM ops.menu_import_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_job_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='IMPORT_NOT_FOUND';END IF;
 IF p_action='snapshot' THEN
 RETURN (to_jsonb(j)-'source_base64'-'lease_token'-'lease_until')||jsonb_build_object('revision',j.revision::text,'status',CASE WHEN j.status='processing' AND j.lease_until<clock_timestamp() THEN 'unknown' ELSE j.status END,'sourceAvailable',j.source_base64 IS NOT NULL AND j.source_expires_at>clock_timestamp());
 ELSIF p_action='source' THEN
 IF j.source_base64 IS NULL OR j.source_expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT410' USING MESSAGE='SOURCE_EXPIRED';END IF;
 RETURN jsonb_build_object('data',j.source_base64,'mime',j.mime);
 ELSIF p_action='delete-source' THEN
 UPDATE ops.menu_import_jobs SET source_base64=NULL WHERE id=j.id;RETURN jsonb_build_object('deleted',true);
 ELSIF p_action='claim' THEN
 IF j.status='processing' AND j.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('claimed',false);END IF;
 IF j.status NOT IN('queued','failed','unknown','processing') THEN RETURN jsonb_build_object('claimed',false);END IF;
 IF j.status<>'queued' AND p_payload->>'retry' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('claimed',false);END IF;
 IF j.source_base64 IS NULL OR j.source_expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT410' USING MESSAGE='SOURCE_EXPIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('menugo:import-budget:'||p_business_id::text||p_branch_id::text,0));
 IF (SELECT count(*) FROM ops.menu_import_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND started_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul')>=5 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='IMPORT_QUOTA';END IF;
 IF (SELECT count(*) FROM ops.menu_import_runs WHERE job_id=j.id)>=3 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='IMPORT_QUOTA';END IF;
 lease:=gen_random_uuid();
 UPDATE ops.menu_import_runs SET state='unknown',finished_at=clock_timestamp() WHERE job_id=j.id AND state='processing';
 UPDATE ops.menu_import_jobs SET status='processing',lease_token=lease,lease_until=clock_timestamp()+interval '90 seconds',error_code=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=j.id;
 INSERT INTO ops.menu_import_runs(id,business_id,branch_id,job_id,started_by,model) VALUES(lease,p_business_id,p_branch_id,j.id,auth.uid(),left(p_payload->>'model',120));
 RETURN jsonb_build_object('claimed',true,'lease',lease,'data',j.source_base64,'mime',j.mime,'catalogue',j.catalogue_snapshot);
 ELSIF p_action='finish' THEN
 IF j.status<>'processing' OR j.lease_token IS DISTINCT FROM (p_payload->>'lease')::uuid OR j.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_LEASE_LOST';END IF;
 IF p_payload->>'error' IS NOT NULL THEN
  UPDATE ops.menu_import_jobs SET status=CASE WHEN p_payload->>'error'='AI_RESULT_UNKNOWN' THEN 'unknown' ELSE 'failed' END,error_code=left(p_payload->>'error',80),lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=j.id;
  UPDATE ops.menu_import_runs SET state=CASE WHEN p_payload->>'error'='AI_RESULT_UNKNOWN' THEN 'unknown' ELSE 'failed' END,finished_at=clock_timestamp() WHERE id=j.lease_token;
 ELSE
  IF jsonb_typeof(p_payload->'draft'->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'draft'->'items')>100 OR jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'rows')>100 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_AI_RESULT';END IF;
  UPDATE ops.menu_import_jobs SET status='review',extracted=p_payload->'draft',review_rows=p_payload->'rows',model=p_payload->>'model',lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=j.id;
  UPDATE ops.menu_import_runs SET state='finished',input_tokens=coalesce((p_payload->>'inputTokens')::bigint,0),output_tokens=coalesce((p_payload->>'outputTokens')::bigint,0),finished_at=clock_timestamp() WHERE id=j.lease_token;
 END IF;
 RETURN jsonb_build_object('saved',true);
 ELSIF p_action='save' THEN
 IF j.status<>'review' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_NOT_REVIEWABLE';END IF;
 IF j.revision IS DISTINCT FROM (p_payload->>'revision')::bigint THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_REVISION_CONFLICT';END IF;
 IF jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'rows')>100 OR length((p_payload->'rows')::text)>250000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_IMPORT_ROWS';END IF;
 UPDATE ops.menu_import_jobs SET review_rows=p_payload->'rows',revision=revision+1,updated_at=clock_timestamp() WHERE id=j.id;
 RETURN jsonb_build_object('revision',(j.revision+1)::text);
 ELSIF p_action='apply' THEN
 digest:=encode(sha256(convert_to(jsonb_build_object('rows',p_payload->'rows','confirmed',p_payload->'confirmed')::text,'UTF8')),'hex');
 IF j.status='applied' THEN
  IF j.apply_digest<>digest THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_ALREADY_APPLIED';END IF;
  RETURN j.apply_receipt;
 END IF;
 IF j.status<>'review' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_NOT_REVIEWABLE';END IF;
 IF j.revision IS DISTINCT FROM (p_payload->>'revision')::bigint THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_REVISION_CONFLICT';END IF;
 IF p_payload->>'confirmed' IS DISTINCT FROM 'true' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='REVIEW_REQUIRED';END IF;
 IF jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'rows') NOT BETWEEN 1 AND 100 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_IMPORT_ROWS';END IF;
 -- Serialize catalog imports within this branch. Existing non-import price writers
 -- still use product row locks + CAS below; no catalog DELETE ever occurs.
 PERFORM pg_advisory_xact_lock(hashtextextended('menugo:import-apply:'||p_business_id::text||p_branch_id::text,0));
 -- Locks target products in stable order. No network call occurs in this transaction.
 PERFORM m.id FROM public.menu_items m WHERE m.business_id=p_business_id AND m.branch_id=p_branch_id AND m.id IN(SELECT (v->>'targetId')::uuid FROM jsonb_array_elements(p_payload->'rows') v WHERE v->>'action'='update') ORDER BY m.id FOR UPDATE;
 FOR row_data IN SELECT value FROM jsonb_array_elements(p_payload->'rows') LOOP
  IF row_data->>'action'='skip' THEN CONTINUE;END IF;
  IF row_data->>'action' NOT IN('create','update') OR row_data->>'reviewed' IS DISTINCT FROM 'true' OR coalesce(length(btrim(row_data->>'name')),0) NOT BETWEEN 1 AND 250 OR length(coalesce(row_data->>'description',''))>1000 OR length(coalesce(row_data->>'serving',''))>120 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_IMPORT_ROWS';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.categories WHERE business_id=p_business_id AND key=row_data->>'categoryKey') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_CATEGORY';END IF;
  IF jsonb_typeof(row_data->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(row_data->'options')>20 OR EXISTS(SELECT 1 FROM jsonb_array_elements(row_data->'options') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}')>100) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_IMPORT_ROWS';END IF;
  amount:=NULL;price_text:=NULL;
  IF row_data->>'priceMinor' IS NOT NULL THEN
   IF row_data->>'priceMinor' !~ '^(0|[1-9][0-9]{0,8})$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
   amount:=(row_data->>'priceMinor')::bigint;IF amount>100000000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
   -- Existing public catalogue stores TL numeric. Convert canonical integer
   -- cents to a decimal TEXT at this legacy boundary; no floating computation.
   price_text:=(amount/100)::text||'.'||lpad((amount%100)::text,2,'0');
  END IF;
  IF row_data->>'action'='update' THEN
   pid:=(row_data->>'targetId')::uuid;
   IF pid=ANY(seen) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='DUPLICATE_TARGET';END IF;
   seen:=array_append(seen,pid);
   SELECT * INTO p FROM public.menu_items WHERE id=pid AND business_id=p_business_id AND branch_id=p_branch_id;
   IF NOT FOUND OR p.updated_at IS DISTINCT FROM (row_data->>'expectedUpdatedAt')::timestamptz THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_CHANGED';END IF;
   IF amount IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
   before_value:=to_jsonb(p);
   UPDATE public.menu_items SET name=btrim(row_data->>'name'),category_key=row_data->>'categoryKey',subcategory=(SELECT title FROM public.categories WHERE business_id=p_business_id AND key=row_data->>'categoryKey'),
   description=nullif(row_data->>'description',''),quantity_label=nullif(row_data->>'serving',''),options=row_data->'options',approved_price=price_text::numeric,price_approved=true,updated_at=clock_timestamp()
   WHERE id=pid RETURNING to_jsonb(menu_items) INTO after_value;
  ELSE
   IF EXISTS(SELECT 1 FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND lower(btrim(name))=lower(btrim(row_data->>'name'))) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='DUPLICATE_PRODUCT_NAME';END IF;
   pid:=gen_random_uuid();before_value:=NULL;
   INSERT INTO public.menu_items(id,business_id,branch_id,source_id,category_key,subcategory,name,description,quantity_label,options,approved_price,price_approved,available,sort_order)
   VALUES(pid,p_business_id,p_branch_id,'AI-'||replace(pid::text,'-',''),row_data->>'categoryKey',(SELECT title FROM public.categories WHERE business_id=p_business_id AND key=row_data->>'categoryKey'),btrim(row_data->>'name'),nullif(row_data->>'description',''),nullif(row_data->>'serving',''),row_data->'options',price_text::numeric,amount IS NOT NULL,amount IS NOT NULL,1000+changed)
   RETURNING to_jsonb(menu_items) INTO after_value;
  END IF;
  INSERT INTO ops.menu_import_changes(business_id,branch_id,job_id,product_id,actor_user_id,kind,price_minor,before_record,after_record)
  VALUES(p_business_id,p_branch_id,j.id,pid,auth.uid(),row_data->>'action',amount,before_value,after_value);
  changed:=changed+1;
 END LOOP;
 IF changed=0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='REVIEW_REQUIRED';END IF;
 receipt:=jsonb_build_object('jobId',j.id,'changed',changed,'status','applied');
 UPDATE ops.menu_import_jobs SET status='applied',apply_digest=digest,apply_receipt=receipt,review_rows=p_payload->'rows',revision=revision+1,updated_at=clock_timestamp() WHERE id=j.id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'ai-menu-reviewed-apply',jsonb_build_object('jobId',j.id,'changed',changed));
 RETURN receipt;
 ELSIF p_action='undo' THEN
 IF j.status='reverted' THEN RETURN jsonb_build_object('status','reverted');END IF;
 IF j.status<>'applied' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='UNDO_UNAVAILABLE';END IF;
 PERFORM m.id FROM public.menu_items m JOIN ops.menu_import_changes x ON x.product_id=m.id WHERE x.job_id=j.id ORDER BY m.id FOR UPDATE OF m;
 FOR ch IN SELECT * FROM ops.menu_import_changes WHERE job_id=j.id ORDER BY product_id LOOP
  SELECT to_jsonb(m) INTO after_value FROM public.menu_items m WHERE id=ch.product_id AND business_id=p_business_id AND branch_id=p_branch_id;
  IF after_value IS DISTINCT FROM ch.after_record THEN RAISE SQLSTATE 'PT409' USING MESSAGE='UNDO_CONFLICT';END IF;
  IF ch.kind='create' THEN
   UPDATE public.menu_items SET available=false,price_approved=false,updated_at=clock_timestamp() WHERE id=ch.product_id;
  ELSE
   before_value:=ch.before_record;
   UPDATE public.menu_items SET name=before_value->>'name',category_key=before_value->>'category_key',subcategory=before_value->>'subcategory',description=before_value->>'description',quantity_label=before_value->>'quantity_label',options=before_value->'options',approved_price=(before_value->>'approved_price')::numeric,price_approved=(before_value->>'price_approved')::boolean,available=(before_value->>'available')::boolean,updated_at=clock_timestamp() WHERE id=ch.product_id;
  END IF;
 END LOOP;
 UPDATE ops.menu_import_jobs SET status='reverted',revision=revision+1,updated_at=clock_timestamp() WHERE id=j.id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'ai-menu-undo',jsonb_build_object('jobId',j.id,'newProductsDeactivated',true));
 RETURN jsonb_build_object('status','reverted');
 ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_ACTION';END IF;
END;$$;
CREATE FUNCTION ops.protect_import_change() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'IMPORT_AUDIT_APPEND_ONLY' USING ERRCODE='23514';END;$$;
CREATE TRIGGER import_changes_append_only BEFORE UPDATE OR DELETE ON ops.menu_import_changes FOR EACH ROW EXECUTE FUNCTION ops.protect_import_change();
CREATE TRIGGER import_changes_no_truncate BEFORE TRUNCATE ON ops.menu_import_changes FOR EACH STATEMENT EXECUTE FUNCTION ops.protect_import_change();
CREATE FUNCTION ops.purge_import_sources() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n integer;BEGIN UPDATE ops.menu_import_jobs SET source_base64=NULL WHERE source_base64 IS NOT NULL AND source_expires_at<=clock_timestamp();GET DIAGNOSTICS n=ROW_COUNT;RETURN n;END;$$;
REVOKE ALL ON FUNCTION ops.ai_menu_job(uuid,uuid,text,uuid,jsonb),ops.import_catalogue(uuid,uuid),ops.import_assert_manager(uuid,uuid),ops.protect_import_change(),ops.purge_import_sources() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.ai_menu_job(uuid,uuid,text,uuid,jsonb) TO authenticated;
DO $$BEGIN IF to_regclass('cron.job') IS NOT NULL THEN
 IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='menugo-import-retention') THEN
 PERFORM cron.schedule('menugo-import-retention','10 3 * * *','select ops.purge_import_sources();');END IF;
END IF;END;$$;
COMMIT;
