-- Human-reviewed text publication. Public catalogue rows/prices are never changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE ops.studio_text_overlays (
 business_id uuid NOT NULL, branch_id uuid NOT NULL,
 product_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE RESTRICT,
 language text NOT NULL CHECK (language IN ('tr','en')),
 title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 180),
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
 source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL CHECK (version > 0), last_change_id uuid NOT NULL,
 updated_by uuid NOT NULL REFERENCES auth.users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (business_id,branch_id,product_id,language),
 FOREIGN KEY (business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK (language = 'en' OR title IS NULL)
);
CREATE TABLE ops.studio_publication_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id), operation_id uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('apply','undo')), request_hash text NOT NULL,
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,branch_id,actor_id,operation_id),
 UNIQUE (business_id,branch_id,id),
 FOREIGN KEY (business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);
CREATE TABLE ops.studio_text_changes (
 id uuid PRIMARY KEY, business_id uuid NOT NULL, branch_id uuid NOT NULL,
 batch_id uuid NOT NULL, job_id uuid NOT NULL,
 product_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE RESTRICT,
 language text NOT NULL CHECK (language IN ('tr','en')),
 action text NOT NULL CHECK (action IN ('apply','undo')),
 before_state jsonb, after_state jsonb NOT NULL,
 reverses_id uuid UNIQUE REFERENCES ops.studio_text_changes(id),
 created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,branch_id,batch_id) REFERENCES ops.studio_publication_batches(business_id,branch_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (business_id,branch_id,job_id) REFERENCES ops.studio_jobs(business_id,branch_id,id),
 CHECK ((action = 'undo') = (reverses_id IS NOT NULL))
);
CREATE UNIQUE INDEX studio_text_job_applied_once ON ops.studio_text_changes(job_id) WHERE action = 'apply';
CREATE INDEX studio_text_changes_history ON ops.studio_text_changes(business_id,branch_id,created_at DESC);
CREATE INDEX studio_text_changes_batch ON ops.studio_text_changes(batch_id);
CREATE FUNCTION ops.studio_publication_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_AUDIT_IMMUTABLE'; END; $$;
CREATE TRIGGER studio_batches_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.studio_publication_batches FOR EACH STATEMENT EXECUTE FUNCTION ops.studio_publication_immutable();
CREATE TRIGGER studio_changes_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.studio_text_changes FOR EACH STATEMENT EXECUTE FUNCTION ops.studio_publication_immutable();
ALTER TABLE ops.studio_text_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.studio_publication_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.studio_text_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.studio_text_overlays,ops.studio_publication_batches,ops.studio_text_changes FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON ops.studio_text_overlays TO service_role;
GRANT SELECT,INSERT ON ops.studio_publication_batches,ops.studio_text_changes TO service_role;
CREATE POLICY studio_overlays_closed ON ops.studio_text_overlays AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY studio_batches_closed ON ops.studio_publication_batches AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY studio_changes_closed ON ops.studio_text_changes AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

