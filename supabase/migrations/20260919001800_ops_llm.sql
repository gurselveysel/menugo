-- Owner-managed direct LLM credentials. Supabase Vault encrypts keys at rest.
-- This migration never enables billing or changes catalogue/orders/money.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.llm_connections (
 business_id uuid NOT NULL,branch_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN('openai','gemini')),
 model text NOT NULL CHECK(model IN('gpt-4.1-mini','gpt-4.1','gemini-2.5-flash')),
 secret_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT true,
 daily_limit integer NOT NULL DEFAULT 30 CHECK(daily_limit BETWEEN 1 AND 100),
 version bigint NOT NULL DEFAULT 1,tested_version bigint,tested_at timestamptz,last_test_error text,
 updated_by uuid NOT NULL REFERENCES auth.users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,branch_id),FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK((provider='openai' AND model IN('gpt-4.1-mini','gpt-4.1')) OR (provider='gemini' AND model='gemini-2.5-flash'))
);
CREATE TABLE ops.llm_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id),operation_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(length(request::text)<=10000),request_hash text NOT NULL,
 provider text NOT NULL,model text NOT NULL,connection_version bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN('test','assistant','menu-extract')),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','sending','succeeded','failed','unknown')),
 lease_token uuid NOT NULL DEFAULT gen_random_uuid(),lease_until timestamptz NOT NULL DEFAULT now()+interval '90 seconds',
 result jsonb CHECK(result IS NULL OR length(result::text)<=350000),error_code text,
 input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0),output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 result_expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
 UNIQUE(actor_id,operation_id),FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);
