BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.product_information(
 business_id uuid NOT NULL,branch_id uuid NOT NULL,product_source_id text NOT NULL,
 ingredients text,allergens text[] NOT NULL DEFAULT '{}',serving text,energy_kcal integer,
 english_name text,english_description text,published boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,branch_id,product_source_id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 FOREIGN KEY(branch_id,product_source_id) REFERENCES public.menu_items(branch_id,source_id),
 CHECK(ingredients IS NULL OR length(ingredients)<=2000),CHECK(serving IS NULL OR length(serving)<=120),
 CHECK(energy_kcal IS NULL OR energy_kcal BETWEEN 0 AND 50000),
 CHECK(english_name IS NULL OR length(english_name)<=250),CHECK(english_description IS NULL OR length(english_description)<=2000),
 CHECK(allergens <@ ARRAY['gluten','crustaceans','eggs','fish','peanuts','soy','milk','nuts','celery','mustard','sesame','sulphites','lupin','molluscs']::text[]),
 CHECK(energy_kcal IS NULL OR serving IS NOT NULL)
);
CREATE TABLE ops.service_controls(
 business_id uuid NOT NULL,branch_id uuid NOT NULL,
 max_waiting_orders integer,estimated_minutes integer,
 version bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,branch_id),FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK(max_waiting_orders IS NULL OR max_waiting_orders BETWEEN 1 AND 300),CHECK(estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 180)
);
INSERT INTO ops.service_controls(business_id,branch_id) SELECT business_id,branch_id FROM ops.branch_settings;
ALTER TABLE ops.product_information ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.service_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.product_information,ops.service_controls FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON ops.product_information,ops.service_controls TO service_role;
CREATE POLICY no_direct_customer_info ON ops.product_information FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY no_direct_service_controls ON ops.service_controls FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE FUNCTION ops.product_information_read(p_business_id uuid,p_branch_id uuid,p_admin boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE rows jsonb;
BEGIN
 IF p_admin AND NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('productId',m.id,'name',m.name,'ingredients',i.ingredients,'allergens',coalesce(i.allergens,'{}'::text[]),'serving',i.serving,'energyKcal',i.energy_kcal,'englishName',i.english_name,'englishDescription',i.english_description,'version',coalesce(i.version,0)::text,'published',coalesce(i.published,false)) ORDER BY m.sort_order,m.source_id),'[]') INTO rows
 FROM public.menu_items m LEFT JOIN ops.product_information i ON i.branch_id=m.branch_id AND i.business_id=m.business_id AND i.product_source_id=m.source_id WHERE m.business_id=p_business_id AND m.branch_id=p_branch_id AND (p_admin OR i.published);
 RETURN rows;
END;$$;
CREATE FUNCTION ops.product_information_save(p_business_id uuid,p_branch_id uuid,p_product_id uuid,p_value jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.menu_items%ROWTYPE;i ops.product_information%ROWTYPE;a text[];
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 SELECT * INTO p FROM public.menu_items WHERE id=p_product_id AND branch_id=p_branch_id AND business_id=p_business_id FOR SHARE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('info:'||p.id::text,0));
 SELECT * INTO i FROM ops.product_information WHERE branch_id=p_branch_id AND business_id=p_business_id AND product_source_id=p.source_id FOR UPDATE;
 IF coalesce(i.version,0) IS DISTINCT FROM (p_value->>'version')::bigint THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_CHANGED';END IF;
 IF jsonb_typeof(p_value->'published') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_value->'allergens') IS DISTINCT FROM 'array' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_INPUT';END IF;
 SELECT coalesce(array_agg(DISTINCT x),'{}') INTO a FROM jsonb_array_elements_text(p_value->'allergens') x;
 INSERT INTO ops.product_information(business_id,branch_id,product_source_id,ingredients,allergens,serving,energy_kcal,english_name,english_description,published,version)
 VALUES(p_business_id,p_branch_id,p.source_id,nullif(btrim(p_value->>'ingredients'),''),a,nullif(btrim(p_value->>'serving'),''),nullif(p_value->>'energyKcal','')::integer,nullif(btrim(p_value->>'englishName'),''),nullif(btrim(p_value->>'englishDescription'),''),(p_value->>'published')::boolean,1)
 ON CONFLICT(business_id,branch_id,product_source_id) DO UPDATE SET ingredients=EXCLUDED.ingredients,allergens=EXCLUDED.allergens,serving=EXCLUDED.serving,energy_kcal=EXCLUDED.energy_kcal,english_name=EXCLUDED.english_name,english_description=EXCLUDED.english_description,published=EXCLUDED.published,version=ops.product_information.version+1,updated_at=clock_timestamp();
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'product-information',jsonb_build_object('productId',p.id,'published',p_value->'published'));
END;$$;
CREATE FUNCTION ops.service_control(p_business_id uuid,p_branch_id uuid,p_value jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s ops.service_controls%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 SELECT * INTO s FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF p_value IS NOT NULL THEN
 IF s.version IS DISTINCT FROM (p_value->>'version')::bigint THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PROFILE_CHANGED';END IF;
 UPDATE ops.service_controls SET max_waiting_orders=nullif(p_value->>'capacity','')::integer,estimated_minutes=nullif(p_value->>'minutes','')::integer,version=version+1,updated_at=clock_timestamp() WHERE business_id=p_business_id AND branch_id=p_branch_id RETURNING * INTO s;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'service-capacity',jsonb_build_object('capacity',s.max_waiting_orders,'minutes',s.estimated_minutes));
 END IF;
 RETURN jsonb_build_object('capacity',s.max_waiting_orders,'minutes',s.estimated_minutes,'version',s.version::text);
