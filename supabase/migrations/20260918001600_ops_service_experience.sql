-- r13: service pause, private visit feedback and precise operator reporting.
-- Additive operational changes only; no catalog, customer, payment or provider writes.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE ops.service_controls ADD COLUMN paused_until timestamptz;

CREATE FUNCTION ops.service_availability(p_business_id uuid,p_branch_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('orderingEnabled',b.ordering_enabled AND b.dine_in_enabled,
 'paused',coalesce(s.paused_until>now(),false),'pausedUntil',CASE WHEN s.paused_until>now() THEN s.paused_until ELSE NULL END,
 'estimatedMinutes',s.estimated_minutes,'serverTime',now())
 FROM ops.branch_settings b LEFT JOIN ops.service_controls s USING(business_id,branch_id)
 WHERE b.business_id=p_business_id AND b.branch_id=p_branch_id;
$$;
CREATE FUNCTION ops.service_pause(p_business_id uuid,p_branch_id uuid,p_minutes integer DEFAULT NULL,p_version bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE s ops.service_controls%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 SELECT * INTO s FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
 IF p_minutes IS NOT NULL THEN
  IF p_minutes NOT IN(0,15,30,60) OR p_version IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_INPUT';END IF;
  IF p_version<>s.version THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PROFILE_CHANGED';END IF;
  UPDATE ops.service_controls SET paused_until=CASE WHEN p_minutes=0 THEN NULL ELSE clock_timestamp()+make_interval(mins=>p_minutes) END,
   version=version+1,updated_at=clock_timestamp() WHERE business_id=p_business_id AND branch_id=p_branch_id RETURNING * INTO s;
  INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details)
  VALUES(p_business_id,p_branch_id,auth.uid(),'service-pause',jsonb_build_object('minutes',p_minutes,'pausedUntil',s.paused_until));
 END IF;
 RETURN ops.service_availability(p_business_id,p_branch_id)||jsonb_build_object('version',s.version::text);
END;$$;
-- One shared admission gate for guest and signed-in orders. Existing acceptance/fulfillment unaffected.
CREATE OR REPLACE FUNCTION ops.guard_service_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s ops.service_controls%ROWTYPE;n integer;
BEGIN
 IF NEW.status<>'submitted' OR OLD.status='submitted' THEN RETURN NEW;END IF;
 SELECT * INTO s FROM ops.service_controls WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id FOR UPDATE;
 IF s.paused_until>clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ORDERING_PAUSED';END IF;
 IF s.max_waiting_orders IS NULL THEN RETURN NEW;END IF;
 SELECT count(*) INTO n FROM ops.orders WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND id<>NEW.id AND status IN('submitted','accepted','preparing');
 IF n>=s.max_waiting_orders THEN RAISE SQLSTATE 'PT409' USING MESSAGE='KITCHEN_CAPACITY_REACHED';END IF;
 RETURN NEW;
END;$$;

CREATE TABLE ops.visit_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,
 guest_session_id uuid NOT NULL,operation_id uuid NOT NULL,rating smallint NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reviewed_at timestamptz,reviewed_by uuid REFERENCES auth.users(id),
 UNIQUE(business_id,branch_id,guest_session_id),
 UNIQUE(business_id,branch_id,operation_id),
 FOREIGN KEY(business_id,branch_id,check_id,guest_session_id) REFERENCES ops.guest_sessions(business_id,branch_id,check_id,id),
 CHECK((reviewed_at IS NULL)=(reviewed_by IS NULL))
);
CREATE INDEX visit_feedback_branch_time ON ops.visit_feedback(business_id,branch_id,created_at DESC);
ALTER TABLE ops.visit_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.visit_feedback FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON ops.visit_feedback TO service_role;
CREATE POLICY no_direct_feedback_access ON ops.visit_feedback AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE FUNCTION ops.protect_feedback_content() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FEEDBACK_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF (to_jsonb(OLD)-'reviewed_at'-'reviewed_by') IS DISTINCT FROM (to_jsonb(NEW)-'reviewed_at'-'reviewed_by')
 OR (OLD.reviewed_at IS NOT NULL AND (OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at OR OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by))
 THEN RAISE EXCEPTION 'FEEDBACK_IMMUTABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER feedback_content_immutable BEFORE UPDATE OR DELETE ON ops.visit_feedback FOR EACH ROW EXECUTE FUNCTION ops.protect_feedback_content();
