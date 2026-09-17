-- MenüGO / Sprint 5: deterministic upsell and balanced transfer subledger.
-- Run AFTER 20260917000100_ops_core.sql, first in an isolated test DB.
-- No public/auth DDL or DML. No campaign, Cron, PSP, or production activation.
-- 1 point = 1 minor TRY unit; 100 points = TRY 1. All amounts are BIGINT.
-- A transfer row contains BOTH equal postings, not a single signed customer delta.
-- accounts has NO balance column. Available/held are derived from immutable transfers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('ops.customers') IS NULL OR to_regclass('ops.checks') IS NULL
     OR to_regclass('ops.branch_settings') IS NULL
     OR to_regclass('public.menu_items') IS NULL THEN
    RAISE EXCEPTION 'CORE_MIGRATION_REQUIRED';
  END IF;
  IF to_regclass('ops.loyalty_accounts') IS NOT NULL
     OR to_regclass('ops.loyalty_ledger') IS NOT NULL
     OR to_regclass('ops.upsell_rules') IS NOT NULL THEN
    RAISE EXCEPTION 'SPRINT5_TABLES_ALREADY_EXIST: reconcile migration history; do not drop them';
  END IF;
END;
$preflight$;

CREATE TABLE ops.upsell_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  target_product_source_id text NOT NULL,
  recommended_product_source_id text NOT NULL,
  weight_bps bigint NOT NULL DEFAULT 10000 CHECK (weight_bps BETWEEN 0 AND 10000),
  confidence_bps bigint NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  margin_score_bps bigint NOT NULL CHECK (margin_score_bps BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, target_product_source_id, recommended_product_source_id),
  FOREIGN KEY (business_id, branch_id) REFERENCES ops.branch_settings(business_id, branch_id),
  FOREIGN KEY (branch_id, target_product_source_id)
    REFERENCES public.menu_items(branch_id, source_id),
  FOREIGN KEY (branch_id, recommended_product_source_id)
    REFERENCES public.menu_items(branch_id, source_id),
  CHECK (target_product_source_id <> recommended_product_source_id),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX upsell_active_branch ON ops.upsell_rules(business_id, branch_id) WHERE active;
CREATE TRIGGER upsell_scope BEFORE UPDATE ON ops.upsell_rules
  FOR EACH ROW EXECUTE FUNCTION ops.guard_scope();
CREATE TRIGGER upsell_updated BEFORE UPDATE ON ops.upsell_rules
  FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

CREATE TABLE ops.loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customer','system')),
  customer_id uuid,
  currency text NOT NULL DEFAULT 'TRY' CHECK (currency='TRY'),
  earn_bps bigint NOT NULL DEFAULT 500 CHECK (earn_bps BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, id),
  FOREIGN KEY (business_id, branch_id) REFERENCES ops.branch_settings(business_id, branch_id),
  FOREIGN KEY (business_id, branch_id, customer_id)
    REFERENCES ops.customers(business_id, branch_id, id),
  CHECK ((kind='customer' AND customer_id IS NOT NULL)
      OR (kind='system' AND customer_id IS NULL))
);
CREATE UNIQUE INDEX loyalty_customer_once
  ON ops.loyalty_accounts(business_id, branch_id, customer_id) WHERE kind='customer';
CREATE UNIQUE INDEX loyalty_system_once
  ON ops.loyalty_accounts(business_id, branch_id) WHERE kind='system';

CREATE SEQUENCE ops.loyalty_posting_seq AS bigint NO CYCLE;

