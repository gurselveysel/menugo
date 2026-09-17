-- Guest dining without registration: capability-scoped, HttpOnly sessions.
-- No auth.users writes, no public catalogue changes, no global authenticated bypass.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.guest_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,
 secret_hash text NOT NULL UNIQUE CHECK(secret_hash ~ '^[0-9a-f]{64}$'),
 channel_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 linked_user_id uuid REFERENCES auth.users(id),seat_no integer NOT NULL CHECK(seat_no BETWEEN 1 AND 16),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '8 hours',revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,branch_id,check_id,id),UNIQUE(check_id,seat_no),
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id)
);
CREATE INDEX guest_active_check ON ops.guest_sessions(check_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE ops.guest_commands (
 session_id uuid NOT NULL REFERENCES ops.guest_sessions(id),operation_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('cart','order','service','cancel')),
 request_payload jsonb NOT NULL,response_body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(session_id,operation_id)
);
ALTER TABLE ops.cart_lines ADD COLUMN guest_session_id uuid;
ALTER TABLE ops.cart_lines ADD CONSTRAINT cart_guest_scope FOREIGN KEY(business_id,branch_id,check_id,guest_session_id) REFERENCES ops.guest_sessions(business_id,branch_id,check_id,id);
ALTER TABLE ops.cart_lines ADD CONSTRAINT cart_one_actor CHECK(guest_session_id IS NULL OR created_by_user_id IS NULL);
ALTER TABLE ops.orders ADD COLUMN guest_session_id uuid;
ALTER TABLE ops.orders ADD CONSTRAINT order_guest_scope FOREIGN KEY(business_id,branch_id,check_id,guest_session_id) REFERENCES ops.guest_sessions(business_id,branch_id,check_id,id);
ALTER TABLE ops.orders ADD CONSTRAINT order_one_actor CHECK(guest_session_id IS NULL OR submitted_by_user_id IS NULL);
ALTER TABLE ops.service_requests ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE ops.service_requests ADD COLUMN guest_session_id uuid;
ALTER TABLE ops.service_requests ADD CONSTRAINT service_guest_scope FOREIGN KEY(business_id,branch_id,check_id,guest_session_id) REFERENCES ops.guest_sessions(business_id,branch_id,check_id,id);
ALTER TABLE ops.service_requests ADD CONSTRAINT service_one_actor CHECK((user_id IS NULL) <> (guest_session_id IS NULL));
DROP INDEX ops.cart_one_product_variant;
DROP INDEX ops.cart_lines_one_base_sku_per_check;
CREATE UNIQUE INDEX cart_one_actor_variant ON ops.cart_lines(business_id,branch_id,check_id,product_source_id,coalesce(guest_session_id,created_by_user_id,'00000000-0000-0000-0000-000000000000'::uuid),options_snapshot);
CREATE TABLE ops.order_change_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,order_id uuid NOT NULL,
 guest_session_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','approved','declined')),
 decided_by uuid REFERENCES auth.users(id),decision_note text,created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,
 FOREIGN KEY(business_id,branch_id,check_id,order_id) REFERENCES ops.orders(business_id,branch_id,check_id,id),
 FOREIGN KEY(business_id,branch_id,check_id,guest_session_id) REFERENCES ops.guest_sessions(business_id,branch_id,check_id,id)
);
CREATE UNIQUE INDEX order_one_pending_cancellation ON ops.order_change_requests(order_id) WHERE state='pending';
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['guest_sessions','guest_commands','order_change_requests'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ops.%I TO service_role',t);
 EXECUTE format('CREATE POLICY no_direct_access ON ops.%I FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
END LOOP;END;$$;
-- Check row always locks first. Revoked/expired/closed visits cannot issue new commands.
CREATE FUNCTION ops.guest_lock(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text)
RETURNS ops.guest_sessions LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;
BEGIN
 IF p_secret IS NULL OR p_secret !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT401' USING MESSAGE='GUEST_SESSION_REQUIRED';END IF;
 SELECT * INTO g FROM ops.guest_sessions WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id
 AND secret_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex') AND revoked_at IS NULL AND expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE SQLSTATE 'PT401' USING MESSAGE='GUEST_SESSION_EXPIRED';END IF;
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 SELECT * INTO g FROM ops.guest_sessions WHERE id=g.id AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT401' USING MESSAGE='GUEST_SESSION_EXPIRED';END IF;
 RETURN g;
END;$$;
CREATE FUNCTION ops.guest_begin(p_session_id uuid,p_operation_id uuid,p_revision bigint,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;r ops.guest_commands%ROWTYPE;
BEGIN
 SELECT * INTO STRICT g FROM ops.guest_sessions WHERE id=p_session_id;
 IF p_operation_id IS NULL OR p_revision IS NULL OR p_revision<0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COMMAND';END IF;
 SELECT * INTO r FROM ops.guest_commands WHERE session_id=g.id AND operation_id=p_operation_id;
 IF FOUND THEN
 IF r.kind<>p_kind OR r.request_payload IS DISTINCT FROM p_payload THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
 RETURN r.response_body;END IF;
 SELECT * INTO c FROM ops.checks WHERE id=g.check_id;
 IF c.status<>'open' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';END IF;
 IF c.revision<>p_revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='REVISION_CONFLICT',DETAIL=jsonb_build_object('currentRevision',c.revision::text)::text;END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE branch_id=g.branch_id AND business_id=g.business_id AND ordering_enabled AND dine_in_enabled)
 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ORDERING_DISABLED';END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.dining_tables WHERE id=c.table_id AND business_id=c.business_id AND branch_id=c.branch_id AND active)
 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='TABLE_INACTIVE';END IF;
 IF (SELECT count(*) FROM ops.guest_commands WHERE session_id=g.id AND created_at>clock_timestamp()-interval '1 minute')>=60
 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='RATE_LIMITED';END IF;
 RETURN NULL;
END;$$;
CREATE FUNCTION ops.guest_snapshot(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;x record;lines jsonb:='[]';mine bigint:=0;total bigint:=0;bill bigint:=0;my_bill bigint:=0;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 SELECT * INTO c FROM ops.checks WHERE id=g.check_id;
 -- After closure, show only this guest's history, never a future table occupant.
 IF c.status IN('open','checkout') THEN
 FOR x IN SELECT cl.*,p.id AS pid,p.name,gs.seat_no FROM ops.cart_lines cl JOIN public.menu_items p ON p.branch_id=cl.branch_id AND p.source_id=cl.product_source_id
 LEFT JOIN ops.guest_sessions gs ON gs.id=cl.guest_session_id WHERE cl.check_id=c.id ORDER BY cl.created_at,cl.id LOOP
 total:=total+x.line_total_minor;IF x.guest_session_id=g.id THEN mine:=mine+x.line_total_minor;END IF;
 lines:=lines||jsonb_build_array(jsonb_build_object('cartLineId',x.id,'productId',x.pid,'productName',left(x.name||CASE WHEN x.options_snapshot<>'[]'::jsonb THEN ' · '||(x.options_snapshot->>0) ELSE '' END,250),'option',x.options_snapshot->>0,'quantity',x.quantity,'unitPriceMinor',x.unit_price_minor::text,'lineTotalMinor',x.line_total_minor::text,'isMine',coalesce(x.guest_session_id=g.id,false),'seat',coalesce(x.seat_no,0)));
 END LOOP;END IF;
 FOR x IN SELECT b.amount_minor,o.guest_session_id FROM ops.bill_charges b JOIN ops.orders o ON o.id=b.order_id WHERE b.check_id=c.id AND b.status='active' LOOP
 bill:=bill+x.amount_minor;IF x.guest_session_id=g.id THEN my_bill:=my_bill+x.amount_minor;END IF;END LOOP;
 IF c.status NOT IN('open','checkout') THEN bill:=my_bill;END IF;
 RETURN jsonb_build_object('businessId',c.business_id,'branchId',c.branch_id,'checkId',c.id,'viewerUserId',g.id,'channelId',g.channel_id,'revision',c.revision::text,'currency','TRY','status',c.status,'canMutate',c.status='open' AND EXISTS(SELECT 1 FROM ops.branch_settings WHERE branch_id=c.branch_id AND business_id=c.business_id AND ordering_enabled AND dine_in_enabled),'totalMinor',total::text,'ownTotalMinor',mine::text,'billMinor',bill::text,'ownBillMinor',my_bill::text,'lines',lines,'seat',g.seat_no,'tableName',(SELECT display_name FROM ops.dining_tables WHERE id=c.table_id));
END;$$;
CREATE FUNCTION ops.guest_join(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_invite text,p_secret text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE c ops.checks%ROWTYPE;ch ops.check_channels%ROWTYPE;g ops.guest_sessions%ROWTYPE;n integer;
BEGIN
 IF p_invite IS NULL OR p_invite !~ '^[0-9a-f]{64}$' OR p_secret IS NULL OR p_secret !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_TABLE_INVITATION';END IF;
 -- Invalid invitations are rejected BEFORE row locking or allocation.
 IF NOT EXISTS(SELECT 1 FROM ops.check_channels WHERE check_id=p_check_id AND business_id=p_business_id AND branch_id=p_branch_id AND expires_at>clock_timestamp() AND token_hash=encode(sha256(convert_to(p_invite,'UTF8')),'hex')) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='INVALID_TABLE_INVITATION';END IF;
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 SELECT * INTO ch FROM ops.check_channels WHERE check_id=c.id FOR SHARE;
 IF c.status<>'open' OR ch.expires_at<=clock_timestamp() OR ch.token_hash IS DISTINCT FROM encode(sha256(convert_to(p_invite,'UTF8')),'hex') THEN RAISE SQLSTATE 'PT403' USING MESSAGE='INVALID_TABLE_INVITATION';END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE branch_id=c.branch_id AND business_id=c.business_id AND ordering_enabled AND dine_in_enabled) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ORDERING_DISABLED';END IF;
 SELECT * INTO g FROM ops.guest_sessions WHERE check_id=c.id AND secret_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex');
 IF FOUND THEN RETURN ops.guest_snapshot(p_business_id,p_branch_id,p_check_id,p_secret);END IF;
 SELECT coalesce(max(seat_no),0)+1 INTO n FROM ops.guest_sessions WHERE check_id=c.id;
 IF n>16 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='TABLE_CAPACITY';END IF;
 INSERT INTO ops.guest_sessions(business_id,branch_id,check_id,secret_hash,seat_no) VALUES(c.business_id,c.branch_id,c.id,encode(sha256(convert_to(p_secret,'UTF8')),'hex'),n);
 RETURN ops.guest_snapshot(p_business_id,p_branch_id,p_check_id,p_secret);
END;$$;

CREATE OR REPLACE FUNCTION ops.guest_cart_mutate( p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid, p_product_id uuid,p_delta integer,p_expected_revision bigint,p_secret text,p_option text DEFAULT NULL ) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $fn$ DECLARE g ops.guest_sessions%ROWTYPE; request_payload jsonb; cached jsonb; result jsonb; product public.menu_items%ROWTYPE; line ops.cart_lines%ROWTYPE; line_exists boolean; new_quantity integer; unit_minor bigint; line_count bigint; unit_count bigint; BEGIN g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret); IF p_product_id IS NULL OR p_delta IS NULL OR p_delta=0 OR p_delta NOT BETWEEN -999 AND 999 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_CART_INPUT'; END IF; request_payload := jsonb_build_object( 'productId',p_product_id,'delta',p_delta,'expectedRevision',p_expected_revision::text ); IF p_option IS NOT NULL THEN request_payload:=request_payload||jsonb_build_object('option',p_option);END IF; cached:=ops.guest_begin(g.id,p_operation_id,p_expected_revision,'cart',request_payload); IF cached IS NOT NULL THEN RETURN cached; END IF; SELECT * INTO product FROM public.menu_items WHERE id=p_product_id AND business_id=p_business_id AND branch_id=p_branch_id FOR SHARE; IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND'; END IF; SELECT * INTO line FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id AND product_source_id=product.source_id AND options_snapshot=CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END FOR UPDATE; line_exists := FOUND; IF NOT line_exists AND p_delta<0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CART_LINE_NOT_FOUND'; END IF; new_quantity := CASE WHEN line_exists THEN line.quantity ELSE 0 END + p_delta; IF new_quantity<0 OR new_quantity>999 THEN RAISE SQLSTATE 'PT422' USING MESSAGE='QUANTITY_OUT_OF_RANGE'; END IF; IF p_delta>0 THEN IF product.available IS NOT TRUE OR product.price_approved IS NOT TRUE OR product.approved_price IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE'; END IF; IF NOT ops.option_valid(product.options,CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED'; END IF; unit_minor := ops.catalog_minor(product.approved_price::text); IF line_exists AND line.unit_price_minor<>unit_minor THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRICE_CHANGED', DETAIL=jsonb_build_object('productId',product.id, 'currentUnitPriceMinor',unit_minor::text)::text; END IF; SELECT count(*),coalesce(sum(quantity),0) INTO line_count,unit_count FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id; IF (NOT line_exists AND line_count>=100) OR unit_count+p_delta>500 THEN RAISE SQLSTATE 'PT422' USING MESSAGE='CART_LIMIT_EXCEEDED'; END IF; ELSE unit_minor := line.unit_price_minor; END IF; IF new_quantity=0 THEN DELETE FROM ops.cart_lines WHERE id=line.id AND business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id; ELSIF line_exists THEN UPDATE ops.cart_lines SET quantity=new_quantity WHERE id=line.id AND business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id; ELSE INSERT INTO ops.cart_lines(business_id,branch_id,check_id,product_source_id, guest_session_id,client_line_key,quantity,unit_price_minor,options_snapshot) VALUES(p_business_id,p_branch_id,p_check_id,product.source_id,g.id, gen_random_uuid(),new_quantity,unit_minor,CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END); END IF; result:=ops.guest_snapshot(p_business_id,p_branch_id,p_check_id,p_secret)||jsonb_build_object('operationId',p_operation_id); INSERT INTO ops.guest_commands(session_id,operation_id,kind,request_payload,response_body) VALUES(g.id,p_operation_id,'cart',request_payload,result); RETURN result; END; $fn$;
CREATE OR REPLACE FUNCTION ops.guest_order_submit( p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid, p_expected_revision bigint,p_secret text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $fn$ DECLARE g ops.guest_sessions%ROWTYPE; request_payload jsonb; cached jsonb; result jsonb; line ops.cart_lines%ROWTYPE; product public.menu_items%ROWTYPE; order_row ops.orders%ROWTYPE; item ops.order_items%ROWTYPE; unit_minor bigint; total_minor bigint := 0; revision_value bigint; line_count bigint; unit_count bigint; line_no integer := 0; charge_count integer := 0; fingerprint text; output_lines jsonb := '[]'::jsonb; BEGIN g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret); request_payload := jsonb_build_object('expectedRevision',p_expected_revision::text); cached:=ops.guest_begin(g.id,p_operation_id,p_expected_revision,'order',request_payload); IF cached IS NOT NULL THEN RETURN cached; END IF; SELECT count(*),coalesce(sum(quantity),0) INTO line_count,unit_count FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id; IF line_count=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CART_EMPTY'; END IF; IF line_count>100 OR unit_count>500 THEN RAISE SQLSTATE 'PT422' USING MESSAGE='CART_LIMIT_EXCEEDED'; END IF; PERFORM p.id FROM public.menu_items p JOIN ops.cart_lines cl ON cl.product_source_id=p.source_id AND cl.branch_id=p.branch_id AND cl.business_id=p.business_id WHERE cl.business_id=p_business_id AND cl.branch_id=p_branch_id AND cl.check_id=p_check_id AND cl.guest_session_id=g.id ORDER BY p.id FOR SHARE OF p; fingerprint := encode(pg_catalog.sha256(convert_to(jsonb_build_object( 'guestSessionId',g.id,'businessId',p_business_id,'branchId',p_branch_id, 'checkId',p_check_id,'operationId',p_operation_id,'payload',request_payload )::text,'UTF8')),'hex'); BEGIN INSERT INTO ops.orders(business_id,branch_id,check_id,client_request_id, request_fingerprint,guest_session_id,status) VALUES(p_business_id,p_branch_id,p_check_id,p_operation_id,fingerprint,g.id,'draft') RETURNING * INTO order_row; EXCEPTION WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT'; END; FOR line IN SELECT * FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id ORDER BY id FOR UPDATE LOOP SELECT * INTO product FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND source_id=line.product_source_id; IF NOT FOUND OR product.available IS NOT TRUE OR product.price_approved IS NOT TRUE OR product.approved_price IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE'; END IF; IF NOT ops.option_valid(product.options,line.options_snapshot) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED'; END IF; unit_minor := ops.catalog_minor(product.approved_price::text); IF unit_minor<>line.unit_price_minor THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRICE_CHANGED', DETAIL=jsonb_build_object('productId',product.id, 'currentUnitPriceMinor',unit_minor::text)::text; END IF; line_no := line_no+1; INSERT INTO ops.order_items(business_id,branch_id,check_id,order_id,line_no, product_source_id,product_name_snapshot,options_snapshot,quantity, unit_price_minor,discount_minor) VALUES(p_business_id,p_branch_id,p_check_id,order_row.id,line_no, product.source_id,left(product.name||CASE WHEN line.options_snapshot<>'[]'::jsonb THEN ' · '||(line.options_snapshot->>0) ELSE '' END,250),line.options_snapshot,line.quantity,unit_minor,0::bigint) RETURNING * INTO item; INSERT INTO ops.bill_charges(business_id,branch_id,check_id,order_id, order_item_id,unit_no,kind,amount_minor,currency,status) SELECT p_business_id,p_branch_id,p_check_id,order_row.id,item.id,u.unit_no, 'item',item.unit_price_minor - (item.discount_minor / item.quantity::bigint) - CASE WHEN u.unit_no::bigint <= item.discount_minor % item.quantity::bigint THEN 1::bigint ELSE 0::bigint END, 'TRY','active' FROM generate_series(1,item.quantity) AS u(unit_no); total_minor := total_minor+item.net_minor; charge_count := charge_count+item.quantity; output_lines := output_lines || jsonb_build_array(jsonb_build_object( 'orderItemId',item.id,'productId',product.id,'productName',item.product_name_snapshot, 'quantity',item.quantity,'unitPriceMinor',item.unit_price_minor::text, 'discountMinor',item.discount_minor::text,'grossMinor',item.gross_minor::text, 'netMinor',item.net_minor::text )); END LOOP; DELETE FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id; UPDATE ops.orders SET status='submitted',submitted_at=clock_timestamp() WHERE id=order_row.id AND business_id=p_business_id AND branch_id=p_branch_id RETURNING * INTO order_row; SELECT revision INTO revision_value FROM ops.checks WHERE id=p_check_id; result := jsonb_build_object('checkId',p_check_id,'operationId',p_operation_id, 'orderId',order_row.id,'status','submitted','revision',revision_value::text, 'currency','TRY','totalMinor',total_minor::text,'chargeCount',charge_count, 'lines',output_lines); INSERT INTO ops.guest_commands(session_id,operation_id,kind,request_payload,response_body) VALUES(g.id,p_operation_id,'order',request_payload,result); RETURN result; EXCEPTION WHEN numeric_value_out_of_range THEN RAISE SQLSTATE 'PT422' USING MESSAGE='AMOUNT_LIMIT_EXCEEDED'; END; $fn$;

-- Individual private channels are read-capabilities, never the session write secret.
-- Supabase anonymous Auth is disabled; no auth.users fabrication or shared user identity.
CREATE FUNCTION ops.receive_guest_topic(p_topic text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM ops.guest_sessions g JOIN ops.checks c ON c.id=g.check_id WHERE 'check:'||g.channel_id::text=p_topic AND g.revoked_at IS NULL AND g.expires_at>now() AND c.status IN('open','checkout'));
$$;
CREATE POLICY guest_private_signal ON realtime.messages FOR SELECT TO anon
 USING(extension='broadcast' AND topic=(SELECT realtime.topic()) AND ops.receive_guest_topic((SELECT realtime.topic())));
GRANT USAGE ON SCHEMA realtime TO anon;
GRANT SELECT ON realtime.messages TO anon;
CREATE FUNCTION ops.emit_guest_signal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g record;
BEGIN
 FOR g IN SELECT channel_id FROM ops.guest_sessions WHERE check_id=NEW.id AND revoked_at IS NULL AND expires_at>clock_timestamp() LOOP
 PERFORM realtime.send(jsonb_build_object('revision',NEW.revision::text),'changed','check:'||g.channel_id::text,true);
 END LOOP;RETURN NULL;
END;$$;
CREATE TRIGGER guest_check_changed AFTER UPDATE ON ops.checks FOR EACH ROW EXECUTE FUNCTION ops.emit_guest_signal();
CREATE FUNCTION ops.guest_orders(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;res jsonb;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status',o.status,'isMine',coalesce(o.guest_session_id=g.id,false),'seat',coalesce(gs.seat_no,0),'createdAt',o.created_at,
 'cancelState',(SELECT cr.state FROM ops.order_change_requests cr WHERE cr.order_id=o.id ORDER BY cr.created_at DESC LIMIT 1),
 'lines',(SELECT jsonb_agg(jsonb_build_object('name',i.product_name_snapshot,'quantity',i.quantity,'amountMinor',i.net_minor::text) ORDER BY i.line_no) FROM ops.order_items i WHERE i.order_id=o.id)) ORDER BY o.created_at),'[]') INTO res
 FROM ops.orders o LEFT JOIN ops.guest_sessions gs ON gs.id=o.guest_session_id JOIN ops.checks c ON c.id=o.check_id
 WHERE o.check_id=g.check_id AND o.status<>'draft' AND (c.status IN('open','checkout') OR o.guest_session_id=g.id);
 RETURN res;
END;$$;
CREATE FUNCTION ops.guest_service(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text,p_kind text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;r ops.service_requests%ROWTYPE;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 IF p_kind NOT IN('waiter','bill') OR p_kind IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_SERVICE_REQUEST';END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.checks WHERE id=g.check_id AND status IN('open','checkout')) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';END IF;
 SELECT * INTO r FROM ops.service_requests WHERE check_id=g.check_id AND kind=p_kind AND status='pending';
 IF FOUND THEN RETURN jsonb_build_object('id',r.id,'status',r.status);END IF;
 IF (SELECT count(*) FROM ops.service_requests WHERE check_id=g.check_id AND created_at>clock_timestamp()-interval '5 minutes')>=10 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='RATE_LIMITED';END IF;
 INSERT INTO ops.service_requests(business_id,branch_id,check_id,guest_session_id,kind) VALUES(g.business_id,g.branch_id,g.check_id,g.id,p_kind) RETURNING * INTO r;
 RETURN jsonb_build_object('id',r.id,'status',r.status);
END;$$;
CREATE FUNCTION ops.guest_cancel_request(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text,p_order_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;o ops.orders%ROWTYPE;r ops.order_change_requests%ROWTYPE;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 300 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='REASON_REQUIRED';END IF;
 SELECT * INTO o FROM ops.orders WHERE id=p_order_id AND check_id=g.check_id AND guest_session_id=g.id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='ORDER_NOT_FOUND';END IF;
 IF o.status NOT IN('submitted','accepted','preparing') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ORDER_NOT_CANCELLABLE';END IF;
 SELECT * INTO r FROM ops.order_change_requests WHERE order_id=o.id AND state='pending';
 IF NOT FOUND THEN
 IF (SELECT count(*) FROM ops.order_change_requests WHERE guest_session_id=g.id AND created_at>clock_timestamp()-interval '5 minutes')>=5 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='RATE_LIMITED';END IF;
 INSERT INTO ops.order_change_requests(business_id,branch_id,check_id,order_id,guest_session_id,reason) VALUES(g.business_id,g.branch_id,g.check_id,o.id,g.id,btrim(p_reason)) RETURNING * INTO r;END IF;
 RETURN jsonb_build_object('id',r.id,'state',r.state);
END;$$;
CREATE FUNCTION ops.guest_link(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=auth.uid() AND email_confirmed_at IS NOT NULL) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='VERIFIED_ACCOUNT_REQUIRED';END IF;
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 IF g.linked_user_id IS NOT NULL AND g.linked_user_id<>auth.uid() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='VISIT_ALREADY_LINKED';END IF;
 UPDATE ops.guest_sessions SET linked_user_id=auth.uid() WHERE id=g.id;
 -- Proof of the visit is linked, not payment/loyalty ownership. No points or consent created.
 RETURN jsonb_build_object('linked',true);
END;$$;
CREATE FUNCTION ops.guest_revoke(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_guest_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 PERFORM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 UPDATE ops.guest_sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()),channel_id=gen_random_uuid() WHERE id=p_guest_id AND check_id=p_check_id AND branch_id=p_branch_id AND business_id=p_business_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='GUEST_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM ops.checks WHERE id=p_check_id AND status='open') THEN DELETE FROM ops.cart_lines WHERE check_id=p_check_id AND guest_session_id=p_guest_id;END IF;
 UPDATE ops.checks SET revision=revision+1 WHERE id=p_check_id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'guest-visit-ended',jsonb_build_object('checkId',p_check_id,'guestId',p_guest_id,'submittedOrdersUnchanged',true));
END;$$;
-- Private channel ids or write capabilities never appear in operator metrics.
CREATE FUNCTION ops.service_dashboard(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE requests jsonb;summary jsonb;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','kitchen','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'orderId',r.order_id,'table',t.display_name,'reason',r.reason,'at',r.created_at) ORDER BY r.created_at),'[]') INTO requests
 FROM ops.order_change_requests r JOIN ops.checks c ON c.id=r.check_id JOIN ops.dining_tables t ON t.id=c.table_id WHERE r.business_id=p_business_id AND r.branch_id=p_branch_id AND r.state='pending';
 SELECT jsonb_build_object('waitingAcceptance',count(*) FILTER(WHERE status='submitted'),'overdue',count(*) FILTER(WHERE status='submitted' AND submitted_at<clock_timestamp()-interval '3 minutes'),'preparing',count(*) FILTER(WHERE status IN('accepted','preparing')),'ready',count(*) FILTER(WHERE status='ready')) INTO summary FROM ops.orders WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>now()-interval '1 day';
 RETURN jsonb_build_object('cancellations',requests,'summary',summary,'guestVisits',(SELECT count(*) FROM ops.guest_sessions WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>now()-interval '1 day'),'visits',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'checkId',g.check_id,'table',t.display_name,'seat',g.seat_no,'active',g.revoked_at IS NULL AND g.expires_at>clock_timestamp()) ORDER BY g.created_at DESC),'[]') FROM ops.guest_sessions g JOIN ops.checks c ON c.id=g.check_id JOIN ops.dining_tables t ON t.id=c.table_id WHERE g.business_id=p_business_id AND g.branch_id=p_branch_id AND c.status IN('open','checkout')),'guestOrders',(SELECT count(*) FROM ops.orders WHERE business_id=p_business_id AND branch_id=p_branch_id AND guest_session_id IS NOT NULL AND created_at>now()-interval '1 day'));