CREATE FUNCTION ops.guest_feedback(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_secret text,
 p_operation_id uuid DEFAULT NULL,p_rating integer DEFAULT NULL,p_comment text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE g ops.guest_sessions%ROWTYPE;f ops.visit_feedback%ROWTYPE;can_rate boolean;c text;
BEGIN
 g:=ops.guest_lock(p_business_id,p_branch_id,p_check_id,p_secret);
 SELECT * INTO f FROM ops.visit_feedback WHERE business_id=p_business_id AND branch_id=p_branch_id AND guest_session_id=g.id;
 can_rate:=EXISTS(SELECT 1 FROM ops.orders WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id AND guest_session_id=g.id AND status IN('served','completed'));
 IF p_operation_id IS NOT NULL THEN
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 OR p_comment IS NULL OR length(p_comment)>500 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_FEEDBACK';END IF;
  c:=btrim(p_comment);
  IF f.id IS NOT NULL THEN
   IF f.operation_id<>p_operation_id THEN RAISE SQLSTATE 'PT409' USING MESSAGE='FEEDBACK_ALREADY_SENT';END IF;
   IF f.rating<>p_rating OR f.comment<>c THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
  ELSE
   IF NOT can_rate THEN RAISE SQLSTATE 'PT409' USING MESSAGE='FEEDBACK_AFTER_SERVICE';END IF;
   BEGIN
    INSERT INTO ops.visit_feedback(business_id,branch_id,check_id,guest_session_id,operation_id,rating,comment)
    VALUES(p_business_id,p_branch_id,p_check_id,g.id,p_operation_id,p_rating,c) RETURNING * INTO f;
   EXCEPTION WHEN unique_violation THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END;
  END IF;
 END IF;
 RETURN jsonb_build_object('eligible',can_rate,'submitted',f.id IS NOT NULL,'feedback',CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object('id',f.id,'rating',f.rating,'comment',f.comment,'createdAt',f.created_at) END);
END;$$;
CREATE FUNCTION ops.feedback_inbox(p_business_id uuid,p_branch_id uuid,p_review_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE f ops.visit_feedback%ROWTYPE;rows jsonb;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 IF p_review_id IS NOT NULL THEN
  SELECT * INTO f FROM ops.visit_feedback WHERE id=p_review_id AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='FEEDBACK_NOT_FOUND';END IF;
  IF f.reviewed_at IS NULL THEN
   UPDATE ops.visit_feedback SET reviewed_at=clock_timestamp(),reviewed_by=auth.uid() WHERE id=f.id;
   INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'feedback-reviewed',jsonb_build_object('feedbackId',f.id));
  END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'rating',x.rating,'comment',x.comment,'createdAt',x.created_at,'reviewed',x.reviewed_at IS NOT NULL,'table',x.table_name) ORDER BY x.created_at DESC),'[]') INTO rows
 FROM (SELECT vf.*,t.display_name AS table_name FROM ops.visit_feedback vf JOIN ops.checks c ON c.id=vf.check_id AND c.business_id=vf.business_id AND c.branch_id=vf.branch_id
 LEFT JOIN ops.dining_tables t ON t.id=c.table_id WHERE vf.business_id=p_business_id AND vf.branch_id=p_branch_id AND vf.created_at>=now()-interval '30 days' ORDER BY vf.created_at DESC,vf.id LIMIT 200)x;
 RETURN jsonb_build_object('days',30,'limit',200,'rows',rows);