CREATE TABLE ops.loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_no bigint NOT NULL UNIQUE, -- assigned AFTER the account lock by the trigger
  -- The single customer owner of this transfer, used for authorization and locking.
  account_id uuid NOT NULL,
  check_id uuid,
  kind text NOT NULL CHECK (kind IN ('earn','reserve','spend','release','refund','expire')),
  reason text NOT NULL CHECK (reason IN (
    'paid_food','checkout_hold','checkout_capture','checkout_cancel',
    'reverse_earn','restore_spend','policy_expiry')),
  from_account_id uuid NOT NULL,
  from_bucket text NOT NULL CHECK (from_bucket IN ('available','held','control')),
  to_account_id uuid NOT NULL,
  to_bucket text NOT NULL CHECK (to_bucket IN ('available','held','control')),
  points bigint NOT NULL CHECK (points>=0),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- Stable captured-share identity / checkout-share identity, from a trusted backend gate.
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  eligible_food_minor bigint CHECK (eligible_food_minor>=0),
  award_refunded_food_minor bigint CHECK (award_refunded_food_minor>=0),
  earn_bps bigint CHECK (earn_bps BETWEEN 0 AND 10000),
  resolves_reservation_id uuid,
  reverses_entry_id uuid,
  refund_food_cumulative_minor bigint CHECK (refund_food_cumulative_minor>=0),
  -- Advisory deadline ONLY. Never release on time alone if PSP outcome is unknown.
  review_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, id),
  UNIQUE (business_id, branch_id, operation_key),
  UNIQUE (business_id, branch_id, account_id, check_id, id),
  FOREIGN KEY (business_id, branch_id, account_id)
    REFERENCES ops.loyalty_accounts(business_id, branch_id, id),
  FOREIGN KEY (business_id, branch_id, from_account_id)
    REFERENCES ops.loyalty_accounts(business_id, branch_id, id),
  FOREIGN KEY (business_id, branch_id, to_account_id)
    REFERENCES ops.loyalty_accounts(business_id, branch_id, id),
  FOREIGN KEY (business_id, branch_id, check_id)
    REFERENCES ops.checks(business_id, branch_id, id),
  FOREIGN KEY (business_id, branch_id, account_id, check_id, resolves_reservation_id)
    REFERENCES ops.loyalty_ledger(business_id, branch_id, account_id, check_id, id),
  FOREIGN KEY (business_id, branch_id, account_id, check_id, reverses_entry_id)
    REFERENCES ops.loyalty_ledger(business_id, branch_id, account_id, check_id, id),
  CHECK (from_account_id<>to_account_id OR from_bucket<>to_bucket),
  CHECK (points>0 OR kind IN ('earn','refund')),
  CHECK ((kind='expire' AND check_id IS NULL) OR (kind<>'expire' AND check_id IS NOT NULL)),
  CHECK ((kind='earn' AND reason='paid_food')
      OR (kind='reserve' AND reason='checkout_hold')
      OR (kind='spend' AND reason='checkout_capture')
      OR (kind='release' AND reason='checkout_cancel')
      OR (kind='refund' AND reason IN ('reverse_earn','restore_spend'))
      OR (kind='expire' AND reason='policy_expiry')),
  CHECK ((kind='earn' AND eligible_food_minor IS NOT NULL AND earn_bps IS NOT NULL
        AND award_refunded_food_minor IS NOT NULL AND award_refunded_food_minor<=eligible_food_minor)
      OR (kind<>'earn' AND eligible_food_minor IS NULL AND earn_bps IS NULL
        AND award_refunded_food_minor IS NULL)),
  CHECK ((kind IN ('spend','release') AND resolves_reservation_id IS NOT NULL)
      OR (kind NOT IN ('spend','release') AND resolves_reservation_id IS NULL)),
  CHECK ((kind='refund' AND reverses_entry_id IS NOT NULL)
      OR (kind<>'refund' AND reverses_entry_id IS NULL)),
  CHECK ((reason='reverse_earn' AND refund_food_cumulative_minor IS NOT NULL)
      OR (reason<>'reverse_earn' AND refund_food_cumulative_minor IS NULL)),
  CHECK ((kind='reserve' AND review_after IS NOT NULL AND review_after>created_at)
      OR (kind<>'reserve' AND review_after IS NULL))
);
CREATE UNIQUE INDEX loyalty_one_award_per_settled_share
  ON ops.loyalty_ledger(business_id,branch_id,source_ref) WHERE kind='earn';
CREATE UNIQUE INDEX loyalty_one_resolution_per_reservation
  ON ops.loyalty_ledger(business_id,branch_id,resolves_reservation_id)
  WHERE resolves_reservation_id IS NOT NULL;
CREATE INDEX loyalty_account_history ON ops.loyalty_ledger
  (business_id,branch_id,account_id,created_at,id);
CREATE INDEX loyalty_refunds ON ops.loyalty_ledger(reverses_entry_id) WHERE kind='refund';
CREATE INDEX loyalty_holds ON ops.loyalty_ledger(account_id,source_ref) WHERE kind='reserve';

-- Exact floor for earned points. Avoid intermediate BIGINT overflow.
CREATE FUNCTION ops.loyalty_points_for(p_minor bigint, p_bps bigint)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
BEGIN
  IF p_minor<0 OR p_bps<0 OR p_bps>10000 THEN
    RAISE EXCEPTION 'INVALID_LOYALTY_AMOUNT';
  END IF;
  RETURN (p_minor / 10000)*p_bps + ((p_minor % 10000)*p_bps)/10000;
END;
$$;

