-- MenüGO / DaaS: additive migration, depends on 20260917000100_ops_core.sql.
-- No public/auth table DDL or DML. Does NOT fabricate payment authorization.
-- Apply once to staging as schema owner; inspect existing schema before applying.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $preflight$
BEGIN
  IF to_regclass('ops.orders') IS NULL
     OR to_regclass('ops.branch_settings') IS NULL
     OR to_regprocedure('ops.lock_check(uuid,uuid,uuid,bigint)') IS NULL THEN
    RAISE EXCEPTION 'OPS_CORE_MIGRATION_REQUIRED';
  END IF;
  IF to_regclass('ops.delivery_jobs') IS NOT NULL
     OR to_regclass('ops.delivery_outbox') IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_SCHEMA_EXISTS_INSPECT_MIGRATION_HISTORY';
  END IF;
END;
$preflight$;

CREATE TABLE ops.delivery_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,40}$'),
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  remote_merchant_ref text NOT NULL CHECK (length(remote_merchant_ref) BETWEEN 1 AND 200),
  credentials_ref text NOT NULL CHECK (length(credentials_ref) BETWEEN 1 AND 300),
  enabled boolean NOT NULL DEFAULT false,
  accept_webhooks boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, id),
  UNIQUE (provider, environment, remote_merchant_ref),
  FOREIGN KEY (business_id, branch_id)
    REFERENCES ops.branch_settings(business_id, branch_id) ON DELETE RESTRICT
);

CREATE TABLE ops.delivery_jobs (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  check_id uuid NOT NULL,
  order_id uuid NOT NULL,
  routing text NOT NULL CHECK (routing IN ('own','daas')),
  account_id uuid,
  dispatch_key text NOT NULL UNIQUE CHECK (dispatch_key = 'menugo:' || id::text),
  -- AEAD envelope: no clear phone/address in queue or logs.
  request_envelope text NOT NULL CHECK (length(request_envelope) BETWEEN 20 AND 65536),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  currency text NOT NULL DEFAULT 'TRY' CHECK (currency = 'TRY'),
  delivery_fee_minor bigint NOT NULL CHECK (delivery_fee_minor >= 0),
  collect_on_delivery_minor bigint NOT NULL DEFAULT 0 CHECK (collect_on_delivery_minor >= 0),
  -- Written only by a trusted payment/address/polygon gate, never by an HTTP body.
  authorization_ref text NOT NULL CHECK (length(authorization_ref) BETWEEN 1 AND 250),
  authorization_expires_at timestamptz NOT NULL,
  authorization_revoked_at timestamptz,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','queued','requested','assigned','picked_up','delivered','cancelled','failed')),
  dispatch_state text NOT NULL DEFAULT 'idle'
    CHECK (dispatch_state IN ('idle','sending','unknown','confirmed','rejected','blocked')),
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 200),
  first_send_at timestamptz,
  replay_until timestamptz,
  last_provider_sequence bigint CHECK (last_provider_sequence >= 0),
  last_provider_at timestamptz,
  last_checked_at timestamptz,
  review_required boolean NOT NULL DEFAULT false,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, id),
  -- This release supports exactly one fulfillment job per order. No new ID on retry.
  UNIQUE (business_id, branch_id, order_id),
  UNIQUE (account_id, provider_ref),
  FOREIGN KEY (business_id, branch_id, check_id, order_id)
    REFERENCES ops.orders(business_id, branch_id, check_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, branch_id, account_id)
    REFERENCES ops.delivery_accounts(business_id, branch_id, id) ON DELETE RESTRICT,
  CHECK ((routing='daas' AND account_id IS NOT NULL) OR (routing='own' AND account_id IS NULL)),
  CHECK ((first_send_at IS NULL AND replay_until IS NULL) OR first_send_at IS NOT NULL),
  CHECK (replay_until IS NULL OR replay_until >= first_send_at)
);
CREATE INDEX delivery_jobs_attention ON ops.delivery_jobs(business_id,branch_id,updated_at)
  WHERE review_required;
CREATE INDEX delivery_jobs_active ON ops.delivery_jobs(business_id,branch_id,status)
  WHERE status NOT IN ('delivered','cancelled','failed');

