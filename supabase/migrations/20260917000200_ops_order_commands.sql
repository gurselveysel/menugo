-- MenüGO | Sprint 1.2 | Atomik sepet ve sipariş komutları
-- Ön koşul: 20260917000100_ops_core.sql. Sadece ops altında DDL/DML.
-- Canlıya otomatik uygulanmaz. Önce staging üzerinde bütün testleri çalıştırın.
-- HTTP POST -> TEK RPC -> lock_check + değişiklikler + idempotency kaydı.
-- public.menu_items yalnızca okunur ve fiyat/onay değişikliğine karşı FOR SHARE kilitlenir.
-- public.approved_price eski TL alanıdır; TEXT üzerinden tam sayılı kuruşa çevrilir.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('ops.bill_charges') IS NULL
     OR pg_catalog.to_regprocedure('ops.lock_check(uuid,uuid,uuid,bigint)') IS NULL THEN
    RAISE EXCEPTION 'Önce 20260917000100_ops_core.sql uygulanmalı.';
  END IF;
  IF pg_catalog.to_regclass('ops.api_commands') IS NOT NULL THEN
    RAISE EXCEPTION 'api_commands zaten var; migration geçmişini kontrol edin.';
  END IF;
END;
$preflight$;

-- Başarılı yanıt transaction içinde saklanır. Aynı anahtar, aynı kullanıcı için
-- farklı adisyon/endpoint/payload ile tekrar kullanılamaz. Hatalar saklanmaz.
CREATE TABLE ops.api_commands (
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  check_id uuid NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('cart','order')),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, operation_id),
  FOREIGN KEY (business_id, branch_id, check_id)
    REFERENCES ops.checks(business_id, branch_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX api_commands_check_idx
  ON ops.api_commands(business_id, branch_id, check_id, created_at);
ALTER TABLE ops.api_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.api_commands FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON ops.api_commands TO authenticated, service_role;
CREATE POLICY api_commands_read_own ON ops.api_commands
  FOR SELECT TO authenticated USING (
    actor_user_id=(SELECT auth.uid())
    AND ops.can_read_check(business_id,branch_id,check_id)
  );
CREATE POLICY api_commands_no_insert ON ops.api_commands AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY api_commands_no_update ON ops.api_commands AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY api_commands_no_delete ON ops.api_commands AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (false);

-- Bu API yalnızca seçeneksiz temel SKU'yu düzenler. Aynı adisyonda bir temel
-- ürünün tek satırı vardır. Var olan mükerrerler varsa migration güvenle durur;
-- hiçbir sepet verisini otomatik birleştirmez/silmez.
CREATE UNIQUE INDEX cart_lines_one_base_sku_per_check
  ON ops.cart_lines(business_id,branch_id,check_id,product_source_id)
  WHERE options_snapshot='[]'::jsonb;

CREATE FUNCTION ops.catalog_minor(p_major_text text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $fn$
DECLARE
  major_text text;
  fraction_text text;
  major_value bigint;
  minor_value bigint;
  -- Generated line_total için quantity<=999 ile çarpım da BIGINT'e sığmalı.
  unit_cap constant bigint := 9223372036854775807::bigint / 999::bigint;
BEGIN
  IF length(p_major_text)>64
     OR p_major_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_CATALOG_PRICE';
  END IF;
  major_text := split_part(p_major_text,'.',1);
  fraction_text := split_part(p_major_text,'.',2);
  -- 1.234 reddedilir, 1.2300 kabul edilir; yuvarlama/tahmin yapılmaz.
  IF substring(fraction_text FROM 3) ~ '[1-9]' OR length(major_text)>19 THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_CATALOG_PRICE';
  END IF;
  BEGIN
    major_value := major_text::bigint;
    IF major_value > unit_cap / 100::bigint THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_CATALOG_PRICE';
    END IF;
    minor_value := major_value * 100::bigint
      + rpad(left(fraction_text,2),2,'0')::bigint;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_CATALOG_PRICE';
  END;
  IF minor_value > unit_cap THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_CATALOG_PRICE';
  END IF;
  RETURN minor_value;
END;
$fn$;

-- Kimlik parametreden alınmaz. SECURITY DEFINER dış RPC içinde dahi
-- auth.uid(), PostgREST'in doğruladığı JWT sub değerini döndürür.
CREATE FUNCTION ops.assert_command_actor(
  p_business_id uuid,p_branch_id uuid,p_check_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE c ops.checks%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';
  END IF;
  SELECT * INTO c FROM ops.checks
    WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=p_check_id;
  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='CHECK_NOT_FOUND';
  END IF;
  IF c.opened_by_user_id IS DISTINCT FROM auth.uid()
     AND NOT ops.has_branch_role(p_business_id,p_branch_id,
       ARRAY['owner','manager','cashier','waiter']::text[]) THEN
    -- Başkasının adisyonunun varlığını açığa çıkarma.
    RAISE SQLSTATE 'PT404' USING MESSAGE='CHECK_NOT_FOUND';
  END IF;
END;
$fn$;

-- Sıra: yetki kontrolü -> işlem advisory kilidi -> adisyon kilidi ->
-- yetkiyi tekrar kontrol -> eski başarılı sonuç -> revizyon -> şube/masa.
-- Helper dönse de kilit DIŞ RPC transaction'ı bitene kadar sürer.
CREATE FUNCTION ops.begin_command(
  p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,
  p_expected_revision bigint,p_type text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  c ops.checks%ROWTYPE;
  settings ops.branch_settings%ROWTYPE;
  cached ops.api_commands%ROWTYPE;
  table_active boolean;
  locked_revision bigint;
BEGIN
  IF p_business_id IS NULL OR p_branch_id IS NULL OR p_check_id IS NULL
     OR p_operation_id IS NULL OR p_expected_revision IS NULL
     OR p_expected_revision<0 OR p_type NOT IN ('cart','order') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COMMAND';
  END IF;
  PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
  -- İki farklı check aynı kullanıcı/operationId ile yarışsa da sıra belirli.
  -- Olası hash çakışması yalnızca ek beklemeye neden olur, yetki vermez.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text || ':' || p_operation_id::text,0)
  );
  SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
  PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
  SELECT * INTO cached FROM ops.api_commands
    WHERE actor_user_id=auth.uid() AND operation_id=p_operation_id;
  IF FOUND THEN
    IF cached.business_id<>p_business_id OR cached.branch_id<>p_branch_id
       OR cached.check_id<>p_check_id OR cached.command_type<>p_type
       OR cached.request_payload IS DISTINCT FROM p_payload THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';
    END IF;
    -- Revizyon/state artık değişmiş olsa bile ilk başarılı yanıt aynen döner.
    RETURN cached.response_body;
  END IF;
  locked_revision := c.revision;
  BEGIN
    SELECT * INTO c FROM ops.lock_check(
      p_business_id,p_branch_id,p_check_id,p_expected_revision
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM='STALE_CHECK_REVISION' THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='REVISION_CONFLICT',
        DETAIL=jsonb_build_object('currentRevision',locked_revision::text)::text;
    END IF;
    RAISE;
  END;
  IF c.status<>'open' THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';
  END IF;
  SELECT * INTO settings FROM ops.branch_settings
    WHERE business_id=p_business_id AND branch_id=p_branch_id FOR SHARE;
  IF NOT FOUND OR settings.ordering_enabled IS NOT TRUE
     OR (c.service_mode='dine_in' AND settings.dine_in_enabled IS NOT TRUE)
     OR (c.service_mode='pickup' AND settings.pickup_enabled IS NOT TRUE)
     OR (c.service_mode='delivery' AND settings.delivery_enabled IS NOT TRUE) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='ORDERING_DISABLED';
  END IF;
  IF c.service_mode='dine_in' THEN
    SELECT active INTO table_active FROM ops.dining_tables
      WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=c.table_id
      FOR SHARE;
    IF table_active IS NOT TRUE THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='TABLE_INACTIVE';
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE FUNCTION ops.cart_result(p_check_id uuid,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  c ops.checks%ROWTYPE;
  item record;
  lines jsonb := '[]'::jsonb;
  total_minor bigint := 0;
BEGIN
  SELECT * INTO STRICT c FROM ops.checks WHERE id=p_check_id;
  FOR item IN
    SELECT cl.*, p.id AS product_id,p.name AS product_name
    FROM ops.cart_lines cl JOIN public.menu_items p
      ON p.business_id=cl.business_id AND p.branch_id=cl.branch_id
      AND p.source_id=cl.product_source_id
    WHERE cl.business_id=c.business_id AND cl.branch_id=c.branch_id
      AND cl.check_id=c.id ORDER BY cl.created_at,cl.id
  LOOP
    total_minor := total_minor + item.line_total_minor;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'cartLineId',item.id,'productId',item.product_id,'productName',item.product_name,
      'quantity',item.quantity,'unitPriceMinor',item.unit_price_minor::text,
      'lineTotalMinor',item.line_total_minor::text
    ));
  END LOOP;
  RETURN jsonb_build_object(
    'checkId',c.id,'operationId',p_operation_id,'revision',c.revision::text,
    'currency',c.currency,'totalMinor',total_minor::text,'lines',lines
  );
EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT422' USING MESSAGE='AMOUNT_LIMIT_EXCEEDED';
END;
$fn$;

CREATE FUNCTION ops.cart_mutate(
  p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,
  p_product_id uuid,p_delta integer,p_expected_revision bigint
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
      AND product_source_id=product.source_id AND options_snapshot='[]'::jsonb
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
    IF product.options IS DISTINCT FROM '[]'::jsonb THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='OPTIONS_NOT_SUPPORTED';
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
      gen_random_uuid(),new_quantity,unit_minor,'[]'::jsonb);
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

CREATE FUNCTION ops.order_submit(
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
      AND check_id=p_check_id;
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
      AND cl.check_id=p_check_id
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
    WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id
    ORDER BY id FOR UPDATE
  LOOP
    SELECT * INTO product FROM public.menu_items
      WHERE business_id=p_business_id AND branch_id=p_branch_id
        AND source_id=line.product_source_id;
    IF NOT FOUND OR product.available IS NOT TRUE
       OR product.price_approved IS NOT TRUE OR product.approved_price IS NULL THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE';
    END IF;
    IF line.options_snapshot<>'[]'::jsonb OR product.options IS DISTINCT FROM '[]'::jsonb THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='OPTIONS_NOT_SUPPORTED';
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
      product.source_id,product.name,line.options_snapshot,line.quantity,unit_minor,0::bigint)
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
    AND check_id=p_check_id;
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

-- İç yardımcıları Data API'ye çağrılabilir hâle GETİRME.
-- Core lock_check'in authenticated için EXECUTE izni hâlâ yoktur.
REVOKE ALL ON FUNCTION ops.catalog_minor(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION ops.assert_command_actor(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION ops.begin_command(uuid,uuid,uuid,uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION ops.cart_result(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION ops.cart_mutate(uuid,uuid,uuid,uuid,uuid,integer,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION ops.order_submit(uuid,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.cart_mutate(uuid,uuid,uuid,uuid,uuid,integer,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.order_submit(uuid,uuid,uuid,uuid,bigint) TO authenticated;

COMMENT ON TABLE ops.api_commands IS 'Başarılı komut yanıtı; actor/operation ile tekilleştirme. Finansal defter değildir. Auth kullanıcı silinmesinde silinir; normal çalışma sırasında kaydı temizlemeyin.';
COMMENT ON FUNCTION ops.cart_mutate(uuid,uuid,uuid,uuid,uuid,integer,bigint) IS 'Tek transaction içinde yetki, kilit, idempotency, revizyon, ürün doğrulama, sepet ve yanıt kaydı.';
COMMENT ON FUNCTION ops.order_submit(uuid,uuid,uuid,uuid,bigint) IS 'Sepetten draft order + immutable items + birim borçlar + submitted + sepet temizleme; tamamı atomik.';
NOTIFY pgrst,'reload schema';
COMMIT;
