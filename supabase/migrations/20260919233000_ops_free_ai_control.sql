-- Free-only routing. No customer, catalogue, order or financial mutations.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_provider_check;
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_model_check;
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_check;
ALTER TABLE ops.llm_connections ALTER COLUMN secret_id DROP NOT NULL;
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_provider_check CHECK(provider IN('openai','gemini','self_hosted','openrouter_free','free_router'));
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_model_check CHECK(length(model) BETWEEN 1 AND 150);
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_free_check CHECK((provider='free_router' AND model='free-router-v1' AND secret_id IS NULL) OR(provider<>'free_router' AND secret_id IS NOT NULL));
-- Legacy paid/self-hosted keys are preserved for owner removal, never called by new Edge.
UPDATE ops.llm_connections SET enabled=false,tested_version=NULL WHERE provider<>'free_router';
ALTER TABLE ops.llm_runs DROP CONSTRAINT llm_runs_result_check;
ALTER TABLE ops.llm_runs ADD CONSTRAINT llm_runs_result_check CHECK(result IS NULL OR length(result::text)<=6000000);
CREATE TABLE ops.ai_free_routes(
 business_id uuid NOT NULL,branch_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN('groq_free','gemini_free','openrouter_free','cloudflare_free')),
 model text NOT NULL,priority integer NOT NULL CHECK(priority BETWEEN 1 AND 100),secret_id uuid NOT NULL,
 credential_fingerprint text NOT NULL,account_id text,enabled boolean NOT NULL DEFAULT false,
 public_content_allowed boolean NOT NULL DEFAULT false,private_content_allowed boolean NOT NULL DEFAULT false,
 attested_until timestamptz NOT NULL,version bigint NOT NULL DEFAULT 1,daily_limit integer NOT NULL CHECK(daily_limit BETWEEN 1 AND 50),
 updated_by uuid NOT NULL REFERENCES auth.users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,branch_id,provider),FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK((provider='groq_free' AND model IN('openai/gpt-oss-20b','openai/gpt-oss-120b')) OR(provider='gemini_free' AND model IN('gemini-2.5-flash','gemini-2.5-flash-lite')) OR(provider='openrouter_free' AND model='openrouter/free') OR(provider='cloudflare_free' AND model='@cf/black-forest-labs/flux-2-klein-4b')),
 CHECK(provider<>'gemini_free' OR NOT private_content_allowed),
 CHECK(provider<>'cloudflare_free' OR daily_limit<=3),
 CHECK((provider='cloudflare_free' AND account_id ~ '^[a-f0-9]{32}$') OR(provider<>'cloudflare_free' AND account_id IS NULL))
);
CREATE TABLE ops.ai_free_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES ops.llm_runs(id),business_id uuid NOT NULL,branch_id uuid NOT NULL,provider text NOT NULL,
 route_version bigint NOT NULL,credential_fingerprint text NOT NULL,state text NOT NULL DEFAULT 'sending' CHECK(state IN('sending','success','rejected','unknown')),
 error_code text,model text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(run_id,provider),FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);
