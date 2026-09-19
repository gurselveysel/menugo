-- AI control plane: platform staff is independent from restaurant staff.
-- No automatic owner/email promotion; bootstrap is a separate audited admin step.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.platform_staff(
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN('platform_owner','ai_admin')),
 active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 granted_by uuid REFERENCES auth.users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 500)
);
CREATE TABLE ops.platform_audit_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_user_id uuid REFERENCES auth.users(id),
 target_user_id uuid REFERENCES auth.users(id),
 business_id uuid,branch_id uuid,
 action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ops.platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.platform_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.platform_staff,ops.platform_audit_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON ops.platform_staff,ops.platform_audit_events TO service_role;
CREATE POLICY platform_staff_closed ON ops.platform_staff AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY platform_audit_closed ON ops.platform_audit_events AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE FUNCTION ops.platform_membership_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO ops.platform_audit_events(actor_user_id,target_user_id,action,details)
 VALUES(auth.uid(),coalesce(NEW.user_id,OLD.user_id),'platform-member-'||lower(TG_OP),
 jsonb_build_object('role',coalesce(NEW.role,OLD.role),'active',CASE WHEN TG_OP='DELETE' THEN false ELSE NEW.active END));
 RETURN coalesce(NEW,OLD);
END;$$;
CREATE TRIGGER platform_membership_audit AFTER INSERT OR UPDATE OR DELETE ON ops.platform_staff FOR EACH ROW EXECUTE FUNCTION ops.platform_membership_audit();
CREATE FUNCTION ops.platform_audit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'PLATFORM_AUDIT_APPEND_ONLY';END;$$;
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.platform_audit_events FOR EACH STATEMENT EXECUTE FUNCTION ops.platform_audit_immutable();
CREATE FUNCTION ops.platform_ai_actor(p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM ops.platform_staff p JOIN auth.users u ON u.id=p.user_id
 WHERE p.user_id=p_actor AND p.active AND p.role IN('platform_owner','ai_admin') AND u.email_confirmed_at IS NOT NULL);
$$;
CREATE FUNCTION ops.platform_principal() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 IF NOT ops.platform_ai_actor(auth.uid()) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_ADMIN_REQUIRED';END IF;
 SELECT role INTO r FROM ops.platform_staff WHERE user_id=auth.uid();
 RETURN jsonb_build_object('userId',auth.uid(),'role',r,'canManageAi',true);
