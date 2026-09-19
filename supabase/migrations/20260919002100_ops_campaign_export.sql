-- Read-only, manager-authorized campaign snapshots. No catalogue/data mutations.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE FUNCTION ops.campaign_snapshot(
 p_business_id uuid,p_branch_id uuid,p_product_id uuid DEFAULT NULL,
 p_job_id uuid DEFAULT NULL,p_expected_version text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path='' SET timezone='UTC' AS $$
DECLARE m public.menu_items%ROWTYPE; j ops.studio_jobs%ROWTYPE;
 v jsonb; caption text; stamp text; business_name text; branch_name text; verified_ingredients text;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_product_id IS NULL THEN
  RETURN jsonb_build_object('products',ops.import_catalogue(p_business_id,p_branch_id),
   'drafts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'productId',source_snapshot->0->>'id','title',result->>'title') ORDER BY reviewed_at DESC),'[]'::jsonb)
    FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id
    AND kind='campaign' AND state='approved' AND expires_at>statement_timestamp()));
 END IF;
 SELECT * INTO m FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_product_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
 IF NOT m.available OR NOT m.price_approved OR m.approved_price IS NULL THEN
  RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ADVERTISABLE';END IF;
 SELECT name INTO business_name FROM public.businesses WHERE id=p_business_id;
 SELECT name INTO branch_name FROM public.branches WHERE id=p_branch_id AND business_id=p_business_id;
 SELECT CASE WHEN i.published THEN i.ingredients ELSE NULL END INTO verified_ingredients FROM ops.product_information i WHERE i.business_id=p_business_id AND i.branch_id=p_branch_id AND i.product_source_id=m.source_id;
 caption:=m.name||CASE WHEN coalesce(m.description,'')<>'' THEN E'\n\n'||m.description ELSE '' END;
 IF p_job_id IS NOT NULL THEN
  SELECT * INTO j FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_job_id;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='STUDIO_JOB_NOT_FOUND';END IF;
  IF j.kind<>'campaign' OR j.state<>'approved' OR j.reviewed_at IS NULL OR j.expires_at<=statement_timestamp() THEN
   RAISE SQLSTATE 'PT409' USING MESSAGE='CAMPAIGN_REVIEW_REQUIRED';END IF;
  IF j.source_snapshot->0->>'id' IS DISTINCT FROM m.id::text
   OR j.result->'sourceIds' IS DISTINCT FROM jsonb_build_array(m.id::text)
   OR j.source_snapshot->0->>'name' IS DISTINCT FROM m.name
   OR coalesce(j.source_snapshot->0->>'description','') IS DISTINCT FROM coalesce(m.description,'')
   OR j.source_snapshot->0->'options' IS DISTINCT FROM m.options
   OR coalesce(j.source_snapshot->0->>'serving','') IS DISTINCT FROM coalesce(m.quantity_label,'')
   OR j.source_snapshot->0->>'ingredients' IS DISTINCT FROM verified_ingredients
   OR (j.source_snapshot->0->>'version')::timestamptz IS DISTINCT FROM m.updated_at
   OR j.source_snapshot->0->>'priceMinor' IS DISTINCT FROM ops.catalog_minor(m.approved_price::text)::text THEN
   RAISE SQLSTATE 'PT409' USING MESSAGE='CAMPAIGN_SOURCE_CHANGED';END IF;
  IF jsonb_typeof(j.result->'body') IS DISTINCT FROM 'string' OR length(j.result->>'body') NOT BETWEEN 1 AND 3000
   OR jsonb_typeof(j.result->'title') IS DISTINCT FROM 'string' OR length(j.result->>'title') NOT BETWEEN 1 AND 180 THEN
   RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_CAMPAIGN_DRAFT';END IF;
  caption:=j.result->>'title'||E'\n\n'||(j.result->>'body');
 END IF;
 v:=jsonb_build_object('productId',m.id,'name',m.name,'description',coalesce(m.description,''),
  'quantityLabel',coalesce(m.quantity_label,''),'options',m.options,'priceMinor',ops.catalog_minor(m.approved_price::text)::text,
  'businessName',business_name,'branchName',branch_name,'caption',caption);
 stamp:=encode(sha256(convert_to((v||jsonb_build_object('updatedAt',m.updated_at,'ingredients',verified_ingredients,'jobId',p_job_id,'jobRevision',j.revision))::text,'UTF8')),'hex');
 IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM stamp THEN
  RAISE SQLSTATE 'PT409' USING MESSAGE='CAMPAIGN_SOURCE_CHANGED';END IF;
 RETURN v||jsonb_build_object('version',stamp,'checkedAt',statement_timestamp());
END;$$;
REVOKE ALL ON FUNCTION ops.campaign_snapshot(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION ops.campaign_snapshot(uuid,uuid,uuid,uuid,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
