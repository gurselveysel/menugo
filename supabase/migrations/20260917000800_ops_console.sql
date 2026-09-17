BEGIN;
-- No public catalogue writes; default operational controls remain disabled.
INSERT INTO ops.branch_settings(business_id,branch_id) SELECT business_id,id FROM public.branches ON CONFLICT DO NOTHING;
INSERT INTO ops.integration_features(business_id,branch_id) SELECT business_id,branch_id FROM ops.branch_settings ON CONFLICT DO NOTHING;
-- Owner invitations are provisioned privately; no personal email is committed.
-- No recipients, discounts or external sends are activated by creating this draft.
INSERT INTO ops.crm_campaigns(business_id,branch_id,name,mode)
 SELECT business_id,branch_id,'21 Gün Geri Kazanım','dry_run' FROM ops.branch_settings;
CREATE FUNCTION ops.catalogue(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE x record;rows jsonb:='[]';v_branch record;
BEGIN
 SELECT o.name,b.name AS branch_name,b.phone,s.ordering_enabled INTO v_branch FROM public.businesses o JOIN public.branches b ON b.business_id=o.id
 JOIN ops.branch_settings s ON s.branch_id=b.id AND s.business_id=o.id WHERE o.id=p_business_id AND b.id=p_branch_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
 FOR x IN SELECT * FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id ORDER BY sort_order,id LOOP
 rows:=rows||jsonb_build_array(jsonb_build_object('id',x.id,'sourceId',x.source_id,'name',x.name,'category',x.category_key,'description',x.description,
 'quantityLabel',x.quantity_label,'options',x.options,'priceMinor',CASE WHEN x.price_approved AND x.approved_price IS NOT NULL THEN ops.catalog_minor(x.approved_price::text)::text WHEN x.source_price IS NOT NULL THEN ops.catalog_minor(x.source_price::text)::text ELSE NULL END,
 'canOrder',v_branch.ordering_enabled AND x.price_approved AND x.approved_price IS NOT NULL AND x.available AND x.options='[]'::jsonb));END LOOP;
 RETURN jsonb_build_object('name',v_branch.name,'branchName',v_branch.branch_name,'phone',v_branch.phone,'orderingEnabled',v_branch.ordering_enabled,'items',rows);
END;$$;
CREATE FUNCTION ops.console_snapshot(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE role_name text;row record;orders jsonb:='[]';tables jsonb:='[]';customers jsonb:='[]';loyalty jsonb:='[]';deliveries jsonb:='[]';campaigns jsonb:='[]';outbox jsonb:='[]';rules jsonb:='[]';features jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 SELECT role INTO role_name FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id AND user_id=auth.uid() AND active;
 IF role_name IS NULL THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 FOR row IN SELECT o.*,t.display_name AS table_name FROM ops.orders o JOIN ops.checks c ON c.id=o.check_id LEFT JOIN ops.dining_tables t ON t.id=c.table_id
 WHERE o.business_id=p_business_id AND o.branch_id=p_branch_id AND o.created_at>now()-interval '7 days' ORDER BY o.created_at DESC LIMIT 200 LOOP
 orders:=orders||jsonb_build_array(jsonb_build_object('id',row.id,'checkId',row.check_id,'status',row.status,'table',coalesce(row.table_name,'Paket servis'),'createdAt',row.created_at,
 'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',i.product_name_snapshot,'quantity',i.quantity,'amountMinor',i.net_minor::text) ORDER BY i.line_no),'[]') FROM ops.order_items i WHERE i.order_id=row.id)));END LOOP;
 FOR row IN SELECT t.*,c.id AS check_id,c.status AS check_status,c.revision FROM ops.dining_tables t LEFT JOIN ops.checks c ON c.table_id=t.id AND c.status IN('open','checkout')
 WHERE t.business_id=p_business_id AND t.branch_id=p_branch_id ORDER BY t.table_code LOOP
 tables:=tables||jsonb_build_array(jsonb_build_object('id',row.id,'name',row.display_name,'checkId',row.check_id,'status',coalesce(row.check_status,'empty'),'revision',coalesce(row.revision,0)::text));END LOOP;
 FOR row IN SELECT * FROM ops.delivery_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id ORDER BY created_at DESC LIMIT 100 LOOP
 deliveries:=deliveries||jsonb_build_array(jsonb_build_object('id',row.id,'orderId',row.order_id,'status',row.status,'routing',row.routing,'dispatchState',row.dispatch_state));END LOOP;
 SELECT to_jsonb(f) INTO features FROM ops.integration_features f WHERE business_id=p_business_id AND branch_id=p_branch_id;
 IF role_name IN('owner','manager') THEN
 FOR row IN SELECT c.id,c.phone_e164,c.phone_verified_at,
 (SELECT decision FROM ops.crm_consent_events e WHERE e.customer_id=c.id ORDER BY sequence DESC LIMIT 1) AS decision,
 (SELECT max(completed_at) FROM ops.crm_purchase_facts p WHERE p.customer_id=c.id) AS last_order
 FROM ops.customers c WHERE c.business_id=p_business_id AND c.branch_id=p_branch_id ORDER BY created_at DESC LIMIT 200 LOOP
 customers:=customers||jsonb_build_array(jsonb_build_object('id',row.id,'phone','•••• ••• '||right(row.phone_e164,4),'verified',row.phone_verified_at IS NOT NULL,'consent',coalesce(row.decision,'unknown'),'lastOrder',row.last_order));END LOOP;
 FOR row IN SELECT a.id,c.phone_e164,b.available,b.held FROM ops.loyalty_accounts a JOIN ops.customers c ON c.id=a.customer_id
 CROSS JOIN LATERAL ops.loyalty_balances(a.business_id,a.branch_id,a.id)b WHERE a.business_id=p_business_id AND a.branch_id=p_branch_id AND a.kind='customer' LIMIT 200 LOOP
 loyalty:=loyalty||jsonb_build_array(jsonb_build_object('id',row.id,'phone','•••• ••• '||right(row.phone_e164,4),'available',row.available::text,'held',row.held::text));END LOOP;
 FOR row IN SELECT * FROM ops.crm_campaigns WHERE business_id=p_business_id AND branch_id=p_branch_id LOOP
 campaigns:=campaigns||jsonb_build_array(jsonb_build_object('id',row.id,'name',row.name,'mode',row.mode,'days',row.inactivity_days,'cooldownDays',row.cooldown_days,'discountBps',row.discount_bps::text,'discountCapMinor',row.discount_cap_minor::text,'template',row.template));END LOOP;
 FOR row IN SELECT * FROM ops.crm_outbox WHERE business_id=p_business_id AND branch_id=p_branch_id ORDER BY created_at DESC LIMIT 100 LOOP
 outbox:=outbox||jsonb_build_array(jsonb_build_object('id',row.id,'state',row.state,'reason',row.reason,'createdAt',row.created_at,'attempts',row.attempts));END LOOP;
 FOR row IN SELECT r.*,a.name AS target_name,b.name AS recommendation_name FROM ops.upsell_rules r JOIN public.menu_items a ON a.branch_id=r.branch_id AND a.source_id=r.target_product_source_id
 JOIN public.menu_items b ON b.branch_id=r.branch_id AND b.source_id=r.recommended_product_source_id WHERE r.business_id=p_business_id AND r.branch_id=p_branch_id LOOP
 rules:=rules||jsonb_build_array(jsonb_build_object('id',row.id,'target',row.target_name,'recommendation',row.recommendation_name,'active',row.active,'weightBps',row.weight_bps::text));END LOOP;
 END IF;
 RETURN jsonb_build_object('role',role_name,'tables',tables,'orders',orders,'deliveries',deliveries,'customers',customers,'loyalty',loyalty,'campaigns',campaigns,'outbox',outbox,'rules',rules,'features',features,
 'catalogue',ops.catalogue(p_business_id,p_branch_id),'lastCrmRun',(SELECT jsonb_build_object('started_at',r.started_at,'finished_at',r.finished_at) FROM ops.crm_runs r ORDER BY started_at DESC LIMIT 1));