END;$$;
CREATE FUNCTION ops.platform_assert_ai(p_business_id uuid,p_branch_id uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM ops.platform_principal();
 IF NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
END;$$;
CREATE FUNCTION ops.platform_ai_console() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE principal jsonb;BEGIN
 principal:=ops.platform_principal();
 RETURN principal||jsonb_build_object('branches',(SELECT coalesce(jsonb_agg(jsonb_build_object('businessId',s.business_id,'branchId',s.branch_id,'name',b.name) ORDER BY b.name,s.branch_id),'[]'::jsonb) FROM ops.branch_settings s JOIN public.branches b ON b.id=s.branch_id AND b.business_id=s.business_id));
END;$$;
REVOKE ALL ON FUNCTION ops.platform_membership_audit(),ops.platform_audit_immutable(),ops.platform_ai_actor(uuid),ops.platform_principal(),ops.platform_assert_ai(uuid,uuid),ops.platform_ai_console() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.platform_principal(),ops.platform_ai_console() TO authenticated;
GRANT EXECUTE ON FUNCTION ops.platform_ai_actor(uuid) TO service_role;
CREATE OR REPLACE FUNCTION ops.free_ai_settings(p_business_id uuid,p_branch_id uuid,p_action text DEFAULT 'status',p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;r ops.ai_free_routes%ROWTYPE;provider_name text;k text;sid uuid;fp text;v bigint;owner_ok boolean;
BEGIN
 PERFORM ops.platform_assert_ai(p_business_id,p_branch_id);
 owner_ok:=true;
 PERFORM pg_advisory_xact_lock(hashtextextended('llm:config:'||p_business_id::text||p_branch_id::text,0));
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF p_action<>'status' THEN
  IF NOT owner_ok THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_REQUIRED';END IF;
  IF coalesce(p_payload->>'version','')!~'^(0|[1-9][0-9]{0,18})$' OR(p_payload->>'version')::bigint IS DISTINCT FROM coalesce(c.version,0) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_CONFIG_CHANGED';END IF;
  provider_name:=p_payload->>'provider';
  IF provider_name IS NULL OR provider_name NOT IN('groq_free','gemini_free','openrouter_free','cloudflare_free') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='LLM_PAID_PROVIDER_BLOCKED';END IF;
  SELECT * INTO r FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id AND provider=provider_name FOR UPDATE;
  IF p_action='save' THEN
   IF p_payload->>'freePlanConfirmed' IS DISTINCT FROM 'true' OR p_payload->>'consent' IS DISTINCT FROM 'true' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='LLM_FREE_PLAN_RECONFIRM';END IF;
   IF jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_payload->'publicContentAllowed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_payload->'privateContentAllowed') IS DISTINCT FROM 'boolean'
    OR coalesce(p_payload->>'priority','')!~'^[0-9]{1,3}$' OR(p_payload->>'priority')::int NOT BETWEEN 1 AND 100
    OR coalesce(p_payload->>'dailyLimit','')!~'^[0-9]{1,2}$' OR(p_payload->>'dailyLimit')::int NOT BETWEEN 1 AND 50 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_SETTINGS';END IF;
   k:=nullif(p_payload->>'apiKey','');sid:=r.secret_id;fp:=r.credential_fingerprint;
   IF k IS NOT NULL THEN
    IF length(k) NOT BETWEEN 20 AND 512 OR k~'[[:space:][:cntrl:]]' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_KEY';END IF;
    sid:=vault.create_secret(k,'menugo-free-ai-'||gen_random_uuid()::text,'MenuGO platform-managed no-billing provider credential');
    fp:=encode(sha256(convert_to(provider_name||':'||k,'UTF8')),'hex');
   ELSIF sid IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='LLM_KEY_REQUIRED';END IF;
   INSERT INTO ops.ai_free_routes(business_id,branch_id,provider,model,priority,secret_id,credential_fingerprint,account_id,enabled,public_content_allowed,private_content_allowed,attested_until,version,daily_limit,updated_by)
   VALUES(p_business_id,p_branch_id,provider_name,p_payload->>'model',(p_payload->>'priority')::int,sid,fp,nullif(lower(p_payload->>'accountId'),''),(p_payload->>'enabled')::boolean,(p_payload->>'publicContentAllowed')::boolean,(p_payload->>'privateContentAllowed')::boolean,clock_timestamp()+interval '30 days',coalesce(r.version,0)+1,(p_payload->>'dailyLimit')::int,auth.uid())
   ON CONFLICT(business_id,branch_id,provider) DO UPDATE SET model=EXCLUDED.model,priority=EXCLUDED.priority,secret_id=EXCLUDED.secret_id,credential_fingerprint=EXCLUDED.credential_fingerprint,account_id=EXCLUDED.account_id,enabled=EXCLUDED.enabled,public_content_allowed=EXCLUDED.public_content_allowed,private_content_allowed=EXCLUDED.private_content_allowed,attested_until=EXCLUDED.attested_until,version=EXCLUDED.version,daily_limit=EXCLUDED.daily_limit,updated_by=auth.uid(),updated_at=clock_timestamp();
   IF k IS NOT NULL AND r.secret_id IS NOT NULL THEN DELETE FROM vault.secrets WHERE id=r.secret_id;END IF;
  ELSIF p_action='remove' THEN
   DELETE FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id AND provider=provider_name;
   DELETE FROM vault.secrets WHERE id=r.secret_id;
  ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_ACTION';END IF;
  SELECT greatest(coalesce(c.version,0),coalesce(max(connection_version),0))+1 INTO v FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id;
  INSERT INTO ops.llm_connections(business_id,branch_id,provider,model,secret_id,enabled,version,daily_limit,updated_by)
   VALUES(p_business_id,p_branch_id,'free_router','free-router-v1',NULL,true,v,50,auth.uid())
   ON CONFLICT(business_id,branch_id) DO UPDATE SET provider='free_router',model='free-router-v1',secret_id=NULL,enabled=true,version=v,tested_version=NULL,tested_at=NULL,last_test_error=NULL,updated_by=auth.uid(),updated_at=clock_timestamp();
  IF c.secret_id IS NOT NULL THEN DELETE FROM vault.secrets WHERE id=c.secret_id;END IF;
  INSERT INTO ops.platform_audit_events(business_id,branch_id,actor_user_id,action,details) VALUES(p_business_id,p_branch_id,auth.uid(),'free-ai-'||p_action,jsonb_build_object('provider',provider_name));
 END IF;
 RETURN jsonb_build_object('canManage',owner_ok,'version',coalesce((SELECT version::text FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id),'0'), 'paidFallback',false,'routes',
 (SELECT coalesce(jsonb_agg(jsonb_build_object('provider',f.provider,'model',f.model,'priority',f.priority,'enabled',f.enabled,'hasKey',true,'accountId',f.account_id,'publicContentAllowed',f.public_content_allowed,'privateContentAllowed',f.private_content_allowed,'attestedUntil',f.attested_until,'dailyLimit',f.daily_limit,'lastSuccessAt',(SELECT max(a.finished_at) FROM ops.ai_free_attempts a WHERE a.business_id=f.business_id AND a.branch_id=f.branch_id AND a.provider=f.provider AND a.route_version=f.version AND a.state='success')) ORDER BY priority,provider),'[]'::jsonb) FROM ops.ai_free_routes f WHERE business_id=p_business_id AND branch_id=p_branch_id));
END;$$;

CREATE OR REPLACE FUNCTION ops.llm_settings(p_business_id uuid,p_branch_id uuid,p_action text DEFAULT 'status',p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;k text;s uuid;v bigint;is_owner boolean;used integer;
BEGIN
 is_owner:=ops.platform_ai_actor(auth.uid());
 IF is_owner THEN PERFORM ops.platform_assert_ai(p_business_id,p_branch_id); ELSE PERFORM ops.import_assert_manager(p_business_id,p_branch_id); END IF;
 IF p_action<>'status' AND NOT is_owner THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_ADMIN_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('llm:config:'||p_business_id::text||p_branch_id::text,0));
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF p_action<>'status' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_FREE_SETTINGS_REQUIRED';END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id;
 SELECT count(*) INTO used FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul';
 RETURN jsonb_build_object('configured',coalesce(c.provider='free_router',false) AND EXISTS(SELECT 1 FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id AND enabled AND attested_until>clock_timestamp()),'enabled',coalesce(c.enabled,false),'provider',c.provider,'model',CASE WHEN is_owner THEN c.model ELSE NULL END,
  'version',CASE WHEN is_owner THEN coalesce(c.version,0)::text ELSE '0' END,'canManage',is_owner,'verified',c.tested_version=c.version AND c.tested_at IS NOT NULL,
  'testedAt',c.tested_at,'testError',CASE WHEN is_owner THEN c.last_test_error ELSE NULL END,'dailyLimit',coalesce(c.daily_limit,30),'usedToday',used,'imageConfigured',EXISTS(SELECT 1 FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id AND provider='cloudflare_free' AND enabled AND private_content_allowed AND attested_until>clock_timestamp()),'freeOnly',true);
END;$$;

CREATE OR REPLACE FUNCTION ops.llm_claim(p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_kind text,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;r ops.llm_runs%ROWTYPE;h text;
BEGIN
 IF p_kind='test' THEN PERFORM ops.platform_assert_ai(p_business_id,p_branch_id); ELSE PERFORM ops.import_assert_manager(p_business_id,p_branch_id); END IF;
 IF p_kind IS NULL OR p_kind NOT IN('test','assistant','menu-extract','studio') OR p_operation_id IS NULL OR p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR length(p_request::text)>10000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_REQUEST';END IF;
 h:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'request',p_request)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('llm:run:'||auth.uid()::text||p_operation_id::text,0));
 SELECT * INTO r FROM ops.llm_runs WHERE actor_id=auth.uid() AND operation_id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF r.business_id<>p_business_id OR r.branch_id<>p_branch_id OR r.request_hash<>h THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
  RETURN jsonb_build_object('claimed',false,'id',r.id,'state',CASE WHEN r.state IN('reserved','sending') AND r.lease_until<=clock_timestamp() THEN 'unknown' ELSE r.state END,'result',CASE WHEN r.result_expires_at>clock_timestamp() THEN r.result ELSE NULL END,'error',CASE WHEN r.result_expires_at<=clock_timestamp() THEN 'LLM_RESULT_EXPIRED' ELSE r.error_code END,'provider',r.provider,'model',r.model,'inputTokens',r.input_tokens::text,'outputTokens',r.output_tokens::text);
 END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_KEY_REQUIRED';END IF;
 IF c.provider<>'free_router' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_PAID_PROVIDER_BLOCKED';END IF;
 IF NOT c.enabled THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_DISABLED';END IF;
 IF p_kind<>'test' AND c.tested_version IS DISTINCT FROM c.version THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_TEST_REQUIRED';END IF;
 IF (SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul')>=c.daily_limit THEN RAISE SQLSTATE 'PT429' USING MESSAGE='LLM_DAILY_LIMIT';END IF;
 IF (SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>clock_timestamp()-interval '1 minute')>=5 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='LLM_RATE_LIMIT';END IF;
 IF (SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND state IN('reserved','sending') AND lease_until>clock_timestamp())>=2 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='LLM_BUSY';END IF;
 INSERT INTO ops.llm_runs(business_id,branch_id,actor_id,operation_id,request,request_hash,provider,model,connection_version,kind)
 VALUES(p_business_id,p_branch_id,auth.uid(),p_operation_id,p_request,h,c.provider,c.model,c.version,p_kind) RETURNING * INTO r;
 RETURN jsonb_build_object('claimed',true,'id',r.id,'lease',r.lease_token,'provider',r.provider,'model',r.model,'inputTokens',r.input_tokens::text,'outputTokens',r.output_tokens::text);
END;$$;

CREATE OR REPLACE FUNCTION ops.llm_dispatch(p_run_id uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE r ops.llm_runs%ROWTYPE;c ops.llm_connections%ROWTYPE;k text;j ops.menu_import_jobs%ROWTYPE;sj ops.studio_jobs%ROWTYPE;context jsonb:='{}';routes jsonb;
BEGIN
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.lease_token IS DISTINCT FROM p_lease OR r.state<>'reserved' OR r.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_ALREADY_DISPATCHED';END IF;
 IF r.kind='test' THEN
 IF NOT ops.platform_ai_actor(r.actor_id) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_ADMIN_REQUIRED';END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM ops.branch_staff s WHERE s.business_id=r.business_id AND s.branch_id=r.branch_id AND s.user_id=r.actor_id AND s.active AND s.role IN('owner','manager')) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=r.business_id AND branch_id=r.branch_id FOR SHARE;
 IF NOT FOUND OR c.version<>r.connection_version OR NOT c.enabled THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_CONFIG_CHANGED';END IF;
 IF c.provider<>'free_router' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_PAID_PROVIDER_BLOCKED';END IF;
 IF r.kind='menu-extract' THEN
  SELECT * INTO j FROM ops.menu_import_jobs WHERE business_id=r.business_id AND branch_id=r.branch_id AND id=(r.request->>'importId')::uuid;
  IF NOT FOUND OR j.status<>'processing' OR j.lease_token IS DISTINCT FROM (r.request->>'importLease')::uuid OR j.lease_until<=clock_timestamp() OR j.source_base64 IS NULL OR j.source_expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_LEASE_LOST';END IF;
  context:=jsonb_build_object('mime',j.mime,'data',j.source_base64);
 ELSIF r.kind='studio' THEN
  SELECT * INTO sj FROM ops.studio_jobs WHERE business_id=r.business_id AND branch_id=r.branch_id AND id=(r.request->>'studioId')::uuid;
  IF NOT FOUND OR sj.created_by<>r.actor_id OR sj.state<>'running' OR sj.lease_token IS DISTINCT FROM (r.request->>'studioLease')::uuid OR sj.lease_until<=clock_timestamp() OR sj.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_LEASE_LOST';END IF;
  context:=jsonb_build_object('studioKind',sj.kind,'sources',sj.source_snapshot,'input',sj.request);
 ELSIF r.kind='assistant' THEN
  context:=jsonb_build_object('menu',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'categoryKey',category_key,'description',coalesce(description,''),'serving',coalesce(quantity_label,''),'options',options,'priceMinor',CASE WHEN price_approved AND approved_price IS NOT NULL THEN ops.catalog_minor(approved_price::text)::text ELSE NULL END,'available',available) ORDER BY sort_order,source_id),'[]'::jsonb) FROM public.menu_items WHERE business_id=r.business_id AND branch_id=r.branch_id),'capturedAt',clock_timestamp(),'branchName',(SELECT name FROM public.branches WHERE id=r.branch_id AND business_id=r.business_id));
  IF r.request->>'task'='daily' THEN
   -- A fixed read-only reporting function, no LLM-generated SQL or record IDs.
   PERFORM set_config('request.jwt.claim.sub',r.actor_id::text,true);
   PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',r.actor_id,'role','authenticated')::text,true);
   context:=context||jsonb_build_object('daily',ops.daily_service_report(r.business_id,r.branch_id,(r.request->>'day')::date));
  END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('provider',f.provider,'model',f.model,'priority',f.priority,'version',f.version::text,'key',v.decrypted_secret,'accountId',f.account_id,'attestedUntil',f.attested_until,'publicContentAllowed',f.public_content_allowed,'privateContentAllowed',f.private_content_allowed) ORDER BY f.priority,f.provider),'[]'::jsonb) INTO routes FROM ops.ai_free_routes f JOIN vault.decrypted_secrets v ON v.id=f.secret_id WHERE f.business_id=r.business_id AND f.branch_id=r.branch_id AND f.enabled AND f.attested_until>clock_timestamp();
 IF jsonb_array_length(routes)=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_NO_ELIGIBLE_FREE_ROUTE';END IF;
 UPDATE ops.llm_runs SET state='sending' WHERE id=r.id;
 RETURN jsonb_build_object('routes',routes,'key','','provider',c.provider,'model',c.model,'request',r.request,'context',context,'kind',r.kind);