END;$$;
CREATE FUNCTION ops.guard_service_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s ops.service_controls%ROWTYPE;n integer;
BEGIN
 IF NEW.status<>'submitted' OR OLD.status='submitted' THEN RETURN NEW;END IF;
 -- Serialize capacity admission across checks; never wait for a provider.
 SELECT * INTO s FROM ops.service_controls WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id FOR UPDATE;
 IF s.max_waiting_orders IS NULL THEN RETURN NEW;END IF;
 SELECT count(*) INTO n FROM ops.orders WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND id<>NEW.id AND status IN('submitted','accepted','preparing');
 IF n>=s.max_waiting_orders THEN RAISE SQLSTATE 'PT409' USING MESSAGE='KITCHEN_CAPACITY_REACHED';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER service_capacity_gate BEFORE UPDATE ON ops.orders FOR EACH ROW EXECUTE FUNCTION ops.guard_service_capacity();
CREATE FUNCTION ops.guest_recommendations(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;result jsonb;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 SELECT coalesce(jsonb_agg(jsonb_build_object('productId',x.pid,'productName',x.name,'priceMinor',ops.catalog_minor(x.approved_price::text)::text)),'[]') INTO result FROM(
 SELECT p.id AS pid,p.name,p.approved_price,max(r.weight_bps*(60::bigint*r.confidence_bps+30::bigint*r.margin_score_bps+10::bigint*10000)) AS score
 FROM ops.upsell_rules r JOIN public.menu_items p ON p.branch_id=r.branch_id AND p.source_id=r.recommended_product_source_id
 WHERE r.branch_id=p_branch_id AND r.business_id=p_business_id AND r.active AND p.available AND p.price_approved AND p.approved_price IS NOT NULL AND p.options='[]'::jsonb
 AND (r.starts_at IS NULL OR r.starts_at<=now()) AND (r.ends_at IS NULL OR r.ends_at>now())
 AND EXISTS(SELECT 1 FROM ops.cart_lines cl WHERE cl.check_id=p_check_id AND cl.guest_session_id=g.id AND cl.product_source_id=r.target_product_source_id)
 AND NOT EXISTS(SELECT 1 FROM ops.cart_lines cl WHERE cl.check_id=p_check_id AND cl.guest_session_id=g.id AND cl.product_source_id=p.source_id)
 GROUP BY p.id,p.name,p.approved_price HAVING max(r.weight_bps*(60::bigint*r.confidence_bps+30::bigint*r.margin_score_bps+10::bigint*10000))>0 ORDER BY score DESC,p.id LIMIT 2)x;
 RETURN result;
END;$$;
CREATE FUNCTION ops.linked_guest_visits(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g record;x record;rows jsonb:='[]';amount bigint;orders jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 FOR g IN SELECT gs.id,gs.check_id,t.display_name,c.status,gs.created_at FROM ops.guest_sessions gs JOIN ops.checks c ON c.id=gs.check_id LEFT JOIN ops.dining_tables t ON t.id=c.table_id WHERE gs.linked_user_id=auth.uid() AND gs.business_id=p_business_id AND gs.branch_id=p_branch_id ORDER BY gs.created_at DESC LIMIT 30 LOOP
 amount:=0;FOR x IN SELECT b.amount_minor FROM ops.bill_charges b JOIN ops.orders o ON o.id=b.order_id WHERE o.guest_session_id=g.id AND b.status='active' LOOP amount:=amount+x.amount_minor;END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('status',o.status,'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',i.product_name_snapshot,'quantity',i.quantity,'amountMinor',i.net_minor::text)),'[]') FROM ops.order_items i WHERE i.order_id=o.id))),'[]') INTO orders FROM ops.orders o WHERE o.guest_session_id=g.id;
 rows:=rows||jsonb_build_array(jsonb_build_object('checkId',g.check_id,'tableName',g.display_name,'status',g.status,'at',g.created_at,'amountMinor',amount::text,'orders',orders));
 END LOOP;RETURN rows;
END;$$;
REVOKE ALL ON FUNCTION ops.product_information_read(uuid,uuid,boolean),ops.product_information_save(uuid,uuid,uuid,jsonb),ops.service_control(uuid,uuid,jsonb),ops.guard_service_capacity(),ops.guest_recommendations(uuid,uuid,uuid,text),ops.linked_guest_visits(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.product_information_read(uuid,uuid,boolean),ops.guest_recommendations(uuid,uuid,uuid,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.product_information_save(uuid,uuid,uuid,jsonb),ops.service_control(uuid,uuid,jsonb),ops.linked_guest_visits(uuid,uuid) TO authenticated;
COMMIT;
