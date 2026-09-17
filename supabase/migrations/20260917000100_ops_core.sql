-- MenüGO | Sprint 0–1 | Çekirdek operasyon şeması
-- Migration: 20260917000100_ops_core.sql
-- Hedef: PostgreSQL 17 / Supabase SQL Editor (postgres/şema sahibi).
-- Tek seferlik migration. Mevcut ops şeması varsa güvenli biçimde durur.
-- public ve auth şemalarındaki mevcut tablolara DDL/DML uygulamaz;
-- yalnızca mevcut anahtarlarına foreign key ile bağlanır.
-- Bu dosya seed, kullanıcı ataması, API, ödeme veya Realtime kurulumu içermez.
-- Bütün parasal alanlar BIGINT ve kuruştur. Fiyatlar vergi dahil brüt fiyatlardır.
-- JSON alanları parasal kayıt kaynağı değildir; seçenek kimliği/etiketi içindir.
-- Kaynaklar:
-- https://www.postgresql.org/docs/17/ddl-constraints.html
-- https://www.postgresql.org/docs/17/explicit-locking.html
-- https://supabase.com/docs/guides/database/postgres/row-level-security
-- https://supabase.com/docs/guides/database/functions

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Ön koşullar. public.branches(id,business_id) ve
-- public.menu_items(branch_id,source_id) UNIQUE anahtarları mevcut olmalıdır.
-- MenüGO projesinde bu anahtarlar salt okunur sorguyla doğrulandı.
DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.businesses') IS NULL
     OR pg_catalog.to_regclass('public.branches') IS NULL
     OR pg_catalog.to_regclass('public.menu_items') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'Gerekli public katalog veya Supabase Auth tabloları eksik.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'ops') THEN
    RAISE EXCEPTION 'ops şeması zaten var. Migration geçmişini kontrol edin; şemayı silmeyin.';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'Supabase anon/authenticated/service_role rolleri bulunamadı.';
  END IF;
END;
$preflight$;

CREATE SCHEMA ops;
REVOKE ALL ON SCHEMA ops FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA ops TO authenticated, service_role;

