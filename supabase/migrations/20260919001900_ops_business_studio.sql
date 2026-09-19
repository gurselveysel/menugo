-- Isolated operator drafts. Never edits catalogue/prices/orders or sends campaigns.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.studio_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL,branch_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES auth.users(id),
 operation_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('product-copy','translation','campaign','invoice','photo-enhance')),
 request_hash text NOT NULL,request jsonb NOT NULL,source_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','review','approved','failed','unknown','discarded')),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),lease_token uuid,lease_until timestamptz,
 result jsonb,model text,error_code text,input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0),output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 reviewed_by uuid REFERENCES auth.users(id),reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 UNIQUE(business_id,branch_id,id),UNIQUE(business_id,branch_id,created_by,operation_id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK(octet_length(request::text)<=2900000),CHECK(result IS NULL OR octet_length(result::text)<=14500000)
);
CREATE INDEX studio_quota ON ops.studio_jobs(business_id,branch_id,created_at);
ALTER TABLE ops.studio_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.studio_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON ops.studio_jobs TO service_role;
CREATE POLICY studio_no_direct_access ON ops.studio_jobs AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE FUNCTION ops.studio_job(p_business_id uuid,p_branch_id uuid,p_action text,p_job_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE j ops.studio_jobs%ROWTYPE; h text; source jsonb; pid uuid; k text; l uuid; today timestamptz;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>14600000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_STUDIO_INPUT';END IF;
 IF p_action='list' THEN
  RETURN jsonb_build_object('jobs',(SELECT coalesce(jsonb_agg(v ORDER BY v->>'createdAt' DESC),'[]') FROM (SELECT jsonb_build_object('id',id,'kind',kind,'state',CASE WHEN state='running' AND lease_until<=clock_timestamp() THEN 'unknown' ELSE state END,'revision',revision::text,'createdAt',created_at,'sourceName',source_snapshot->0->>'name') v FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND expires_at>clock_timestamp() AND state<>'discarded' ORDER BY created_at DESC LIMIT 30)t),'catalogue',ops.import_catalogue(p_business_id,p_branch_id));
 END IF;
 IF p_action='create' THEN
  k:=p_payload->>'kind';
  IF k IS NULL OR k NOT IN('product-copy','translation','campaign','invoice','photo-enhance') OR p_payload->>'operationId' IS NULL OR jsonb_typeof(p_payload->'input') IS DISTINCT FROM 'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_STUDIO_INPUT';END IF;
  IF octet_length((p_payload->'input')::text)>2900000 THEN RAISE SQLSTATE 'PT413' USING MESSAGE='STUDIO_INPUT_TOO_LARGE';END IF;
  h:=encode(sha256(convert_to((p_payload-'operationId')::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('studio:'||p_business_id::text||p_branch_id::text,0));
  SELECT * INTO j FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_by=auth.uid() AND operation_id=(p_payload->>'operationId')::uuid;
  IF FOUND THEN
   IF j.request_hash<>h THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
   RETURN jsonb_build_object('id',j.id,'duplicate',true,'state',j.state);
  END IF;
  IF (SELECT count(*) FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND expires_at>clock_timestamp() AND state<>'discarded')>=30 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='STUDIO_STORAGE_LIMIT';END IF;
  source:='[]'::jsonb;
  IF k IN('product-copy','translation','campaign','photo-enhance') THEN
   pid:=(p_payload->'input'->>'productId')::uuid;
   SELECT jsonb_build_array(jsonb_build_object('id',m.id,'name',m.name,'description',coalesce(m.description,''),'ingredients',CASE WHEN i.published THEN i.ingredients ELSE NULL END,'serving',coalesce(m.quantity_label,''),'options',m.options,'priceMinor',CASE WHEN m.price_approved AND m.approved_price IS NOT NULL THEN ops.catalog_minor(m.approved_price::text)::text ELSE NULL END,'version',m.updated_at)) INTO source
   FROM public.menu_items m LEFT JOIN ops.product_information i ON i.business_id=m.business_id AND i.branch_id=m.branch_id AND i.product_source_id=m.source_id
   WHERE m.business_id=p_business_id AND m.branch_id=p_branch_id AND m.id=pid;
   IF source IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
  END IF;
  INSERT INTO ops.studio_jobs(business_id,branch_id,created_by,operation_id,kind,request_hash,request,source_snapshot)
  VALUES(p_business_id,p_branch_id,auth.uid(),(p_payload->>'operationId')::uuid,k,h,p_payload->'input',source) RETURNING * INTO j;
  RETURN jsonb_build_object('id',j.id,'state',j.state,'duplicate',false);
 END IF;
 SELECT * INTO j FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_job_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='STUDIO_JOB_NOT_FOUND';END IF;
 IF p_action='discard' THEN
  UPDATE ops.studio_jobs SET state='discarded',request=request-'attachment',result=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1 WHERE id=j.id;
  RETURN jsonb_build_object('discarded',true);
 END IF;
 IF j.state='discarded' OR j.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT410' USING MESSAGE='STUDIO_RESULT_EXPIRED';END IF;
 IF p_action='get' THEN
  RETURN (to_jsonb(j)-'request'-'lease_token'-'lease_until'-'request_hash')||jsonb_build_object('revision',j.revision::text,'state',CASE WHEN j.state='running' AND j.lease_until<=clock_timestamp() THEN 'unknown' ELSE j.state END,'hasSource',j.request ? 'attachment');
 ELSIF p_action='source' THEN
  IF NOT(j.request ? 'attachment') THEN RAISE SQLSTATE 'PT404' USING MESSAGE='STUDIO_SOURCE_NOT_FOUND';END IF;
  RETURN j.request->'attachment';
 ELSIF p_action='claim' THEN
  IF j.created_by<>auth.uid() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STUDIO_ACTOR_MISMATCH';END IF;
  IF j.state<>'queued' THEN RETURN jsonb_build_object('claimed',false,'state',CASE WHEN j.state='running' AND j.lease_until<=clock_timestamp() THEN 'unknown' ELSE j.state END);END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('studio:'||p_business_id::text||p_branch_id::text,0));
  today:=date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul';
  IF (SELECT count(*) FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND started_at>=today)>=10 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='STUDIO_DAILY_LIMIT';END IF;
  IF j.kind='photo-enhance' AND (SELECT count(*) FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND kind='photo-enhance' AND started_at>=today)>=3 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='STUDIO_IMAGE_LIMIT';END IF;
  IF EXISTS(SELECT 1 FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND state='running' AND lease_until>clock_timestamp()) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_BUSY';END IF;
  l:=gen_random_uuid();
  UPDATE ops.studio_jobs SET state='running',lease_token=l,lease_until=clock_timestamp()+interval '120 seconds',started_at=clock_timestamp(),revision=revision+1 WHERE id=j.id;
  RETURN jsonb_build_object('claimed',true,'lease',l,'kind',j.kind,'input',j.request,'sources',j.source_snapshot);
 ELSIF p_action='finish' THEN
  -- A manager can author their own drafts; this endpoint conveys no publish/payment authority.
  IF j.created_by<>auth.uid() OR j.state<>'running' OR j.lease_token IS DISTINCT FROM (p_payload->>'lease')::uuid OR j.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_LEASE_LOST';END IF;
  IF p_payload->>'error' IS NOT NULL THEN
   IF NOT (p_payload->>'error' ~ '^[A-Z0-9_]{1,80}$') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_STUDIO_INPUT';END IF;
   UPDATE ops.studio_jobs SET state=CASE WHEN p_payload->>'error' IN('AI_RESULT_UNKNOWN','AI_SAVE_UNKNOWN') THEN 'unknown' ELSE 'failed' END,error_code=p_payload->>'error',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),revision=revision+1 WHERE id=j.id;
  ELSE
   IF jsonb_typeof(p_payload->'draft')<>'object' OR p_payload->'draft'->>'kind' IS DISTINCT FROM j.kind OR p_payload->'draft'->>'draftOnly' IS DISTINCT FROM 'true' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_STUDIO_INPUT';END IF;
   UPDATE ops.studio_jobs SET state='review',result=p_payload->'draft',model=left(p_payload->>'model',120),input_tokens=coalesce((p_payload->>'inputTokens')::bigint,0),output_tokens=coalesce((p_payload->>'outputTokens')::bigint,0),lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),revision=revision+1 WHERE id=j.id;
  END IF;
  RETURN jsonb_build_object('saved',true);
 ELSIF p_action='approve' THEN
  IF j.state='approved' THEN RETURN jsonb_build_object('approved',true,'applied',false);END IF;
  IF j.state<>'review' OR j.revision IS DISTINCT FROM (p_payload->>'revision')::bigint OR p_payload->>'comparedOriginal' IS DISTINCT FROM 'true' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_REVIEW_REQUIRED';END IF;
  UPDATE ops.studio_jobs SET state='approved',reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),revision=revision+1 WHERE id=j.id;
  RETURN jsonb_build_object('approved',true,'applied',false);
 END IF;
 RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_STUDIO_ACTION';
END;$$;
REVOKE ALL ON FUNCTION ops.studio_job(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION ops.studio_job(uuid,uuid,text,uuid,jsonb) TO authenticated;
CREATE FUNCTION ops.studio_purge() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 UPDATE ops.studio_jobs SET request=request-'attachment',result=NULL,lease_token=NULL,lease_until=NULL,state='discarded' WHERE expires_at<clock_timestamp() AND state<>'discarded';
$$;
REVOKE ALL ON FUNCTION ops.studio_purge() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.studio_purge() TO service_role;
DO $$BEGIN IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
 PERFORM cron.schedule('menugo-studio-retention','17 * * * *','select ops.studio_purge()');
END IF;END;$$;
NOTIFY pgrst,'reload schema';
COMMIT;
