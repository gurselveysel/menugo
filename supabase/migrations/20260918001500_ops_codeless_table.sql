-- r12: no-code table QR; acceptance belongs to the order, not the guest.
-- Keeps existing staff-approved mode as opt-in; no catalog/Auth writes or seeded visits.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE ops.service_controls ADD COLUMN guest_entry_mode text NOT NULL DEFAULT 'direct'
 CHECK(guest_entry_mode IN('direct','staff_approved'));

CREATE FUNCTION ops.table_ordering_policy(p_business_id uuid,p_branch_id uuid,p_mode text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s ops.service_controls%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier','kitchen']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 SELECT * INTO s FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF p_mode IS NOT NULL THEN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 IF p_mode NOT IN('direct','staff_approved') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_INPUT';END IF;
 UPDATE ops.service_controls SET guest_entry_mode=p_mode,version=version+1,updated_at=clock_timestamp() WHERE business_id=p_business_id AND branch_id=p_branch_id RETURNING * INTO s;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'table-entry-mode',jsonb_build_object('mode',p_mode));
 END IF;
 RETURN jsonb_build_object('mode',s.guest_entry_mode);
END;$$;

CREATE OR REPLACE FUNCTION ops.table_entry_info(p_business_id uuid,p_branch_id uuid,p_table_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE t ops.dining_tables%ROWTYPE;
BEGIN
 SELECT * INTO t FROM ops.dining_tables WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_table_id AND active;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='TABLE_NOT_FOUND';END IF;
 RETURN jsonb_build_object('tableId',t.id,'tableName',t.display_name,
 'entryMode',coalesce((SELECT guest_entry_mode FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id),'direct'),
 'enabled',EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=t.business_id AND branch_id=t.branch_id AND ordering_enabled AND dine_in_enabled));
END;$$;