CREATE TABLE ops.delivery_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dispatch','poll')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done','dead')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 2000),
  deadline_at timestamptz NOT NULL,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,branch_id,job_id,kind),
  FOREIGN KEY (business_id,branch_id,job_id)
    REFERENCES ops.delivery_jobs(business_id,branch_id,id) ON DELETE RESTRICT,
  CHECK ((state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state<>'leased' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX delivery_outbox_ready ON ops.delivery_outbox(available_at,created_at,id)
  WHERE state='pending';
CREATE INDEX delivery_outbox_expired ON ops.delivery_outbox(lease_until,id) WHERE state='leased';

CREATE TABLE ops.delivery_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  account_id uuid NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  -- Normalized, allowlisted fields only. No raw body / signature / recipient PII.
  event jsonb NOT NULL CHECK (jsonb_typeof(event)='object' AND octet_length(event::text)<=8192),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done','dead')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  max_attempts integer NOT NULL DEFAULT 24 CHECK (max_attempts BETWEEN 1 AND 2000),
  deadline_at timestamptz NOT NULL DEFAULT (now()+interval '6 hours'),
  last_error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id,event_id),
  FOREIGN KEY (business_id,branch_id,account_id)
    REFERENCES ops.delivery_accounts(business_id,branch_id,id) ON DELETE RESTRICT,
  CHECK ((state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state<>'leased' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX delivery_inbox_ready ON ops.delivery_webhook_inbox(available_at,received_at,id)
  WHERE state='pending';
CREATE INDEX delivery_inbox_expired ON ops.delivery_webhook_inbox(lease_until,id) WHERE state='leased';

CREATE TABLE ops.delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  job_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('order','receipt','webhook','poll','worker')),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 250),
  from_status text NOT NULL,
  to_status text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('applied','ignored','quarantined','review')),
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,source,source_key),
  FOREIGN KEY (business_id,branch_id,job_id)
    REFERENCES ops.delivery_jobs(business_id,branch_id,id) ON DELETE RESTRICT
);

CREATE TABLE ops.delivery_commands (
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  check_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  response_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_user_id,operation_id),
  FOREIGN KEY(business_id,branch_id,check_id,order_id)
    REFERENCES ops.orders(business_id,branch_id,check_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(business_id,branch_id)
    REFERENCES ops.branch_settings(business_id,branch_id) ON DELETE RESTRICT
);

-- Identity/routing/payload never change on an existing active request.
CREATE FUNCTION ops.daas_guard_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $fn$
DECLARE k text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'DELIVERY_HISTORY_DELETE_FORBIDDEN' USING ERRCODE='23514';
  END IF;
  FOREACH k IN ARRAY ARRAY['id','business_id','branch_id','check_id','order_id',
    'account_id','routing','dispatch_key','request_envelope','request_sha256',
    'currency','delivery_fee_minor','collect_on_delivery_minor','authorization_ref',
    'authorization_expires_at','provider','environment','remote_merchant_ref','created_at',
    'job_id','kind','event_id','event','raw_sha256','event_sha256','received_at'] LOOP
    IF (to_jsonb(NEW)->k) IS DISTINCT FROM (to_jsonb(OLD)->k) THEN
      RAISE EXCEPTION 'IMMUTABLE_DELIVERY_FIELD: %',k USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF TG_TABLE_NAME='delivery_jobs' THEN
    IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
      RAISE EXCEPTION 'PROVIDER_REF_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF OLD.first_send_at IS NOT NULL AND
       (NEW.first_send_at,NEW.replay_until) IS DISTINCT FROM (OLD.first_send_at,OLD.replay_until) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_WINDOW_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF OLD.status IN ('delivered','cancelled','failed') AND NEW.status<>OLD.status THEN
      RAISE EXCEPTION 'TERMINAL_DELIVERY_IMMUTABLE' USING ERRCODE='23514';
    END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER daas_account_guard BEFORE UPDATE OR DELETE ON ops.delivery_accounts
  FOR EACH ROW EXECUTE FUNCTION ops.daas_guard_identity();
CREATE TRIGGER daas_job_guard BEFORE UPDATE OR DELETE ON ops.delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION ops.daas_guard_identity();
CREATE TRIGGER daas_outbox_guard BEFORE UPDATE OR DELETE ON ops.delivery_outbox
  FOR EACH ROW EXECUTE FUNCTION ops.daas_guard_identity();