END;$$;
CREATE FUNCTION ops.console_action(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;ord ops.orders%ROWTYPE;c ops.checks%ROWTYPE;result jsonb;next_status text;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier','waiter','kitchen']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 IF p_action='order-status' THEN
 v_id:=(p_payload->>'orderId')::uuid;next_status:=p_payload->>'status';
 SELECT * INTO ord FROM ops.orders WHERE id=v_id AND business_id=p_business_id AND branch_id=p_branch_id;
 IF ord.id IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='ORDER_NOT_FOUND';END IF;
 PERFORM ops.lock_check(p_business_id,p_branch_id,ord.check_id,NULL);
 SELECT * INTO ord FROM ops.orders WHERE ops.orders.id=ord.id FOR UPDATE;
 IF NOT ((ord.status='submitted' AND next_status='accepted') OR (ord.status='accepted' AND next_status='preparing') OR (ord.status='preparing' AND next_status='ready') OR (ord.status='ready' AND next_status IN('served','completed')) OR (ord.status='served' AND next_status='completed')) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_STATUS_TRANSITION';END IF;
 UPDATE ops.orders SET status=next_status WHERE ops.orders.id=ord.id;
 ELSIF p_action='create-table' THEN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 INSERT INTO ops.dining_tables(business_id,branch_id,table_code,display_name) VALUES(p_business_id,p_branch_id,p_payload->>'code',p_payload->>'name');
 ELSIF p_action='save-campaign' THEN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 UPDATE ops.crm_campaigns SET inactivity_days=(p_payload->>'days')::integer,template=p_payload->>'template',mode='dry_run',template_approved=false,updated_at=clock_timestamp()
 WHERE ops.crm_campaigns.id=(p_payload->>'id')::uuid AND business_id=p_business_id AND branch_id=p_branch_id;
 ELSIF p_action='save-rule' THEN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 INSERT INTO ops.upsell_rules(business_id,branch_id,target_product_source_id,recommended_product_source_id,confidence_bps,margin_score_bps,weight_bps,active)
 VALUES(p_business_id,p_branch_id,p_payload->>'target',p_payload->>'recommended',(p_payload->>'confidenceBps')::bigint,(p_payload->>'marginBps')::bigint,(p_payload->>'weightBps')::bigint,true)
 ON CONFLICT(business_id,branch_id,target_product_source_id,recommended_product_source_id) DO UPDATE SET confidence_bps=EXCLUDED.confidence_bps,margin_score_bps=EXCLUDED.margin_score_bps,weight_bps=EXCLUDED.weight_bps,active=true;
 ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_ACTION';END IF;
 RETURN ops.console_snapshot(p_business_id,p_branch_id);
END;$$;
CREATE FUNCTION ops.wallet_snapshot(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a ops.loyalty_accounts%ROWTYPE;b record;rows jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 SELECT a1.* INTO a FROM ops.loyalty_accounts a1 JOIN ops.customers c ON c.id=a1.customer_id WHERE a1.business_id=p_business_id AND a1.branch_id=p_branch_id AND c.auth_user_id=auth.uid();
 IF NOT FOUND THEN RETURN jsonb_build_object('enabled',false,'available','0','held','0','history','[]'::jsonb);END IF;
 SELECT * INTO b FROM ops.loyalty_balances(a.business_id,a.branch_id,a.id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'points',points::text,'at',created_at) ORDER BY posting_no DESC),'[]') INTO rows FROM (SELECT * FROM ops.loyalty_ledger WHERE account_id=a.id ORDER BY posting_no DESC LIMIT 100)x;
 RETURN jsonb_build_object('enabled',a.active,'available',b.available::text,'held',b.held::text,'history',rows);
