-- CRM evaluation is separate from external SMS dispatch. New campaigns start in dry_run.
BEGIN;
CREATE TABLE ops.crm_consent_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,customer_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel='sms'),decision text NOT NULL CHECK(decision IN('granted','revoked','denied')),
 text_version text NOT NULL CHECK(length(text_version) BETWEEN 1 AND 150),evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 250),
 actor_user_id uuid REFERENCES auth.users(id),source text NOT NULL CHECK(source IN('customer','iys','staff_evidence')),
 sequence bigint GENERATED ALWAYS AS IDENTITY,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(business_id,branch_id,customer_id,id),FOREIGN KEY(business_id,branch_id,customer_id) REFERENCES ops.customers(business_id,branch_id,id));
CREATE INDEX crm_consent_latest ON ops.crm_consent_events(business_id,branch_id,customer_id,sequence DESC);
CREATE TABLE ops.crm_iys_permissions (
 business_id uuid NOT NULL,branch_id uuid NOT NULL,customer_id uuid NOT NULL,
 brand_ref text NOT NULL,decision text NOT NULL CHECK(decision IN('granted','revoked','unknown')),
 verified_at timestamptz NOT NULL,evidence_ref text NOT NULL,version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(business_id,branch_id,customer_id),FOREIGN KEY(business_id,branch_id,customer_id) REFERENCES ops.customers(business_id,branch_id,id));
CREATE TABLE ops.crm_purchase_facts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,customer_id uuid NOT NULL,check_id uuid NOT NULL,
 payment_id uuid NOT NULL UNIQUE,completed_at timestamptz NOT NULL,net_food_minor bigint NOT NULL CHECK(net_food_minor>0),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(business_id,branch_id,customer_id,id),
 FOREIGN KEY(business_id,branch_id,customer_id) REFERENCES ops.customers(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id,payment_id) REFERENCES ops.payment_intents(business_id,branch_id,id));
CREATE INDEX crm_last_purchase ON ops.crm_purchase_facts(business_id,branch_id,customer_id,completed_at DESC,id);
CREATE TABLE ops.crm_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,
 name text NOT NULL DEFAULT '21 Gün Geri Kazanım',mode text NOT NULL DEFAULT 'dry_run' CHECK(mode IN('disabled','dry_run','live')),
 inactivity_days integer NOT NULL DEFAULT 21 CHECK(inactivity_days BETWEEN 7 AND 365),cooldown_days integer NOT NULL DEFAULT 30 CHECK(cooldown_days BETWEEN 7 AND 365),
 discount_bps bigint NOT NULL DEFAULT 1000 CHECK(discount_bps BETWEEN 0 AND 5000),discount_cap_minor bigint NOT NULL DEFAULT 10000 CHECK(discount_cap_minor>=0),
 starts_hour integer NOT NULL DEFAULT 10 CHECK(starts_hour BETWEEN 0 AND 23),ends_hour integer NOT NULL DEFAULT 20 CHECK(ends_hour BETWEEN 1 AND 24 AND ends_hour>starts_hour),
 template text NOT NULL DEFAULT '{brand}: Sizi özledik. Size özel fırsatı menümüzde keşfedin. {link} İleti tercihi: {optout}',
 template_approved boolean NOT NULL DEFAULT false,sender_ref text,iys_brand_ref text,provider_account_ref text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK(mode<>'live' OR (template_approved AND sender_ref IS NOT NULL AND iys_brand_ref IS NOT NULL AND provider_account_ref IS NOT NULL AND template LIKE '%{optout}%')));
CREATE TABLE ops.crm_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,customer_id uuid NOT NULL,campaign_id uuid NOT NULL,purchase_id uuid NOT NULL,
 consent_id uuid NOT NULL,consent_version bigint NOT NULL,iys_version bigint NOT NULL,
 state text NOT NULL CHECK(state IN('dry_run','queued','leased','sending','accepted','delivered','unknown','suppressed','failed')),
 idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,
 reason text,provider_ref text,requested_at timestamptz,accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,customer_id,purchase_id),UNIQUE(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id,customer_id,purchase_id) REFERENCES ops.crm_purchase_facts(business_id,branch_id,customer_id,id),
 FOREIGN KEY(business_id,branch_id,campaign_id) REFERENCES ops.crm_campaigns(business_id,branch_id,id),
 FOREIGN KEY(business_id,branch_id,customer_id,consent_id) REFERENCES ops.crm_consent_events(business_id,branch_id,customer_id,id));