END;$$;
CREATE FUNCTION ops.daily_service_report(p_business_id uuid,p_branch_id uuid,p_day date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE d date:=coalesce(p_day,(now() AT TIME ZONE 'Europe/Istanbul')::date);a timestamptz;z timestamptz;r record;
 net bigint:=0;waiting bigint:=0;voided bigint:=0;cash bigint:=0;pos bigint:=0;receipts integer:=0;order_count integer:=0;accepted_count integer:=0;cancelled_count integer:=0;status_counts jsonb:='{}';products jsonb:='{}';top_rows jsonb;k text;prev jsonb;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 IF d>(now() AT TIME ZONE 'Europe/Istanbul')::date OR d<(now() AT TIME ZONE 'Europe/Istanbul')::date-366 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_REPORT_DAY';END IF;
 a:=d::timestamp AT TIME ZONE 'Europe/Istanbul';z:=(d+1)::timestamp AT TIME ZONE 'Europe/Istanbul';
 FOR r IN SELECT id,status FROM ops.orders WHERE business_id=p_business_id AND branch_id=p_branch_id AND submitted_at>=a AND submitted_at<z AND status<>'draft' LOOP
  order_count:=order_count+1;status_counts:=jsonb_set(status_counts,ARRAY[r.status],to_jsonb(coalesce((status_counts->>r.status)::integer,0)+1));
  IF r.status IN('accepted','preparing','ready','served','completed') THEN accepted_count:=accepted_count+1;END IF;
  IF r.status='cancelled' THEN cancelled_count:=cancelled_count+1;END IF;
 END LOOP;
 -- Sum monetary columns with bigint throughout; no numeric/float aggregate or intent-as-payment.
 FOR r IN SELECT b.amount_minor,b.status AS charge_status,o.status AS order_status FROM ops.bill_charges b JOIN ops.orders o ON o.id=b.order_id AND o.business_id=b.business_id AND o.branch_id=b.branch_id
  WHERE b.business_id=p_business_id AND b.branch_id=p_branch_id AND o.submitted_at>=a AND o.submitted_at<z AND o.status<>'draft' LOOP
  IF r.charge_status='voided' THEN voided:=voided+r.amount_minor;
  ELSIF r.order_status='submitted' THEN waiting:=waiting+r.amount_minor;
  ELSIF r.order_status IN('accepted','preparing','ready','served','completed') THEN net:=net+r.amount_minor;END IF;
 END LOOP;
 FOR r IN SELECT method,amount_minor FROM ops.counter_receipts WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>=a AND created_at<z LOOP
  receipts:=receipts+1;IF r.method='cash' THEN cash:=cash+r.amount_minor;ELSE pos:=pos+r.amount_minor;END IF;
 END LOOP;
 FOR r IN SELECT i.product_source_id,coalesce(m.name,i.product_name_snapshot) AS product_name_snapshot,i.quantity,i.net_minor FROM ops.order_items i JOIN ops.orders o ON o.id=i.order_id AND o.business_id=i.business_id AND o.branch_id=i.branch_id LEFT JOIN public.menu_items m ON m.branch_id=i.branch_id AND m.business_id=i.business_id AND m.source_id=i.product_source_id
 WHERE i.business_id=p_business_id AND i.branch_id=p_branch_id AND o.submitted_at>=a AND o.submitted_at<z AND o.status IN('accepted','preparing','ready','served','completed') LOOP
  k:=r.product_source_id;prev:=products->k;
  products:=jsonb_set(products,ARRAY[k],jsonb_build_object('name',r.product_name_snapshot,'quantity',coalesce((prev->>'quantity')::bigint,0)+r.quantity,'netMinor',(coalesce((prev->>'netMinor')::bigint,0)+r.net_minor)::text));
 END LOOP;
 SELECT coalesce(jsonb_agg(x.value ORDER BY (x.value->>'quantity')::bigint DESC,x.key),'[]') INTO top_rows FROM(SELECT key,value FROM jsonb_each(products) ORDER BY (value->>'quantity')::bigint DESC,key LIMIT 10)x;
 RETURN jsonb_build_object('day',d,'timezone','Europe/Istanbul','generatedAt',now(),'orderCount',order_count,'acceptedCount',accepted_count,'cancelledCount',cancelled_count,
 'statusCounts',status_counts,'acceptedOrderMinor',net::text,'waitingOrderMinor',waiting::text,'voidedOrderMinor',voided::text,
 'cashMinor',cash::text,'externalPosMinor',pos::text,'collectedMinor',(cash+pos)::text,'receiptCount',receipts,'topProducts',top_rows);
END;$$;
CREATE INDEX IF NOT EXISTS orders_branch_submitted_reporting ON ops.orders(business_id,branch_id,submitted_at) WHERE submitted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipts_branch_created_reporting ON ops.counter_receipts(business_id,branch_id,created_at);
REVOKE ALL ON FUNCTION ops.service_availability(uuid,uuid),ops.service_pause(uuid,uuid,integer,bigint),ops.protect_feedback_content(),ops.guest_feedback(uuid,uuid,uuid,text,uuid,integer,text),ops.feedback_inbox(uuid,uuid,uuid),ops.daily_service_report(uuid,uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.service_availability(uuid,uuid),ops.guest_feedback(uuid,uuid,uuid,text,uuid,integer,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.service_pause(uuid,uuid,integer,bigint),ops.feedback_inbox(uuid,uuid,uuid),ops.daily_service_report(uuid,uuid,date) TO authenticated;
COMMIT;