-- BIGINT accumulator; deliberately avoids sum(bigint), whose PostgreSQL return type is numeric.
-- Replay customer postings only. System control balances are not customer spending balances.
CREATE FUNCTION ops.loyalty_balances(p_business uuid,p_branch uuid,p_account uuid)
RETURNS TABLE(available bigint,held bigint)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE r record;
BEGIN
  available:=0; held:=0;
  FOR r IN SELECT * FROM ops.loyalty_ledger
    WHERE business_id=p_business AND branch_id=p_branch AND account_id=p_account
    ORDER BY posting_no LOOP
    IF r.from_account_id=p_account THEN
      IF r.from_bucket='available' THEN available:=available-r.points;
      ELSIF r.from_bucket='held' THEN held:=held-r.points; END IF;
    END IF;
    IF r.to_account_id=p_account THEN
      IF r.to_bucket='available' THEN available:=available+r.points;
      ELSIF r.to_bucket='held' THEN held:=held+r.points; END IF;
    END IF;
  END LOOP;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION ops.loyalty_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'APPEND_ONLY_LOYALTY_HISTORY' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER loyalty_no_mutation BEFORE UPDATE OR DELETE ON ops.loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION ops.loyalty_immutable();
CREATE TRIGGER loyalty_no_truncate BEFORE TRUNCATE ON ops.loyalty_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION ops.loyalty_immutable();

CREATE FUNCTION ops.loyalty_account_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF (NEW.id,NEW.business_id,NEW.branch_id,NEW.customer_id,NEW.kind,NEW.currency,NEW.created_at)
    IS DISTINCT FROM
     (OLD.id,OLD.business_id,OLD.branch_id,OLD.customer_id,OLD.kind,OLD.currency,OLD.created_at) THEN
    RAISE EXCEPTION 'LOYALTY_ACCOUNT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER loyalty_account_identity BEFORE UPDATE ON ops.loyalty_accounts
  FOR EACH ROW EXECUTE FUNCTION ops.loyalty_account_identity();

-- Financial gate remains a trusted-server concern, but transfer shapes, balances,
-- one-time holds and cumulative refund limits are also enforced in PostgreSQL.
CREATE FUNCTION ops.loyalty_guard_transfer() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
  a ops.loyalty_accounts%ROWTYPE;
  s uuid;
  original ops.loyalty_ledger%ROWTYPE;
  b record; r record;
  reversed bigint:=0; previous_food bigint:=0; expected bigint;
