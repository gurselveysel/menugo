-- Free-router extension. No catalogue, price, order, payment, social-post or DNS changes.
-- Extends existing Vault-backed direct connection and committed run/lease ledger.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_provider_check;
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_model_check;
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_check;
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_provider_check CHECK(provider IN('openai','gemini','self_hosted','openrouter_free'));
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_model_check CHECK(model IN('gpt-4.1-mini','gpt-4.1','gemini-2.5-flash','qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B','openrouter/free'));
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_check CHECK((provider='openai' AND model IN('gpt-4.1-mini','gpt-4.1')) OR (provider='gemini' AND model='gemini-2.5-flash') OR (provider='self_hosted' AND model IN('qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B')) OR (provider='openrouter_free' AND model='openrouter/free'));
ALTER TABLE ops.llm_runs DROP CONSTRAINT llm_runs_kind_check;
ALTER TABLE ops.llm_runs ADD CONSTRAINT llm_runs_kind_check CHECK(kind IN('test','assistant','menu-extract','studio'));
CREATE OR REPLACE FUNCTION ops.llm_settings(p_business_id uuid,p_branch_id uuid,p_action text DEFAULT 'status',p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;k text;s uuid;v bigint;is_owner boolean;used integer;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 is_owner:=ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner']);
 PERFORM pg_advisory_xact_lock(hashtextextended('llm:config:'||p_business_id::text||p_branch_id::text,0));
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF p_action<>'status' THEN
  IF NOT is_owner THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_REQUIRED';END IF;
  IF (p_payload->>'version')::bigint IS DISTINCT FROM coalesce(c.version,0) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_CONFIG_CHANGED';END IF;
  IF p_action='save' THEN
   IF p_payload->>'consent' IS DISTINCT FROM 'true' OR p_payload->>'provider' NOT IN('openai','gemini','self_hosted','openrouter_free')
    OR NOT ((p_payload->>'provider'='openai' AND p_payload->>'model' IN('gpt-4.1-mini','gpt-4.1')) OR (p_payload->>'provider'='gemini' AND p_payload->>'model'='gemini-2.5-flash') OR (p_payload->>'provider'='self_hosted' AND p_payload->>'model' IN('qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B')) OR (p_payload->>'provider'='openrouter_free' AND p_payload->>'model'='openrouter/free'))
    OR jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean'
    OR coalesce(p_payload->>'dailyLimit','')!~'^[0-9]{1,3}$' OR (p_payload->>'dailyLimit')::integer NOT BETWEEN 1 AND 100
    THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_SETTINGS';END IF;
   k:=nullif(btrim(p_payload->>'apiKey'),'');
   IF k IS NOT NULL AND (length(k) NOT BETWEEN 20 AND 512 OR k ~ '[[:space:][:cntrl:]]') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_KEY';END IF;
   IF k IS NULL AND (c.secret_id IS NULL OR c.provider<>p_payload->>'provider') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='LLM_KEY_REQUIRED';END IF;
   s:=c.secret_id;SELECT greatest(coalesce(c.version,0),coalesce(max(connection_version),0))+1 INTO v FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id;
   IF k IS NOT NULL THEN
    -- Never return secret_id or decrypted key through an authenticated RPC.
    s:=vault.create_secret(k,'menugo-llm-'||gen_random_uuid()::text,'Owner supplied LLM credential');
   END IF;
   INSERT INTO ops.llm_connections(business_id,branch_id,provider,model,secret_id,enabled,daily_limit,version,updated_by)
    VALUES(p_business_id,p_branch_id,p_payload->>'provider',p_payload->>'model',s,(p_payload->>'enabled')::boolean,(p_payload->>'dailyLimit')::integer,v,auth.uid())
    ON CONFLICT(business_id,branch_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model,secret_id=EXCLUDED.secret_id,enabled=EXCLUDED.enabled,daily_limit=EXCLUDED.daily_limit,version=EXCLUDED.version,tested_version=NULL,tested_at=NULL,last_test_error=NULL,updated_by=auth.uid(),updated_at=clock_timestamp();
   IF k IS NOT NULL AND c.secret_id IS NOT NULL THEN DELETE FROM vault.secrets WHERE id=c.secret_id;END IF;
  ELSIF p_action='disconnect' THEN
   IF c.secret_id IS NOT NULL THEN DELETE FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id;DELETE FROM vault.secrets WHERE id=c.secret_id;END IF;
  ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_ACTION';END IF;
  INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'llm-'||p_action,jsonb_build_object('provider',p_payload->>'provider'));
 END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id;
 SELECT count(*) INTO used FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul';
 RETURN jsonb_build_object('configured',c.secret_id IS NOT NULL,'enabled',coalesce(c.enabled,false),'provider',c.provider,'model',c.model,
  'version',coalesce(c.version,0)::text,'canManage',is_owner,'verified',c.tested_version=c.version AND c.tested_at IS NOT NULL,
  'testedAt',c.tested_at,'testError',c.last_test_error,'dailyLimit',coalesce(c.daily_limit,30),'usedToday',used);
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
 IF c.provider NOT IN('self_hosted','openrouter_free') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_OPEN_SOURCE_REQUIRED';END IF;
 IF NOT c.enabled THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_DISABLED';END IF;
 IF p_kind<>'test' AND c.tested_version IS DISTINCT FROM c.version THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_TEST_REQUIRED';END IF;
 IF (SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul')>=c.daily_limit THEN RAISE SQLSTATE 'PT429' USING MESSAGE='LLM_DAILY_LIMIT';END IF;
 IF (SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>clock_timestamp()-interval '1 minute')>=5 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='LLM_RATE_LIMIT';END IF;
 IF (SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND state IN('reserved','sending') AND lease_until>clock_timestamp())>=2 THEN RAISE SQLSTATE 'PT429' USING MESSAGE='LLM_BUSY';END IF;
 INSERT INTO ops.llm_runs(business_id,branch_id,actor_id,operation_id,request,request_hash,provider,model,connection_version,kind)
 VALUES(p_business_id,p_branch_id,auth.uid(),p_operation_id,p_request,h,c.provider,c.model,c.version,p_kind) RETURNING * INTO r;
 RETURN jsonb_build_object('claimed',true,'id',r.id,'lease',r.lease_token,'provider',r.provider,'model',r.model,'inputTokens',r.input_tokens::text,'outputTokens',r.output_tokens::text);
END;$$;
-- Backend-only capability. Even an owner cannot read this RPC via their JWT.
CREATE OR REPLACE FUNCTION ops.llm_dispatch(p_run_id uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE r ops.llm_runs%ROWTYPE;c ops.llm_connections%ROWTYPE;k text;j ops.menu_import_jobs%ROWTYPE;sj ops.studio_jobs%ROWTYPE;context jsonb:='{}';
BEGIN
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.lease_token IS DISTINCT FROM p_lease OR r.state<>'reserved' OR r.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_ALREADY_DISPATCHED';END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.branch_staff s WHERE s.business_id=r.business_id AND s.branch_id=r.branch_id AND s.user_id=r.actor_id AND s.active AND s.role IN('owner','manager')) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=r.business_id AND branch_id=r.branch_id FOR SHARE;
 IF NOT FOUND OR c.version<>r.connection_version OR NOT c.enabled THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_CONFIG_CHANGED';END IF;
 IF c.provider NOT IN('self_hosted','openrouter_free') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_OPEN_SOURCE_REQUIRED';END IF;
 IF r.kind='menu-extract' THEN
  SELECT * INTO j FROM ops.menu_import_jobs WHERE business_id=r.business_id AND branch_id=r.branch_id AND id=(r.request->>'importId')::uuid;
  IF NOT FOUND OR j.status<>'processing' OR j.lease_token IS DISTINCT FROM (r.request->>'importLease')::uuid OR j.lease_until<=clock_timestamp() OR j.source_base64 IS NULL OR j.source_expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_LEASE_LOST';END IF;
  context:=jsonb_build_object('mime',j.mime,'data',j.source_base64);
 ELSIF r.kind='studio' THEN
  SELECT * INTO sj FROM ops.studio_jobs WHERE business_id=r.business_id AND branch_id=r.branch_id AND id=(r.request->>'studioId')::uuid;
  IF NOT FOUND OR sj.created_by<>r.actor_id OR sj.state<>'running' OR sj.lease_token IS DISTINCT FROM (r.request->>'studioLease')::uuid OR sj.lease_until<=clock_timestamp() OR sj.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_LEASE_LOST';END IF;
  IF sj.kind='photo-enhance' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_IMAGE_ENGINE_REQUIRED';END IF;
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
 SELECT decrypted_secret INTO k FROM vault.decrypted_secrets WHERE id=c.secret_id;
 IF k IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_KEY_REQUIRED';END IF;
 UPDATE ops.llm_runs SET state='sending' WHERE id=r.id;
 RETURN jsonb_build_object('key',k,'provider',c.provider,'model',c.model,'request',r.request,'context',context,'kind',r.kind);
END;$$;

REVOKE ALL ON FUNCTION ops.llm_settings(uuid,uuid,text,jsonb),ops.llm_claim(uuid,uuid,uuid,text,jsonb),ops.llm_dispatch(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.llm_settings(uuid,uuid,text,jsonb),ops.llm_claim(uuid,uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.llm_dispatch(uuid,uuid) TO service_role;
COMMIT;
