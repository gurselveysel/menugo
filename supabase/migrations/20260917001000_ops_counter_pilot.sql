-- MenuGO r6: staff-controlled dine-in pilot; no PSP, courier or SMS activation.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.operator_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES auth.users(id),kind text NOT NULL,subject_id uuid,
 details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id));
CREATE TABLE ops.counter_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,
 operation_id uuid NOT NULL,recorded_by uuid NOT NULL REFERENCES auth.users(id),
 method text NOT NULL CHECK(method IN('cash','external_pos')),
 reference text,amount_minor bigint NOT NULL CHECK(amount_minor>0),currency text NOT NULL DEFAULT 'TRY' CHECK(currency='TRY'),
 confirmed_revision bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(business_id,branch_id,check_id),UNIQUE(business_id,branch_id,operation_id),
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id),
 CHECK(method<>'external_pos' OR length(btrim(reference)) BETWEEN 1 AND 100));
CREATE FUNCTION ops.counter_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'APPEND_ONLY_RECORD' USING ERRCODE='23514';END;$$;
CREATE TRIGGER counter_receipt_immutable BEFORE UPDATE OR DELETE ON ops.counter_receipts FOR EACH ROW EXECUTE FUNCTION ops.counter_immutable();
CREATE TRIGGER operator_event_immutable BEFORE UPDATE OR DELETE ON ops.operator_events FOR EACH ROW EXECUTE FUNCTION ops.counter_immutable();
ALTER TABLE ops.operator_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.counter_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.operator_events,ops.counter_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON ops.operator_events,ops.counter_receipts TO authenticated;
GRANT SELECT,INSERT ON ops.operator_events,ops.counter_receipts TO service_role;
CREATE POLICY operator_events_read ON ops.operator_events FOR SELECT TO authenticated USING(ops.has_branch_role(business_id,branch_id,ARRAY['owner','manager']));
CREATE POLICY counter_receipts_read ON ops.counter_receipts FOR SELECT TO authenticated USING(ops.has_branch_role(business_id,branch_id,ARRAY['owner','manager','cashier']));

