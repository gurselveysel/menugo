-- MenüGO AI suite r24 | Demand & waste evidence pipeline.
-- No catalogue, price, order, payment or stock mutation. Waste observations are explicit
-- operator records; forecasts stay closed until minimum real history exists.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE ops.waste_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_source_id text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  client_request_id uuid NOT NULL,
  quantity_milli bigint NOT NULL CHECK (quantity_milli BETWEEN 1 AND 999000),
  reason text NOT NULL CHECK (reason IN ('prep','spoilage','return','other')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id, branch_id, client_request_id),
  FOREIGN KEY (business_id, branch_id)
    REFERENCES ops.branch_settings (business_id, branch_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (branch_id, product_source_id)
    REFERENCES public.menu_items (branch_id, source_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX waste_events_branch_time_idx
  ON ops.waste_events (business_id, branch_id, observed_at DESC);
CREATE INDEX waste_events_product_time_idx
  ON ops.waste_events (branch_id, product_source_id, observed_at DESC);

ALTER TABLE ops.waste_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.waste_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON ops.waste_events TO service_role;
CREATE POLICY waste_events_client_no_access ON ops.waste_events
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION ops.record_waste_event(
  p_business_id uuid,
  p_branch_id uuid,
  p_product_source_id text,
  p_quantity_milli bigint,
  p_reason text,
  p_client_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  v_role text;
  v_existing ops.waste_events%ROWTYPE;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';
  END IF;
  SELECT role INTO v_role
  FROM ops.branch_staff
  WHERE business_id=p_business_id AND branch_id=p_branch_id
    AND user_id=auth.uid() AND active
  FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('owner','manager','kitchen','cashier') THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE='OPERATIONS_STAFF_REQUIRED';
  END IF;
  IF p_quantity_milli IS NULL OR p_quantity_milli NOT BETWEEN 1 AND 999000
     OR p_reason IS NULL OR p_reason NOT IN ('prep','spoilage','return','other')
     OR p_client_request_id IS NULL OR coalesce(length(btrim(p_product_source_id)),0)=0
     OR length(p_product_source_id)>100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_WASTE_EVENT';
  END IF;

  -- Branch row lock serializes the short idempotency check/insert window for this branch.
  PERFORM 1 FROM ops.branch_settings
  WHERE business_id=p_business_id AND branch_id=p_branch_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND'; END IF;

  SELECT * INTO v_existing
  FROM ops.waste_events
  WHERE business_id=p_business_id AND branch_id=p_branch_id
    AND client_request_id=p_client_request_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.product_source_id IS DISTINCT FROM p_product_source_id
       OR v_existing.quantity_milli IS DISTINCT FROM p_quantity_milli
       OR v_existing.reason IS DISTINCT FROM p_reason THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN jsonb_build_object(
      'id',v_existing.id,'replayed',true,'quantityMilli',v_existing.quantity_milli::text,
      'reason',v_existing.reason,'observedAt',v_existing.observed_at
    );
  END IF;

  SELECT name INTO v_name
  FROM public.menu_items
  WHERE business_id=p_business_id AND branch_id=p_branch_id
    AND source_id=p_product_source_id;
  IF v_name IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND'; END IF;

  INSERT INTO ops.waste_events(
    business_id,branch_id,product_source_id,actor_user_id,client_request_id,
    quantity_milli,reason
  ) VALUES (
    p_business_id,p_branch_id,p_product_source_id,auth.uid(),p_client_request_id,
    p_quantity_milli,p_reason
  ) RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'id',v_existing.id,'replayed',false,'productId',v_existing.product_source_id,
    'productName',v_name,'quantityMilli',v_existing.quantity_milli::text,
    'reason',v_existing.reason,'observedAt',v_existing.observed_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION ops.demand_waste_snapshot(
  p_business_id uuid,
  p_branch_id uuid,
  p_lookback_days integer DEFAULT 28
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  v_role text;
  v_timezone text;
  v_since date;
  v_order_days bigint:=0;
  v_completed_orders bigint:=0;
  v_waste_events bigint:=0;
  v_demand_ready boolean:=false;
  v_waste_ready boolean:=false;
  v_reasons jsonb:='[]'::jsonb;
  v_products jsonb:='[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED'; END IF;
  SELECT role INTO v_role FROM ops.branch_staff
   WHERE business_id=p_business_id AND branch_id=p_branch_id
     AND user_id=auth.uid() AND active;
  IF v_role IS NULL OR v_role NOT IN ('owner','manager','kitchen','cashier') THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE='OPERATIONS_STAFF_REQUIRED';
  END IF;
  IF p_lookback_days IS NULL OR p_lookback_days NOT BETWEEN 14 AND 90 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LOOKBACK';
  END IF;
  SELECT timezone INTO v_timezone FROM ops.branch_settings
   WHERE business_id=p_business_id AND branch_id=p_branch_id;
  IF v_timezone IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND'; END IF;
  v_since := (clock_timestamp() AT TIME ZONE v_timezone)::date - (p_lookback_days-1);

  SELECT count(DISTINCT (coalesce(o.submitted_at,o.created_at) AT TIME ZONE v_timezone)::date), count(*)
    INTO v_order_days,v_completed_orders
  FROM ops.orders o
  WHERE o.business_id=p_business_id AND o.branch_id=p_branch_id
    AND o.status IN ('served','completed')
    AND (coalesce(o.submitted_at,o.created_at) AT TIME ZONE v_timezone)::date >= v_since;

  SELECT count(*) INTO v_waste_events
  FROM ops.waste_events w
  WHERE w.business_id=p_business_id AND w.branch_id=p_branch_id
    AND (w.observed_at AT TIME ZONE v_timezone)::date >= v_since;

  v_demand_ready := v_order_days>=14 AND v_completed_orders>=50;
  v_waste_ready := v_demand_ready AND v_waste_events>=10;
  IF v_order_days<14 THEN v_reasons:=v_reasons||jsonb_build_array('En az 14 gerçek servis günü gerekir.'); END IF;
  IF v_completed_orders<50 THEN v_reasons:=v_reasons||jsonb_build_array('En az 50 tamamlanmış/servis edilmiş gerçek sipariş gerekir.'); END IF;
  IF v_waste_events<10 THEN v_reasons:=v_reasons||jsonb_build_array('Fire oranı için en az 10 gerçek fire kaydı gerekir.'); END IF;

  WITH sold AS (
    SELECT oi.product_source_id,
           sum(oi.quantity)::bigint AS sold_units,
           count(DISTINCT (coalesce(o.submitted_at,o.created_at) AT TIME ZONE v_timezone)::date)::bigint AS sold_days
    FROM ops.orders o
    JOIN ops.order_items oi ON oi.order_id=o.id AND oi.business_id=o.business_id AND oi.branch_id=o.branch_id
    WHERE o.business_id=p_business_id AND o.branch_id=p_branch_id
      AND o.status IN ('served','completed')
      AND (coalesce(o.submitted_at,o.created_at) AT TIME ZONE v_timezone)::date >= v_since
    GROUP BY oi.product_source_id
  ), wasted AS (
    SELECT product_source_id,sum(quantity_milli)::bigint AS waste_milli,count(*)::bigint AS waste_count
    FROM ops.waste_events
    WHERE business_id=p_business_id AND branch_id=p_branch_id
      AND (observed_at AT TIME ZONE v_timezone)::date >= v_since
    GROUP BY product_source_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',m.source_id,
    'name',m.name,
    'soldMilli',(coalesce(s.sold_units,0)*1000)::text,
    'soldDays',coalesce(s.sold_days,0)::text,
    'wasteMilli',coalesce(w.waste_milli,0)::text,
    'wasteEvents',coalesce(w.waste_count,0)::text,
    'baselineNextDayMilli',CASE WHEN v_demand_ready THEN round((coalesce(s.sold_units,0)*1000)::numeric/greatest(v_order_days,1))::bigint::text ELSE NULL END,
    'wasteRateBps',CASE WHEN v_waste_ready AND (coalesce(s.sold_units,0)*1000+coalesce(w.waste_milli,0))>0
      THEN round(coalesce(w.waste_milli,0)::numeric*10000/(coalesce(s.sold_units,0)*1000+coalesce(w.waste_milli,0)))::bigint::text ELSE NULL END
  ) ORDER BY m.sort_order,m.name),'[]'::jsonb) INTO v_products
  FROM public.menu_items m
  LEFT JOIN sold s ON s.product_source_id=m.source_id
  LEFT JOIN wasted w ON w.product_source_id=m.source_id
  WHERE m.business_id=p_business_id AND m.branch_id=p_branch_id;

  RETURN jsonb_build_object(
    'lookbackDays',p_lookback_days,
    'since',v_since,
    'serviceDays',v_order_days::text,
    'completedOrders',v_completed_orders::text,
    'wasteEvents',v_waste_events::text,
    'demandReady',v_demand_ready,
    'wasteReady',v_waste_ready,
    'reasons',v_reasons,
    'method','rolling_service_day_baseline_v1',
    'products',v_products
  );
END;
$$;

REVOKE ALL ON FUNCTION ops.record_waste_event(uuid,uuid,text,bigint,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.demand_waste_snapshot(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.record_waste_event(uuid,uuid,text,bigint,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.demand_waste_snapshot(uuid,uuid,integer) TO authenticated,service_role;

COMMIT;