-- GET is read-only. It neither joins a table nor exposes a table's current bill ID.
CREATE FUNCTION ops.table_guest_status(p_business_id uuid,p_branch_id uuid,p_table_id uuid,p_secret text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;
BEGIN
 IF p_secret IS NULL OR p_secret !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT401' USING MESSAGE='ENTRY_SESSION_REQUIRED';END IF;
 SELECT gs.* INTO g FROM ops.guest_sessions gs JOIN ops.checks ch ON ch.id=gs.check_id AND ch.business_id=gs.business_id AND ch.branch_id=gs.branch_id
 WHERE gs.business_id=p_business_id AND gs.branch_id=p_branch_id AND ch.table_id=p_table_id AND gs.secret_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex');
 IF NOT FOUND THEN RETURN jsonb_build_object('state','idle');END IF;
 SELECT * INTO c FROM ops.checks WHERE id=g.check_id;
 IF g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp() OR c.status NOT IN('open','checkout') THEN RETURN jsonb_build_object('state','finished');END IF;
 RETURN jsonb_build_object('state','active');
END;$$;

-- A single scoped, idempotent command. A table is created by the manager, never the guest.
-- The first visitor can open an empty visit; no order is accepted or produced here.
CREATE FUNCTION ops.table_guest_join(p_business_id uuid,p_branch_id uuid,p_table_id uuid,p_secret text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;n integer;h text;
BEGIN
 IF p_secret IS NULL OR p_secret !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_TABLE_INVITATION';END IF;
 h:=encode(sha256(convert_to(p_secret,'UTF8')),'hex');
 -- Match start_table's lock order: table -> check -> guest.
 PERFORM id FROM ops.dining_tables WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_table_id AND active FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='TABLE_NOT_FOUND';END IF;
 SELECT * INTO g FROM ops.guest_sessions WHERE secret_hash=h;
 IF FOUND THEN
 SELECT * INTO c FROM ops.checks WHERE id=g.check_id;
 IF g.business_id<>p_business_id OR g.branch_id<>p_branch_id OR c.table_id<>p_table_id THEN RAISE SQLSTATE 'PT403' USING MESSAGE='TABLE_ACCESS_DENIED';END IF;
 PERFORM ops.lock_check(p_business_id,p_branch_id,g.check_id,NULL);
 SELECT * INTO c FROM ops.checks WHERE id=g.check_id;
 IF c.status NOT IN('open','checkout') OR g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ENTRY_FINISHED';END IF;
 RETURN ops.guest_snapshot(p_business_id,p_branch_id,c.id,p_secret);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id AND ordering_enabled AND dine_in_enabled) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ORDERING_DISABLED';END IF;
 IF EXISTS(SELECT 1 FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id AND guest_entry_mode<>'direct') THEN RAISE SQLSTATE 'PT403' USING MESSAGE='ENTRY_APPROVAL_REQUIRED';END IF;
 -- Aggregate limits also apply to callers of the public RPC, not just Next.js.
 IF (SELECT count(*) FROM ops.guest_sessions gs JOIN ops.checks ch ON ch.id=gs.check_id WHERE gs.business_id=p_business_id AND gs.branch_id=p_branch_id AND ch.table_id=p_table_id AND gs.created_at>clock_timestamp()-interval '5 minutes')>=20 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='RATE_LIMITED';END IF;
 SELECT * INTO c FROM ops.checks WHERE business_id=p_business_id AND branch_id=p_branch_id AND table_id=p_table_id AND status IN('open','checkout') FOR UPDATE;
 IF NOT FOUND THEN
 INSERT INTO ops.checks(business_id,branch_id,table_id,service_mode,opened_by_user_id) VALUES(p_business_id,p_branch_id,p_table_id,'dine_in',NULL) RETURNING * INTO c;
 END IF;
 IF c.status<>'open' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';END IF;
 SELECT coalesce(max(seat_no),0)+1 INTO n FROM ops.guest_sessions WHERE check_id=c.id;
 IF n>16 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='TABLE_GUEST_LIMIT';END IF;
 INSERT INTO ops.guest_sessions(business_id,branch_id,check_id,secret_hash,seat_no) VALUES(p_business_id,p_branch_id,c.id,h,n);
 UPDATE ops.checks SET revision=revision+1 WHERE id=c.id;
 RETURN ops.guest_snapshot(p_business_id,p_branch_id,c.id,p_secret);
END;$$;
CREATE OR REPLACE FUNCTION ops.guest_snapshot(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;x record;lines jsonb:='[]';mine bigint:=0;total bigint:=0;bill bigint:=0;my_bill bigint:=0;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 SELECT * INTO c FROM ops.checks WHERE id=g.check_id;
 -- Each capability sees only its own drafts and charges, even while the table is open.
 IF c.status IN('open','checkout') THEN
 FOR x IN SELECT cl.*,p.id AS pid,p.name,gs.seat_no FROM ops.cart_lines cl JOIN public.menu_items p ON p.branch_id=cl.branch_id AND p.source_id=cl.product_source_id
 LEFT JOIN ops.guest_sessions gs ON gs.id=cl.guest_session_id WHERE cl.business_id=g.business_id AND cl.branch_id=g.branch_id AND cl.check_id=c.id AND cl.guest_session_id=g.id ORDER BY cl.created_at,cl.id LOOP
 total:=total+x.line_total_minor;IF x.guest_session_id=g.id THEN mine:=mine+x.line_total_minor;END IF;
 lines:=lines||jsonb_build_array(jsonb_build_object('cartLineId',x.id,'productId',x.pid,'productName',left(x.name||CASE WHEN x.options_snapshot<>'[]'::jsonb THEN ' · '||(x.options_snapshot->>0) ELSE '' END,250),'option',x.options_snapshot->>0,'quantity',x.quantity,'unitPriceMinor',x.unit_price_minor::text,'lineTotalMinor',x.line_total_minor::text,'isMine',coalesce(x.guest_session_id=g.id,false),'seat',coalesce(x.seat_no,0)));
 END LOOP;END IF;
 FOR x IN SELECT b.amount_minor,o.guest_session_id FROM ops.bill_charges b JOIN ops.orders o ON o.id=b.order_id WHERE b.business_id=g.business_id AND b.branch_id=g.branch_id AND b.check_id=c.id AND o.guest_session_id=g.id AND b.status='active' LOOP
 bill:=bill+x.amount_minor;IF x.guest_session_id=g.id THEN my_bill:=my_bill+x.amount_minor;END IF;END LOOP;
 IF c.status NOT IN('open','checkout') THEN bill:=my_bill;END IF;
 RETURN jsonb_build_object('businessId',c.business_id,'branchId',c.branch_id,'checkId',c.id,'viewerUserId',g.id,'channelId',g.channel_id,'revision',c.revision::text,'currency','TRY','status',c.status,'canMutate',c.status='open' AND EXISTS(SELECT 1 FROM ops.branch_settings WHERE branch_id=c.branch_id AND business_id=c.business_id AND ordering_enabled AND dine_in_enabled),'totalMinor',total::text,'ownTotalMinor',mine::text,'billMinor',bill::text,'ownBillMinor',my_bill::text,'lines',lines,'seat',g.seat_no,'tableName',(SELECT display_name FROM ops.dining_tables WHERE id=c.table_id));
END;$$;
CREATE OR REPLACE FUNCTION ops.guest_orders(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;res jsonb;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status',o.status,'isMine',coalesce(o.guest_session_id=g.id,false),'seat',coalesce(gs.seat_no,0),'createdAt',o.created_at,'rejected',EXISTS(SELECT 1 FROM ops.operator_events e WHERE e.business_id=g.business_id AND e.branch_id=g.branch_id AND e.kind='order-rejected' AND e.details->>'orderId'=o.id::text),
 'cancelState',(SELECT cr.state FROM ops.order_change_requests cr WHERE cr.order_id=o.id ORDER BY cr.created_at DESC LIMIT 1),
 'lines',(SELECT jsonb_agg(jsonb_build_object('name',i.product_name_snapshot,'quantity',i.quantity,'amountMinor',i.net_minor::text) ORDER BY i.line_no) FROM ops.order_items i WHERE i.order_id=o.id)) ORDER BY o.created_at),'[]') INTO res
 FROM ops.orders o LEFT JOIN ops.guest_sessions gs ON gs.id=o.guest_session_id JOIN ops.checks c ON c.id=o.check_id
 WHERE o.check_id=g.check_id AND o.status<>'draft' AND o.business_id=g.business_id AND o.branch_id=g.branch_id AND o.guest_session_id=g.id;
 RETURN res;
