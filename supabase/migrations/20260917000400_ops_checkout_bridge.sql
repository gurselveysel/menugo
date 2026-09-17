BEGIN;
CREATE TABLE ops.integration_features (
 business_id uuid NOT NULL,branch_id uuid NOT NULL,
 payments_enabled boolean NOT NULL DEFAULT false,loyalty_enabled boolean NOT NULL DEFAULT false,
 sms_enabled boolean NOT NULL DEFAULT false,daas_enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(business_id,branch_id),FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);
CREATE TABLE ops.checkout_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,
 operation_id uuid NOT NULL,request_body jsonb NOT NULL,created_by uuid NOT NULL REFERENCES auth.users(id),
 mode text NOT NULL CHECK(mode IN('equal','items')),status text NOT NULL DEFAULT 'active' CHECK(status IN('active','settled','cancelled')),
 total_minor bigint NOT NULL CHECK(total_minor>=0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,branch_id,check_id,id),UNIQUE(business_id,branch_id,operation_id),
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id));
CREATE UNIQUE INDEX one_active_plan ON ops.checkout_plans(business_id,branch_id,check_id) WHERE status='active';
CREATE TABLE ops.checkout_shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,plan_id uuid NOT NULL,
 payer_user_id uuid NOT NULL REFERENCES auth.users(id),sort_order integer NOT NULL,
 base_minor bigint NOT NULL CHECK(base_minor>=0),food_minor bigint NOT NULL CHECK(food_minor>=0 AND food_minor<=base_minor),
 UNIQUE(business_id,branch_id,check_id,id),UNIQUE(plan_id,payer_user_id),
 FOREIGN KEY(business_id,branch_id,check_id,plan_id) REFERENCES ops.checkout_plans(business_id,branch_id,check_id,id));
CREATE TABLE ops.charge_allocations (
 business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,share_id uuid NOT NULL,charge_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),PRIMARY KEY(share_id,charge_id),
 FOREIGN KEY(business_id,branch_id,check_id,share_id) REFERENCES ops.checkout_shares(business_id,branch_id,check_id,id),
 FOREIGN KEY(business_id,branch_id,check_id,charge_id) REFERENCES ops.bill_charges(business_id,branch_id,check_id,id));
CREATE TABLE ops.payment_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,share_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES auth.users(id),operation_id uuid NOT NULL,tip_bps integer NOT NULL CHECK(tip_bps IN(0,500,1000,1500)),
 currency text NOT NULL DEFAULT 'TRY' CHECK(currency='TRY'),base_minor bigint NOT NULL CHECK(base_minor>0),
 tip_minor bigint NOT NULL CHECK(tip_minor>=0),amount_minor bigint NOT NULL CHECK(amount_minor=base_minor+tip_minor),
 status text NOT NULL DEFAULT 'created' CHECK(status IN('created','initiating','pending','unknown','captured','failed','cancelled')),
 provider_ref text,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,branch_id,id),CONSTRAINT payment_intents_idempotency_key UNIQUE(business_id,actor_user_id,operation_id),
 FOREIGN KEY(business_id,branch_id,check_id,share_id) REFERENCES ops.checkout_shares(business_id,branch_id,check_id,id));
CREATE UNIQUE INDEX one_live_intent_per_share ON ops.payment_intents(business_id,share_id)
 WHERE status IN('created','initiating','pending','unknown','captured');
CREATE FUNCTION ops.checkout_snapshot(p_business_id uuid,p_branch_id uuid,p_check_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c ops.checks%ROWTYPE;x record;total bigint:=0;charges jsonb:='[]';shares jsonb:='[]';members jsonb;
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 FOR x IN SELECT b.*,i.product_name_snapshot AS name FROM ops.bill_charges b
 LEFT JOIN ops.order_items i ON i.id=b.order_item_id WHERE b.check_id=c.id AND b.business_id=p_business_id AND b.branch_id=p_branch_id AND b.status='active' ORDER BY b.created_at,b.id LOOP
 total:=total+x.amount_minor;charges:=charges||jsonb_build_array(jsonb_build_object('id',x.id,'name',coalesce(x.name,'Teslimat'),'unitNo',x.unit_no,'kind',x.kind,'amountMinor',x.amount_minor::text)); END LOOP;
 FOR x IN SELECT s.*,p.status AS plan_status FROM ops.checkout_shares s JOIN ops.checkout_plans p ON p.id=s.plan_id WHERE s.check_id=c.id AND p.status IN('active','settled') ORDER BY s.sort_order LOOP
 shares:=shares||jsonb_build_array(jsonb_build_object('id',x.id,'payerId',x.payer_user_id,'isMine',x.payer_user_id=auth.uid(),'baseMinor',x.base_minor::text,'foodMinor',x.food_minor::text,
 'paymentStatus',coalesce((SELECT pi.status FROM ops.payment_intents pi WHERE pi.share_id=x.id ORDER BY pi.created_at DESC LIMIT 1),'not_started')));END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'isMe',m.user_id=auth.uid()) ORDER BY m.joined_at,m.user_id),'[]') INTO members FROM ops.check_members m WHERE m.check_id=c.id AND m.active AND m.expires_at>now();
 RETURN jsonb_build_object('checkId',c.id,'revision',c.revision::text,'totalMinor',total::text,'charges',charges,'shares',shares,'members',members);