BEGIN
  -- All service writers lock check FIRST, then financial rows, then account.
  IF NEW.check_id IS NOT NULL THEN
    PERFORM ops.lock_check(NEW.business_id,NEW.branch_id,NEW.check_id,NULL);
  END IF;
  SELECT * INTO a FROM ops.loyalty_accounts
    WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND id=NEW.account_id
    FOR UPDATE;
  IF NOT FOUND OR a.kind<>'customer' THEN RAISE EXCEPTION 'CUSTOMER_ACCOUNT_REQUIRED'; END IF;
  SELECT id INTO s FROM ops.loyalty_accounts
    WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND kind='system';
  IF NOT FOUND THEN RAISE EXCEPTION 'SYSTEM_ACCOUNT_REQUIRED'; END IF;
  IF NEW.kind IN ('earn','reserve') AND NOT a.active THEN RAISE EXCEPTION 'ACCOUNT_INACTIVE'; END IF;

  IF NEW.kind IN ('earn') OR NEW.reason='restore_spend' THEN
    IF (NEW.from_account_id,NEW.from_bucket,NEW.to_account_id,NEW.to_bucket)
      IS DISTINCT FROM (s,'control'::text,a.id,'available'::text) THEN
      RAISE EXCEPTION 'INVALID_TRANSFER_LEGS'; END IF;
  ELSIF NEW.kind='reserve' THEN
    IF (NEW.from_account_id,NEW.from_bucket,NEW.to_account_id,NEW.to_bucket)
      IS DISTINCT FROM (a.id,'available'::text,a.id,'held'::text) THEN
      RAISE EXCEPTION 'INVALID_TRANSFER_LEGS'; END IF;
  ELSIF NEW.kind='release' THEN
    IF (NEW.from_account_id,NEW.from_bucket,NEW.to_account_id,NEW.to_bucket)
      IS DISTINCT FROM (a.id,'held'::text,a.id,'available'::text) THEN
      RAISE EXCEPTION 'INVALID_TRANSFER_LEGS'; END IF;
  ELSIF NEW.kind='spend' THEN
    IF (NEW.from_account_id,NEW.from_bucket,NEW.to_account_id,NEW.to_bucket)
      IS DISTINCT FROM (a.id,'held'::text,s,'control'::text) THEN
      RAISE EXCEPTION 'INVALID_TRANSFER_LEGS'; END IF;
  ELSE
    IF (NEW.from_account_id,NEW.from_bucket,NEW.to_account_id,NEW.to_bucket)
      IS DISTINCT FROM (a.id,'available'::text,s,'control'::text) THEN
      RAISE EXCEPTION 'INVALID_TRANSFER_LEGS'; END IF;
  END IF;

  IF NEW.kind='earn' AND NEW.points<>ops.loyalty_points_for(NEW.eligible_food_minor-NEW.award_refunded_food_minor,NEW.earn_bps) THEN
    RAISE EXCEPTION 'EARN_AMOUNT_MISMATCH'; END IF;

  IF NEW.kind='reserve' AND EXISTS (
    SELECT 1 FROM ops.loyalty_ledger h
    WHERE h.business_id=NEW.business_id AND h.branch_id=NEW.branch_id
      AND h.account_id=a.id AND h.check_id=NEW.check_id AND h.source_ref=NEW.source_ref
      AND h.kind='reserve' AND NOT EXISTS (
        SELECT 1 FROM ops.loyalty_ledger z WHERE z.resolves_reservation_id=h.id)
  ) THEN RAISE EXCEPTION 'SHARE_ALREADY_HAS_HOLD'; END IF;

  IF NEW.resolves_reservation_id IS NOT NULL THEN
    SELECT * INTO original FROM ops.loyalty_ledger
      WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id
        AND account_id=a.id AND check_id=NEW.check_id AND id=NEW.resolves_reservation_id;
    IF NOT FOUND OR original.kind<>'reserve' OR NEW.points<>original.points
      OR NEW.source_ref<>original.source_ref THEN RAISE EXCEPTION 'INVALID_HOLD_RESOLUTION'; END IF;
  END IF;

  IF NEW.kind='refund' THEN
    SELECT * INTO original FROM ops.loyalty_ledger
      WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND account_id=a.id
        AND check_id=NEW.check_id AND id=NEW.reverses_entry_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_SOURCE_MISSING'; END IF;
    previous_food:=coalesce(original.award_refunded_food_minor,0);
    FOR r IN SELECT points,refund_food_cumulative_minor FROM ops.loyalty_ledger
      WHERE reverses_entry_id=original.id AND kind='refund' LOOP
      reversed:=reversed+r.points;
      previous_food:=greatest(previous_food,coalesce(r.refund_food_cumulative_minor,0));
    END LOOP;
    IF NEW.reason='reverse_earn' THEN
      IF original.kind<>'earn' OR NEW.refund_food_cumulative_minor<previous_food
        OR NEW.refund_food_cumulative_minor>original.eligible_food_minor THEN
        RAISE EXCEPTION 'INVALID_REFUND_BASIS'; END IF;
      expected:=original.points-ops.loyalty_points_for(
        original.eligible_food_minor-NEW.refund_food_cumulative_minor,original.earn_bps)-reversed;
      IF NEW.points<>expected THEN RAISE EXCEPTION 'REFUND_POINTS_MISMATCH'; END IF;
    ELSE
      IF original.kind<>'spend' OR NEW.points>original.points-reversed THEN
        RAISE EXCEPTION 'REFUND_EXCEEDS_SPEND'; END IF;
    END IF;
  END IF;

  SELECT * INTO b FROM ops.loyalty_balances(NEW.business_id,NEW.branch_id,a.id);
  IF NEW.from_account_id=a.id AND NEW.from_bucket='available'
     AND NEW.reason<>'reverse_earn' AND NEW.points>b.available THEN
    RAISE EXCEPTION 'INSUFFICIENT_POINTS' USING ERRCODE='P0001'; END IF;
  IF NEW.from_account_id=a.id AND NEW.from_bucket='held' AND NEW.points>b.held THEN
    RAISE EXCEPTION 'INSUFFICIENT_HELD_POINTS' USING ERRCODE='P0001'; END IF;
  -- Force BIGINT range checks on resulting balances. Only earn reversal may create debt.
  IF NEW.from_account_id=a.id AND NEW.from_bucket='available' THEN b.available:=b.available-NEW.points; END IF;
  IF NEW.to_account_id=a.id AND NEW.to_bucket='available' THEN b.available:=b.available+NEW.points; END IF;
  IF NEW.from_account_id=a.id AND NEW.from_bucket='held' THEN b.held:=b.held-NEW.points; END IF;
  IF NEW.to_account_id=a.id AND NEW.to_bucket='held' THEN b.held:=b.held+NEW.points; END IF;
  -- Insertion order is serial for a customer. Stamp after acquiring the account lock.
  NEW.posting_no:=nextval('ops.loyalty_posting_seq'::regclass);
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER loyalty_transfer_guard BEFORE INSERT ON ops.loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION ops.loyalty_guard_transfer();

