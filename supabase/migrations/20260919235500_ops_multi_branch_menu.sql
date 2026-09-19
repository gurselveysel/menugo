-- MenüGO r26 | Çok şubeli ana menü + yerel fiyat çekirdeği
-- Şema-only migration: mevcut katalog satırlarını migration sırasında değiştirmez.
-- Fiyatlar BIGINT kuruş; değişiklikler yalnız yetkili, idempotent RPC komutlarıyla uygulanır.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE ops.master_menu_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
 master_key text NOT NULL CHECK(master_key ~ '^[A-Za-z0-9._:-]{1,100}$'),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 250),
 base_price_minor bigint NOT NULL CHECK(base_price_minor BETWEEN 0 AND 100000000),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,master_key),UNIQUE(business_id,id)
);
CREATE TABLE ops.master_menu_bindings(
 business_id uuid NOT NULL,master_item_id uuid NOT NULL,branch_id uuid NOT NULL,product_source_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,master_item_id,branch_id),
 UNIQUE(business_id,branch_id,product_source_id),
 FOREIGN KEY(business_id,master_item_id) REFERENCES ops.master_menu_items(business_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,business_id) REFERENCES public.branches(id,business_id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,product_source_id) REFERENCES public.menu_items(branch_id,source_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE ops.branch_price_overrides(
 business_id uuid NOT NULL,master_item_id uuid NOT NULL,branch_id uuid NOT NULL,
 price_minor bigint NOT NULL CHECK(price_minor BETWEEN 0 AND 100000000),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),updated_by uuid NOT NULL REFERENCES auth.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,master_item_id,branch_id),
 FOREIGN KEY(business_id,master_item_id,branch_id) REFERENCES ops.master_menu_bindings(business_id,master_item_id,branch_id) ON DELETE RESTRICT
);
CREATE TABLE ops.multi_branch_commands(
 business_id uuid NOT NULL,branch_id uuid NOT NULL,operation_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES auth.users(id),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 PRIMARY KEY(business_id,branch_id,operation_id),
 FOREIGN KEY(branch_id,business_id) REFERENCES public.branches(id,business_id) ON DELETE RESTRICT,
 CHECK((result IS NULL AND completed_at IS NULL) OR (result IS NOT NULL AND completed_at IS NOT NULL))
);

DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['master_menu_items','master_menu_bindings','branch_price_overrides','multi_branch_commands'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ops.%I TO service_role',t);
 EXECUTE format('CREATE POLICY client_no_access ON ops.%I FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
 END LOOP;END$$;

CREATE FUNCTION ops.multi_branch_role(p_business_id uuid,p_branch_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 SELECT role INTO r FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id AND user_id=auth.uid() AND active;
 IF r NOT IN('owner','manager') THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 RETURN r;
END$$;

CREATE FUNCTION ops.multi_branch_snapshot(p_business_id uuid,p_branch_id uuid) RETURNS jsonb
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
 SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',mi.source_id,'name',mi.name,'priceMinor',ops.catalog_minor(mi.approved_price::text)::text) ORDER BY mi.sort_order,mi.name),'[]') INTO products
 FROM public.menu_items mi WHERE mi.business_id=p_business_id AND mi.branch_id=p_branch_id AND mi.price_approved
 AND NOT EXISTS(SELECT 1 FROM ops.master_menu_bindings b WHERE b.business_id=p_business_id AND b.branch_id=p_branch_id AND b.product_source_id=mi.source_id);
 RETURN jsonb_build_object('role',r,'branches',branches,'masters',masters,'unboundProducts',products);
END$$;

CREATE FUNCTION ops.multi_branch_manage(p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;req jsonb;cmd ops.multi_branch_commands%ROWTYPE;m ops.master_menu_items%ROWTYPE;mi public.menu_items%ROWTYPE;
 target_branch uuid;master_id uuid;v_source_id text;price_minor bigint;expected bigint;ov ops.branch_price_overrides%ROWTYPE;res jsonb;BEGIN
 r:=ops.multi_branch_role(p_business_id,p_branch_id);
 IF p_operation_id IS NULL OR p_action NOT IN('create-master','bind-product','set-master-price','set-local-price','clear-local-price') OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_MULTI_BRANCH_COMMAND';END IF;
 req:=jsonb_build_object('action',p_action,'payload',p_payload);
 INSERT INTO ops.multi_branch_commands(business_id,branch_id,operation_id,actor_user_id,request) VALUES(p_business_id,p_branch_id,p_operation_id,auth.uid(),req) ON CONFLICT DO NOTHING;
 SELECT * INTO cmd FROM ops.multi_branch_commands WHERE business_id=p_business_id AND branch_id=p_branch_id AND operation_id=p_operation_id FOR UPDATE;
 IF cmd.request<>req THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
 IF cmd.result IS NOT NULL THEN RETURN cmd.result||jsonb_build_object('replayed',true);END IF;

 IF p_action='create-master' THEN
  v_source_id:=p_payload->>'productSourceId';IF v_source_id IS NULL OR v_source_id!~'^[A-Za-z0-9._:-]{1,100}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRODUCT';END IF;
  SELECT * INTO mi FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND source_id=v_source_id FOR UPDATE;
  IF NOT FOUND OR NOT mi.price_approved THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_PRICE_NOT_APPROVED';END IF;
  INSERT INTO ops.master_menu_items(business_id,master_key,name,base_price_minor) VALUES(p_business_id,v_source_id,mi.name,ops.catalog_minor(mi.approved_price::text))
   RETURNING * INTO m;
  INSERT INTO ops.master_menu_bindings(business_id,master_item_id,branch_id,product_source_id) VALUES(p_business_id,m.id,p_branch_id,v_source_id);
  res:=jsonb_build_object('masterItemId',m.id,'version',m.version::text,'basePriceMinor',m.base_price_minor::text,'replayed',false);
 ELSE
  BEGIN master_id:=(p_payload->>'masterItemId')::uuid;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_MASTER_ITEM';END;
  SELECT * INTO m FROM ops.master_menu_items WHERE business_id=p_business_id AND id=master_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='MASTER_ITEM_NOT_FOUND';END IF;
  IF p_action='bind-product' THEN
   IF r<>'owner' THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_REQUIRED';END IF;
   BEGIN target_branch:=(p_payload->>'targetBranchId')::uuid;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_BRANCH';END;
   v_source_id:=p_payload->>'productSourceId';IF v_source_id IS NULL OR v_source_id!~'^[A-Za-z0-9._:-]{1,100}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRODUCT';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.branches WHERE id=target_branch AND business_id=p_business_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
   SELECT * INTO mi FROM public.menu_items WHERE business_id=p_business_id AND branch_id=target_branch AND source_id=v_source_id FOR UPDATE;
   IF NOT FOUND OR NOT mi.price_approved THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_PRICE_NOT_APPROVED';END IF;
   INSERT INTO ops.master_menu_bindings(business_id,master_item_id,branch_id,product_source_id) VALUES(p_business_id,m.id,target_branch,v_source_id);
   res:=jsonb_build_object('masterItemId',m.id,'targetBranchId',target_branch,'cataloguePriceMinor',ops.catalog_minor(mi.approved_price::text)::text,'basePriceMinor',m.base_price_minor::text,'replayed',false);
  ELSIF p_action='set-master-price' THEN
   IF r<>'owner' THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_REQUIRED';END IF;
   IF coalesce(p_payload->>'priceMinor','')!~'^(0|[1-9][0-9]{0,8})$' OR coalesce(p_payload->>'expectedVersion','')!~'^[0-9]{1,18}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
   price_minor:=(p_payload->>'priceMinor')::bigint;expected:=(p_payload->>'expectedVersion')::bigint;
   IF price_minor>100000000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
   IF m.version<>expected THEN RAISE SQLSTATE 'PT409' USING MESSAGE='MASTER_ITEM_CHANGED';END IF;
   UPDATE ops.master_menu_items SET base_price_minor=price_minor,version=version+1,updated_at=clock_timestamp() WHERE business_id=p_business_id AND id=m.id RETURNING * INTO m;
   UPDATE public.menu_items mi2 SET approved_price=(price_minor::numeric/100),price_approved=true,updated_at=clock_timestamp()
    FROM ops.master_menu_bindings b LEFT JOIN ops.branch_price_overrides o ON o.business_id=b.business_id AND o.master_item_id=b.master_item_id AND o.branch_id=b.branch_id
    WHERE b.business_id=p_business_id AND b.master_item_id=m.id AND o.master_item_id IS NULL AND mi2.business_id=b.business_id AND mi2.branch_id=b.branch_id AND mi2.source_id=b.product_source_id;
   res:=jsonb_build_object('masterItemId',m.id,'version',m.version::text,'basePriceMinor',m.base_price_minor::text,'replayed',false);
  ELSE
   BEGIN target_branch:=coalesce(nullif(p_payload->>'targetBranchId','')::uuid,p_branch_id);EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_BRANCH';END;
   IF r<>'owner' AND target_branch<>p_branch_id THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_REQUIRED';END IF;
   SELECT mi2.* INTO mi FROM ops.master_menu_bindings b JOIN public.menu_items mi2 ON mi2.business_id=b.business_id AND mi2.branch_id=b.branch_id AND mi2.source_id=b.product_source_id
    WHERE b.business_id=p_business_id AND b.master_item_id=m.id AND b.branch_id=target_branch FOR UPDATE OF mi2;
   IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='MASTER_BINDING_NOT_FOUND';END IF;
   SELECT * INTO ov FROM ops.branch_price_overrides WHERE business_id=p_business_id AND master_item_id=m.id AND branch_id=target_branch FOR UPDATE;
   IF coalesce(p_payload->>'expectedOverrideVersion','')!~'^(-1|[0-9]{1,18})$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_OVERRIDE_VERSION';END IF;
   expected:=(p_payload->>'expectedOverrideVersion')::bigint;
   IF (FOUND AND ov.version<>expected) OR (NOT FOUND AND expected<>-1) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='BRANCH_PRICE_CHANGED';END IF;
   IF p_action='set-local-price' THEN
    IF coalesce(p_payload->>'priceMinor','')!~'^(0|[1-9][0-9]{0,8})$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
    price_minor:=(p_payload->>'priceMinor')::bigint;IF price_minor>100000000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
    INSERT INTO ops.branch_price_overrides(business_id,master_item_id,branch_id,price_minor,version,updated_by) VALUES(p_business_id,m.id,target_branch,price_minor,0,auth.uid())
    ON CONFLICT(business_id,master_item_id,branch_id) DO UPDATE SET price_minor=EXCLUDED.price_minor,version=ops.branch_price_overrides.version+1,updated_by=auth.uid(),updated_at=clock_timestamp() RETURNING * INTO ov;
    UPDATE public.menu_items SET approved_price=(price_minor::numeric/100),price_approved=true,updated_at=clock_timestamp() WHERE business_id=p_business_id AND branch_id=target_branch AND source_id=mi.source_id;
    res:=jsonb_build_object('masterItemId',m.id,'targetBranchId',target_branch,'overridePriceMinor',ov.price_minor::text,'overrideVersion',ov.version::text,'replayed',false);
   ELSE
    IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='BRANCH_OVERRIDE_NOT_FOUND';END IF;
    DELETE FROM ops.branch_price_overrides WHERE business_id=p_business_id AND master_item_id=m.id AND branch_id=target_branch;
    UPDATE public.menu_items SET approved_price=(m.base_price_minor::numeric/100),price_approved=true,updated_at=clock_timestamp() WHERE business_id=p_business_id AND branch_id=target_branch AND source_id=mi.source_id;
    res:=jsonb_build_object('masterItemId',m.id,'targetBranchId',target_branch,'overridePriceMinor',NULL,'overrideVersion',NULL,'basePriceMinor',m.base_price_minor::text,'replayed',false);
   END IF;
  END IF;
 END IF;
 UPDATE ops.multi_branch_commands SET result=res,completed_at=clock_timestamp() WHERE business_id=p_business_id AND branch_id=p_branch_id AND operation_id=p_operation_id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'multi-branch-'||p_action,jsonb_build_object('operationId',p_operation_id,'masterItemId',res->>'masterItemId'));
 RETURN res;
END$$;

REVOKE ALL ON FUNCTION ops.multi_branch_role(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION ops.multi_branch_snapshot(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION ops.multi_branch_manage(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION ops.multi_branch_role(uuid,uuid),ops.multi_branch_snapshot(uuid,uuid),ops.multi_branch_manage(uuid,uuid,uuid,text,jsonb) TO authenticated,service_role;
COMMIT;