CREATE FUNCTION ops.counter_info(p_business_id uuid,p_branch_id uuid,p_check_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.checks%ROWTYPE;r record;total bigint:=0;items jsonb:='[]';receipt jsonb;blocked boolean;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='CASHIER_REQUIRED';END IF;
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 FOR r IN SELECT b.*,i.product_name_snapshot AS name FROM ops.bill_charges b LEFT JOIN ops.order_items i ON i.id=b.order_item_id
 WHERE b.business_id=p_business_id AND b.branch_id=p_branch_id AND b.check_id=c.id AND b.status='active' ORDER BY b.id LOOP
 total:=total+r.amount_minor;items:=items||jsonb_build_array(jsonb_build_object('name',coalesce(r.name,'Teslimat'),'amountMinor',r.amount_minor::text));END LOOP;
 SELECT jsonb_build_object('id',id,'amountMinor',amount_minor::text,'method',method,'reference',reference,'createdAt',created_at) INTO receipt FROM ops.counter_receipts WHERE check_id=c.id AND business_id=p_business_id AND branch_id=p_branch_id;
 blocked:=EXISTS(SELECT 1 FROM ops.payment_intents WHERE check_id=c.id AND status IN('created','initiating','pending','unknown','captured'));
 RETURN jsonb_build_object('checkId',c.id,'revision',c.revision::text,'status',c.status,'totalMinor',total::text,'lines',items,'receipt',receipt,
 'cartEmpty',NOT EXISTS(SELECT 1 FROM ops.cart_lines WHERE check_id=c.id),
 'serviceComplete',NOT EXISTS(SELECT 1 FROM ops.orders WHERE check_id=c.id AND status NOT IN('served','completed','cancelled')),
 'hasOnlinePayment',blocked);
END;$$;

CREATE FUNCTION ops.counter_close(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,p_expected_revision bigint,p_amount_minor bigint,p_method text,p_reference text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.checks%ROWTYPE;r record;total bigint:=0;existing ops.counter_receipts%ROWTYPE;v_ref text:=nullif(btrim(p_reference),'');
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='CASHIER_REQUIRED';END IF;
 IF p_operation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_amount_minor IS NULL OR p_amount_minor<=0 OR p_method IS NULL OR p_method NOT IN('cash','external_pos') OR length(v_ref)>100 OR (p_method='external_pos' AND v_ref IS NULL) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COUNTER_RECEIPT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text||p_branch_id::text||p_operation_id::text,0));
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 SELECT * INTO existing FROM ops.counter_receipts WHERE business_id=p_business_id AND branch_id=p_branch_id AND operation_id=p_operation_id;
 IF FOUND THEN
 IF existing.check_id<>c.id OR existing.recorded_by<>auth.uid() OR existing.method<>p_method OR existing.amount_minor<>p_amount_minor OR existing.reference IS DISTINCT FROM v_ref OR existing.confirmed_revision<>p_expected_revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
 RETURN jsonb_build_object('receiptId',existing.id,'checkId',c.id,'amountMinor',existing.amount_minor::text,'status','closed','replayed',true);END IF;
 IF EXISTS(SELECT 1 FROM ops.counter_receipts WHERE check_id=c.id) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_ALREADY_SETTLED';END IF;
 IF c.revision<>p_expected_revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='REVISION_CONFLICT';END IF;
 IF c.status NOT IN('open','checkout') OR c.service_mode<>'dine_in' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';END IF;
 IF EXISTS(SELECT 1 FROM ops.cart_lines WHERE check_id=c.id) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='SUBMIT_CART_FIRST';END IF;
 IF EXISTS(SELECT 1 FROM ops.orders WHERE check_id=c.id AND status NOT IN('served','completed','cancelled')) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='SERVICE_NOT_FINISHED';END IF;
 IF EXISTS(SELECT 1 FROM ops.payment_intents WHERE check_id=c.id AND status IN('created','initiating','pending','unknown','captured')) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ONLINE_PAYMENT_REQUIRES_RECONCILIATION';END IF;
 FOR r IN SELECT amount_minor FROM ops.bill_charges WHERE check_id=c.id AND status='active' FOR UPDATE LOOP total:=total+r.amount_minor;END LOOP;
 IF total<=0 OR total<>p_amount_minor THEN RAISE SQLSTATE 'PT409' USING MESSAGE='AMOUNT_CHANGED';END IF;
 INSERT INTO ops.counter_receipts(business_id,branch_id,check_id,operation_id,recorded_by,method,reference,amount_minor,confirmed_revision)
 VALUES(p_business_id,p_branch_id,c.id,p_operation_id,auth.uid(),p_method,v_ref,total,p_expected_revision) RETURNING * INTO existing;
 UPDATE ops.orders SET status='completed' WHERE check_id=c.id AND status='served';
 UPDATE ops.checkout_plans SET status='settled' WHERE check_id=c.id AND status='active';
 UPDATE ops.checks SET status='closed',closed_at=clock_timestamp() WHERE id=c.id;
 UPDATE ops.check_channels SET expires_at=clock_timestamp(),channel_id=gen_random_uuid() WHERE check_id=c.id;
 UPDATE ops.check_members SET active=false WHERE check_id=c.id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,subject_id,details) VALUES(p_business_id,p_branch_id,auth.uid(),'counter_receipt',c.id,jsonb_build_object('receiptId',existing.id,'method',p_method,'amountMinor',total::text));
 RETURN jsonb_build_object('receiptId',existing.id,'checkId',c.id,'amountMinor',total::text,'status','closed','replayed',false);
END;$$;