END;$$;
CREATE OR REPLACE FUNCTION ops.guest_begin(p_session_id uuid,p_operation_id uuid,p_revision bigint,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;r ops.guest_commands%ROWTYPE;
BEGIN
 SELECT * INTO STRICT g FROM ops.guest_sessions WHERE id=p_session_id;
 IF p_operation_id IS NULL OR p_revision IS NULL OR p_revision<0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COMMAND';END IF;
 SELECT * INTO r FROM ops.guest_commands WHERE session_id=g.id AND operation_id=p_operation_id;
 IF FOUND THEN
 IF r.kind<>p_kind OR r.request_payload IS DISTINCT FROM p_payload THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
 IF r.kind='cart' THEN
 -- Cached pre-upgrade responses must not reveal other visitors' drafts or totals.
 RETURN r.response_body||jsonb_build_object('lines',coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(r.response_body->'lines') v WHERE v->>'isMine'='true'),'[]'::jsonb),'totalMinor',r.response_body->>'ownTotalMinor','billMinor',r.response_body->>'ownBillMinor');
 END IF;
 RETURN r.response_body;END IF;
 IF p_kind='order' AND (SELECT count(*) FROM ops.orders WHERE guest_session_id=g.id AND status='submitted')>=2 THEN
 RAISE SQLSTATE 'PT409' USING MESSAGE='ORDER_AWAITING_ACCEPTANCE';END IF;
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
CREATE OR REPLACE FUNCTION ops.guest_order_submit( p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid, p_expected_revision bigint,p_secret text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $fn$ DECLARE g ops.guest_sessions%ROWTYPE; request_payload jsonb; cached jsonb; result jsonb; line ops.cart_lines%ROWTYPE; product public.menu_items%ROWTYPE; order_row ops.orders%ROWTYPE; item ops.order_items%ROWTYPE; unit_minor bigint; total_minor bigint := 0; revision_value bigint; line_count bigint; unit_count bigint; line_no integer := 0; charge_count integer := 0; fingerprint text; output_lines jsonb := '[]'::jsonb; BEGIN g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret); request_payload := jsonb_build_object('expectedRevision',p_expected_revision::text); cached:=ops.guest_begin(g.id,p_operation_id,p_expected_revision,'order',request_payload); IF cached IS NOT NULL THEN RETURN cached; END IF; SELECT count(*),coalesce(sum(quantity),0) INTO line_count,unit_count FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id; IF line_count=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CART_EMPTY'; END IF; IF line_count>50 OR unit_count>50 THEN RAISE SQLSTATE 'PT422' USING MESSAGE='ORDER_LIMIT_EXCEEDED'; END IF;
FOR line IN SELECT * FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id LOOP
 total_minor:=total_minor+line.line_total_minor;
