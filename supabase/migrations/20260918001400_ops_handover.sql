-- Permanent table QR: public table identity is NOT an adisyon capability.
-- Staff checks a code displayed on the physically present guest's phone.
-- No public catalog/auth tables are changed. No tables or customers are seeded.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.table_access_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL, branch_id uuid NOT NULL, table_id uuid NOT NULL,
 secret_hash text NOT NULL UNIQUE CHECK(secret_hash ~ '^[0-9a-f]{64}$'),
 display_code text NOT NULL CHECK(display_code ~ '^[0-9]{4}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','approved','claimed','declined')),
 check_id uuid, guest_session_id uuid,
 decided_by uuid REFERENCES auth.users(id), decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 FOREIGN KEY(business_id,branch_id,table_id) REFERENCES ops.dining_tables(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id,check_id,guest_session_id) REFERENCES ops.guest_sessions(business_id,branch_id,check_id,id),
 CHECK((state='pending' AND decided_at IS NULL AND check_id IS NULL AND guest_session_id IS NULL)
    OR (state='declined' AND decided_at IS NOT NULL AND guest_session_id IS NULL)
    OR (state='approved' AND decided_at IS NOT NULL AND check_id IS NOT NULL AND guest_session_id IS NULL)
    OR (state='claimed' AND decided_at IS NOT NULL AND check_id IS NOT NULL AND guest_session_id IS NOT NULL))
);
CREATE INDEX table_access_pending ON ops.table_access_requests(business_id,branch_id,table_id,created_at) WHERE state='pending';
ALTER TABLE ops.table_access_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.table_access_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON ops.table_access_requests TO service_role;
CREATE POLICY no_direct_client_access ON ops.table_access_requests AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION ops.table_entry_info(p_business_id uuid,p_branch_id uuid,p_table_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE t ops.dining_tables%ROWTYPE;
BEGIN
 SELECT * INTO t FROM ops.dining_tables WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_table_id AND active;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='TABLE_NOT_FOUND';END IF;
 RETURN jsonb_build_object('tableId',t.id,'tableName',t.display_name,'enabled',EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=t.business_id AND branch_id=t.branch_id AND ordering_enabled AND dine_in_enabled));
END;$$;

CREATE FUNCTION ops.table_entry_request(p_business_id uuid,p_branch_id uuid,p_table_id uuid,p_secret text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE r ops.table_access_requests%ROWTYPE; h text; info jsonb;
BEGIN
 IF p_secret IS NULL OR p_secret !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_TABLE_INVITATION';END IF;
 info:=ops.table_entry_info(p_business_id,p_branch_id,p_table_id);
 IF NOT (info->>'enabled')::boolean THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ORDERING_DISABLED';END IF;
 h:=encode(sha256(convert_to(p_secret,'UTF8')),'hex');
 -- Serializes request count checks without exposing or locking an active adisyon.
 PERFORM pg_advisory_xact_lock(hashtextextended('menugo:entry:'||p_table_id::text,0));
 SELECT * INTO r FROM ops.table_access_requests WHERE secret_hash=h;
 IF FOUND THEN
  IF r.business_id<>p_business_id OR r.branch_id<>p_branch_id OR r.table_id<>p_table_id THEN RAISE SQLSTATE 'PT403' USING MESSAGE='TABLE_ACCESS_DENIED';END IF;
  RETURN jsonb_build_object('id',r.id,'state',CASE WHEN r.expires_at<=clock_timestamp() THEN 'expired' WHEN r.state='claimed' AND (NOT EXISTS(SELECT 1 FROM ops.checks c WHERE c.id=r.check_id AND c.status IN('open','checkout')) OR NOT EXISTS(SELECT 1 FROM ops.guest_sessions g WHERE g.id=r.guest_session_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp())) THEN 'finished' ELSE r.state END,'code',r.display_code,'expiresAt',r.expires_at);
 END IF;
 IF (SELECT count(*) FROM ops.table_access_requests WHERE table_id=p_table_id AND created_at>clock_timestamp()-interval '5 minutes')>=20
 OR (SELECT count(*) FROM ops.table_access_requests WHERE table_id=p_table_id AND state='pending' AND expires_at>clock_timestamp())>=16 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='RATE_LIMITED';END IF;
 INSERT INTO ops.table_access_requests(business_id,branch_id,table_id,secret_hash,display_code)
 VALUES(p_business_id,p_branch_id,p_table_id,h,lpad((floor(random()*10000)::integer)::text,4,'0')) RETURNING * INTO r;
 RETURN jsonb_build_object('id',r.id,'state',r.state,'code',r.display_code,'expiresAt',r.expires_at);
END;$$;

CREATE FUNCTION ops.table_entry_status(p_business_id uuid,p_branch_id uuid,p_table_id uuid,p_secret text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r ops.table_access_requests%ROWTYPE;
BEGIN
 IF p_secret IS NULL OR p_secret !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT401' USING MESSAGE='ENTRY_SESSION_REQUIRED';END IF;
 SELECT * INTO r FROM ops.table_access_requests WHERE business_id=p_business_id AND branch_id=p_branch_id AND table_id=p_table_id
  AND secret_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex');
 IF NOT FOUND THEN RETURN jsonb_build_object('state','idle');END IF;
 RETURN jsonb_build_object('id',r.id,'state',CASE WHEN r.expires_at<=clock_timestamp() THEN 'expired' WHEN r.state='claimed' AND (NOT EXISTS(SELECT 1 FROM ops.checks c WHERE c.id=r.check_id AND c.status IN('open','checkout')) OR NOT EXISTS(SELECT 1 FROM ops.guest_sessions g WHERE g.id=r.guest_session_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp())) THEN 'finished' ELSE r.state END,'code',r.display_code,'expiresAt',r.expires_at);
END;$$;

CREATE FUNCTION ops.table_entry_pending(p_business_id uuid,p_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='FLOOR_STAFF_REQUIRED';END IF;
 -- Display code and secrets are NOT returned to staff; staff reads guest's phone.
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'tableId',r.table_id,'tableName',t.display_name,'createdAt',r.created_at,'expiresAt',r.expires_at) ORDER BY r.created_at),'[]')
 FROM ops.table_access_requests r JOIN ops.dining_tables t ON t.id=r.table_id AND t.branch_id=r.branch_id AND t.business_id=r.business_id
 WHERE r.business_id=p_business_id AND r.branch_id=p_branch_id AND r.state='pending' AND r.expires_at>clock_timestamp());
