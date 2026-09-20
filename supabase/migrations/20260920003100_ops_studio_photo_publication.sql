-- Reviewed product-image publication. No public catalogue DDL/DML, no paid calls.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.studio_photo_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, branch_id uuid NOT NULL,
 product_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE RESTRICT,
 job_id uuid NOT NULL, data bytea NOT NULL CHECK(octet_length(data) BETWEEN 20 AND 4194304),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,branch_id,id), UNIQUE(business_id,branch_id,product_id,id),
 FOREIGN KEY(business_id,branch_id,job_id) REFERENCES ops.studio_jobs(business_id,branch_id,id),
 CHECK(substring(data FROM 1 FOR 4)=decode('52494646','hex') AND substring(data FROM 9 FOR 4)=decode('57454250','hex')),
 CHECK(digest=encode(sha256(data),'hex'))
);
CREATE TABLE ops.studio_photo_overlays (
 business_id uuid NOT NULL, branch_id uuid NOT NULL, product_id uuid NOT NULL REFERENCES public.menu_items(id),
 asset_id uuid NOT NULL, source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 active boolean NOT NULL DEFAULT true, version bigint NOT NULL CHECK(version>0), last_change_id uuid NOT NULL,
 updated_by uuid NOT NULL REFERENCES auth.users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,branch_id,product_id),
 FOREIGN KEY(business_id,branch_id,product_id,asset_id) REFERENCES ops.studio_photo_assets(business_id,branch_id,product_id,id)
);
CREATE TABLE ops.studio_photo_publications (
 id uuid PRIMARY KEY, business_id uuid NOT NULL, branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id), operation_id uuid NOT NULL,
 job_id uuid NOT NULL, product_id uuid NOT NULL REFERENCES public.menu_items(id),
 action text NOT NULL CHECK(action IN('apply','undo')), request_hash text NOT NULL,
 before_state jsonb, after_state jsonb NOT NULL, receipt jsonb NOT NULL,
 reverses_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,branch_id,id), UNIQUE(business_id,branch_id,actor_id,operation_id), UNIQUE(reverses_id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 FOREIGN KEY(business_id,branch_id,job_id) REFERENCES ops.studio_jobs(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id,reverses_id) REFERENCES ops.studio_photo_publications(business_id,branch_id,id),
 CHECK((action='undo')=(reverses_id IS NOT NULL))
);
CREATE UNIQUE INDEX studio_photo_job_applied_once ON ops.studio_photo_publications(job_id) WHERE action='apply';
CREATE INDEX studio_photo_history ON ops.studio_photo_publications(business_id,branch_id,created_at DESC,id);
CREATE INDEX studio_photo_assets_job ON ops.studio_photo_assets(business_id,branch_id,job_id);
CREATE INDEX studio_photo_publications_job ON ops.studio_photo_publications(business_id,branch_id,job_id);
ALTER TABLE ops.studio_photo_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.studio_photo_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.studio_photo_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.studio_photo_assets,ops.studio_photo_overlays,ops.studio_photo_publications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON ops.studio_photo_assets,ops.studio_photo_publications TO service_role;
GRANT SELECT,INSERT,UPDATE ON ops.studio_photo_overlays TO service_role;
CREATE POLICY studio_photos_closed ON ops.studio_photo_assets AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY studio_photo_overlays_closed ON ops.studio_photo_overlays AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY studio_photo_history_closed ON ops.studio_photo_publications AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE TRIGGER photo_assets_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.studio_photo_assets FOR EACH STATEMENT EXECUTE FUNCTION ops.studio_publication_immutable();
CREATE TRIGGER photo_history_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.studio_photo_publications FOR EACH STATEMENT EXECUTE FUNCTION ops.studio_publication_immutable();
CREATE FUNCTION ops.studio_photo_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF NEW.action='apply' THEN PERFORM ops.platform_gate(NEW.business_id,NEW.branch_id,'studioPublicationEnabled'); END IF; RETURN NEW; END;$$;
CREATE TRIGGER photo_company_gate BEFORE INSERT ON ops.studio_photo_publications FOR EACH ROW EXECUTE FUNCTION ops.studio_photo_gate();
-- Keep product-to-tenant integrity even for a malformed privileged writer.
CREATE FUNCTION ops.studio_photo_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.menu_items WHERE id=NEW.product_id AND business_id=NEW.business_id AND branch_id=NEW.branch_id FOR SHARE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PHOTO_PRODUCT_SCOPE_MISMATCH';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER photo_asset_scope BEFORE INSERT ON ops.studio_photo_assets FOR EACH ROW EXECUTE FUNCTION ops.studio_photo_scope();
CREATE TRIGGER photo_overlay_scope BEFORE INSERT OR UPDATE ON ops.studio_photo_overlays FOR EACH ROW EXECUTE FUNCTION ops.studio_photo_scope();
CREATE TRIGGER photo_publication_scope BEFORE INSERT ON ops.studio_photo_publications FOR EACH ROW EXECUTE FUNCTION ops.studio_photo_scope();
CREATE FUNCTION ops.studio_photo_state(p_row ops.studio_photo_overlays) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN p_row.product_id IS NULL THEN NULL ELSE jsonb_build_object('assetId',p_row.asset_id,'sourceHash',p_row.source_hash,'active',p_row.active,'version',p_row.version::text,'lastChangeId',p_row.last_change_id) END;
$$;
CREATE FUNCTION ops.studio_photo_publication(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='4s' AS $$
DECLARE j ops.studio_jobs%ROWTYPE; o ops.studio_photo_overlays%ROWTYPE; prior ops.studio_photo_publications%ROWTYPE;
 original ops.studio_photo_publications%ROWTYPE; source jsonb; source_hash text; image_hash text; bytes bytea;
 op uuid; change_id uuid; pid uuid; aid uuid; req_hash text; beforev jsonb; afterv jsonb; res jsonb; reason text; revision bigint;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>4000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PHOTO_PUBLICATION_INPUT'; END IF;
 IF p_action='list' THEN
  RETURN jsonb_build_object('scopeKey',p_business_id::text||':'||p_branch_id::text||':'||auth.uid()::text,'jobs',coalesce((SELECT jsonb_agg(x) FROM (
   SELECT j.id,j.revision::text AS revision,j.source_snapshot->0->>'name' AS "sourceName"
   FROM ops.studio_jobs j WHERE j.business_id=p_business_id AND j.branch_id=p_branch_id
   AND j.kind='photo-enhance' AND j.state='approved' AND j.reviewed_by IS NOT NULL AND j.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM ops.studio_photo_publications p WHERE p.job_id=j.id AND p.action='apply')
   ORDER BY j.created_at DESC,j.id LIMIT 30)x),'[]'),
  'history',coalesce((SELECT jsonb_agg(x) FROM (
   SELECT p.id,p.action,p.created_at AS "createdAt",p.receipt,
   (p.action='apply' AND o.last_change_id=p.id AND NOT EXISTS(SELECT 1 FROM ops.studio_photo_publications u WHERE u.reverses_id=p.id)) AS "canUndo"
   FROM ops.studio_photo_publications p LEFT JOIN ops.studio_photo_overlays o USING(business_id,branch_id,product_id)
   WHERE p.business_id=p_business_id AND p.branch_id=p_branch_id ORDER BY p.created_at DESC,p.id LIMIT 30)x),'[]'));
 END IF;
 IF p_action NOT IN('preview','apply','undo') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_PHOTO_ACTION'; END IF;
 -- Reject extra fields even on direct RPC. No client content, prices, URLs or asset IDs.
 IF (p_action='preview' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_payload) key) IS DISTINCT FROM ARRAY['jobId'])
 OR (p_action='apply' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_payload) key) IS DISTINCT FROM ARRAY['confirmed','imageHash','jobId','jobRevision','operationId','overlayVersion','sourceHash'])
 OR (p_action='undo' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_payload) key) IS DISTINCT FROM ARRAY['confirmed','operationId','publicationId']) THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PHOTO_PUBLICATION_INPUT'; END IF;
 IF p_action IN('apply','undo') THEN
  IF p_payload->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE SQLSTATE 'PT400' USING MESSAGE='PUBLICATION_CONFIRM_REQUIRED';END IF;
  op:=(p_payload->>'operationId')::uuid; IF op IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PHOTO_PUBLICATION_INPUT';END IF;
  req_hash:=encode(sha256(convert_to(jsonb_build_object('action',p_action,'payload',p_payload-'operationId')::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-photo:'||p_business_id::text||p_branch_id::text,0));
  SELECT * INTO prior FROM ops.studio_photo_publications WHERE business_id=p_business_id AND branch_id=p_branch_id AND actor_id=auth.uid() AND operation_id=op;
  IF FOUND THEN
   IF prior.request_hash<>req_hash THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
   RETURN prior.receipt;
  END IF;
  change_id:=gen_random_uuid();
 END IF;
 IF p_action='undo' THEN
  SELECT * INTO original FROM ops.studio_photo_publications WHERE id=(p_payload->>'publicationId')::uuid AND business_id=p_business_id AND branch_id=p_branch_id AND action='apply';
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PUBLICATION_NOT_FOUND';END IF;
  pid:=original.product_id;
  PERFORM 1 FROM public.menu_items WHERE id=pid AND business_id=p_business_id AND branch_id=p_branch_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('info:'||pid::text,0));
  SELECT * INTO o FROM ops.studio_photo_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=pid FOR UPDATE;
  IF o.last_change_id IS DISTINCT FROM original.id OR ops.studio_photo_state(o) IS DISTINCT FROM original.after_state THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PUBLICATION_CHANGED';END IF;
  beforev:=ops.studio_photo_state(o);
  UPDATE ops.studio_photo_overlays SET asset_id=coalesce((original.before_state->>'assetId')::uuid,o.asset_id),
   source_hash=coalesce(original.before_state->>'sourceHash',o.source_hash),active=coalesce((original.before_state->>'active')::boolean,false),
   version=o.version+1,last_change_id=change_id,updated_by=auth.uid(),updated_at=clock_timestamp()
  WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=pid RETURNING * INTO o;
  afterv:=ops.studio_photo_state(o);
  res:=jsonb_build_object('publicationId',change_id,'operationId',op,'action','undo','productId',pid,'version',o.version::text,'cataloguePricesChanged',false);
  INSERT INTO ops.studio_photo_publications(id,business_id,branch_id,actor_id,operation_id,job_id,product_id,action,request_hash,before_state,after_state,receipt,reverses_id)
  VALUES(change_id,p_business_id,p_branch_id,auth.uid(),op,original.job_id,pid,'undo',req_hash,beforev,afterv,res,original.id);
  RETURN res;
 END IF;
 -- Lock job before product consistently with studio review/discard. Public rows never updated.
 IF p_action='apply' THEN
  SELECT * INTO j FROM ops.studio_jobs WHERE id=(p_payload->>'jobId')::uuid AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 ELSE
  SELECT * INTO j FROM ops.studio_jobs WHERE id=(p_payload->>'jobId')::uuid AND business_id=p_business_id AND branch_id=p_branch_id;
 END IF;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='STUDIO_JOB_NOT_FOUND';END IF;
 IF j.kind<>'photo-enhance' OR j.state<>'approved' OR j.reviewed_by IS NULL OR j.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_REVIEW_REQUIRED';END IF;
 IF jsonb_typeof(j.source_snapshot) IS DISTINCT FROM 'array' OR jsonb_array_length(j.source_snapshot)<>1
 OR j.result->>'kind' IS DISTINCT FROM 'photo-enhance' OR j.result->>'mime' IS DISTINCT FROM 'image/webp'
 OR j.result->'draftOnly' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(j.result->'data') IS DISTINCT FROM 'string'
 OR length(j.result->>'data') NOT BETWEEN 28 AND 5592408 OR (j.result->>'data') !~ '^[A-Za-z0-9+/]+={0,2}$'
 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PHOTO_DRAFT';END IF;
 BEGIN bytes:=decode(j.result->>'data','base64');EXCEPTION WHEN OTHERS THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PHOTO_DRAFT';END;
 IF octet_length(bytes) NOT BETWEEN 20 AND 4194304 OR substring(bytes FROM 1 FOR 4)<>decode('52494646','hex') OR substring(bytes FROM 9 FOR 4)<>decode('57454250','hex') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PHOTO_DRAFT';END IF;
 pid:=(j.source_snapshot->0->>'id')::uuid;
 IF p_action='apply' THEN
  PERFORM 1 FROM public.menu_items WHERE id=pid AND business_id=p_business_id AND branch_id=p_branch_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('info:'||pid::text,0));
  SELECT * INTO o FROM ops.studio_photo_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=pid FOR UPDATE;
 ELSE
  SELECT * INTO o FROM ops.studio_photo_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=pid;
 END IF;
 source:=ops.studio_publication_source(p_business_id,p_branch_id,pid);
 IF source IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
 source_hash:=encode(sha256(convert_to(source::text,'UTF8')),'hex');image_hash:=encode(sha256(bytes),'hex');
 reason:=CASE WHEN j.source_snapshot->0 IS DISTINCT FROM source->'product' THEN 'STUDIO_SOURCE_CHANGED' ELSE NULL END;
 IF EXISTS(SELECT 1 FROM ops.studio_photo_publications WHERE job_id=j.id AND action='apply') THEN reason:='STUDIO_ALREADY_APPLIED';END IF;
 IF p_action='preview' THEN RETURN jsonb_build_object('jobId',j.id,'productId',pid,'productName',source->'product'->>'name',
  'jobRevision',j.revision::text,'sourceHash',source_hash,'imageHash',image_hash,'overlayVersion',coalesce(o.version,0)::text,
  'ready',reason IS NULL,'reason',reason,
  'sourceUrl','/api/studio/source?id='||j.id::text,'draftUrl','/api/studio/image?id='||j.id::text,
  'beforeUrl',CASE WHEN o.active AND o.source_hash=source_hash THEN '/api/menu-photo/'||pid::text||'/'||o.asset_id::text ELSE NULL END); END IF;
 IF reason IS NOT NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE=reason;END IF;
 IF p_payload->>'jobRevision' IS DISTINCT FROM j.revision::text OR p_payload->>'sourceHash' IS DISTINCT FROM source_hash
 OR p_payload->>'imageHash' IS DISTINCT FROM image_hash OR p_payload->>'overlayVersion' IS DISTINCT FROM coalesce(o.version,0)::text
 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PUBLICATION_CHANGED';END IF;
 beforev:=ops.studio_photo_state(o);revision:=coalesce(o.version,0)+1;aid:=gen_random_uuid();
 INSERT INTO ops.studio_photo_assets(id,business_id,branch_id,product_id,job_id,data,digest,created_by)
 VALUES(aid,p_business_id,p_branch_id,pid,j.id,bytes,image_hash,auth.uid());
 INSERT INTO ops.studio_photo_overlays(business_id,branch_id,product_id,asset_id,source_hash,active,version,last_change_id,updated_by)
 VALUES(p_business_id,p_branch_id,pid,aid,source_hash,true,revision,change_id,auth.uid())
 ON CONFLICT(business_id,branch_id,product_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,source_hash=EXCLUDED.source_hash,active=true,
 version=EXCLUDED.version,last_change_id=EXCLUDED.last_change_id,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp() RETURNING * INTO o;
 afterv:=ops.studio_photo_state(o);
 res:=jsonb_build_object('publicationId',change_id,'operationId',op,'action','apply','productId',pid,'version',o.version::text,'cataloguePricesChanged',false);
 INSERT INTO ops.studio_photo_publications(id,business_id,branch_id,actor_id,operation_id,job_id,product_id,action,request_hash,before_state,after_state,receipt)
 VALUES(change_id,p_business_id,p_branch_id,auth.uid(),op,j.id,pid,'apply',req_hash,beforev,afterv,res);
 RETURN res;
END;$$;
-- Only the currently active, still-current product image is public; neither draft nor source is served.
CREATE FUNCTION ops.menu_photo(p_business_id uuid,p_branch_id uuid,p_product_id uuid,p_asset_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('data',encode(a.data,'base64'),'mime','image/webp','digest',a.digest)
 FROM ops.studio_photo_overlays o JOIN ops.studio_photo_assets a ON a.business_id=o.business_id AND a.branch_id=o.branch_id AND a.product_id=o.product_id AND a.id=o.asset_id
 WHERE o.business_id=p_business_id AND o.branch_id=p_branch_id AND o.product_id=p_product_id AND o.asset_id=p_asset_id AND o.active
 AND o.source_hash=encode(sha256(convert_to(ops.studio_publication_source(p_business_id,p_branch_id,p_product_id)::text,'UTF8')),'hex');
$$;
CREATE FUNCTION ops.catalogue_with_studio_media(p_business_id uuid,p_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE data jsonb; item jsonb; result jsonb:='[]'; o ops.studio_photo_overlays%ROWTYPE;
BEGIN
 data:=ops.catalogue_with_studio_text(p_business_id,p_branch_id);
 FOR item IN SELECT v FROM jsonb_array_elements(data->'items') v LOOP
  SELECT * INTO o FROM ops.studio_photo_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=(item->>'id')::uuid AND active;
  IF FOUND AND o.source_hash=encode(sha256(convert_to(ops.studio_publication_source(p_business_id,p_branch_id,o.product_id)::text,'UTF8')),'hex') THEN
   item:=item||jsonb_build_object('photoUrl','/api/menu-photo/'||o.product_id::text||'/'||o.asset_id::text,'photoVersion',o.version::text);
  END IF;
  result:=result||jsonb_build_array(item);
 END LOOP;RETURN jsonb_set(data,'{items}',result);
END;$$;
REVOKE ALL ON FUNCTION ops.studio_photo_scope(),ops.studio_photo_gate(),ops.studio_photo_state(ops.studio_photo_overlays),ops.studio_photo_publication(uuid,uuid,text,jsonb),ops.menu_photo(uuid,uuid,uuid,uuid),ops.catalogue_with_studio_media(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.studio_photo_publication(uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.menu_photo(uuid,uuid,uuid,uuid),ops.catalogue_with_studio_media(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