END LOOP;
IF total_minor>1000000::bigint THEN RAISE SQLSTATE 'PT422' USING MESSAGE='ORDER_LIMIT_EXCEEDED';END IF;
total_minor:=0; PERFORM p.id FROM public.menu_items p JOIN ops.cart_lines cl ON cl.product_source_id=p.source_id AND cl.branch_id=p.branch_id AND cl.business_id=p.business_id WHERE cl.business_id=p_business_id AND cl.branch_id=p_branch_id AND cl.check_id=p_check_id AND cl.guest_session_id=g.id ORDER BY p.id FOR SHARE OF p; fingerprint := encode(pg_catalog.sha256(convert_to(jsonb_build_object( 'guestSessionId',g.id,'businessId',p_business_id,'branchId',p_branch_id, 'checkId',p_check_id,'operationId',p_operation_id,'payload',request_payload )::text,'UTF8')),'hex'); BEGIN INSERT INTO ops.orders(business_id,branch_id,check_id,client_request_id, request_fingerprint,guest_session_id,status) VALUES(p_business_id,p_branch_id,p_check_id,p_operation_id,fingerprint,g.id,'draft') RETURNING * INTO order_row; EXCEPTION WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT'; END; FOR line IN SELECT * FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id ORDER BY id FOR UPDATE LOOP SELECT * INTO product FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND source_id=line.product_source_id; IF NOT FOUND OR product.available IS NOT TRUE OR product.price_approved IS NOT TRUE OR product.approved_price IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE'; END IF; IF NOT ops.option_valid(product.options,line.options_snapshot) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED'; END IF; unit_minor := ops.catalog_minor(product.approved_price::text); IF unit_minor<>line.unit_price_minor THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRICE_CHANGED', DETAIL=jsonb_build_object('productId',product.id, 'currentUnitPriceMinor',unit_minor::text)::text; END IF; line_no := line_no+1; INSERT INTO ops.order_items(business_id,branch_id,check_id,order_id,line_no, product_source_id,product_name_snapshot,options_snapshot,quantity, unit_price_minor,discount_minor) VALUES(p_business_id,p_branch_id,p_check_id,order_row.id,line_no, product.source_id,left(product.name||CASE WHEN line.options_snapshot<>'[]'::jsonb THEN ' · '||(line.options_snapshot->>0) ELSE '' END,250),line.options_snapshot,line.quantity,unit_minor,0::bigint) RETURNING * INTO item; INSERT INTO ops.bill_charges(business_id,branch_id,check_id,order_id, order_item_id,unit_no,kind,amount_minor,currency,status) SELECT p_business_id,p_branch_id,p_check_id,order_row.id,item.id,u.unit_no, 'item',item.unit_price_minor - (item.discount_minor / item.quantity::bigint) - CASE WHEN u.unit_no::bigint <= item.discount_minor % item.quantity::bigint THEN 1::bigint ELSE 0::bigint END, 'TRY','active' FROM generate_series(1,item.quantity) AS u(unit_no); total_minor := total_minor+item.net_minor; charge_count := charge_count+item.quantity; output_lines := output_lines || jsonb_build_array(jsonb_build_object( 'orderItemId',item.id,'productId',product.id,'productName',item.product_name_snapshot, 'quantity',item.quantity,'unitPriceMinor',item.unit_price_minor::text, 'discountMinor',item.discount_minor::text,'grossMinor',item.gross_minor::text, 'netMinor',item.net_minor::text )); END LOOP; DELETE FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id; UPDATE ops.orders SET status='submitted',submitted_at=clock_timestamp() WHERE id=order_row.id AND business_id=p_business_id AND branch_id=p_branch_id RETURNING * INTO order_row; SELECT revision INTO revision_value FROM ops.checks WHERE id=p_check_id; result := jsonb_build_object('checkId',p_check_id,'operationId',p_operation_id, 'orderId',order_row.id,'status','submitted','revision',revision_value::text, 'currency','TRY','totalMinor',total_minor::text,'chargeCount',charge_count, 'lines',output_lines); INSERT INTO ops.guest_commands(session_id,operation_id,kind,request_payload,response_body) VALUES(g.id,p_operation_id,'order',request_payload,result); RETURN result; EXCEPTION WHEN numeric_value_out_of_range THEN RAISE SQLSTATE 'PT422' USING MESSAGE='AMOUNT_LIMIT_EXCEEDED'; END; $fn$;
-- A rejected submission is retained with voided debts, never deleted or prepared.
CREATE FUNCTION ops.reject_submitted_order(p_business_id uuid,p_branch_id uuid,p_order_id uuid,p_note text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE o ops.orders%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','kitchen']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 300 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='REASON_REQUIRED';END IF;
 SELECT * INTO o FROM ops.orders WHERE id=p_order_id AND business_id=p_business_id AND branch_id=p_branch_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='ORDER_NOT_FOUND';END IF;
 PERFORM ops.lock_check(p_business_id,p_branch_id,o.check_id,NULL);
 SELECT * INTO o FROM ops.orders WHERE id=o.id FOR UPDATE;
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','kitchen']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 IF o.status='cancelled' AND EXISTS(SELECT 1 FROM ops.operator_events WHERE business_id=p_business_id AND branch_id=p_branch_id AND kind='order-rejected' AND details->>'orderId'=o.id::text) THEN RETURN jsonb_build_object('status','cancelled','replayed',true);END IF;
 IF o.status<>'submitted' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ORDER_NOT_PENDING';END IF;
 IF EXISTS(SELECT 1 FROM ops.checkout_plans WHERE check_id=o.check_id AND status<>'cancelled') OR EXISTS(SELECT 1 FROM ops.payment_intents WHERE check_id=o.check_id AND status NOT IN('failed','cancelled')) OR EXISTS(SELECT 1 FROM ops.counter_receipts WHERE check_id=o.check_id) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='REFUND_OR_SERVICE_REVIEW_REQUIRED';END IF;
 UPDATE ops.bill_charges SET status='voided',voided_at=clock_timestamp(),void_reason=btrim(p_note) WHERE order_id=o.id AND business_id=p_business_id AND branch_id=p_branch_id AND status='active';
 UPDATE ops.orders SET status='cancelled' WHERE id=o.id;
 UPDATE ops.order_change_requests SET state='approved',decision_note=btrim(p_note),decided_by=auth.uid(),decided_at=clock_timestamp() WHERE order_id=o.id AND state='pending';
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'order-rejected',jsonb_build_object('orderId',o.id,'reason',btrim(p_note)));
 RETURN jsonb_build_object('status','cancelled','replayed',false);