END;$$;
CREATE FUNCTION ops.prepare_split(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,p_expected_revision bigint,
 p_mode text,p_payers uuid[],p_assignments jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.checks%ROWTYPE;plan ops.checkout_plans%ROWTYPE;req jsonb;total bigint:=0;r record;i integer;cnt integer;share_ids uuid[]:=ARRAY[]::uuid[];
 targets bigint[]:=ARRAY[]::bigint[];left_charge bigint;portion bigint;pos integer:=1;food bigint;sid uuid;existing uuid;
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier','waiter']) AND c.opened_by_user_id IS DISTINCT FROM auth.uid() THEN RAISE SQLSTATE 'PT403' USING MESSAGE='TABLE_HOST_REQUIRED';END IF;
 req:=jsonb_build_object('mode',p_mode,'payers',p_payers,'assignments',p_assignments,'revision',p_expected_revision::text);
 SELECT * INTO plan FROM ops.checkout_plans WHERE business_id=p_business_id AND branch_id=p_branch_id AND operation_id=p_operation_id;
 IF FOUND THEN IF plan.check_id<>c.id OR plan.request_body<>req OR plan.created_by<>auth.uid() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;RETURN ops.checkout_snapshot(p_business_id,p_branch_id,c.id);END IF;
 PERFORM ops.lock_check(p_business_id,p_branch_id,p_check_id,p_expected_revision);
 IF c.status<>'open' OR EXISTS(SELECT 1 FROM ops.cart_lines WHERE check_id=c.id) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='SUBMIT_CART_FIRST';END IF;
 IF EXISTS(SELECT 1 FROM ops.checkout_plans WHERE check_id=c.id AND status<>'cancelled') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECKOUT_ALREADY_PLANNED';END IF;
 cnt:=coalesce(array_length(p_payers,1),0);
 IF cnt<1 OR cnt>16 OR cnt<>(SELECT count(DISTINCT u) FROM unnest(p_payers) u) OR p_mode NOT IN('equal','items') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_SPLIT';END IF;
 FOREACH existing IN ARRAY p_payers LOOP
 IF NOT EXISTS(SELECT 1 FROM ops.check_members m WHERE m.check_id=c.id AND m.user_id=existing AND m.active AND m.expires_at>now()) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PAYER_NOT_AT_TABLE';END IF;END LOOP;
 FOR r IN SELECT * FROM ops.bill_charges WHERE check_id=c.id AND status='active' ORDER BY id FOR UPDATE LOOP total:=total+r.amount_minor;END LOOP;
 IF total<=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='NO_PAYABLE_CHARGES';END IF;
 INSERT INTO ops.checkout_plans(business_id,branch_id,check_id,operation_id,request_body,created_by,mode,total_minor)
 VALUES(p_business_id,p_branch_id,c.id,p_operation_id,req,auth.uid(),p_mode,total) RETURNING * INTO plan;
 FOR i IN 1..cnt LOOP
 INSERT INTO ops.checkout_shares(business_id,branch_id,check_id,plan_id,payer_user_id,sort_order,base_minor,food_minor)
 VALUES(p_business_id,p_branch_id,c.id,plan.id,p_payers[i],i,0,0) RETURNING id INTO sid;
 share_ids:=array_append(share_ids,sid); targets:=array_append(targets,total/cnt::bigint+CASE WHEN i::bigint<=total%cnt::bigint THEN 1 ELSE 0 END);END LOOP;
 FOR r IN SELECT * FROM ops.bill_charges WHERE check_id=c.id AND status='active' ORDER BY id LOOP
 left_charge:=r.amount_minor;
 IF p_mode='items' THEN
 IF NOT (p_assignments ? r.id::text) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='UNASSIGNED_CHARGE';END IF;
 pos:=array_position(p_payers,(p_assignments->>r.id::text)::uuid);
 IF pos IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PAYER';END IF;
 IF left_charge>0 THEN INSERT INTO ops.charge_allocations VALUES(p_business_id,p_branch_id,c.id,share_ids[pos],r.id,left_charge);END IF;
 ELSE
 WHILE left_charge>0 LOOP
 WHILE pos<=cnt AND targets[pos]=0 LOOP pos:=pos+1;END LOOP;
 IF pos>cnt THEN RAISE EXCEPTION 'ALLOCATION_OVERFLOW';END IF;
 portion:=least(targets[pos],left_charge);
 INSERT INTO ops.charge_allocations VALUES(p_business_id,p_branch_id,c.id,share_ids[pos],r.id,portion);
 targets[pos]:=targets[pos]-portion;left_charge:=left_charge-portion;END LOOP;END IF;END LOOP;
 FOR i IN 1..cnt LOOP total:=0;food:=0;
 FOR r IN SELECT a.amount_minor,b.kind FROM ops.charge_allocations a JOIN ops.bill_charges b ON b.id=a.charge_id WHERE a.share_id=share_ids[i] LOOP
 total:=total+r.amount_minor;IF r.kind='item' THEN food:=food+r.amount_minor;END IF;END LOOP;
 UPDATE ops.checkout_shares SET base_minor=total,food_minor=food WHERE id=share_ids[i];END LOOP;
 UPDATE ops.checks SET status='checkout' WHERE id=c.id;
 RETURN ops.checkout_snapshot(p_business_id,p_branch_id,c.id);
END;$$;
CREATE FUNCTION ops.reserve_payment(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_share_id uuid,p_operation_id uuid,p_tip_bps integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s ops.checkout_shares%ROWTYPE;p ops.payment_intents%ROWTYPE;tip bigint;amount bigint;payid uuid:=gen_random_uuid();payload jsonb;
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 PERFORM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 SELECT * INTO s FROM ops.checkout_shares WHERE id=p_share_id AND business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id FOR UPDATE;
 IF NOT FOUND OR s.payer_user_id<>auth.uid() THEN RAISE SQLSTATE 'PT404' USING MESSAGE='SHARE_NOT_FOUND';END IF;
 SELECT * INTO p FROM ops.payment_intents WHERE business_id=p_business_id AND actor_user_id=auth.uid() AND operation_id=p_operation_id;
 IF FOUND THEN IF p.share_id<>s.id OR p.tip_bps<>p_tip_bps THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;RETURN p.payload;END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.integration_features WHERE business_id=p_business_id AND branch_id=p_branch_id AND payments_enabled) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PAYMENT_PROVIDER_NOT_CONFIGURED';END IF;
 IF EXISTS(SELECT 1 FROM ops.payment_intents WHERE share_id=s.id AND status IN('created','initiating','pending','unknown','captured')) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LIVE_INTENT_EXISTS';END IF;
 IF p_tip_bps NOT IN(0,500,1000,1500) OR s.base_minor<=0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PAYMENT';END IF;
 tip:=(s.base_minor/10000::bigint)*p_tip_bps::bigint+((s.base_minor%10000::bigint)*p_tip_bps::bigint+5000::bigint)/10000::bigint;
 amount:=s.base_minor+tip;
 payload:=jsonb_build_object('paymentId',payid,'checkId',p_check_id,'currency','TRY','baseMinor',s.base_minor::text,'tipMinor',tip::text,'amountMinor',amount::text,
 'lines',jsonb_build_array(jsonb_build_object('name','Adisyon payı','amountMinor',s.base_minor::text))||CASE WHEN tip>0 THEN jsonb_build_array(jsonb_build_object('name','Gönüllü bahşiş','amountMinor',tip::text)) ELSE '[]'::jsonb END);
 INSERT INTO ops.payment_intents(id,business_id,branch_id,check_id,share_id,actor_user_id,operation_id,tip_bps,base_minor,tip_minor,amount_minor,payload)
 VALUES(payid,p_business_id,p_branch_id,p_check_id,s.id,auth.uid(),p_operation_id,p_tip_bps,s.base_minor,tip,amount,payload);
 RETURN payload;
END;$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['integration_features','checkout_plans','checkout_shares','charge_allocations','payment_intents'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ops.%I TO service_role',t);END LOOP;END;$$;
REVOKE ALL ON FUNCTION ops.checkout_snapshot(uuid,uuid,uuid),ops.prepare_split(uuid,uuid,uuid,uuid,bigint,text,uuid[],jsonb),ops.reserve_payment(uuid,uuid,uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.checkout_snapshot(uuid,uuid,uuid),ops.prepare_split(uuid,uuid,uuid,uuid,bigint,text,uuid[],jsonb),ops.reserve_payment(uuid,uuid,uuid,uuid,uuid,integer) TO authenticated;
COMMIT;