CREATE INDEX crm_outbox_queue ON ops.crm_outbox(state,created_at);
CREATE TABLE ops.crm_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,queued integer NOT NULL DEFAULT 0,dry_run integer NOT NULL DEFAULT 0,suppressed integer NOT NULL DEFAULT 0);
CREATE FUNCTION ops.crm_no_change() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN RAISE EXCEPTION 'CRM_EVIDENCE_APPEND_ONLY';END;$$;
CREATE TRIGGER immutable_consent BEFORE UPDATE OR DELETE ON ops.crm_consent_events FOR EACH ROW EXECUTE FUNCTION ops.crm_no_change();
CREATE TRIGGER immutable_purchase BEFORE UPDATE OR DELETE ON ops.crm_purchase_facts FOR EACH ROW EXECUTE FUNCTION ops.crm_no_change();
CREATE FUNCTION ops.crm_guard_purchase() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE p ops.payment_intents%ROWTYPE;s ops.checkout_shares%ROWTYPE;u uuid;
BEGIN
 PERFORM ops.lock_check(NEW.business_id,NEW.branch_id,NEW.check_id,NULL);
 SELECT * INTO p FROM ops.payment_intents WHERE id=NEW.payment_id AND business_id=NEW.business_id AND branch_id=NEW.branch_id AND check_id=NEW.check_id FOR SHARE;
 SELECT * INTO s FROM ops.checkout_shares WHERE id=p.share_id;
 SELECT auth_user_id INTO u FROM ops.customers WHERE id=NEW.customer_id AND business_id=NEW.business_id AND branch_id=NEW.branch_id;
 IF u IS NULL OR s.id IS NULL OR p.status IS DISTINCT FROM 'captured' OR s.payer_user_id IS DISTINCT FROM u OR NEW.net_food_minor>s.food_minor OR NEW.completed_at>clock_timestamp()
 OR EXISTS(SELECT 1 FROM ops.orders WHERE check_id=NEW.check_id AND status NOT IN('completed','cancelled'))
 THEN RAISE EXCEPTION 'VERIFIED_COMPLETED_PAYMENT_REQUIRED';END IF;RETURN NEW;