END;$$;
-- Close empty or entirely rejected/cancelled visits, preserving every historical row.
CREATE OR REPLACE FUNCTION ops.close_empty_check(p_business_id uuid,p_branch_id uuid,p_check_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE c ops.checks%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='FLOOR_STAFF_REQUIRED';END IF;
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 IF c.status IN('cancelled','closed') THEN RETURN jsonb_build_object('status',c.status);END IF;
 IF EXISTS(SELECT 1 FROM ops.cart_lines WHERE check_id=c.id)
 OR EXISTS(SELECT 1 FROM ops.orders WHERE check_id=c.id AND status<>'cancelled')
 OR EXISTS(SELECT 1 FROM ops.bill_charges WHERE check_id=c.id AND status='active')
 OR EXISTS(SELECT 1 FROM ops.payment_intents WHERE check_id=c.id)
 OR EXISTS(SELECT 1 FROM ops.checkout_plans WHERE check_id=c.id)
 OR EXISTS(SELECT 1 FROM ops.counter_receipts WHERE check_id=c.id)
 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_EMPTY';END IF;
 UPDATE ops.checks SET status='cancelled',closed_at=clock_timestamp() WHERE id=c.id;
 UPDATE ops.guest_sessions SET revoked_at=clock_timestamp(),channel_id=gen_random_uuid() WHERE check_id=c.id AND revoked_at IS NULL;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'empty-table-closed',jsonb_build_object('checkId',c.id,'historyPreserved',true));
 RETURN jsonb_build_object('status','cancelled');
END;$$;

REVOKE ALL ON FUNCTION ops.table_ordering_policy(uuid,uuid,text),ops.table_guest_status(uuid,uuid,uuid,text),ops.table_guest_join(uuid,uuid,uuid,text),ops.reject_submitted_order(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.table_guest_status(uuid,uuid,uuid,text),ops.table_guest_join(uuid,uuid,uuid,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.table_ordering_policy(uuid,uuid,text),ops.reject_submitted_order(uuid,uuid,uuid,text) TO authenticated;
COMMIT;
