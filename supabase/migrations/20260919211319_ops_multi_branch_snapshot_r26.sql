-- r26 follow-up: owner snapshot may inspect approved unbound products across own business branches.
BEGIN;
CREATE OR REPLACE FUNCTION ops.multi_branch_snapshot(p_business_id uuid,p_branch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;branches jsonb;masters jsonb;products jsonb;BEGIN
 r:=ops.multi_branch_role(p_business_id,p_branch_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'slug',x.slug) ORDER BY x.name),'[]') INTO branches
 FROM public.branches x WHERE x.business_id=p_business_id AND (r='owner' OR x.id=p_branch_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',m.id,'key',m.master_key,'name',m.name,'basePriceMinor',m.base_price_minor::text,'version',m.version::text,'active',m.active,
  'bindings',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'branchId',b.branch_id,'branchName',br.name,'productSourceId',b.product_source_id,'productName',mi.name,
    'overridePriceMinor',o.price_minor::text,'overrideVersion',CASE WHEN o.version IS NULL THEN NULL ELSE o.version::text END,
    'effectivePriceMinor',coalesce(o.price_minor,m.base_price_minor)::text,
    'cataloguePriceMinor',CASE WHEN mi.price_approved THEN ops.catalog_minor(mi.approved_price::text)::text ELSE NULL END,
    'drift',CASE WHEN mi.price_approved THEN ops.catalog_minor(mi.approved_price::text)<>coalesce(o.price_minor,m.base_price_minor) ELSE true END
   ) ORDER BY br.name),'[]')
   FROM ops.master_menu_bindings b JOIN public.branches br ON br.id=b.branch_id AND br.business_id=b.business_id
   JOIN public.menu_items mi ON mi.branch_id=b.branch_id AND mi.source_id=b.product_source_id
   LEFT JOIN ops.branch_price_overrides o ON o.business_id=b.business_id AND o.master_item_id=b.master_item_id AND o.branch_id=b.branch_id
   WHERE b.business_id=m.business_id AND b.master_item_id=m.id AND (r='owner' OR b.branch_id=p_branch_id))
 ) ORDER BY m.name),'[]') INTO masters FROM ops.master_menu_items m WHERE m.business_id=p_business_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('branchId',mi.branch_id,'branchName',br.name,'sourceId',mi.source_id,'name',mi.name,'priceMinor',ops.catalog_minor(mi.approved_price::text)::text) ORDER BY br.name,mi.sort_order,mi.name),'[]') INTO products
 FROM public.menu_items mi JOIN public.branches br ON br.id=mi.branch_id AND br.business_id=mi.business_id
 WHERE mi.business_id=p_business_id AND mi.price_approved AND (r='owner' OR mi.branch_id=p_branch_id)
 AND NOT EXISTS(SELECT 1 FROM ops.master_menu_bindings b WHERE b.business_id=p_business_id AND b.branch_id=mi.branch_id AND b.product_source_id=mi.source_id);
 RETURN jsonb_build_object('role',r,'currentBranchId',p_branch_id,'branches',branches,'masters',masters,'unboundProducts',products);
END$$;
COMMIT;