CREATE INDEX free_ai_quota ON ops.ai_free_attempts(credential_fingerprint,created_at);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['ai_free_routes','ai_free_attempts'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ops.%I TO service_role',t);
 EXECUTE format('CREATE POLICY free_ai_deny ON ops.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
END LOOP;END;$$;
CREATE FUNCTION ops.free_ai_settings(p_business_id uuid,p_branch_id uuid,p_action text DEFAULT 'status',p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;r ops.ai_free_routes%ROWTYPE;provider_name text;k text;sid uuid;fp text;v bigint;owner_ok boolean;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 owner_ok:=ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner']);
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
    sid:=vault.create_secret(k,'menugo-free-ai-'||gen_random_uuid()::text,'Owner supplied no-billing provider credential');
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
  INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'free-ai-'||p_action,jsonb_build_object('provider',provider_name));
 END IF;
 RETURN jsonb_build_object('canManage',owner_ok,'version',coalesce((SELECT version::text FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id),'0'), 'paidFallback',false,'routes',
 (SELECT coalesce(jsonb_agg(jsonb_build_object('provider',f.provider,'model',f.model,'priority',f.priority,'enabled',f.enabled,'hasKey',true,'accountId',f.account_id,'publicContentAllowed',f.public_content_allowed,'privateContentAllowed',f.private_content_allowed,'attestedUntil',f.attested_until,'dailyLimit',f.daily_limit,'lastSuccessAt',(SELECT max(a.finished_at) FROM ops.ai_free_attempts a WHERE a.business_id=f.business_id AND a.branch_id=f.branch_id AND a.provider=f.provider AND a.route_version=f.version AND a.state='success')) ORDER BY priority,provider),'[]'::jsonb) FROM ops.ai_free_routes f WHERE business_id=p_business_id AND branch_id=p_branch_id));
END;$$;
CREATE FUNCTION ops.free_ai_attempt(p_run_id uuid,p_lease uuid,p_provider text,p_version bigint,p_action text,p_error text DEFAULT NULL,p_model text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE r ops.llm_runs%ROWTYPE;f ops.ai_free_routes%ROWTYPE;a ops.ai_free_attempts%ROWTYPE;lim int;
BEGIN
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.state<>'sending' OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_LEASE_LOST';END IF;
 IF p_action='start' THEN
  IF NOT EXISTS(SELECT 1 FROM ops.branch_staff WHERE business_id=r.business_id AND branch_id=r.branch_id AND user_id=r.actor_id AND active AND role IN('owner','manager')) THEN RETURN jsonb_build_object('allowed',false);END IF;
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
CREATE OR REPLACE FUNCTION ops.llm_settings(p_business_id uuid,p_branch_id uuid,p_action text DEFAULT 'status',p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;k text;s uuid;v bigint;is_owner boolean;used integer;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 is_owner:=ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner']);
 PERFORM pg_advisory_xact_lock(hashtextextended('llm:config:'||p_business_id::text||p_branch_id::text,0));
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF p_action<>'status' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_FREE_SETTINGS_REQUIRED';END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id;
 SELECT count(*) INTO used FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul';
 RETURN jsonb_build_object('configured',coalesce(c.provider='free_router',false) AND EXISTS(SELECT 1 FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id AND enabled AND attested_until>clock_timestamp()),'enabled',coalesce(c.enabled,false),'provider',c.provider,'model',c.model,
  'version',coalesce(c.version,0)::text,'canManage',is_owner,'verified',c.tested_version=c.version AND c.tested_at IS NOT NULL,
  'testedAt',c.tested_at,'testError',c.last_test_error,'dailyLimit',coalesce(c.daily_limit,30),'usedToday',used,'imageConfigured',EXISTS(SELECT 1 FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id AND provider='cloudflare_free' AND enabled AND private_content_allowed AND attested_until>clock_timestamp()),'freeOnly',true);
END;$$;
CREATE OR REPLACE FUNCTION ops.llm_claim(p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_kind text,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;r ops.llm_runs%ROWTYPE;h text;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
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
 IF NOT EXISTS(SELECT 1 FROM ops.branch_staff s WHERE s.business_id=r.business_id AND s.branch_id=r.branch_id AND s.user_id=r.actor_id AND s.active AND s.role IN('owner','manager')) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
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
CREATE OR REPLACE FUNCTION ops.llm_finish(p_run_id uuid,p_lease uuid,p_result jsonb DEFAULT NULL,p_error text DEFAULT NULL,p_input bigint DEFAULT 0,p_output bigint DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE r ops.llm_runs%ROWTYPE;st text;
BEGIN
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.lease_token IS DISTINCT FROM p_lease OR r.state NOT IN('reserved','sending') OR r.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_LEASE_LOST';END IF;
 IF p_error IS NOT NULL AND p_error!~'^[A-Z0-9_]{1,80}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_RESULT';END IF;
 IF (p_error IS NULL AND (p_result IS NULL OR length(p_result::text)>6000000)) OR p_input<0 OR p_output<0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_RESULT';END IF;
 st:=CASE WHEN p_error IS NULL THEN 'succeeded' WHEN p_error IN('LLM_RESULT_UNKNOWN','LLM_SAVE_UNKNOWN') THEN 'unknown' ELSE 'failed' END;
 UPDATE ops.llm_runs SET provider=coalesce((SELECT a.provider FROM ops.ai_free_attempts a WHERE a.run_id=r.id AND a.state='success' ORDER BY a.finished_at DESC LIMIT 1),provider),model=coalesce((SELECT a.model FROM ops.ai_free_attempts a WHERE a.run_id=r.id AND a.state='success' ORDER BY a.finished_at DESC LIMIT 1),model),state=st,result=p_result,error_code=p_error,input_tokens=p_input,output_tokens=p_output,finished_at=clock_timestamp() WHERE id=r.id;
 IF r.kind='test' THEN
 UPDATE ops.llm_connections SET tested_at=CASE WHEN st='succeeded' THEN clock_timestamp() ELSE NULL END,tested_version=CASE WHEN st='succeeded' THEN version ELSE NULL END,last_test_error=p_error WHERE business_id=r.business_id AND branch_id=r.branch_id AND version=r.connection_version;
 END IF;
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id;
 RETURN jsonb_build_object('id',r.id,'state',st,'result',p_result,'error',p_error,'provider',r.provider,'model',r.model,'inputTokens',p_input::text,'outputTokens',p_output::text);
END;$$;
REVOKE ALL ON FUNCTION ops.free_ai_settings(uuid,uuid,text,jsonb),ops.free_ai_attempt(uuid,uuid,text,bigint,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.free_ai_settings(uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.free_ai_attempt(uuid,uuid,text,bigint,text,text,text) TO service_role;

CREATE FUNCTION ops.studio_free_source_retention() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.state='discarded' THEN NEW.request:=NEW.request-'modelAttachment'-'attachment';END IF;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION ops.studio_free_source_retention() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER studio_free_source_retention BEFORE UPDATE ON ops.studio_jobs
FOR EACH ROW EXECUTE FUNCTION ops.studio_free_source_retention();

COMMIT;