CREATE INDEX llm_branch_quota ON ops.llm_runs(business_id,branch_id,created_at);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['llm_connections','llm_runs'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ops.%I TO service_role',t);
 EXECUTE format('CREATE POLICY no_direct_llm_access ON ops.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
END LOOP;END;$$;
CREATE FUNCTION ops.llm_settings(p_business_id uuid,p_branch_id uuid,p_action text DEFAULT 'status',p_payload jsonb DEFAULT '{}') RETURNS jsonb
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
   IF p_payload->>'consent' IS DISTINCT FROM 'true' OR p_payload->>'provider' NOT IN('openai','gemini')
    OR NOT ((p_payload->>'provider'='openai' AND p_payload->>'model' IN('gpt-4.1-mini','gpt-4.1')) OR (p_payload->>'provider'='gemini' AND p_payload->>'model'='gemini-2.5-flash'))
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
CREATE FUNCTION ops.llm_claim(p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_kind text,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.llm_connections%ROWTYPE;r ops.llm_runs%ROWTYPE;h text;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_kind IS NULL OR p_kind NOT IN('test','assistant','menu-extract') OR p_operation_id IS NULL OR p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR length(p_request::text)>10000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_REQUEST';END IF;
 h:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'request',p_request)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('llm:run:'||auth.uid()::text||p_operation_id::text,0));
 SELECT * INTO r FROM ops.llm_runs WHERE actor_id=auth.uid() AND operation_id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF r.business_id<>p_business_id OR r.branch_id<>p_branch_id OR r.request_hash<>h THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
  RETURN jsonb_build_object('claimed',false,'id',r.id,'state',CASE WHEN r.state IN('reserved','sending') AND r.lease_until<=clock_timestamp() THEN 'unknown' ELSE r.state END,'result',CASE WHEN r.result_expires_at>clock_timestamp() THEN r.result ELSE NULL END,'error',CASE WHEN r.result_expires_at<=clock_timestamp() THEN 'LLM_RESULT_EXPIRED' ELSE r.error_code END,'provider',r.provider,'model',r.model,'inputTokens',r.input_tokens::text,'outputTokens',r.output_tokens::text);
 END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_KEY_REQUIRED';END IF;
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
CREATE FUNCTION ops.llm_dispatch(p_run_id uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE r ops.llm_runs%ROWTYPE;c ops.llm_connections%ROWTYPE;k text;j ops.menu_import_jobs%ROWTYPE;context jsonb:='{}';
BEGIN
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.lease_token IS DISTINCT FROM p_lease OR r.state<>'reserved' OR r.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_ALREADY_DISPATCHED';END IF;
 IF NOT EXISTS(SELECT 1 FROM ops.branch_staff s WHERE s.business_id=r.business_id AND s.branch_id=r.branch_id AND s.user_id=r.actor_id AND s.active AND s.role IN('owner','manager')) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 SELECT * INTO c FROM ops.llm_connections WHERE business_id=r.business_id AND branch_id=r.branch_id FOR SHARE;
 IF NOT FOUND OR c.version<>r.connection_version OR NOT c.enabled THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_CONFIG_CHANGED';END IF;
 IF r.kind='menu-extract' THEN
  SELECT * INTO j FROM ops.menu_import_jobs WHERE business_id=r.business_id AND branch_id=r.branch_id AND id=(r.request->>'importId')::uuid;
  IF NOT FOUND OR j.status<>'processing' OR j.lease_token IS DISTINCT FROM (r.request->>'importLease')::uuid OR j.lease_until<=clock_timestamp() OR j.source_base64 IS NULL OR j.source_expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IMPORT_LEASE_LOST';END IF;
  context:=jsonb_build_object('mime',j.mime,'data',j.source_base64);
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
CREATE FUNCTION ops.llm_finish(p_run_id uuid,p_lease uuid,p_result jsonb DEFAULT NULL,p_error text DEFAULT NULL,p_input bigint DEFAULT 0,p_output bigint DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE r ops.llm_runs%ROWTYPE;st text;
BEGIN
 SELECT * INTO r FROM ops.llm_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.lease_token IS DISTINCT FROM p_lease OR r.state NOT IN('reserved','sending') OR r.lease_until<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_LEASE_LOST';END IF;
 IF p_error IS NOT NULL AND p_error!~'^[A-Z0-9_]{1,80}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_RESULT';END IF;
 IF (p_error IS NULL AND (p_result IS NULL OR length(p_result::text)>350000)) OR p_input<0 OR p_output<0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_LLM_RESULT';END IF;
 st:=CASE WHEN p_error IS NULL THEN 'succeeded' WHEN p_error IN('LLM_RESULT_UNKNOWN','LLM_SAVE_UNKNOWN') THEN 'unknown' ELSE 'failed' END;
 UPDATE ops.llm_runs SET state=st,result=p_result,error_code=p_error,input_tokens=p_input,output_tokens=p_output,finished_at=clock_timestamp() WHERE id=r.id;
 IF r.kind='test' THEN
 UPDATE ops.llm_connections SET tested_at=CASE WHEN st='succeeded' THEN clock_timestamp() ELSE NULL END,tested_version=CASE WHEN st='succeeded' THEN version ELSE NULL END,last_test_error=p_error WHERE business_id=r.business_id AND branch_id=r.branch_id AND version=r.connection_version;
 END IF;
 RETURN jsonb_build_object('id',r.id,'state',st,'result',p_result,'error',p_error,'provider',r.provider,'model',r.model,'inputTokens',p_input::text,'outputTokens',p_output::text);
END;$$;
CREATE FUNCTION ops.llm_purge_results() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n integer;BEGIN UPDATE ops.llm_runs SET result=NULL,request='{}'::jsonb WHERE result_expires_at<=clock_timestamp() AND (result IS NOT NULL OR request<>'{}'::jsonb);GET DIAGNOSTICS n=ROW_COUNT;RETURN n;END;$$;
REVOKE ALL ON FUNCTION ops.llm_settings(uuid,uuid,text,jsonb),ops.llm_claim(uuid,uuid,uuid,text,jsonb),ops.llm_dispatch(uuid,uuid),ops.llm_finish(uuid,uuid,jsonb,text,bigint,bigint),ops.llm_purge_results() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.llm_settings(uuid,uuid,text,jsonb),ops.llm_claim(uuid,uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.llm_dispatch(uuid,uuid),ops.llm_finish(uuid,uuid,jsonb,text,bigint,bigint) TO service_role;
DO $$BEGIN IF to_regclass('cron.job') IS NOT NULL THEN IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='menugo-llm-retention') THEN PERFORM cron.schedule('menugo-llm-retention','25 3 * * *','select ops.llm_purge_results();');END IF;END IF;END;$$;
COMMIT;