-- 1. ŞUBE VE AYARLAR
CREATE TABLE ops.branch_settings (
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  currency text NOT NULL DEFAULT 'TRY' CHECK (currency = 'TRY'),
  timezone text NOT NULL DEFAULT 'Europe/Istanbul'
    CHECK (length(btrim(timezone)) BETWEEN 1 AND 100),
  ordering_enabled boolean NOT NULL DEFAULT false,
  dine_in_enabled boolean NOT NULL DEFAULT false,
  pickup_enabled boolean NOT NULL DEFAULT false,
  delivery_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, branch_id),
  FOREIGN KEY (branch_id, business_id)
    REFERENCES public.branches (id, business_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE ops.branch_staff (
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','manager','cashier','waiter','kitchen')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, branch_id, user_id),
  FOREIGN KEY (business_id, branch_id)
    REFERENCES ops.branch_settings (business_id, branch_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX branch_staff_active_user_idx
  ON ops.branch_staff (user_id, business_id, branch_id) WHERE active;

-- 2. MÜŞTERİ: Şube kapsamında yalnız telefon, Auth ilişkisi ve izin anlık durumu.
-- OTP/telefon doğrulaması pazarlama izni DEĞİLDİR.
-- Aydınlatmanın sunulması ayrı, SMS pazarlama tercihi ayrı tutulur.
-- İzin geçmişi/İYS senkronizasyonu daha sonraki CRM migration'ına aittir.
CREATE TABLE ops.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  auth_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phone_verified_at timestamptz,
  privacy_notice_version text,
  privacy_notice_presented_at timestamptz,
  sms_marketing_status text NOT NULL DEFAULT 'unknown'
    CHECK (sms_marketing_status IN ('unknown','granted','denied','revoked')),
  sms_marketing_recorded_at timestamptz,
  sms_marketing_text_version text,
  sms_marketing_evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, id),
  UNIQUE (business_id, branch_id, phone_e164),
  UNIQUE (business_id, branch_id, auth_user_id),
  FOREIGN KEY (business_id, branch_id)
    REFERENCES ops.branch_settings (business_id, branch_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (privacy_notice_version IS NULL AND privacy_notice_presented_at IS NULL)
    OR (privacy_notice_version IS NOT NULL
        AND length(btrim(privacy_notice_version)) > 0
        AND privacy_notice_presented_at IS NOT NULL)
  ),
  CHECK (
    (sms_marketing_status = 'unknown'
      AND sms_marketing_recorded_at IS NULL
      AND sms_marketing_text_version IS NULL
      AND sms_marketing_evidence_ref IS NULL)
    OR (sms_marketing_status <> 'unknown'
      AND sms_marketing_recorded_at IS NOT NULL
      AND coalesce(length(btrim(sms_marketing_text_version)), 0) > 0
      AND coalesce(length(btrim(sms_marketing_evidence_ref)), 0) > 0)
  ),
  CHECK (sms_marketing_status <> 'granted' OR phone_verified_at IS NOT NULL)
);
CREATE INDEX customers_auth_idx ON ops.customers (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- 3. MASA, ADİSYON VE TASLAK SEPET
CREATE TABLE ops.dining_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  table_code text NOT NULL CHECK (table_code ~ '^[a-z0-9_-]{1,32}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  capacity integer NOT NULL DEFAULT 4 CHECK (capacity BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, id),
  UNIQUE (business_id, branch_id, table_code),
  FOREIGN KEY (business_id, branch_id)
    REFERENCES ops.branch_settings (business_id, branch_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE ops.checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  table_id uuid,
  customer_id uuid,
  opened_by_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  service_mode text NOT NULL CHECK (service_mode IN ('dine_in','pickup','delivery')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','checkout','closed','cancelled')),
  currency text NOT NULL DEFAULT 'TRY' CHECK (currency = 'TRY'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, id),
  FOREIGN KEY (business_id, branch_id)
    REFERENCES ops.branch_settings (business_id, branch_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (business_id, branch_id, table_id)
    REFERENCES ops.dining_tables (business_id, branch_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (business_id, branch_id, customer_id)
    REFERENCES ops.customers (business_id, branch_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((service_mode = 'dine_in' AND table_id IS NOT NULL)
      OR (service_mode IN ('pickup','delivery') AND table_id IS NULL)),
  CHECK ((status IN ('open','checkout') AND closed_at IS NULL)
      OR (status IN ('closed','cancelled') AND closed_at IS NOT NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);
CREATE UNIQUE INDEX one_active_check_per_table
  ON ops.checks (business_id, branch_id, table_id)
  WHERE table_id IS NOT NULL AND status IN ('open','checkout');
CREATE INDEX checks_customer_idx ON ops.checks (business_id, branch_id, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX checks_opened_by_idx ON ops.checks (opened_by_user_id)
  WHERE opened_by_user_id IS NOT NULL;
CREATE INDEX checks_branch_status_idx ON ops.checks (business_id, branch_id, status);

CREATE TABLE ops.cart_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  check_id uuid NOT NULL,
  product_source_id text NOT NULL,
  created_by_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  client_line_key uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor bigint GENERATED ALWAYS AS
    (unit_price_minor * quantity::bigint) STORED,
  options_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(options_snapshot) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, check_id, client_line_key),
  FOREIGN KEY (business_id, branch_id, check_id)
    REFERENCES ops.checks (business_id, branch_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Mevcut public şemasını değiştirmeden şubeye bağlı katalog kimliği.
  FOREIGN KEY (branch_id, product_source_id)
    REFERENCES public.menu_items (branch_id, source_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX cart_lines_product_idx ON ops.cart_lines (branch_id, product_source_id);
CREATE INDEX cart_lines_creator_idx ON ops.cart_lines (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

-- 4. SİPARİŞ VE BORÇ
-- orders bir mutfağa gönderim turudur. checks birden fazla orders içerebilir.
-- Üst tabloda yinelenen parasal toplam tutulmaz; hesap kayması önlenir.
CREATE TABLE ops.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  check_id uuid NOT NULL,
  client_request_id uuid NOT NULL,
  request_fingerprint text NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  submitted_by_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','accepted','preparing',
                     'ready','served','completed','cancelled')),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, check_id, id),
  UNIQUE (business_id, branch_id, client_request_id),
  FOREIGN KEY (business_id, branch_id, check_id)
    REFERENCES ops.checks (business_id, branch_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((status = 'draft' AND submitted_at IS NULL)
      OR (status = 'cancelled')
      OR (status NOT IN ('draft','cancelled') AND submitted_at IS NOT NULL)),
  CHECK (submitted_at IS NULL OR submitted_at >= created_at)
);
CREATE INDEX orders_queue_idx ON ops.orders
  (business_id, branch_id, status, created_at);
CREATE INDEX orders_submitter_idx ON ops.orders (submitted_by_user_id)
  WHERE submitted_by_user_id IS NOT NULL;

CREATE TABLE ops.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  check_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  product_source_id text NOT NULL,
  product_name_snapshot text NOT NULL
    CHECK (length(btrim(product_name_snapshot)) BETWEEN 1 AND 250),
  options_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(options_snapshot) = 'array'),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  -- Birim başına değil, sipariş satırının tamamına uygulanmış indirim.
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  gross_minor bigint GENERATED ALWAYS AS
    (unit_price_minor * quantity::bigint) STORED,
  net_minor bigint GENERATED ALWAYS AS
    (unit_price_minor * quantity::bigint - discount_minor) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, check_id, order_id, id),
  UNIQUE (business_id, branch_id, order_id, line_no),
  FOREIGN KEY (business_id, branch_id, check_id, order_id)
    REFERENCES ops.orders (business_id, branch_id, check_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (branch_id, product_source_id)
    REFERENCES public.menu_items (branch_id, source_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (discount_minor <= unit_price_minor * quantity::bigint)
);
CREATE INDEX order_items_product_idx ON ops.order_items (branch_id, product_source_id);

-- Bir ürün satırında quantity=3 ise, aynı satıra bağlı unit_no=1,2,3
-- olmak üzere üç ayrı borç kaydı oluşturulur. Ürün bazlı bölüşümün temeli budur.
-- Bu tablo tahsilat defteri DEĞİLDİR. Ödeme/iade tabloları sonraki migration'dadır.
CREATE TABLE ops.bill_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  check_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid,
  unit_no integer,
  kind text NOT NULL CHECK (kind IN ('item','delivery')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'TRY' CHECK (currency = 'TRY'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, branch_id, check_id, id),
  FOREIGN KEY (business_id, branch_id, check_id, order_id)
    REFERENCES ops.orders (business_id, branch_id, check_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (business_id, branch_id, check_id, order_id, order_item_id)
    REFERENCES ops.order_items (business_id, branch_id, check_id, order_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((kind = 'item' AND order_item_id IS NOT NULL
                       AND unit_no IS NOT NULL AND unit_no > 0)
      OR (kind = 'delivery' AND order_item_id IS NULL AND unit_no IS NULL)),
  CHECK ((status = 'active' AND voided_at IS NULL AND void_reason IS NULL)
      OR (status = 'voided' AND voided_at IS NOT NULL
                           AND coalesce(length(btrim(void_reason)), 0) > 0))
);
CREATE UNIQUE INDEX bill_charges_one_per_item_unit
  ON ops.bill_charges (business_id, branch_id, order_item_id, unit_no)
  WHERE kind = 'item';
CREATE UNIQUE INDEX bill_charges_one_delivery_per_order
  ON ops.bill_charges (business_id, branch_id, order_id)
  WHERE kind = 'delivery';
CREATE INDEX bill_charges_check_status_idx ON ops.bill_charges
  (business_id, branch_id, check_id, status);

-- 5. KAPSAM, SNAPSHOT VE KİLİT KORUMALARI
CREATE FUNCTION ops.guard_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE
  k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['id','business_id','branch_id','user_id',
                          'check_id','order_id','created_at'] LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'IMMUTABLE_SCOPE_FIELD: %', k USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION ops.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  NEW.updated_at := clock_timestamp();
  IF TG_TABLE_NAME = 'checks' THEN
    IF OLD.status IN ('closed','cancelled') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'TERMINAL_CHECK_CANNOT_REOPEN' USING ERRCODE = '23514';
    END IF;
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Aynı adisyondaki sepet/sipariş/borç değişikliklerini sıraya sokar.
-- Servis katmanı çok satırlı işlemlerde YİNE ilk olarak lock_check çağırmalıdır:
-- PostgreSQL UPDATE, BEFORE trigger'dan önce hedef alt satırı kilitleyebilir.
-- Böylece kilit sırası: checks -> orders -> order_items -> bill_charges olur.
CREATE FUNCTION ops.guard_check_child() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE
  row_data jsonb;
  parent_check ops.checks%ROWTYPE;
  parent_order_status text;
  item ops.order_items%ROWTYPE;
  expected_minor bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME <> 'cart_lines' THEN
      RAISE EXCEPTION 'HISTORY_DELETE_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
    row_data := to_jsonb(OLD);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;

  SELECT c.* INTO parent_check FROM ops.checks c
  WHERE c.business_id = (row_data ->> 'business_id')::uuid
    AND c.branch_id = (row_data ->> 'branch_id')::uuid
    AND c.id = (row_data ->> 'check_id')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECK_NOT_FOUND_IN_SCOPE' USING ERRCODE = '23503';
  END IF;

  IF (TG_TABLE_NAME = 'cart_lines' OR TG_OP = 'INSERT')
     AND parent_check.status <> 'open' THEN
    RAISE EXCEPTION 'CHECK_NOT_OPEN' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'orders' THEN
    IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'ORDER_MUST_START_AS_DRAFT' USING ERRCODE = '23514';
    ELSIF TG_OP = 'UPDATE' THEN
      IF (NEW.client_request_id, NEW.request_fingerprint)
         IS DISTINCT FROM (OLD.client_request_id, OLD.request_fingerprint) THEN
        RAISE EXCEPTION 'IDEMPOTENCY_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      -- Ayrıntılı mutfak durum makinesi sonraki servis katmanındadır.
      IF OLD.status IN ('completed','cancelled') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'TERMINAL_ORDER_CANNOT_REOPEN' USING ERRCODE = '23514';
      END IF;
      IF OLD.submitted_at IS NOT NULL
         AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
        RAISE EXCEPTION 'SUBMISSION_TIME_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM ops.bill_charges b
           WHERE b.business_id=NEW.business_id AND b.branch_id=NEW.branch_id
             AND b.check_id=NEW.check_id AND b.order_id=NEW.id AND b.status='active') THEN
        RAISE EXCEPTION 'VOID_CHARGES_BEFORE_ORDER_CANCELLATION' USING ERRCODE = '23514';
      END IF;
      IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
        RAISE EXCEPTION 'ORDER_CANNOT_RETURN_TO_DRAFT' USING ERRCODE = '23514';
      END IF;
      IF OLD.status = 'draft' AND NEW.status NOT IN ('draft','cancelled') THEN
        IF NEW.status <> 'submitted' OR parent_check.status <> 'open' THEN
          RAISE EXCEPTION 'INVALID_INITIAL_SUBMISSION' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM ops.order_items i
          WHERE i.business_id=NEW.business_id AND i.branch_id=NEW.branch_id
            AND i.check_id=NEW.check_id AND i.order_id=NEW.id) THEN
          RAISE EXCEPTION 'EMPTY_ORDER' USING ERRCODE = '23514';
        END IF;
        -- Borç tutarları aşağıda birim bazında doğrulanır; burada eksik birim
        -- olup olmadığı denetlenir. Böylece eksik borçla sipariş gönderilemez.
        IF EXISTS (SELECT 1 FROM ops.order_items i
          WHERE i.business_id=NEW.business_id AND i.branch_id=NEW.branch_id
            AND i.check_id=NEW.check_id AND i.order_id=NEW.id
            AND i.quantity <> (SELECT count(*) FROM ops.bill_charges b
              WHERE b.business_id=i.business_id AND b.branch_id=i.branch_id
                AND b.check_id=i.check_id AND b.order_id=i.order_id
                AND b.order_item_id=i.id AND b.kind='item' AND b.status='active')) THEN
          RAISE EXCEPTION 'ORDER_CHARGES_INCOMPLETE' USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'order_items' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'ORDER_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    SELECT o.status INTO parent_order_status FROM ops.orders o
      WHERE o.business_id=NEW.business_id AND o.branch_id=NEW.branch_id
        AND o.check_id=NEW.check_id AND o.id=NEW.order_id;
    IF parent_order_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'ORDER_NOT_DRAFT' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'bill_charges' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (NEW.order_item_id, NEW.unit_no, NEW.kind, NEW.amount_minor, NEW.currency)
        IS DISTINCT FROM
        (OLD.order_item_id, OLD.unit_no, OLD.kind, OLD.amount_minor, OLD.currency)
        OR OLD.status = 'voided'
        OR NEW.status <> 'voided'
        OR parent_check.status NOT IN ('open','checkout') THEN
        RAISE EXCEPTION 'CHARGE_IMMUTABLE_OR_NOT_VOIDABLE' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT o.status INTO parent_order_status FROM ops.orders o
        WHERE o.business_id=NEW.business_id AND o.branch_id=NEW.branch_id
          AND o.check_id=NEW.check_id AND o.id=NEW.order_id;
      IF parent_order_status IS DISTINCT FROM 'draft' OR NEW.status <> 'active' THEN
        RAISE EXCEPTION 'CHARGES_REQUIRE_DRAFT_ORDER' USING ERRCODE = '23514';
      END IF;
      IF NEW.kind = 'item' THEN
        SELECT i.* INTO item FROM ops.order_items i
          WHERE i.business_id=NEW.business_id AND i.branch_id=NEW.branch_id
            AND i.check_id=NEW.check_id AND i.order_id=NEW.order_id
            AND i.id=NEW.order_item_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ORDER_ITEM_NOT_FOUND_IN_SCOPE' USING ERRCODE = '23503';
        END IF;
        IF NEW.unit_no IS NULL OR NEW.unit_no NOT BETWEEN 1 AND item.quantity THEN
          RAISE EXCEPTION 'INVALID_UNIT_NUMBER' USING ERRCODE = '23514';
        END IF;
        -- Tam sayılı bölme: indirim artan kuruşları ilk birimlere dağıtılır.
        expected_minor := item.unit_price_minor
          - (item.discount_minor / item.quantity::bigint)
          - CASE WHEN NEW.unit_no::bigint <= (item.discount_minor % item.quantity::bigint)
                 THEN 1::bigint ELSE 0::bigint END;
        IF NEW.amount_minor IS DISTINCT FROM expected_minor THEN
          RAISE EXCEPTION 'UNIT_CHARGE_AMOUNT_MISMATCH' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.kind = 'delivery' AND parent_check.service_mode <> 'delivery' THEN
        RAISE EXCEPTION 'DELIVERY_CHARGE_NOT_APPLICABLE' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- Her başarılı değişiklikte monoton revizyon. Başarısız yazımda rollback olur.
  UPDATE ops.checks SET revision = revision + 1
    WHERE business_id=parent_check.business_id AND branch_id=parent_check.branch_id
      AND id=parent_check.id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$;

-- Sunucu transaction'ının başında çağrılır. İki ayrı HTTP/RPC isteğiyle
-- "kilitle, sonra yaz" YAPILMAZ: kilit ilk transaction bittiğinde bırakılır.
CREATE FUNCTION ops.lock_check(
  p_business_id uuid, p_branch_id uuid, p_check_id uuid,
  p_expected_revision bigint DEFAULT NULL
) RETURNS ops.checks
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  result ops.checks%ROWTYPE;
BEGIN
  IF p_expected_revision IS NOT NULL AND p_expected_revision < 0 THEN
    RAISE EXCEPTION 'INVALID_REVISION' USING ERRCODE = '22023';
  END IF;
  SELECT c.* INTO result FROM ops.checks c
    WHERE c.business_id=p_business_id AND c.branch_id=p_branch_id AND c.id=p_check_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECK_NOT_FOUND_IN_SCOPE' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_revision IS NOT NULL AND result.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'STALE_CHECK_REVISION' USING ERRCODE = 'P0001';
  END IF;
  RETURN result;
END;
$fn$;

DO $triggers$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch_settings','branch_staff','customers','dining_tables',
                          'checks','cart_lines','orders','order_items','bill_charges'] LOOP
    EXECUTE format('CREATE TRIGGER a_scope_guard BEFORE UPDATE ON ops.%I
      FOR EACH ROW EXECUTE FUNCTION ops.guard_scope()', t);
    IF t <> 'order_items' THEN
      EXECUTE format('CREATE TRIGGER z_touch_updated_at BEFORE UPDATE ON ops.%I
        FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at()', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cart_lines','orders','order_items','bill_charges'] LOOP
    EXECUTE format('CREATE TRIGGER m_guard_check_child BEFORE INSERT OR UPDATE OR DELETE
      ON ops.%I FOR EACH ROW EXECUTE FUNCTION ops.guard_check_child()', t);
  END LOOP;
END;
$triggers$;

-- 6. RLS YARDIMCILARI
-- Migration sahibi bu tabloların da sahibidir. SECURITY DEFINER yalnızca
-- kendi Auth kimliğini kontrol eder; dışarıdan kullanıcı ID parametresi almaz.
-- Sabit search_path ve aşağıdaki EXECUTE izinleri birlikte kullanılır.
CREATE FUNCTION ops.has_branch_role(
  p_business_id uuid, p_branch_id uuid,
  p_roles text[] DEFAULT ARRAY['owner','manager','cashier','waiter','kitchen']::text[]
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM ops.branch_staff s
    WHERE s.business_id=p_business_id AND s.branch_id=p_branch_id
      AND s.user_id=(SELECT auth.uid()) AND s.active AND s.role=ANY(p_roles)
  );
$fn$;

CREATE FUNCTION ops.can_read_check(p_business_id uuid, p_branch_id uuid, p_check_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM ops.checks c
    WHERE c.business_id=p_business_id AND c.branch_id=p_branch_id AND c.id=p_check_id
      AND (c.opened_by_user_id=(SELECT auth.uid())
        OR ops.has_branch_role(p_business_id,p_branch_id,
             ARRAY['owner','manager','cashier','waiter']::text[]))
  );
$fn$;

-- 7. RLS + SQL GRANT BİRLİKTE. Authenticated istemciler şimdilik salt okunur.
-- Paylaşımlı masa üyeliği modeli gelmeden tüm müşterilere adisyon açılmaz.
-- service_role RLS'yi aşabilir: yalnız sunucuda, doğrulanmış işletme/şube
-- bağlamıyla kullanılmalıdır. Bu key hiçbir zaman tarayıcıya gönderilmez.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch_settings','branch_staff','customers','dining_tables',
                          'checks','cart_lines','orders','order_items','bill_charges'] LOOP
    EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY', t);
    -- Geniş izinlerin sonradan yanlışlıkla eklenmesine karşı ek koruma.
    EXECUTE format('CREATE POLICY no_client_insert ON ops.%I AS RESTRICTIVE
      FOR INSERT TO anon, authenticated WITH CHECK (false)', t);
    EXECUTE format('CREATE POLICY no_client_update ON ops.%I AS RESTRICTIVE
      FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false)', t);
    EXECUTE format('CREATE POLICY no_client_delete ON ops.%I AS RESTRICTIVE
      FOR DELETE TO anon, authenticated USING (false)', t);
  END LOOP;
END;
$rls$;

CREATE POLICY branch_settings_read ON ops.branch_settings FOR SELECT TO authenticated
  USING (ops.has_branch_role(business_id,branch_id));
CREATE POLICY branch_staff_read ON ops.branch_staff FOR SELECT TO authenticated
  USING (user_id=(SELECT auth.uid())
    OR ops.has_branch_role(business_id,branch_id,ARRAY['owner','manager']::text[]));
CREATE POLICY customers_read ON ops.customers FOR SELECT TO authenticated
  USING (auth_user_id=(SELECT auth.uid())
    OR ops.has_branch_role(business_id,branch_id,ARRAY['owner','manager']::text[]));
CREATE POLICY dining_tables_read ON ops.dining_tables FOR SELECT TO authenticated
  USING (ops.has_branch_role(business_id,branch_id));
CREATE POLICY checks_read ON ops.checks FOR SELECT TO authenticated
  USING (ops.can_read_check(business_id,branch_id,id));
CREATE POLICY cart_lines_read ON ops.cart_lines FOR SELECT TO authenticated
  USING (ops.can_read_check(business_id,branch_id,check_id));
CREATE POLICY orders_read ON ops.orders FOR SELECT TO authenticated
  USING (ops.can_read_check(business_id,branch_id,check_id)
    OR ops.has_branch_role(business_id,branch_id,ARRAY['kitchen']::text[]));
CREATE POLICY order_items_read ON ops.order_items FOR SELECT TO authenticated
  USING (ops.can_read_check(business_id,branch_id,check_id)
    OR ops.has_branch_role(business_id,branch_id,ARRAY['kitchen']::text[]));
CREATE POLICY bill_charges_read ON ops.bill_charges FOR SELECT TO authenticated
  USING (ops.can_read_check(business_id,branch_id,check_id));

REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA ops TO authenticated;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ops TO service_role;
REVOKE UPDATE ON ops.order_items FROM service_role;
GRANT DELETE ON ops.cart_lines TO service_role;

-- PostgreSQL fonksiyonlarının varsayılan PUBLIC EXECUTE yetkisini kaldır.
-- Bunu gelecek migration'lardaki her yeni fonksiyon için ayrıca tekrarlayın.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ops FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ops.has_branch_role(uuid,uuid,text[])
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ops.can_read_check(uuid,uuid,uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ops.lock_check(uuid,uuid,uuid,bigint) TO service_role;

COMMENT ON TABLE ops.customers IS
  'Şube kapsamlı telefon ve güncel izin durumu; tek başına izin geçmişi/İYS kaydı değildir.';
COMMENT ON TABLE ops.order_items IS
  'INSERT-only fiyat/ürün snapshotları. Satır indirimleri ve tüm tutarlar BIGINT kuruş.';
COMMENT ON TABLE ops.bill_charges IS
  'Birim bazlı borçlar; ödeme kanıtı değildir. Tutar değiştirilemez; gerekçeli void desteklenir.';
COMMENT ON FUNCTION ops.lock_check(uuid,uuid,uuid,bigint) IS
  'Sunucu içindir. Aynı transaction içinde çağır ve yaz; ayrı RPC çağrısı kilidi korumaz.';

COMMIT;