END;$$;
CREATE TRIGGER verify_purchase BEFORE INSERT ON ops.crm_purchase_facts FOR EACH ROW EXECUTE FUNCTION ops.crm_guard_purchase();
CREATE FUNCTION ops.crm_permission(p_business uuid,p_branch uuid,p_customer uuid,p_brand text)
RETURNS TABLE(consent_id uuid,consent_version bigint,iys_version bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT e.id,e.sequence,i.version FROM ops.customers c
 JOIN LATERAL(SELECT * FROM ops.crm_consent_events e WHERE e.business_id=c.business_id AND e.branch_id=c.branch_id AND e.customer_id=c.id ORDER BY sequence DESC LIMIT 1)e ON true
 JOIN ops.crm_iys_permissions i ON i.business_id=c.business_id AND i.branch_id=c.branch_id AND i.customer_id=c.id
 WHERE c.business_id=p_business AND c.branch_id=p_branch AND c.id=p_customer AND c.phone_verified_at IS NOT NULL AND c.auth_user_id IS NOT NULL
 AND e.decision='granted' AND i.decision='granted' AND i.verified_at>=now()-interval '24 hours' AND i.verified_at<=now() AND i.brand_ref=p_brand;
$$;
CREATE FUNCTION ops.crm_enqueue() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' SET statement_timeout='20s' AS $$
DECLARE runid uuid;cp record;r record;perm record;n integer;v_queued integer:=0;dry integer:=0;supp integer:=0;
BEGIN
 -- Serialize audience evaluation; this function NEVER calls a network service.
 IF NOT pg_try_advisory_xact_lock(8391280712::bigint) THEN RETURN jsonb_build_object('busy',true);END IF;
 INSERT INTO ops.crm_runs DEFAULT VALUES RETURNING id INTO runid;
 FOR cp IN SELECT c.*,s.timezone,f.sms_enabled FROM ops.crm_campaigns c JOIN ops.branch_settings s USING(business_id,branch_id)
 JOIN ops.integration_features f USING(business_id,branch_id) WHERE mode IN('dry_run','live') ORDER BY c.id LOOP
 FOR r IN SELECT c.id AS customer_id,p.id AS purchase_id,p.completed_at FROM ops.customers c
 JOIN LATERAL(SELECT * FROM ops.crm_purchase_facts p WHERE p.business_id=c.business_id AND p.branch_id=c.branch_id AND p.customer_id=c.id ORDER BY completed_at DESC,id DESC LIMIT 1)p ON true
 WHERE c.business_id=cp.business_id AND c.branch_id=cp.branch_id
 AND p.completed_at<=now()-make_interval(days=>cp.inactivity_days)
 AND NOT EXISTS(SELECT 1 FROM ops.crm_outbox q WHERE q.campaign_id=cp.id AND q.customer_id=c.id AND q.purchase_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM ops.crm_outbox q WHERE q.business_id=c.business_id AND q.customer_id=c.id AND q.state IN('queued','leased','sending','unknown'))
 AND NOT EXISTS(SELECT 1 FROM ops.crm_outbox q WHERE q.business_id=c.business_id AND q.customer_id=c.id AND q.state IN('accepted','delivered') AND q.accepted_at>now()-make_interval(days=>cp.cooldown_days))
 ORDER BY p.completed_at,c.id LIMIT 500 LOOP
 SELECT * INTO perm FROM ops.crm_permission(cp.business_id,cp.branch_id,r.customer_id,coalesce(cp.iys_brand_ref,''));
 IF NOT FOUND THEN CONTINUE; END IF;
 IF cp.mode='live' AND (NOT cp.sms_enabled OR extract(hour FROM timezone(cp.timezone,now()))<cp.starts_hour OR extract(hour FROM timezone(cp.timezone,now()))>=cp.ends_hour) THEN CONTINUE;END IF;
 INSERT INTO ops.crm_outbox(business_id,branch_id,customer_id,campaign_id,purchase_id,consent_id,consent_version,iys_version,state)
 VALUES(cp.business_id,cp.branch_id,r.customer_id,cp.id,r.purchase_id,perm.consent_id,perm.consent_version,perm.iys_version,CASE WHEN cp.mode='dry_run' THEN 'dry_run' ELSE 'queued' END) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;IF cp.mode='dry_run' THEN dry:=dry+n;ELSE v_queued:=v_queued+n;END IF;
 END LOOP;END LOOP;
 UPDATE ops.crm_outbox q SET state='suppressed',reason='PERMISSION_OR_ACTIVITY_CHANGED',updated_at=clock_timestamp()
 FROM ops.crm_campaigns c WHERE q.campaign_id=c.id AND q.state IN('queued','leased') AND (
 c.mode<>'live' OR NOT EXISTS(SELECT 1 FROM ops.crm_permission(q.business_id,q.branch_id,q.customer_id,coalesce(c.iys_brand_ref,'')) p WHERE p.consent_id=q.consent_id AND p.iys_version=q.iys_version)
 OR q.purchase_id IS DISTINCT FROM(SELECT id FROM ops.crm_purchase_facts p WHERE p.business_id=q.business_id AND p.branch_id=q.branch_id AND p.customer_id=q.customer_id ORDER BY completed_at DESC,id DESC LIMIT 1));
 GET DIAGNOSTICS supp=ROW_COUNT;
 -- A send with an expired worker lease is uncertain, never automatically resent.
 UPDATE ops.crm_outbox SET state='unknown',reason='WORKER_LEASE_EXPIRED',updated_at=clock_timestamp() WHERE state='sending' AND lease_until<=clock_timestamp();
 UPDATE ops.crm_runs SET finished_at=clock_timestamp(),queued=v_queued,dry_run=dry,suppressed=supp WHERE id=runid;
 RETURN jsonb_build_object('runId',runid,'queued',v_queued,'dryRun',dry,'suppressed',supp,'smsSent',0);
END;$$;
CREATE FUNCTION ops.crm_set_consent(p_business_id uuid,p_branch_id uuid,p_customer_id uuid,p_decision text,p_text_version text,p_evidence_ref text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c ops.customers%ROWTYPE;
BEGIN
 SELECT * INTO c FROM ops.customers WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_customer_id FOR UPDATE;
 IF c.auth_user_id IS DISTINCT FROM auth.uid() OR auth.uid() IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='CUSTOMER_NOT_FOUND';END IF;
 IF p_decision NOT IN('granted','revoked','denied') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_CONSENT';END IF;
 -- Grant requires verified phone and approved legal text; a browser cannot claim OTP success.
 IF p_decision='granted' AND (c.phone_verified_at IS NULL OR c.privacy_notice_version IS NULL OR p_text_version IS DISTINCT FROM c.sms_marketing_text_version) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='VERIFIED_CONSENT_FLOW_REQUIRED';END IF;
 INSERT INTO ops.crm_consent_events(business_id,branch_id,customer_id,channel,decision,text_version,evidence_ref,actor_user_id,source)
 VALUES(p_business_id,p_branch_id,c.id,'sms',p_decision,p_text_version,p_evidence_ref,auth.uid(),'customer');
 IF p_decision<>'granted' THEN UPDATE ops.crm_outbox SET state='suppressed',reason='CUSTOMER_OPTED_OUT' WHERE customer_id=c.id AND state IN('queued','leased');END IF;
END;$$;
-- Called by a server worker after external IYS refresh; all final gates are repeated.
CREATE FUNCTION ops.crm_prepare_send(p_id uuid,p_lease_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE q ops.crm_outbox%ROWTYPE;c ops.crm_campaigns%ROWTYPE;contact ops.customers%ROWTYPE;p record;tz text;
BEGIN
 SELECT * INTO q FROM ops.crm_outbox WHERE id=p_id;
 IF q.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO contact FROM ops.customers WHERE id=q.customer_id AND business_id=q.business_id AND branch_id=q.branch_id FOR UPDATE;
 SELECT * INTO q FROM ops.crm_outbox WHERE id=p_id FOR UPDATE;
 IF q.state<>'leased' OR q.lease_token IS DISTINCT FROM p_lease_token OR q.lease_until<=clock_timestamp() THEN RETURN NULL;END IF;
 SELECT * INTO c FROM ops.crm_campaigns WHERE id=q.campaign_id FOR SHARE;
 SELECT timezone INTO tz FROM ops.branch_settings WHERE business_id=q.business_id AND branch_id=q.branch_id;
 SELECT * INTO p FROM ops.crm_permission(q.business_id,q.branch_id,q.customer_id,coalesce(c.iys_brand_ref,''));
 IF p.consent_id IS NULL OR p.consent_id<>q.consent_id OR p.iys_version<>q.iys_version OR c.mode<>'live'
 OR NOT EXISTS(SELECT 1 FROM ops.integration_features f WHERE f.business_id=q.business_id AND f.branch_id=q.branch_id AND f.sms_enabled)
 OR q.purchase_id IS DISTINCT FROM(SELECT id FROM ops.crm_purchase_facts f WHERE f.customer_id=q.customer_id ORDER BY completed_at DESC,id DESC LIMIT 1)
 THEN UPDATE ops.crm_outbox SET state='suppressed',reason='PRE_SEND_GATE_FAILED' WHERE id=q.id;RETURN NULL;END IF;
 IF extract(hour FROM timezone(tz,now()))<c.starts_hour OR extract(hour FROM timezone(tz,now()))>=c.ends_hour THEN
 UPDATE ops.crm_outbox SET state='queued',lease_until=NULL,lease_token=NULL,reason='QUIET_HOURS' WHERE id=q.id;RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM ops.crm_outbox other WHERE other.id<>q.id AND other.customer_id=q.customer_id AND other.business_id=q.business_id
 AND (other.state IN('sending','unknown') OR (other.state IN('accepted','delivered') AND other.accepted_at>now()-make_interval(days=>c.cooldown_days)))) THEN
 UPDATE ops.crm_outbox SET state='suppressed',reason='CONTACT_COOLDOWN' WHERE id=q.id;RETURN NULL;END IF;
 UPDATE ops.crm_outbox SET state='sending',requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=q.id;
 RETURN jsonb_build_object('id',q.id,'idempotencyKey',q.idempotency_key,'phone',contact.phone_e164,'senderRef',c.sender_ref,'providerRef',c.provider_account_ref,'template',c.template,'customerId',q.customer_id,'businessId',q.business_id,'branchId',q.branch_id);
END;$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['crm_consent_events','crm_iys_permissions','crm_purchase_facts','crm_campaigns','crm_outbox','crm_runs'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ops.%I TO service_role',t);END LOOP;END;$$;
REVOKE UPDATE ON ops.crm_consent_events,ops.crm_purchase_facts FROM service_role;
REVOKE ALL ON FUNCTION ops.crm_no_change(),ops.crm_guard_purchase(),ops.crm_permission(uuid,uuid,uuid,text),ops.crm_enqueue(),ops.crm_set_consent(uuid,uuid,uuid,text,text,text),ops.crm_prepare_send(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.crm_set_consent(uuid,uuid,uuid,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.crm_enqueue(),ops.crm_prepare_send(uuid,uuid) TO service_role;
GRANT USAGE ON SEQUENCE ops.crm_consent_events_sequence_seq TO service_role;
COMMIT;