END;$$;
CREATE FUNCTION ops.decide_cancellation(p_business_id uuid,p_branch_id uuid,p_id uuid,p_approve boolean,p_note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r ops.order_change_requests%ROWTYPE;o ops.orders%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier','waiter']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 SELECT * INTO r FROM ops.order_change_requests WHERE id=p_id AND business_id=p_business_id AND branch_id=p_branch_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='NOT_FOUND';END IF;
 PERFORM ops.lock_check(p_business_id,p_branch_id,r.check_id,NULL);
 SELECT * INTO r FROM ops.order_change_requests WHERE id=p_id FOR UPDATE;
 IF r.state<>'pending' THEN RETURN jsonb_build_object('state',r.state);END IF;
 IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 300 OR p_approve IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='REASON_REQUIRED';END IF;
 IF p_approve THEN
 SELECT * INTO o FROM ops.orders WHERE id=r.order_id FOR UPDATE;
 IF o.status NOT IN('submitted','accepted','preparing') OR EXISTS(SELECT 1 FROM ops.checkout_plans WHERE check_id=r.check_id AND status<>'cancelled') OR EXISTS(SELECT 1 FROM ops.payment_intents WHERE check_id=r.check_id AND status NOT IN('failed','cancelled')) OR EXISTS(SELECT 1 FROM ops.counter_receipts WHERE check_id=r.check_id)
 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='REFUND_OR_SERVICE_REVIEW_REQUIRED';END IF;
 UPDATE ops.bill_charges SET status='voided',voided_at=clock_timestamp(),void_reason=btrim(p_note) WHERE order_id=o.id AND status='active';
 UPDATE ops.orders SET status='cancelled' WHERE id=o.id;
 END IF;
 UPDATE ops.order_change_requests SET state=CASE WHEN p_approve THEN 'approved' ELSE 'declined' END,decision_note=btrim(p_note),decided_at=clock_timestamp(),decided_by=auth.uid() WHERE id=r.id;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'cancellation-decision',jsonb_build_object('requestId',r.id,'approved',p_approve,'reason',p_note));
 RETURN jsonb_build_object('saved',true);