END;$$;

CREATE FUNCTION ops.table_entry_decide(p_business_id uuid,p_branch_id uuid,p_request_id uuid,p_code text,p_approve boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE r ops.table_access_requests%ROWTYPE; c ops.checks%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='FLOOR_STAFF_REQUIRED';END IF;
 IF p_approve IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_INPUT';END IF;
 SELECT * INTO r FROM ops.table_access_requests WHERE id=p_request_id AND business_id=p_business_id AND branch_id=p_branch_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='ENTRY_NOT_FOUND';END IF;
 IF p_approve THEN
  SELECT * INTO c FROM ops.checks WHERE business_id=p_business_id AND branch_id=p_branch_id AND table_id=r.table_id AND status='open';
  IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='OPEN_TABLE_FIRST';END IF;
  PERFORM ops.lock_check(p_business_id,p_branch_id,c.id,NULL);
 END IF;
 SELECT * INTO r FROM ops.table_access_requests WHERE id=p_request_id AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='FLOOR_STAFF_REQUIRED';END IF;
 IF r.state<>'pending' THEN RETURN jsonb_build_object('state',r.state);END IF;
 IF r.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ENTRY_EXPIRED';END IF;
 IF p_approve AND (p_code IS NULL OR p_code !~ '^[0-9]{4}$' OR r.display_code<>p_code) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ENTRY_CODE_MISMATCH';END IF;
 IF p_approve AND (NOT EXISTS(SELECT 1 FROM ops.checks WHERE id=c.id AND status='open')
  OR NOT EXISTS(SELECT 1 FROM ops.dining_tables WHERE id=r.table_id AND active)
  OR NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id AND ordering_enabled AND dine_in_enabled)) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';END IF;
 UPDATE ops.table_access_requests SET state=CASE WHEN p_approve THEN 'approved' ELSE 'declined' END,
 check_id=CASE WHEN p_approve THEN c.id ELSE NULL END,decided_by=auth.uid(),decided_at=clock_timestamp(),
 expires_at=CASE WHEN p_approve THEN clock_timestamp()+interval '2 minutes' ELSE expires_at END WHERE id=r.id RETURNING * INTO r;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'table-entry-decision',jsonb_build_object('requestId',r.id,'approved',p_approve,'tableId',r.table_id));
 RETURN jsonb_build_object('state',r.state);
END;$$;