END;$$;

CREATE OR REPLACE FUNCTION ops.free_ai_attempt(p_run_id uuid,p_lease uuid,p_provider text,p_version bigint,p_action text,p_error text DEFAULT NULL,p_model text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE r ops.llm_runs%ROWTYPE;f ops.ai_free_routes%ROWTYPE;a ops.ai_free_attempts%ROWTYPE;lim int;
BEGIN
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.state<>'sending' OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_LEASE_LOST';END IF;
 IF p_action='start' THEN
  IF r.kind='test' THEN
 IF NOT ops.platform_ai_actor(r.actor_id) THEN RETURN jsonb_build_object('allowed',false);END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM ops.branch_staff WHERE business_id=r.business_id AND branch_id=r.branch_id AND user_id=r.actor_id AND active AND role IN('owner','manager')) THEN RETURN jsonb_build_object('allowed',false);END IF;
  SELECT * INTO f FROM ops.ai_free_routes WHERE business_id=r.business_id AND branch_id=r.branch_id AND provider=p_provider FOR SHARE;
  IF NOT FOUND OR NOT f.enabled OR f.version<>p_version OR f.attested_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM ops.llm_connections c WHERE c.business_id=r.business_id AND c.branch_id=r.branch_id AND c.enabled AND c.version=r.connection_version AND c.provider='free_router') THEN RETURN jsonb_build_object('allowed',false);END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('free-ai-quota:'||f.credential_fingerprint,0));
  SELECT * INTO a FROM ops.ai_free_attempts WHERE run_id=r.id AND provider=p_provider;
  IF FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_ALREADY_DISPATCHED';END IF;
  SELECT min(daily_limit) INTO lim FROM ops.ai_free_routes WHERE credential_fingerprint=f.credential_fingerprint AND enabled;
  IF (SELECT count(*) FROM ops.ai_free_attempts WHERE credential_fingerprint=f.credential_fingerprint AND created_at>clock_timestamp()-interval '24 hours')>=lim
   OR(SELECT count(*) FROM ops.ai_free_attempts WHERE credential_fingerprint=f.credential_fingerprint AND created_at>clock_timestamp()-interval '1 minute')>=3
   OR EXISTS(SELECT 1 FROM ops.ai_free_attempts WHERE credential_fingerprint=f.credential_fingerprint AND created_at>clock_timestamp()-interval '2 minutes' AND(state IN('sending','unknown') OR error_code IN('LLM_RATE_LIMIT','LLM_KEY_INVALID','LLM_CREDIT_REQUIRED')))
   OR(SELECT count(*) FROM ops.ai_free_attempts WHERE run_id=r.id)>=3 THEN RETURN jsonb_build_object('allowed',false);END IF;
  INSERT INTO ops.ai_free_attempts(run_id,business_id,branch_id,provider,route_version,credential_fingerprint) VALUES(r.id,r.business_id,r.branch_id,p_provider,p_version,f.credential_fingerprint);
  RETURN jsonb_build_object('allowed',true);
 END IF;
 IF p_action NOT IN('success','rejected','unknown') OR (p_error IS NOT NULL AND p_error!~'^[A-Z0-9_]{1,80}$') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_RESULT';END IF;
 UPDATE ops.ai_free_attempts SET state=p_action,error_code=p_error,model=left(p_model,150),finished_at=clock_timestamp() WHERE run_id=r.id AND provider=p_provider AND state='sending';
 IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_ALREADY_DISPATCHED';END IF;
 RETURN jsonb_build_object('saved',true);
END;$$;
COMMIT;