CREATE TRIGGER daas_inbox_guard BEFORE UPDATE OR DELETE ON ops.delivery_webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION ops.daas_guard_identity();

-- No network request in the trigger. Both rows commit/rollback with the order.
CREATE FUNCTION ops.daas_on_preparing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE c ops.checks%ROWTYPE; j ops.delivery_jobs%ROWTYPE; a ops.delivery_accounts%ROWTYPE;
BEGIN
  IF NEW.status<>'preparing' OR OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF OLD.status<>'accepted' THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='ORDER_NOT_ACCEPTED';
  END IF;
  SELECT * INTO c FROM ops.checks WHERE id=NEW.check_id
    AND business_id=NEW.business_id AND branch_id=NEW.branch_id;
  IF c.service_mode<>'delivery' THEN RETURN NEW; END IF;
  SELECT * INTO j FROM ops.delivery_jobs WHERE business_id=NEW.business_id
    AND branch_id=NEW.branch_id AND order_id=NEW.id FOR UPDATE;
  IF NOT FOUND OR j.status<>'waiting' THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='DELIVERY_PLAN_REQUIRED';
  END IF;
  IF j.authorization_revoked_at IS NOT NULL OR j.authorization_expires_at<=clock_timestamp() THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='FULFILLMENT_AUTHORIZATION_EXPIRED';
  END IF;
  IF j.routing='daas' THEN
    SELECT * INTO a FROM ops.delivery_accounts WHERE id=j.account_id FOR SHARE;
    IF a.enabled IS NOT TRUE THEN RAISE SQLSTATE 'PT409' USING MESSAGE='COURIER_DISABLED'; END IF;
  END IF;
  UPDATE ops.delivery_jobs SET status='queued' WHERE id=j.id;
  IF j.routing='daas' THEN
    INSERT INTO ops.delivery_outbox(business_id,branch_id,job_id,kind,max_attempts,deadline_at)
      VALUES(j.business_id,j.branch_id,j.id,'dispatch',12,clock_timestamp()+interval '30 minutes');
    INSERT INTO ops.delivery_outbox(business_id,branch_id,job_id,kind,max_attempts,available_at,deadline_at)
      VALUES(j.business_id,j.branch_id,j.id,'poll',360,
             clock_timestamp()+interval '60 seconds',clock_timestamp()+interval '6 hours');
  END IF;
  INSERT INTO ops.delivery_events(business_id,branch_id,job_id,source,source_key,
      from_status,to_status,decision,reason_code)
    VALUES(j.business_id,j.branch_id,j.id,'order','preparing','waiting','queued','applied','ORDER_PREPARING');
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER daas_after_order_preparing AFTER UPDATE OF status ON ops.orders
  FOR EACH ROW EXECUTE FUNCTION ops.daas_on_preparing();