-- Private helper: evaluates the current Auth user, not an arbitrary supplied user ID.
CREATE FUNCTION ops.loyalty_can_read(p_business uuid,p_branch uuid,p_account uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS (
    SELECT 1 FROM ops.loyalty_accounts a JOIN ops.customers c
      ON c.business_id=a.business_id AND c.branch_id=a.branch_id AND c.id=a.customer_id
    WHERE a.business_id=p_business AND a.branch_id=p_branch AND a.id=p_account
      AND c.auth_user_id=(SELECT auth.uid())
  ) OR ops.has_branch_role(p_business,p_branch,ARRAY['owner','manager']::text[]);
$$;

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['upsell_rules','loyalty_accounts','loyalty_ledger'] LOOP
    EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE POLICY no_client_insert ON ops.%I AS RESTRICTIVE FOR INSERT TO anon,authenticated WITH CHECK(false)',t);
    EXECUTE format('CREATE POLICY no_client_update ON ops.%I AS RESTRICTIVE FOR UPDATE TO anon,authenticated USING(false) WITH CHECK(false)',t);
    EXECUTE format('CREATE POLICY no_client_delete ON ops.%I AS RESTRICTIVE FOR DELETE TO anon,authenticated USING(false)',t);
  END LOOP;
END;
$rls$;
CREATE POLICY rules_staff_read ON ops.upsell_rules FOR SELECT TO authenticated
  USING (ops.has_branch_role(business_id,branch_id,ARRAY['owner','manager']::text[]));
CREATE POLICY loyalty_account_read ON ops.loyalty_accounts FOR SELECT TO authenticated
  USING (ops.loyalty_can_read(business_id,branch_id,id));
CREATE POLICY loyalty_ledger_read ON ops.loyalty_ledger FOR SELECT TO authenticated
  USING (ops.loyalty_can_read(business_id,branch_id,account_id));
GRANT SELECT ON ops.upsell_rules,ops.loyalty_accounts,ops.loyalty_ledger TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON ops.upsell_rules TO service_role;
GRANT SELECT,INSERT ON ops.loyalty_accounts,ops.loyalty_ledger TO service_role;
-- FOR UPDATE requires UPDATE privilege on at least one account column; no balance exists.
REVOKE ALL ON SEQUENCE ops.loyalty_posting_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SEQUENCE ops.loyalty_posting_seq TO service_role;
GRANT UPDATE(active,earn_bps) ON ops.loyalty_accounts TO service_role;

REVOKE ALL ON FUNCTION ops.loyalty_points_for(bigint,bigint),
  ops.loyalty_balances(uuid,uuid,uuid),ops.loyalty_immutable(),
  ops.loyalty_account_identity(),ops.loyalty_guard_transfer(),ops.loyalty_can_read(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.loyalty_points_for(bigint,bigint),
  ops.loyalty_balances(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION ops.loyalty_can_read(uuid,uuid,uuid) TO authenticated,service_role;

-- A read-only posting projection: each transfer expands into exactly two equal legs.
CREATE VIEW ops.loyalty_postings WITH (security_invoker=true) AS
  SELECT id AS entry_id,business_id,branch_id,check_id,kind,from_account_id AS posting_account_id,
    from_bucket AS bucket,'out'::text AS leg,-points AS delta_points,posting_no
  FROM ops.loyalty_ledger
  UNION ALL
  SELECT id,business_id,branch_id,check_id,kind,to_account_id,
    to_bucket,'in'::text,points,posting_no
  FROM ops.loyalty_ledger;
REVOKE ALL ON ops.loyalty_postings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON ops.loyalty_postings TO authenticated,service_role;

COMMENT ON TABLE ops.loyalty_ledger IS
'Append-only double-entry TRANSFER subledger: one row = equal debit and credit, possibly between buckets of the same customer account. Not a statutory general ledger.';
COMMENT ON COLUMN ops.loyalty_ledger.source_ref IS
'Trusted payment-share settlement identity, not an unverified client payment flag. Bind via the backend EvidencePort.';
COMMENT ON COLUMN ops.loyalty_ledger.review_after IS
'Hold review deadline, NOT permission to release pending/unknown payments.';
COMMIT;