END;$$;
-- Everyone, including logged-in customers, has personal draft ownership.

CREATE OR REPLACE FUNCTION ops.cart_mutate_choice(
  p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,
  p_product_id uuid,p_delta integer,p_expected_revision bigint,p_option text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path='' SET lock_timeout='2s' AS $fn$
DECLARE
  request_payload jsonb;
  cached jsonb;
  result jsonb;
  product public.menu_items%ROWTYPE;
  line ops.cart_lines%ROWTYPE;
  line_exists boolean;
  new_quantity integer;
  unit_minor bigint;
  line_count bigint;
  unit_count bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';
  END IF;
  IF p_product_id IS NULL OR p_delta IS NULL
     OR p_delta=0 OR p_delta NOT BETWEEN -999 AND 999 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_CART_INPUT';
  END IF;
  request_payload := jsonb_build_object(
    'productId',p_product_id,'delta',p_delta,'expectedRevision',p_expected_revision::text
  );
  IF p_option IS NOT NULL THEN request_payload:=request_payload||jsonb_build_object('option',p_option);END IF;
  cached := ops.begin_command(p_business_id,p_branch_id,p_check_id,p_operation_id,
    p_expected_revision,'cart',request_payload);
  IF cached IS NOT NULL THEN RETURN cached; END IF;

  SELECT * INTO product FROM public.menu_items
    WHERE id=p_product_id AND business_id=p_business_id AND branch_id=p_branch_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';
  END IF;
  SELECT * INTO line FROM ops.cart_lines
    WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id
      AND created_by_user_id=auth.uid() AND guest_session_id IS NULL AND product_source_id=product.source_id AND options_snapshot=CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END
    FOR UPDATE;
  line_exists := FOUND;
  IF NOT line_exists AND p_delta<0 THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='CART_LINE_NOT_FOUND';
  END IF;
  new_quantity := CASE WHEN line_exists THEN line.quantity ELSE 0 END + p_delta;
  IF new_quantity<0 OR new_quantity>999 THEN
    RAISE SQLSTATE 'PT422' USING MESSAGE='QUANTITY_OUT_OF_RANGE';
  END IF;

  IF p_delta>0 THEN
    IF product.available IS NOT TRUE OR product.price_approved IS NOT TRUE
       OR product.approved_price IS NULL THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE';
    END IF;
    -- Mevcut giriş sözleşmesinde optionId yok: seçenek gerektiren ürünlerde
    -- gizlice ilk seçeneği seçmek / ek ücreti atlamak yerine güvenli ret.
    IF NOT ops.option_valid(product.options,CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED';
    END IF;
    unit_minor := ops.catalog_minor(product.approved_price::text);
    -- İstemcinin zaten gördüğü satırı sessizce yeniden fiyatlandırma.
    IF line_exists AND line.unit_price_minor<>unit_minor THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRICE_CHANGED',
        DETAIL=jsonb_build_object('productId',product.id,
          'currentUnitPriceMinor',unit_minor::text)::text;
    END IF;
    SELECT count(*),coalesce(sum(quantity),0) INTO line_count,unit_count
      FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id
        AND check_id=p_check_id;
    -- sum(integer) BIGINT döner. Para toplamında sum(bigint) kullanılmaz.
    IF (NOT line_exists AND line_count>=100) OR unit_count+p_delta>500 THEN
      RAISE SQLSTATE 'PT422' USING MESSAGE='CART_LIMIT_EXCEEDED';
    END IF;
  ELSE
    -- Satıştan kalkmış/fiyatı onaysız ürünün AZALTILMASI/SİLİNMESİ serbest.
    -- Bu işlem yeni fiyat veya borç üretmez; mevcut taslak fiyatı korunur.
    unit_minor := line.unit_price_minor;
  END IF;

  IF new_quantity=0 THEN
    DELETE FROM ops.cart_lines WHERE id=line.id
      AND business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id;
  ELSIF line_exists THEN
    UPDATE ops.cart_lines SET quantity=new_quantity
      WHERE id=line.id AND business_id=p_business_id AND branch_id=p_branch_id
        AND check_id=p_check_id;
  ELSE
    INSERT INTO ops.cart_lines(business_id,branch_id,check_id,product_source_id,
      created_by_user_id,client_line_key,quantity,unit_price_minor,options_snapshot)
    VALUES(p_business_id,p_branch_id,p_check_id,product.source_id,auth.uid(),
      gen_random_uuid(),new_quantity,unit_minor,CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END);
  END IF;
  -- Core trigger'ların artırdığı GERÇEK revizyon okunur; +1 varsayılmaz.
  result := ops.cart_result(p_check_id,p_operation_id);
  INSERT INTO ops.api_commands(actor_user_id,operation_id,business_id,branch_id,
    check_id,command_type,request_payload,response_body)
  VALUES(auth.uid(),p_operation_id,p_business_id,p_branch_id,p_check_id,
    'cart',request_payload,result);
  RETURN result;
END;
$fn$;
CREATE OR REPLACE FUNCTION ops.order_submit(
  p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,
  p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path='' SET lock_timeout='2s' AS $fn$
DECLARE
  request_payload jsonb;
  cached jsonb;
  result jsonb;
  line ops.cart_lines%ROWTYPE;
  product public.menu_items%ROWTYPE;
  order_row ops.orders%ROWTYPE;
  item ops.order_items%ROWTYPE;
  unit_minor bigint;
  total_minor bigint := 0;
  revision_value bigint;
  line_count bigint;
  unit_count bigint;
  line_no integer := 0;
  charge_count integer := 0;
  fingerprint text;
  output_lines jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';
  END IF;
  request_payload := jsonb_build_object('expectedRevision',p_expected_revision::text);
  cached := ops.begin_command(p_business_id,p_branch_id,p_check_id,p_operation_id,
    p_expected_revision,'order',request_payload);
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT count(*),coalesce(sum(quantity),0) INTO line_count,unit_count
    FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id
      AND check_id=p_check_id AND created_by_user_id=auth.uid() AND guest_session_id IS NULL;
  IF line_count=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CART_EMPTY'; END IF;
  IF line_count>100 OR unit_count>500 THEN
    RAISE SQLSTATE 'PT422' USING MESSAGE='CART_LIMIT_EXCEEDED';
  END IF;

  -- Tüm katalog satırları sabit sırayla kilitlenir: fiyat/uygunluk güncellemesi
  -- bu sipariş transaction'ı bitmeden araya giremez. Aynı ürünlü farklı
  -- adisyonlar FOR SHARE ile birbiriyle uyumludur.
  PERFORM p.id FROM public.menu_items p
    JOIN ops.cart_lines cl ON cl.product_source_id=p.source_id
      AND cl.branch_id=p.branch_id AND cl.business_id=p.business_id
    WHERE cl.business_id=p_business_id AND cl.branch_id=p_branch_id
      AND cl.check_id=p_check_id AND cl.created_by_user_id=auth.uid() AND cl.guest_session_id IS NULL
    ORDER BY p.id FOR SHARE OF p;

  -- Core trigger yeni order için önce draft zorunlu kılar. Sipariş turu
  -- burada oluşturulur; bütün snapshot ve borçlar tamamlanınca submitted olur.
  fingerprint := encode(pg_catalog.sha256(convert_to(jsonb_build_object(
    'actorId',auth.uid(),'businessId',p_business_id,'branchId',p_branch_id,
    'checkId',p_check_id,'operationId',p_operation_id,'payload',request_payload
  )::text,'UTF8')),'hex');
  BEGIN
    INSERT INTO ops.orders(business_id,branch_id,check_id,client_request_id,
      request_fingerprint,submitted_by_user_id,status)
    VALUES(p_business_id,p_branch_id,p_check_id,p_operation_id,fingerprint,auth.uid(),'draft')
    RETURNING * INTO order_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';
  END;

  FOR line IN SELECT * FROM ops.cart_lines
    WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND created_by_user_id=auth.uid() AND guest_session_id IS NULL
    ORDER BY id FOR UPDATE
  LOOP
    SELECT * INTO product FROM public.menu_items
      WHERE business_id=p_business_id AND branch_id=p_branch_id
        AND source_id=line.product_source_id;
    IF NOT FOUND OR product.available IS NOT TRUE
       OR product.price_approved IS NOT TRUE OR product.approved_price IS NULL THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE';
    END IF;
    IF NOT ops.option_valid(product.options,line.options_snapshot) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED';
    END IF;
    unit_minor := ops.catalog_minor(product.approved_price::text);
    IF unit_minor<>line.unit_price_minor THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRICE_CHANGED',
        DETAIL=jsonb_build_object('productId',product.id,
          'currentUnitPriceMinor',unit_minor::text)::text;
    END IF;
    line_no := line_no+1;
    INSERT INTO ops.order_items(business_id,branch_id,check_id,order_id,line_no,
      product_source_id,product_name_snapshot,options_snapshot,quantity,
      unit_price_minor,discount_minor)
    VALUES(p_business_id,p_branch_id,p_check_id,order_row.id,line_no,
      product.source_id,left(product.name||CASE WHEN line.options_snapshot<>'[]'::jsonb THEN ' · '||(line.options_snapshot->>0) ELSE '' END,250),line.options_snapshot,line.quantity,unit_minor,0::bigint)
    RETURNING * INTO item;

    -- quantity=3 -> unit_no=1,2,3. Set tabanlı döngü her birim için ayrı INSERT
    -- kaydı oluşturur. Core trigger birim tutarını ayrıca doğrular.
    INSERT INTO ops.bill_charges(business_id,branch_id,check_id,order_id,
      order_item_id,unit_no,kind,amount_minor,currency,status)
    SELECT p_business_id,p_branch_id,p_check_id,order_row.id,item.id,u.unit_no,
      'item',item.unit_price_minor
        - (item.discount_minor / item.quantity::bigint)
        - CASE WHEN u.unit_no::bigint <= item.discount_minor % item.quantity::bigint
               THEN 1::bigint ELSE 0::bigint END,
      'TRY','active'
    FROM generate_series(1,item.quantity) AS u(unit_no);

    total_minor := total_minor+item.net_minor;
    charge_count := charge_count+item.quantity;
    output_lines := output_lines || jsonb_build_array(jsonb_build_object(
      'orderItemId',item.id,'productId',product.id,'productName',item.product_name_snapshot,
      'quantity',item.quantity,'unitPriceMinor',item.unit_price_minor::text,
      'discountMinor',item.discount_minor::text,'grossMinor',item.gross_minor::text,
      'netMinor',item.net_minor::text
    ));
  END LOOP;
  DELETE FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id
    AND check_id=p_check_id AND created_by_user_id=auth.uid() AND guest_session_id IS NULL;
  UPDATE ops.orders SET status='submitted',submitted_at=clock_timestamp()
    WHERE id=order_row.id AND business_id=p_business_id AND branch_id=p_branch_id
    RETURNING * INTO order_row;
  SELECT revision INTO revision_value FROM ops.checks WHERE id=p_check_id;
  result := jsonb_build_object('checkId',p_check_id,'operationId',p_operation_id,
    'orderId',order_row.id,'status','submitted','revision',revision_value::text,
    'currency','TRY','totalMinor',total_minor::text,'chargeCount',charge_count,
    'lines',output_lines);
  INSERT INTO ops.api_commands(actor_user_id,operation_id,business_id,branch_id,
    check_id,command_type,request_payload,response_body)
  VALUES(auth.uid(),p_operation_id,p_business_id,p_branch_id,p_check_id,
    'order',request_payload,result);
  RETURN result;
EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT422' USING MESSAGE='AMOUNT_LIMIT_EXCEEDED';
END;
$fn$;

DO $$DECLARE r record;BEGIN FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ops' AND p.proname=ANY(ARRAY['guest_lock','guest_begin','guest_snapshot','guest_join','guest_cart_mutate','guest_order_submit','receive_guest_topic','emit_guest_signal','guest_orders','guest_service','guest_cancel_request','guest_link','guest_revoke','service_dashboard','decide_cancellation','cart_mutate_choice','order_submit']::text[]) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);END LOOP;END;$$;
GRANT EXECUTE ON FUNCTION ops.guest_join(uuid,uuid,uuid,text,text),ops.guest_snapshot(uuid,uuid,uuid,text),ops.guest_cart_mutate(uuid,uuid,uuid,uuid,uuid,integer,bigint,text,text),ops.guest_order_submit(uuid,uuid,uuid,uuid,bigint,text),ops.guest_orders(uuid,uuid,uuid,text),ops.guest_service(uuid,uuid,uuid,text,text),ops.guest_cancel_request(uuid,uuid,uuid,text,uuid,text),ops.receive_guest_topic(text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.guest_link(uuid,uuid,uuid,text),ops.guest_revoke(uuid,uuid,uuid,uuid),ops.service_dashboard(uuid,uuid),ops.decide_cancellation(uuid,uuid,uuid,boolean,text),ops.cart_mutate_choice(uuid,uuid,uuid,uuid,uuid,integer,bigint,text),ops.order_submit(uuid,uuid,uuid,uuid,bigint) TO authenticated;
COMMIT;