-- Public staff command: one RPC = one transaction. Caller cannot choose tenant via payload alone.
CREATE FUNCTION ops.daas_start_preparing(
  p_business_id uuid,p_branch_id uuid,p_order_id uuid,
  p_operation_id uuid,p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path='' SET lock_timeout='2s' AS $fn$
DECLARE o ops.orders%ROWTYPE; c ops.checks%ROWTYPE; saved ops.delivery_commands%ROWTYPE;
  j ops.delivery_jobs%ROWTYPE; request jsonb; response jsonb; cfg ops.branch_settings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED'; END IF;
  IF p_business_id IS NULL OR p_branch_id IS NULL OR p_order_id IS NULL
     OR p_operation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COMMAND';
  END IF;
  IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier','waiter','kitchen']) THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='ORDER_NOT_FOUND';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':delivery:'||p_operation_id::text,0));
  SELECT * INTO o FROM ops.orders WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_order_id;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='ORDER_NOT_FOUND'; END IF;
  SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,o.check_id,NULL);
  SELECT * INTO o FROM ops.orders WHERE id=p_order_id FOR UPDATE;
  -- Lock current staff membership too, so concurrent revocation serializes.
  PERFORM 1 FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id
    AND user_id=auth.uid() AND active AND role IN ('owner','manager','cashier','waiter','kitchen') FOR SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='ORDER_NOT_FOUND'; END IF;
  request:=jsonb_build_object('orderId',p_order_id,'expectedRevision',p_expected_revision::text);
  SELECT * INTO saved FROM ops.delivery_commands WHERE actor_user_id=auth.uid() AND operation_id=p_operation_id;
  IF FOUND THEN
    IF (saved.business_id,saved.branch_id,saved.order_id,saved.request_payload)
       IS DISTINCT FROM (p_business_id,p_branch_id,p_order_id,request) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN saved.response_payload;
  END IF;
  IF c.revision<>p_expected_revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='REVISION_CONFLICT'; END IF;
  IF c.status='cancelled' OR o.status<>'accepted' THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='ORDER_NOT_ACCEPTED';
  END IF;
  SELECT * INTO cfg FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id FOR SHARE;
  IF cfg.ordering_enabled IS NOT TRUE OR
     (c.service_mode='delivery' AND cfg.delivery_enabled IS NOT TRUE) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='ORDERING_DISABLED';
  END IF;
  UPDATE ops.orders SET status='preparing' WHERE id=o.id;
  SELECT * INTO j FROM ops.delivery_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND order_id=o.id;
  SELECT * INTO c FROM ops.checks WHERE id=o.check_id;
  response:=jsonb_build_object('orderId',o.id,'status','preparing','revision',c.revision::text,
      'deliveryJobId',j.id,'deliveryState',j.status);
  INSERT INTO ops.delivery_commands(actor_user_id,operation_id,business_id,branch_id,order_id,check_id,
      request_payload,response_payload)
    VALUES(auth.uid(),p_operation_id,p_business_id,p_branch_id,p_order_id,o.check_id,request,response);
  RETURN response;
END;
$fn$;

DO $security$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['delivery_accounts','delivery_jobs','delivery_outbox',
    'delivery_webhook_inbox','delivery_events','delivery_commands'] LOOP
    EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE POLICY deny_client_insert ON ops.%I AS RESTRICTIVE FOR INSERT TO anon,authenticated WITH CHECK(false)',t);
    EXECUTE format('CREATE POLICY deny_client_update ON ops.%I AS RESTRICTIVE FOR UPDATE TO anon,authenticated USING(false) WITH CHECK(false)',t);
    EXECUTE format('CREATE POLICY deny_client_delete ON ops.%I AS RESTRICTIVE FOR DELETE TO anon,authenticated USING(false)',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ops.%I TO service_role',t);
  END LOOP;
END;
$security$;
REVOKE UPDATE ON ops.delivery_events,ops.delivery_commands FROM service_role;
-- Authenticated staff cannot SELECT encrypted recipient payload or secret refs.
GRANT SELECT(id,business_id,branch_id,check_id,order_id,routing,status,dispatch_state,
  provider_ref,review_required,review_reason,created_at,updated_at)
  ON ops.delivery_jobs TO authenticated;
CREATE POLICY delivery_jobs_staff_read ON ops.delivery_jobs FOR SELECT TO authenticated
  USING(ops.has_branch_role(business_id,branch_id));
GRANT SELECT ON ops.delivery_events TO authenticated;
CREATE POLICY delivery_events_staff_read ON ops.delivery_events FOR SELECT TO authenticated
  USING(ops.has_branch_role(business_id,branch_id));
REVOKE ALL ON FUNCTION ops.daas_guard_identity() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION ops.daas_on_preparing() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION ops.daas_start_preparing(uuid,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.daas_start_preparing(uuid,uuid,uuid,uuid,bigint) TO authenticated;
COMMENT ON TABLE ops.delivery_outbox IS 'Durable dispatch/poll queue. No PII. Leased with SKIP LOCKED; late completions fenced by lease_token.';
COMMENT ON TABLE ops.delivery_webhook_inbox IS 'Verified, normalized callbacks, persisted before ACK. Unique per account and provider event ID.';
COMMENT ON TABLE ops.delivery_jobs IS 'One fulfillment per order. External unknown is not cancellation. No automatic own-courier fallback.';
NOTIFY pgrst, 'reload schema';
COMMIT;