END;$$;
CREATE FUNCTION ops.upsell_input(p_business_id uuid,p_branch_id uuid,p_check_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r record;rows jsonb:='[]';
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 FOR r IN SELECT r.*,a.id AS target_id,b.id AS recommended_id,b.name,b.available,b.price_approved,b.approved_price,b.options FROM ops.upsell_rules r
 JOIN public.menu_items a ON a.source_id=r.target_product_source_id AND a.branch_id=r.branch_id
 JOIN public.menu_items b ON b.source_id=r.recommended_product_source_id AND b.branch_id=r.branch_id
 WHERE r.business_id=p_business_id AND r.branch_id=p_branch_id AND r.active AND (r.starts_at IS NULL OR r.starts_at<=now()) AND (r.ends_at IS NULL OR r.ends_at>now()) LIMIT 5000 LOOP
 rows:=rows||jsonb_build_array(jsonb_build_object('id',r.id,'businessId',r.business_id,'branchId',r.branch_id,'targetProductId',r.target_id,'activeNow',true,
 'weightBps',r.weight_bps::text,'confidenceBps',r.confidence_bps::text,'marginScoreBps',r.margin_score_bps::text,
 'recommended',jsonb_build_object('id',r.recommended_id,'name',r.name,'available',r.available,'priceApproved',r.price_approved,'priceMinor',CASE WHEN r.approved_price IS NOT NULL THEN ops.catalog_minor(r.approved_price::text)::text ELSE NULL END,'stockScoreBps',CASE WHEN r.available THEN '10000' ELSE '0' END,'permitted',r.options='[]'::jsonb)));
 END LOOP;RETURN rows;
END;$$;
REVOKE ALL ON FUNCTION ops.catalogue(uuid,uuid),ops.console_snapshot(uuid,uuid),ops.console_action(uuid,uuid,text,jsonb),ops.wallet_snapshot(uuid,uuid),ops.upsell_input(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.catalogue(uuid,uuid) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.console_snapshot(uuid,uuid),ops.console_action(uuid,uuid,text,jsonb),ops.wallet_snapshot(uuid,uuid),ops.upsell_input(uuid,uuid,uuid) TO authenticated;
GRANT USAGE ON SCHEMA ops TO anon;
COMMIT;