-- Exact original generation source plus a conservative freshness guard for product information.
CREATE FUNCTION ops.studio_publication_source(p_business_id uuid,p_branch_id uuid,p_product_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('product',jsonb_build_object(
 'id',m.id,'name',m.name,'description',coalesce(m.description,''),
 'ingredients',CASE WHEN i.published THEN i.ingredients ELSE NULL END,
 'serving',coalesce(m.quantity_label,''),'options',m.options,
 'priceMinor',CASE WHEN m.price_approved AND m.approved_price IS NOT NULL THEN ops.catalog_minor(m.approved_price::text)::text ELSE NULL END,
 'version',m.updated_at),
 'englishName',CASE WHEN i.published THEN i.english_name ELSE NULL END,
 'englishDescription',CASE WHEN i.published THEN i.english_description ELSE NULL END,
 'metadataVersion',i.version::text,'metadataPublished',i.published,
 'available',m.available,'sourceId',m.source_id)
 FROM public.menu_items m LEFT JOIN ops.product_information i
 ON i.business_id=m.business_id AND i.branch_id=m.branch_id AND i.product_source_id=m.source_id
 WHERE m.business_id=p_business_id AND m.branch_id=p_branch_id AND m.id=p_product_id;
$$;
CREATE FUNCTION ops.studio_text_state(p_row ops.studio_text_overlays) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN p_row.product_id IS NULL THEN NULL ELSE jsonb_build_object(
 'title',p_row.title,'body',p_row.body,'sourceHash',p_row.source_hash,
 'active',p_row.active,'version',p_row.version::text,'lastChangeId',p_row.last_change_id) END;
$$;

CREATE FUNCTION ops.studio_text_publication(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='4s' AS $$
DECLARE
 j ops.studio_jobs%ROWTYPE; o ops.studio_text_overlays%ROWTYPE; c ops.studio_text_changes%ROWTYPE;
 prior ops.studio_publication_batches%ROWTYPE; input jsonb; source jsonb; source_hash text;
 expected_hash text; pid uuid; lang text; txt text; title_value text; old_state jsonb; new_state jsonb;
 items jsonb := '[]'; request_hash text; op uuid; batch uuid; change_id uuid; target_batch uuid;
 ids uuid[]; seen text[] := '{}'; ready boolean; reason text; new_version bigint; receipt jsonb;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>16000 THEN
  RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PUBLICATION_INPUT';
 END IF;
 IF p_action='list' THEN
  RETURN jsonb_build_object('jobs',coalesce((SELECT jsonb_agg(x) FROM (
   SELECT j.id,j.kind,j.revision::text AS revision,j.source_snapshot->0->>'name' AS "sourceName",j.request->>'language' AS language
   FROM ops.studio_jobs j WHERE j.business_id=p_business_id AND j.branch_id=p_branch_id AND j.state='approved'
   AND j.expires_at>clock_timestamp() AND ((j.kind='product-copy' AND j.request->>'language'='tr') OR (j.kind='translation' AND j.request->>'language'='en'))
   AND NOT EXISTS(SELECT 1 FROM ops.studio_text_changes c WHERE c.job_id=j.id AND c.action='apply') ORDER BY j.created_at DESC LIMIT 30
  )x),'[]'), 'history',coalesce((SELECT jsonb_agg(x) FROM (
   SELECT b.id,b.action,b.created_at AS "createdAt",b.receipt
   FROM ops.studio_publication_batches b WHERE b.business_id=p_business_id AND b.branch_id=p_branch_id ORDER BY b.created_at DESC LIMIT 30
  )x),'[]'));
 END IF;
 IF p_action NOT IN ('preview','apply','undo') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_PUBLICATION_ACTION'; END IF;
 IF p_action IN ('apply','undo') THEN
  IF p_payload->>'confirmed' IS DISTINCT FROM 'true' OR jsonb_typeof(p_payload->'confirmed') IS DISTINCT FROM 'boolean' THEN
   RAISE SQLSTATE 'PT400' USING MESSAGE='PUBLICATION_CONFIRM_REQUIRED'; END IF;
  op := (p_payload->>'operationId')::uuid;
  IF op IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PUBLICATION_INPUT'; END IF;
  request_hash := encode(sha256(convert_to(jsonb_build_object('action',p_action,'payload',p_payload-'operationId')::text,'UTF8')),'hex');
  -- Publication/undo share a branch lock. Other modules keep their existing lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-publication:'||p_business_id::text||p_branch_id::text,0));
  SELECT * INTO prior FROM ops.studio_publication_batches WHERE business_id=p_business_id AND branch_id=p_branch_id AND actor_id=auth.uid() AND operation_id=op;
  IF FOUND THEN
   IF prior.request_hash<>request_hash THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
   RETURN prior.receipt;
  END IF;
  batch:=gen_random_uuid();
 END IF;
 IF p_action='undo' THEN
  target_batch := (p_payload->>'batchId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM ops.studio_publication_batches WHERE id=target_batch AND business_id=p_business_id AND branch_id=p_branch_id AND action='apply') THEN
   RAISE SQLSTATE 'PT404' USING MESSAGE='PUBLICATION_NOT_FOUND'; END IF;
  FOR c IN SELECT * FROM ops.studio_text_changes WHERE batch_id=target_batch AND business_id=p_business_id AND branch_id=p_branch_id ORDER BY product_id,language LOOP
   PERFORM 1 FROM public.menu_items WHERE id=c.product_id AND business_id=p_business_id AND branch_id=p_branch_id FOR SHARE;
   PERFORM pg_advisory_xact_lock(hashtextextended('info:'||c.product_id::text,0));
   SELECT * INTO o FROM ops.studio_text_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=c.product_id AND language=c.language FOR UPDATE;
   IF o.last_change_id IS DISTINCT FROM c.id OR ops.studio_text_state(o) IS DISTINCT FROM c.after_state THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='PUBLICATION_CHANGED'; END IF;
   old_state:=ops.studio_text_state(o); change_id:=gen_random_uuid();
   UPDATE ops.studio_text_overlays SET
    title=CASE WHEN c.before_state IS NULL THEN o.title ELSE c.before_state->>'title' END,
    body=CASE WHEN c.before_state IS NULL THEN o.body ELSE c.before_state->>'body' END,
    source_hash=CASE WHEN c.before_state IS NULL THEN o.source_hash ELSE c.before_state->>'sourceHash' END,
    active=coalesce((c.before_state->>'active')::boolean,false),version=o.version+1,last_change_id=change_id,updated_by=auth.uid(),updated_at=clock_timestamp()
   WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=c.product_id AND language=c.language RETURNING * INTO o;
   new_state:=ops.studio_text_state(o);
   INSERT INTO ops.studio_text_changes(id,business_id,branch_id,batch_id,job_id,product_id,language,action,before_state,after_state,reverses_id,created_by)
   VALUES(change_id,p_business_id,p_branch_id,batch,c.job_id,c.product_id,c.language,'undo',old_state,new_state,c.id,auth.uid());
   items:=items||jsonb_build_array(jsonb_build_object('productId',c.product_id,'language',c.language,'version',o.version::text));
  END LOOP;
 ELSE
  IF jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'items') NOT BETWEEN 1 AND 20 THEN
   RAISE SQLSTATE 'PT400' USING MESSAGE='PUBLICATION_SELECTION_LIMIT'; END IF;
  SELECT array_agg((v->>'jobId')::uuid) INTO ids FROM jsonb_array_elements(p_payload->'items') v;
  IF array_position(ids,NULL) IS NOT NULL OR cardinality(ids)<>(SELECT count(DISTINCT n) FROM unnest(ids) n) THEN
   RAISE SQLSTATE 'PT400' USING MESSAGE='DUPLICATE_PUBLICATION_JOB'; END IF;
  -- Sort by source product then language to keep deterministic lock order for batch writes.
  FOR input IN SELECT v FROM jsonb_array_elements(p_payload->'items') v LEFT JOIN ops.studio_jobs x ON x.id=(v->>'jobId')::uuid AND x.business_id=p_business_id AND x.branch_id=p_branch_id ORDER BY x.source_snapshot->0->>'id',x.request->>'language',x.id LOOP
   IF p_action='apply' THEN
    SELECT * INTO j FROM ops.studio_jobs WHERE id=(input->>'jobId')::uuid AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
   ELSE
    SELECT * INTO j FROM ops.studio_jobs WHERE id=(input->>'jobId')::uuid AND business_id=p_business_id AND branch_id=p_branch_id;
   END IF;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='STUDIO_JOB_NOT_FOUND'; END IF;
   IF j.state<>'approved' OR j.reviewed_by IS NULL OR j.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_REVIEW_REQUIRED'; END IF;
   lang:=j.request->>'language';
   IF NOT ((j.kind='product-copy' AND lang='tr') OR (j.kind='translation' AND lang='en')) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='TEXT_PUBLICATION_ONLY'; END IF;
   IF jsonb_typeof(j.source_snapshot) IS DISTINCT FROM 'array' OR jsonb_array_length(j.source_snapshot)<>1 OR jsonb_typeof(j.result) IS DISTINCT FROM 'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PUBLICATION_DRAFT'; END IF;
   pid:=(j.source_snapshot->0->>'id')::uuid; txt:=j.result->>'body';title_value:=CASE WHEN lang='en' THEN j.result->>'title' ELSE NULL END;
   IF j.result->>'kind' IS DISTINCT FROM j.kind OR j.result->>'draftOnly' IS DISTINCT FROM 'true'
    OR jsonb_typeof(j.result->'body') IS DISTINCT FROM 'string' OR char_length(txt) NOT BETWEEN 1 AND 2000 OR btrim(txt)=''
    OR (lang='en' AND (jsonb_typeof(j.result->'title') IS DISTINCT FROM 'string' OR char_length(title_value) NOT BETWEEN 1 AND 180 OR btrim(title_value)=''))
    OR j.result->'sourceIds' IS DISTINCT FROM jsonb_build_array(pid::text) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PUBLICATION_DRAFT'; END IF;
   IF (pid::text||':'||lang)=ANY(seen) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='DUPLICATE_PUBLICATION_TARGET'; END IF;
   seen:=array_append(seen,pid::text||':'||lang);
   IF p_action='apply' THEN
    PERFORM 1 FROM public.menu_items WHERE id=pid AND business_id=p_business_id AND branch_id=p_branch_id FOR SHARE;
    PERFORM pg_advisory_xact_lock(hashtextextended('info:'||pid::text,0));
    SELECT * INTO o FROM ops.studio_text_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=pid AND language=lang FOR UPDATE;
   ELSE
    SELECT * INTO o FROM ops.studio_text_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=pid AND language=lang;
   END IF;
   source:=ops.studio_publication_source(p_business_id,p_branch_id,pid);
   IF source IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND'; END IF;
   source_hash:=encode(sha256(convert_to(source::text,'UTF8')),'hex');
   ready:=j.source_snapshot->0=source->'product';reason:=CASE WHEN ready THEN NULL ELSE 'STUDIO_SOURCE_CHANGED' END;
   IF EXISTS(SELECT 1 FROM ops.studio_text_changes WHERE job_id=j.id AND action='apply') THEN ready:=false;reason:='STUDIO_ALREADY_APPLIED'; END IF;
   old_state:=ops.studio_text_state(o);
   IF p_action='preview' THEN
    items:=items||jsonb_build_array(jsonb_build_object('jobId',j.id,'productId',pid,'productName',source->'product'->>'name','language',lang,
     'jobRevision',j.revision::text,'sourceHash',source_hash,'overlayVersion',coalesce(o.version,0)::text,
     'before',CASE WHEN o.active AND o.source_hash=source_hash THEN jsonb_build_object('title',o.title,'body',o.body) ELSE jsonb_build_object('title',CASE WHEN lang='en' THEN source->>'englishName' ELSE NULL END,'body',CASE WHEN lang='tr' THEN source->'product'->>'description' ELSE source->>'englishDescription' END) END,
     'after',jsonb_build_object('title',title_value,'body',txt),'ready',ready,'reason',reason));
   ELSE
    IF NOT ready THEN RAISE SQLSTATE 'PT409' USING MESSAGE=reason; END IF;
    IF input->>'jobRevision' IS DISTINCT FROM j.revision::text OR input->>'sourceHash' IS DISTINCT FROM source_hash OR input->>'overlayVersion' IS DISTINCT FROM coalesce(o.version,0)::text THEN
     RAISE SQLSTATE 'PT409' USING MESSAGE='PUBLICATION_CHANGED'; END IF;
    change_id:=gen_random_uuid();new_version:=coalesce(o.version,0)+1;
    INSERT INTO ops.studio_text_overlays(business_id,branch_id,product_id,language,title,body,source_hash,active,version,last_change_id,updated_by)
    VALUES(p_business_id,p_branch_id,pid,lang,title_value,txt,source_hash,true,new_version,change_id,auth.uid())
    ON CONFLICT(business_id,branch_id,product_id,language) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,source_hash=EXCLUDED.source_hash,active=true,version=EXCLUDED.version,last_change_id=EXCLUDED.last_change_id,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp() RETURNING * INTO o;
    new_state:=ops.studio_text_state(o);
    INSERT INTO ops.studio_text_changes(id,business_id,branch_id,batch_id,job_id,product_id,language,action,before_state,after_state,created_by)
    VALUES(change_id,p_business_id,p_branch_id,batch,j.id,pid,lang,'apply',old_state,new_state,auth.uid());
    items:=items||jsonb_build_array(jsonb_build_object('jobId',j.id,'productId',pid,'language',lang,'version',o.version::text));
   END IF;
  END LOOP;
 END IF;
 IF p_action='preview' THEN RETURN jsonb_build_object('items',items); END IF;
 receipt:=jsonb_build_object('batchId',batch,'action',p_action,'items',items,'cataloguePricesChanged',false);
 INSERT INTO ops.studio_publication_batches(id,business_id,branch_id,actor_id,operation_id,action,request_hash,receipt)
 VALUES(batch,p_business_id,p_branch_id,auth.uid(),op,p_action,request_hash,receipt);
 RETURN receipt;
END;$$;

-- Caller sees only active reviewed display text whose entire source guard is still current.
-- Keep canonical catalogue identifiers/options/prices/stock unchanged for checkout.
CREATE FUNCTION ops.catalogue_with_studio_text(p_business_id uuid,p_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE data jsonb; item jsonb; result jsonb:='[]'; source_hash text; o ops.studio_text_overlays%ROWTYPE;
BEGIN
 data:=ops.catalogue(p_business_id,p_branch_id);
 FOR item IN SELECT v FROM jsonb_array_elements(data->'items') v LOOP
  source_hash:=encode(sha256(convert_to(ops.studio_publication_source(p_business_id,p_branch_id,(item->>'id')::uuid)::text,'UTF8')),'hex');
  FOR o IN SELECT * FROM ops.studio_text_overlays WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=(item->>'id')::uuid AND active LOOP
   IF o.source_hash=source_hash THEN
    IF o.language='tr' THEN item:=item||jsonb_build_object('description',o.body);
    ELSE item:=item||jsonb_build_object('englishName',o.title,'englishDescription',o.body); END IF;
   END IF;
  END LOOP;
  result:=result||jsonb_build_array(item);
 END LOOP;
 RETURN jsonb_set(data,'{items}',result);
END;$$;
REVOKE ALL ON FUNCTION ops.studio_publication_immutable(),ops.studio_publication_source(uuid,uuid,uuid),ops.studio_text_state(ops.studio_text_overlays),ops.studio_text_publication(uuid,uuid,text,jsonb),ops.catalogue_with_studio_text(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.studio_text_publication(uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.catalogue_with_studio_text(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
