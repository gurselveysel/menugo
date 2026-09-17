BEGIN;
-- Exact server-side quote; never creates a charge and does not imply a PSP is connected.
CREATE FUNCTION ops.payment_quote(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_share_id uuid,p_tip_bps integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s ops.checkout_shares%ROWTYPE;tip bigint;
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 PERFORM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 SELECT * INTO s FROM ops.checkout_shares WHERE id=p_share_id AND check_id=p_check_id AND business_id=p_business_id AND branch_id=p_branch_id;
 IF s.id IS NULL OR s.payer_user_id IS DISTINCT FROM auth.uid() THEN RAISE SQLSTATE 'PT404' USING MESSAGE='SHARE_NOT_FOUND';END IF;
 IF p_tip_bps IS NULL OR p_tip_bps NOT IN(0,500,1000,1500) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_TIP';END IF;
 tip:=(s.base_minor/10000::bigint)*p_tip_bps::bigint+((s.base_minor%10000::bigint)*p_tip_bps::bigint+5000::bigint)/10000::bigint;
 RETURN jsonb_build_object('baseMinor',s.base_minor::text,'tipMinor',tip::text,'amountMinor',(s.base_minor+tip)::text,'currency','TRY');
END;$$;
REVOKE ALL ON FUNCTION ops.payment_quote(uuid,uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.payment_quote(uuid,uuid,uuid,uuid,integer) TO authenticated;
-- Worker commands are service-only; customer payloads cannot select these RPCs.
CREATE FUNCTION ops.crm_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE q ops.crm_outbox%ROWTYPE;
BEGIN
 WITH candidate AS(SELECT o.id FROM ops.crm_outbox o JOIN ops.crm_campaigns c ON c.id=o.campaign_id
 JOIN ops.integration_features f ON f.business_id=o.business_id AND f.branch_id=o.branch_id
 WHERE ((o.state='queued') OR (o.state='leased' AND o.lease_until<=clock_timestamp())) AND o.attempts<5
 AND c.mode='live' AND f.sms_enabled
 ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1)
 UPDATE ops.crm_outbox o SET state='leased',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',attempts=o.attempts+1,updated_at=clock_timestamp()
 FROM candidate WHERE o.id=candidate.id RETURNING o.* INTO q;
 IF NOT FOUND THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',q.id,'leaseToken',q.lease_token,'businessId',q.business_id,'branchId',q.branch_id,'customerId',q.customer_id,'idempotencyKey',q.idempotency_key,'campaignId',q.campaign_id);
END;$$;
CREATE FUNCTION ops.crm_finish(p_id uuid,p_token uuid,p_state text,p_provider_ref text,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n integer;
BEGIN
 IF p_state NOT IN('accepted','unknown','failed') OR length(coalesce(p_reason,''))>120 OR length(coalesce(p_provider_ref,''))>200 THEN RAISE EXCEPTION 'INVALID_SMS_RESULT';END IF;
 IF p_state='accepted' AND coalesce(length(p_provider_ref),0)=0 THEN RAISE EXCEPTION 'PROVIDER_REFERENCE_REQUIRED';END IF;
 -- Unknown remains fenced even if a worker returns after its lease expired.
 UPDATE ops.crm_outbox SET state=p_state,provider_ref=p_provider_ref,reason=p_reason,accepted_at=CASE WHEN p_state='accepted' THEN clock_timestamp() ELSE NULL END,
 updated_at=clock_timestamp() WHERE id=p_id AND lease_token=p_token AND state IN('sending','unknown');
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n=1;
END;$$;
REVOKE ALL ON FUNCTION ops.crm_claim(),ops.crm_finish(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.crm_claim(),ops.crm_finish(uuid,uuid,text,text,text) TO service_role;
-- Do not silently change an existing IYS snapshot without invalidating queued versions.
CREATE FUNCTION ops.crm_bump_iys() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF (NEW.business_id,NEW.branch_id,NEW.customer_id) IS DISTINCT FROM (OLD.business_id,OLD.branch_id,OLD.customer_id) THEN RAISE EXCEPTION 'IMMUTABLE_IYS_SCOPE';END IF;
 NEW.version:=OLD.version+CASE WHEN (NEW.decision,NEW.brand_ref) IS DISTINCT FROM (OLD.decision,OLD.brand_ref) THEN 1 ELSE 0 END;
 RETURN NEW;END;$$;
CREATE TRIGGER iys_revision BEFORE UPDATE ON ops.crm_iys_permissions FOR EACH ROW EXECUTE FUNCTION ops.crm_bump_iys();
REVOKE ALL ON FUNCTION ops.crm_bump_iys() FROM PUBLIC,anon,authenticated;
COMMIT;