CREATE FUNCTION ops.manage_pilot(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.checks%ROWTYPE;m public.menu_items%ROWTYPE;v_minor bigint;v_id uuid;v_enabled boolean;old_data jsonb;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 IF p_action='save-product' THEN
 v_id:=(p_payload->>'productId')::uuid;
 SELECT * INTO m FROM public.menu_items WHERE id=v_id AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
 IF (p_payload->>'expectedUpdatedAt') IS DISTINCT FROM m.updated_at::text AND (p_payload->>'expectedUpdatedAt')::timestamptz IS DISTINCT FROM m.updated_at THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_CHANGED';END IF;
 IF jsonb_typeof(p_payload->'available') IS DISTINCT FROM 'boolean' OR coalesce(p_payload->>'priceMinor','') !~ '^[0-9]{1,12}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
 v_minor:=(p_payload->>'priceMinor')::bigint;
 IF v_minor<=0 OR v_minor>100000000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PRICE';END IF;
 old_data:=jsonb_build_object('price',m.approved_price::text,'available',m.available);
 -- Legacy public price is numeric: exact string conversion ONLY; calculations stay bigint.
 UPDATE public.menu_items SET approved_price=((v_minor/100)::text||'.'||lpad((v_minor%100)::text,2,'0'))::numeric,price_approved=true,available=(p_payload->>'available')::boolean,updated_at=clock_timestamp() WHERE id=m.id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,subject_id,details) VALUES(p_business_id,p_branch_id,auth.uid(),p_action,m.id,jsonb_build_object('before',old_data,'priceMinor',v_minor::text,'available',p_payload->'available'));
 ELSIF p_action='dine-in' THEN
 IF jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_SETTING';END IF;
 v_enabled:=(p_payload->>'enabled')::boolean;
 IF v_enabled AND NOT EXISTS(SELECT 1 FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND available AND price_approved AND approved_price>0) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='APPROVE_MENU_FIRST';END IF;
 UPDATE ops.branch_settings SET ordering_enabled=v_enabled,dine_in_enabled=v_enabled WHERE business_id=p_business_id AND branch_id=p_branch_id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),p_action,p_payload);
 ELSIF p_action IN('cancel-split','close-empty') THEN
 v_id:=(p_payload->>'checkId')::uuid;SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,v_id,NULL);
 IF EXISTS(SELECT 1 FROM ops.counter_receipts WHERE check_id=c.id) OR EXISTS(SELECT 1 FROM ops.payment_intents WHERE check_id=c.id AND status IN('created','initiating','pending','unknown','captured')) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ONLINE_PAYMENT_REQUIRES_RECONCILIATION';END IF;
 IF p_action='cancel-split' THEN
 IF c.status<>'checkout' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='NO_ACTIVE_PLAN';END IF;
 UPDATE ops.checkout_plans SET status='cancelled' WHERE check_id=c.id AND status='active';UPDATE ops.checks SET status='open' WHERE id=c.id;
 ELSE
 IF c.status<>'open' OR EXISTS(SELECT 1 FROM ops.cart_lines WHERE check_id=c.id) OR EXISTS(SELECT 1 FROM ops.bill_charges WHERE check_id=c.id AND status='active') OR EXISTS(SELECT 1 FROM ops.orders WHERE check_id=c.id AND status<>'cancelled') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='TABLE_NOT_EMPTY';END IF;
 UPDATE ops.checks SET status='cancelled',closed_at=clock_timestamp() WHERE id=c.id;
 UPDATE ops.check_channels SET expires_at=clock_timestamp(),channel_id=gen_random_uuid() WHERE check_id=c.id;
 UPDATE ops.check_members SET active=false WHERE check_id=c.id;
 END IF;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,subject_id,details) VALUES(p_business_id,p_branch_id,auth.uid(),p_action,c.id,'{}');
 ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_PILOT_ACTION';END IF;
 RETURN jsonb_build_object('saved',true);
END;$$;

CREATE FUNCTION ops.operator_snapshot(p_business_id uuid,p_branch_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE data jsonb;products jsonb:='[]';r record;receipts jsonb:='[]';settings jsonb;
BEGIN
 data:=ops.console_snapshot(p_business_id,p_branch_id);
 IF ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN
 FOR r IN SELECT * FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id ORDER BY sort_order,source_id LOOP
 products:=products||jsonb_build_array(jsonb_build_object('id',r.id,'name',r.name,'category',r.category_key,'sourceId',r.source_id,'available',r.available,'approved',r.price_approved,'updatedAt',r.updated_at,'priceMinor',CASE WHEN r.approved_price IS NOT NULL THEN ops.catalog_minor(r.approved_price::text)::text WHEN r.source_price IS NOT NULL THEN ops.catalog_minor(r.source_price::text)::text ELSE NULL END,'optionCount',jsonb_array_length(r.options)));END LOOP;END IF;
 IF ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier']) THEN
 FOR r IN SELECT cr.*,t.display_name FROM ops.counter_receipts cr JOIN ops.checks c ON c.id=cr.check_id LEFT JOIN ops.dining_tables t ON t.id=c.table_id WHERE cr.business_id=p_business_id AND cr.branch_id=p_branch_id ORDER BY cr.created_at DESC LIMIT 100 LOOP
 receipts:=receipts||jsonb_build_array(jsonb_build_object('id',r.id,'checkId',r.check_id,'table',r.display_name,'method',r.method,'reference',r.reference,'amountMinor',r.amount_minor::text,'createdAt',r.created_at));END LOOP;END IF;
 SELECT jsonb_build_object('orderingEnabled',ordering_enabled,'dineInEnabled',dine_in_enabled,'pickupEnabled',pickup_enabled,'deliveryEnabled',delivery_enabled) INTO settings FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id;
 RETURN data||jsonb_build_object('products',products,'receipts',receipts,'orderingSettings',settings);
END;$$;
REVOKE ALL ON FUNCTION ops.counter_immutable(),ops.counter_info(uuid,uuid,uuid),ops.counter_close(uuid,uuid,uuid,uuid,bigint,bigint,text,text),ops.manage_pilot(uuid,uuid,text,jsonb),ops.operator_snapshot(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.counter_info(uuid,uuid,uuid),ops.counter_close(uuid,uuid,uuid,uuid,bigint,bigint,text,text),ops.manage_pilot(uuid,uuid,text,jsonb),ops.operator_snapshot(uuid,uuid) TO authenticated;
COMMENT ON TABLE ops.counter_receipts IS 'Staff-declared external cash/POS collection for the entire check. Not a PSP capture and not a fiscal invoice.';
COMMIT;