CREATE FUNCTION ops.table_entry_claim(p_business_id uuid,p_branch_id uuid,p_table_id uuid,p_secret text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE r ops.table_access_requests%ROWTYPE;g ops.guest_sessions%ROWTYPE;c ops.checks%ROWTYPE;n integer;h text;
BEGIN
 IF p_secret IS NULL OR p_secret !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT401' USING MESSAGE='ENTRY_SESSION_REQUIRED';END IF;
 h:=encode(sha256(convert_to(p_secret,'UTF8')),'hex');
 SELECT * INTO r FROM ops.table_access_requests WHERE secret_hash=h AND table_id=p_table_id AND business_id=p_business_id AND branch_id=p_branch_id;
 IF NOT FOUND OR r.state NOT IN('approved','claimed') OR r.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='ENTRY_NOT_APPROVED';END IF;
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,r.check_id,NULL);
 SELECT * INTO r FROM ops.table_access_requests WHERE id=r.id FOR UPDATE;
 IF r.state NOT IN('approved','claimed') OR r.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='ENTRY_NOT_APPROVED';END IF;
 IF r.state='claimed' THEN
  IF c.status NOT IN('open','checkout') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ENTRY_FINISHED';END IF;
  RETURN ops.guest_snapshot(p_business_id,p_branch_id,r.check_id,p_secret);
 END IF;
 IF c.status<>'open' OR NOT EXISTS(SELECT 1 FROM ops.dining_tables WHERE id=r.table_id AND active)
  OR NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id AND ordering_enabled AND dine_in_enabled)
  THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';END IF;
 SELECT coalesce(max(seat_no),0)+1 INTO n FROM ops.guest_sessions WHERE check_id=c.id;
 IF n>16 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='TABLE_GUEST_LIMIT';END IF;
 INSERT INTO ops.guest_sessions(business_id,branch_id,check_id,secret_hash,seat_no) VALUES(p_business_id,p_branch_id,c.id,h,n) RETURNING * INTO g;
 UPDATE ops.table_access_requests SET state='claimed',guest_session_id=g.id,expires_at=g.expires_at WHERE id=r.id;
 UPDATE ops.checks SET revision=revision+1 WHERE id=c.id;
 RETURN ops.guest_snapshot(p_business_id,p_branch_id,c.id,p_secret);
END;$$;

-- Safe empty-table closure. Never erases drafts, orders, debts or receipts.
CREATE FUNCTION ops.close_empty_check(p_business_id uuid,p_branch_id uuid,p_check_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE c ops.checks%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='FLOOR_STAFF_REQUIRED';END IF;
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 IF c.status IN('cancelled','closed') THEN RETURN jsonb_build_object('status',c.status);END IF;
 IF EXISTS(SELECT 1 FROM ops.cart_lines WHERE check_id=c.id) OR EXISTS(SELECT 1 FROM ops.orders WHERE check_id=c.id)
 OR EXISTS(SELECT 1 FROM ops.bill_charges WHERE check_id=c.id) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_EMPTY';END IF;
 UPDATE ops.checks SET status='cancelled',closed_at=clock_timestamp() WHERE id=c.id;
 UPDATE ops.guest_sessions SET revoked_at=clock_timestamp(),channel_id=gen_random_uuid() WHERE check_id=c.id AND revoked_at IS NULL;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'empty-table-closed',jsonb_build_object('checkId',c.id));
 RETURN jsonb_build_object('status','cancelled');
END;$$;

CREATE FUNCTION ops.handover_readiness(p_business_id uuid,p_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 RETURN jsonb_build_object('tableCount',(SELECT count(*) FROM ops.dining_tables WHERE business_id=p_business_id AND branch_id=p_branch_id AND active),
  'staffCount',(SELECT count(*) FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id AND active),
  'approvedProducts',(SELECT count(*) FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND price_approved AND approved_price IS NOT NULL AND available),
  'unpricedProducts',(SELECT count(*) FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND approved_price IS NULL),
  'orderingEnabled',(SELECT ordering_enabled AND dine_in_enabled FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id),
  'profile',ops.merchant_profile(p_business_id,p_branch_id));
END;$$;

REVOKE ALL ON FUNCTION ops.table_entry_info(uuid,uuid,uuid),ops.table_entry_request(uuid,uuid,uuid,text),ops.table_entry_status(uuid,uuid,uuid,text),ops.table_entry_claim(uuid,uuid,uuid,text),ops.table_entry_pending(uuid,uuid),ops.table_entry_decide(uuid,uuid,uuid,text,boolean),ops.close_empty_check(uuid,uuid,uuid),ops.handover_readiness(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.table_entry_info(uuid,uuid,uuid),ops.table_entry_request(uuid,uuid,uuid,text),ops.table_entry_status(uuid,uuid,uuid,text),ops.table_entry_claim(uuid,uuid,uuid,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.table_entry_pending(uuid,uuid),ops.table_entry_decide(uuid,uuid,uuid,text,boolean),ops.close_empty_check(uuid,uuid,uuid),ops.handover_readiness(uuid,uuid) TO authenticated;
COMMIT;
