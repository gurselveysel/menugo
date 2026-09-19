-- Company control plane. Additive: no catalogue, payment, or customer data changes.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE ops.platform_staff DROP CONSTRAINT platform_staff_role_check;
ALTER TABLE ops.platform_staff ADD CONSTRAINT platform_staff_role_check CHECK(role IN('platform_owner','ai_admin','ops_admin','security_admin','auditor'));

CREATE TABLE ops.platform_control_policies(
 scope_key text PRIMARY KEY,
 business_id uuid, branch_id uuid,
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 settings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings)='object'),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES auth.users(id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK((scope_key='global' AND business_id IS NULL AND branch_id IS NULL) OR
 (business_id IS NOT NULL AND branch_id IS NOT NULL AND scope_key=business_id::text||':'||branch_id::text))
);
INSERT INTO ops.platform_control_policies(scope_key,settings) VALUES('global',
 '{"aiEnabled":true,"importsEnabled":true,"studioPublicationEnabled":true,"orderingEnabled":true,"whatsappEnabled":true,"crmEvaluationEnabled":true,"dailyAiLimit":50}');
CREATE TABLE ops.platform_control_changes(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES auth.users(id), operation_id uuid NOT NULL,
 scope_key text NOT NULL, action text NOT NULL,
 request jsonb NOT NULL, before_value jsonb NOT NULL, after_value jsonb NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 300),
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,operation_id)
);
CREATE INDEX platform_control_changes_scope ON ops.platform_control_changes(scope_key,id DESC);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['platform_control_policies','platform_control_changes'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('CREATE POLICY company_no_direct_access ON ops.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
END LOOP;END;$$;
CREATE TRIGGER platform_control_changes_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.platform_control_changes FOR EACH STATEMENT EXECUTE FUNCTION ops.platform_audit_immutable();

CREATE OR REPLACE FUNCTION ops.platform_principal() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 SELECT p.role INTO r FROM ops.platform_staff p JOIN auth.users u ON u.id=p.user_id
 WHERE p.user_id=auth.uid() AND p.active AND u.email_confirmed_at IS NOT NULL;
 IF r IS NULL THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_ADMIN_REQUIRED';END IF;
 RETURN jsonb_build_object('userId',auth.uid(),'role',r,'canManageAi',r IN('platform_owner','ai_admin'),
 'canManageOperations',r IN('platform_owner','ops_admin'),'canManageSecurity',r IN('platform_owner','security_admin'),
 'canManageMembers',r='platform_owner');
END;$$;
CREATE FUNCTION ops.platform_require(p_permission text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p jsonb;BEGIN
 p:=ops.platform_principal();
 IF p_permission NOT IN('read','ai','operations','security','members') OR NOT (CASE p_permission
 WHEN 'read' THEN true WHEN 'ai' THEN (p->>'canManageAi')::boolean WHEN 'operations' THEN (p->>'canManageOperations')::boolean
 WHEN 'security' THEN (p->>'canManageSecurity')::boolean WHEN 'members' THEN (p->>'canManageMembers')::boolean ELSE false END)
 THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_PERMISSION_REQUIRED';END IF;
END;$$;
CREATE OR REPLACE FUNCTION ops.platform_assert_ai(p_business_id uuid,p_branch_id uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM ops.platform_require('ai');
 IF NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
END;$$;
CREATE OR REPLACE FUNCTION ops.platform_ai_console() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p jsonb;BEGIN
 PERFORM ops.platform_require('ai'); p:=ops.platform_principal();
 RETURN p||jsonb_build_object('branches',(SELECT coalesce(jsonb_agg(jsonb_build_object('businessId',s.business_id,'branchId',s.branch_id,'name',b.name) ORDER BY b.name,s.branch_id),'[]') FROM ops.branch_settings s JOIN public.branches b ON b.id=s.branch_id AND b.business_id=s.business_id));
END;$$;

CREATE FUNCTION ops.platform_validate_policy(p_settings jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE k text;v jsonb;BEGIN
 IF p_settings IS NULL OR jsonb_typeof(p_settings)<>'object' OR length(p_settings::text)>2000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_POLICY';END IF;
 FOR k,v IN SELECT * FROM jsonb_each(p_settings) LOOP
  IF k IN('aiEnabled','importsEnabled','studioPublicationEnabled','orderingEnabled','whatsappEnabled','crmEvaluationEnabled') THEN
   IF jsonb_typeof(v)<>'boolean' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_POLICY';END IF;
  ELSIF k='dailyAiLimit' THEN
   IF jsonb_typeof(v)<>'number' OR v::text!~'^[0-9]{1,2}$' OR (v::text)::int NOT BETWEEN 1 AND 50 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_LIMIT';END IF;
  ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_PLATFORM_SETTING';END IF;
 END LOOP;
END;$$;
CREATE FUNCTION ops.platform_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 PERFORM ops.platform_validate_policy(NEW.settings);
 IF NEW.scope_key='global' AND NOT NEW.settings ?& ARRAY['aiEnabled','importsEnabled','studioPublicationEnabled','orderingEnabled','whatsappEnabled','crmEvaluationEnabled','dailyAiLimit'] THEN RAISE SQLSTATE 'PT400' USING MESSAGE='GLOBAL_POLICY_REQUIRED';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER platform_policy_guard BEFORE INSERT OR UPDATE ON ops.platform_control_policies FOR EACH ROW EXECUTE FUNCTION ops.platform_policy_guard();

-- Global disable and ceiling cannot be bypassed by a branch override.
CREATE FUNCTION ops.platform_effective_policy(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
 'aiEnabled',(g.settings->>'aiEnabled')::boolean AND coalesce((b.settings->>'aiEnabled')::boolean,true),
 'importsEnabled',(g.settings->>'importsEnabled')::boolean AND coalesce((b.settings->>'importsEnabled')::boolean,true),
 'studioPublicationEnabled',(g.settings->>'studioPublicationEnabled')::boolean AND coalesce((b.settings->>'studioPublicationEnabled')::boolean,true),
 'orderingEnabled',(g.settings->>'orderingEnabled')::boolean AND coalesce((b.settings->>'orderingEnabled')::boolean,true),
 'whatsappEnabled',(g.settings->>'whatsappEnabled')::boolean AND coalesce((b.settings->>'whatsappEnabled')::boolean,true),
 'crmEvaluationEnabled',(g.settings->>'crmEvaluationEnabled')::boolean AND coalesce((b.settings->>'crmEvaluationEnabled')::boolean,true),
 'dailyAiLimit',least((g.settings->>'dailyAiLimit')::int,coalesce((b.settings->>'dailyAiLimit')::int,50)))
 FROM ops.platform_control_policies g LEFT JOIN ops.platform_control_policies b ON b.business_id=p_business_id AND b.branch_id=p_branch_id
 WHERE g.scope_key='global';
$$;
CREATE FUNCTION ops.platform_gate(p_business_id uuid,p_branch_id uuid,p_key text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (ops.platform_effective_policy(p_business_id,p_branch_id)->>p_key)::boolean IS DISTINCT FROM true THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PLATFORM_SERVICE_PAUSED';END IF;
END;$$;

CREATE FUNCTION ops.platform_control_save(p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_expected_version bigint,p_settings jsonb,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE k text;v jsonb;target text;old ops.platform_control_policies%ROWTYPE;c ops.platform_control_changes%ROWTYPE;req jsonb;res jsonb;principal jsonb;
BEGIN
 principal:=ops.platform_principal();
 IF NOT ((principal->>'canManageAi')::boolean OR(principal->>'canManageOperations')::boolean) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_PERMISSION_REQUIRED';END IF;
 PERFORM ops.platform_validate_policy(p_settings);
 IF p_operation_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 300 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_REQUEST';END IF;
 IF (p_business_id IS NULL)<>(p_branch_id IS NULL) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_SCOPE';END IF;
 IF p_branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
 target:=CASE WHEN p_branch_id IS NULL THEN 'global' ELSE p_business_id::text||':'||p_branch_id::text END;
 req:=jsonb_build_object('scope',target,'version',p_expected_version::text,'settings',p_settings,'reason',btrim(p_reason));
 -- One serial order for policy/member commands prevents role revocation racing a save.
 PERFORM pg_advisory_xact_lock(8391280999::bigint); principal:=ops.platform_principal();
 IF NOT ((principal->>'canManageAi')::boolean OR(principal->>'canManageOperations')::boolean) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_PERMISSION_REQUIRED';END IF;
 SELECT * INTO c FROM ops.platform_control_changes WHERE actor_id=auth.uid() AND operation_id=p_operation_id;
 IF FOUND THEN IF c.action<>'policy' OR c.request<>req THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;RETURN c.receipt;END IF;
 SELECT * INTO old FROM ops.platform_control_policies WHERE scope_key=target FOR UPDATE;
 IF coalesce(old.version,0)<>p_expected_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PLATFORM_VERSION_CHANGED';END IF;
 -- Full replacement: also authorize removed overrides, not only supplied keys.
 FOR k IN SELECT DISTINCT x FROM (SELECT jsonb_object_keys(p_settings) x UNION SELECT jsonb_object_keys(coalesce(old.settings,'{}'))) keys LOOP
  IF p_settings->k IS NOT DISTINCT FROM old.settings->k THEN CONTINUE;END IF;
  PERFORM ops.platform_require(CASE WHEN k IN('aiEnabled','importsEnabled','studioPublicationEnabled','dailyAiLimit') THEN 'ai' ELSE 'operations' END);
 END LOOP;
 IF p_settings='{}' AND target='global' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='GLOBAL_POLICY_REQUIRED';END IF;
 INSERT INTO ops.platform_control_policies(scope_key,business_id,branch_id,version,settings,updated_by)
 VALUES(target,p_business_id,p_branch_id,coalesce(old.version,0)+1,p_settings,auth.uid()) ON CONFLICT(scope_key) DO UPDATE
 SET version=EXCLUDED.version,settings=EXCLUDED.settings,updated_by=auth.uid(),updated_at=clock_timestamp();
 res:=jsonb_build_object('version',(coalesce(old.version,0)+1)::text,'scope',target);
 INSERT INTO ops.platform_control_changes(actor_id,operation_id,scope_key,action,request,before_value,after_value,reason,receipt)
 VALUES(auth.uid(),p_operation_id,target,'policy',req,coalesce(old.settings,'{}'),p_settings,btrim(p_reason),res);
 INSERT INTO ops.platform_audit_events(actor_user_id,business_id,branch_id,action,details) VALUES(auth.uid(),p_business_id,p_branch_id,'platform-policy',jsonb_build_object('scope',target,'version',res->>'version'));
 RETURN res;
END;$$;

-- Access mode is a company security policy; old restaurant setter is read-only now.
CREATE OR REPLACE FUNCTION ops.table_ordering_policy(p_business_id uuid,p_branch_id uuid,p_mode text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s ops.service_controls%ROWTYPE;BEGIN
 IF p_mode IS NOT NULL THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_SECURITY_SETTINGS_REQUIRED';END IF;
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier','kitchen']) THEN PERFORM ops.platform_require('read');END IF;
 SELECT * INTO s FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
 RETURN jsonb_build_object('mode',s.guest_entry_mode,'managedBy','platform');
END;$$;
CREATE FUNCTION ops.platform_admission_save(p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_expected_version bigint,p_mode text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE s ops.service_controls%ROWTYPE;c ops.platform_control_changes%ROWTYPE;req jsonb;res jsonb;BEGIN
 PERFORM ops.platform_require('security');
 IF p_mode IS NULL OR p_mode NOT IN('direct','staff_approved') OR p_operation_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 300 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_REQUEST';END IF;
 req:=jsonb_build_object('businessId',p_business_id,'branchId',p_branch_id,'mode',p_mode,'version',p_expected_version::text,'reason',btrim(p_reason));
 PERFORM pg_advisory_xact_lock(8391280999::bigint); PERFORM ops.platform_require('security');
 SELECT * INTO c FROM ops.platform_control_changes WHERE actor_id=auth.uid() AND operation_id=p_operation_id;
 IF FOUND THEN IF c.action<>'admission' OR c.request<>req THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;RETURN c.receipt;END IF;
 SELECT * INTO s FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
 IF s.version IS DISTINCT FROM p_expected_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PLATFORM_VERSION_CHANGED';END IF;
 UPDATE ops.service_controls SET guest_entry_mode=p_mode,version=version+1,updated_at=clock_timestamp() WHERE business_id=p_business_id AND branch_id=p_branch_id;
 res:=jsonb_build_object('mode',p_mode,'version',(s.version+1)::text);
 INSERT INTO ops.platform_control_changes(actor_id,operation_id,scope_key,action,request,before_value,after_value,reason,receipt)
 VALUES(auth.uid(),p_operation_id,p_business_id::text||':'||p_branch_id::text,'admission',req,jsonb_build_object('mode',s.guest_entry_mode),jsonb_build_object('mode',p_mode),btrim(p_reason),res);
 RETURN res;
END;$$;

CREATE FUNCTION ops.platform_member_save(p_operation_id uuid,p_email text,p_role text,p_active boolean,p_previous jsonb,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE uid uuid;old ops.platform_staff%ROWTYPE;c ops.platform_control_changes%ROWTYPE;req jsonb;beforev jsonb;afterv jsonb;res jsonb;BEGIN
 PERFORM ops.platform_require('members');
 IF p_operation_id IS NULL OR p_email IS NULL OR length(p_email)>254 OR p_role IS NULL OR p_role NOT IN('platform_owner','ai_admin','ops_admin','security_admin','auditor') OR p_active IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 5 AND 300 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_REQUEST';END IF;
 req:=jsonb_build_object('email',lower(btrim(p_email)),'role',p_role,'active',p_active,'previous',p_previous,'reason',btrim(p_reason));
 PERFORM pg_advisory_xact_lock(8391280999::bigint);PERFORM ops.platform_require('members');
 SELECT * INTO c FROM ops.platform_control_changes WHERE actor_id=auth.uid() AND operation_id=p_operation_id;
 IF FOUND THEN IF c.action<>'member' OR c.request<>req THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;RETURN c.receipt;END IF;
 SELECT id INTO uid FROM auth.users WHERE lower(email)=lower(btrim(p_email)) AND email_confirmed_at IS NOT NULL;
 IF uid IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='VERIFIED_ACCOUNT_REQUIRED';END IF;
 SELECT * INTO old FROM ops.platform_staff WHERE user_id=uid FOR UPDATE;
 beforev:=CASE WHEN FOUND THEN jsonb_build_object('role',old.role,'active',old.active) ELSE '{}'::jsonb END;
 IF p_previous IS DISTINCT FROM beforev THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PLATFORM_VERSION_CHANGED';END IF;
 IF old.active AND old.role='platform_owner' AND (NOT p_active OR p_role<>'platform_owner') AND
 NOT EXISTS(SELECT 1 FROM ops.platform_staff WHERE user_id<>uid AND active AND role='platform_owner') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LAST_PLATFORM_OWNER';END IF;
 INSERT INTO ops.platform_staff(user_id,role,active,granted_by,reason) VALUES(uid,p_role,p_active,auth.uid(),btrim(p_reason))
 ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,active=EXCLUDED.active,granted_by=EXCLUDED.granted_by,reason=EXCLUDED.reason;
 afterv:=jsonb_build_object('role',p_role,'active',p_active);res:=jsonb_build_object('saved',true,'userId',uid);
 INSERT INTO ops.platform_control_changes(actor_id,operation_id,scope_key,action,request,before_value,after_value,reason,receipt)
 VALUES(auth.uid(),p_operation_id,'members','member',req,beforev,afterv,btrim(p_reason),res);RETURN res;
END;$$;

-- Gates execute where writes occur, including direct RPCs. Existing receipts,
-- callbacks, cancellations, cash settlement, and undo operations keep working.
CREATE FUNCTION ops.platform_runtime_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cap integer;BEGIN
 IF TG_TABLE_NAME='orders' THEN
  IF TG_OP='INSERT' OR(NEW.status='submitted' AND OLD.status IS DISTINCT FROM NEW.status) THEN PERFORM ops.platform_gate(NEW.business_id,NEW.branch_id,'orderingEnabled');END IF;
 ELSIF TG_TABLE_NAME='llm_runs' THEN
  IF TG_OP='INSERT' OR(NEW.state='sending' AND OLD.state IS DISTINCT FROM NEW.state) THEN
   PERFORM ops.platform_gate(NEW.business_id,NEW.branch_id,'aiEnabled');
   IF NEW.kind='menu-extract' THEN PERFORM ops.platform_gate(NEW.business_id,NEW.branch_id,'importsEnabled');END IF;
  END IF;
  IF TG_OP='INSERT' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('platform-ai-quota:'||NEW.business_id::text||NEW.branch_id::text,0));
   cap:=(ops.platform_effective_policy(NEW.business_id,NEW.branch_id)->>'dailyAiLimit')::int;
   IF(SELECT count(*) FROM ops.llm_runs WHERE business_id=NEW.business_id AND branch_id=NEW.branch_id AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul')>=cap THEN RAISE SQLSTATE 'PT429' USING MESSAGE='LLM_DAILY_LIMIT';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='menu_import_jobs' THEN
  IF TG_OP='INSERT' THEN PERFORM ops.platform_gate(NEW.business_id,NEW.branch_id,'importsEnabled');END IF;
 ELSIF TG_TABLE_NAME='studio_publication_batches' THEN
  IF NEW.action='apply' THEN PERFORM ops.platform_gate(NEW.business_id,NEW.branch_id,'studioPublicationEnabled');END IF;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER company_order_gate BEFORE INSERT OR UPDATE OF status ON ops.orders FOR EACH ROW EXECUTE FUNCTION ops.platform_runtime_guard();
CREATE TRIGGER company_ai_gate BEFORE INSERT OR UPDATE OF state ON ops.llm_runs FOR EACH ROW EXECUTE FUNCTION ops.platform_runtime_guard();
CREATE TRIGGER company_import_gate BEFORE INSERT ON ops.menu_import_jobs FOR EACH ROW EXECUTE FUNCTION ops.platform_runtime_guard();
CREATE TRIGGER company_studio_publish_gate BEFORE INSERT ON ops.studio_publication_batches FOR EACH ROW EXECUTE FUNCTION ops.platform_runtime_guard();

-- Preserve the existing WhatsApp implementation, close its previous direct grant.
ALTER FUNCTION ops.whatsapp_quote(uuid,uuid,jsonb) RENAME TO _whatsapp_quote_before_company;
REVOKE ALL ON FUNCTION ops._whatsapp_quote_before_company(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION ops.whatsapp_quote(p_business_id uuid,p_branch_id uuid,p_lines jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM ops.platform_gate(p_business_id,p_branch_id,'whatsappEnabled');RETURN ops._whatsapp_quote_before_company(p_business_id,p_branch_id,p_lines);END;$$;
GRANT EXECUTE ON FUNCTION ops.whatsapp_quote(uuid,uuid,jsonb) TO anon,authenticated;
REVOKE ALL ON FUNCTION ops.whatsapp_quote(uuid,uuid,jsonb) FROM PUBLIC;
-- Add branch-aware gate to the existing evaluator without changing consent logic.
DO $$DECLARE definition text;needle text:='WHERE mode IN(''dry_run'',''live'')';BEGIN
 SELECT pg_get_functiondef('ops.crm_enqueue()'::regprocedure) INTO definition;
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'CRM_EVALUATOR_CONTRACT_CHANGED';END IF;
 EXECUTE replace(definition,needle,needle||' AND (ops.platform_effective_policy(c.business_id,c.branch_id)->>''crmEvaluationEnabled'')::boolean');
END;$$;

CREATE FUNCTION ops.platform_control_snapshot(p_business_id uuid DEFAULT NULL,p_branch_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p jsonb;selected_cfg ops.platform_control_policies%ROWTYPE;g ops.platform_control_policies%ROWTYPE;data jsonb;BEGIN
 p:=ops.platform_principal();
 IF(p_business_id IS NULL)<>(p_branch_id IS NULL) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_SCOPE';END IF;
 IF p_branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
 SELECT * INTO g FROM ops.platform_control_policies WHERE scope_key='global';
 SELECT * INTO selected_cfg FROM ops.platform_control_policies WHERE scope_key=CASE WHEN p_branch_id IS NULL THEN 'global' ELSE p_business_id::text||':'||p_branch_id::text END;
 data:=p||jsonb_build_object('version',coalesce(selected_cfg.version,0)::text,'settings',coalesce(selected_cfg.settings,'{}'),'globalSettings',g.settings,'effective',ops.platform_effective_policy(p_business_id,p_branch_id),
 'branches',(SELECT coalesce(jsonb_agg(jsonb_build_object('businessId',b.business_id,'branchId',b.id,'name',b.name) ORDER BY b.name,b.id),'[]') FROM public.branches b JOIN ops.branch_settings s ON s.business_id=b.business_id AND s.branch_id=b.id),
 'members',CASE WHEN (p->>'canManageMembers')::boolean OR(p->>'canManageSecurity')::boolean THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'email',u.email,'role',s.role,'active',s.active) ORDER BY u.email),'[]') FROM ops.platform_staff s JOIN auth.users u ON u.id=s.user_id) ELSE '[]'::jsonb END,
 'changes',(SELECT coalesce(jsonb_agg(x ORDER BY (x->>'id')::bigint DESC),'[]') FROM(SELECT jsonb_build_object('id',c.id::text,'actorId',c.actor_id,'action',c.action,'scope',c.scope_key,'createdAt',c.created_at,'reason',c.reason,'before',c.before_value,'after',c.after_value) x FROM ops.platform_control_changes c WHERE(c.action<>'member' OR (p->>'canManageMembers')::boolean OR(p->>'canManageSecurity')::boolean) ORDER BY c.id DESC LIMIT 60)q),
 'audit',(SELECT coalesce(jsonb_agg(x),'[]') FROM(SELECT jsonb_build_object('action',a.action,'createdAt',a.created_at,'branchId',a.branch_id) x FROM ops.platform_audit_events a ORDER BY a.created_at DESC,a.id DESC LIMIT 30)q),
 'rules',jsonb_build_object('paidAiFallback',false,'paidAiBudgetMinor','0','currency','TRY','money','bigint','automaticPublishing',false,'unsafeQueueRetry',false));
 IF p_branch_id IS NOT NULL THEN
  data:=data||jsonb_build_object(
   'admission',(SELECT jsonb_build_object('mode',guest_entry_mode,'version',version::text) FROM ops.service_controls WHERE business_id=p_business_id AND branch_id=p_branch_id),
   'features',(SELECT to_jsonb(f)-'business_id'-'branch_id' FROM ops.integration_features f WHERE business_id=p_business_id AND branch_id=p_branch_id),
   'branchOrdering',(SELECT jsonb_build_object('ordering',ordering_enabled,'dineIn',dine_in_enabled,'pickup',pickup_enabled,'delivery',delivery_enabled) FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id),
   'readiness',jsonb_build_object(
    'products',(SELECT count(*) FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id),
    'approvedPrices',(SELECT count(*) FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND price_approved AND approved_price IS NOT NULL),
    'tables',(SELECT count(*) FROM ops.dining_tables WHERE business_id=p_business_id AND branch_id=p_branch_id AND active),
    'staff',(SELECT count(*) FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id AND active),
    'aiRoutes',(SELECT count(*) FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id),
    'expiredAiAttestations',(SELECT count(*) FROM ops.ai_free_routes WHERE business_id=p_business_id AND branch_id=p_branch_id AND attested_until<=clock_timestamp()),
    'courierAccounts',(SELECT count(*) FROM ops.delivery_accounts WHERE business_id=p_business_id AND branch_id=p_branch_id),
    'aiToday',(SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND created_at>=date_trunc('day',now() AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul')),
   'queues',jsonb_build_object(
    'aiUnknown',(SELECT count(*) FROM ops.llm_runs WHERE business_id=p_business_id AND branch_id=p_branch_id AND(state='unknown' OR(state IN('reserved','sending') AND lease_until<=clock_timestamp()))),
    'paymentUnknown',(SELECT count(*) FROM ops.payment_intents WHERE business_id=p_business_id AND branch_id=p_branch_id AND status='unknown'),
    'courierDead',(SELECT count(*) FROM ops.delivery_outbox WHERE business_id=p_business_id AND branch_id=p_branch_id AND state='dead'),
    'courierPending',(SELECT count(*) FROM ops.delivery_outbox WHERE business_id=p_business_id AND branch_id=p_branch_id AND state IN('pending','leased')),
    'smsUnknown',(SELECT count(*) FROM ops.crm_outbox WHERE business_id=p_business_id AND branch_id=p_branch_id AND state='unknown'),
    'crmLastRun',(SELECT max(finished_at) FROM ops.crm_runs)));
 END IF;RETURN data;
END;$$;

-- Read models show the effective restriction, not a falsely enabled customer button.
ALTER FUNCTION ops.service_availability(uuid,uuid) RENAME TO _service_availability_before_company;
REVOKE ALL ON FUNCTION ops._service_availability_before_company(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION ops.service_availability(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT ops._service_availability_before_company(p_business_id,p_branch_id)||jsonb_build_object('orderingEnabled',
 coalesce((ops._service_availability_before_company(p_business_id,p_branch_id)->>'orderingEnabled')::boolean,false)
 AND coalesce((ops.platform_effective_policy(p_business_id,p_branch_id)->>'orderingEnabled')::boolean,false));
$$;
ALTER FUNCTION ops.merchant_profile(uuid,uuid) RENAME TO _merchant_profile_before_company;
REVOKE ALL ON FUNCTION ops._merchant_profile_before_company(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION ops.merchant_profile(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;p jsonb;BEGIN v:=ops._merchant_profile_before_company(p_business_id,p_branch_id);p:=ops.platform_effective_policy(p_business_id,p_branch_id);
 RETURN v||jsonb_build_object('orderingEnabled',coalesce((v->>'orderingEnabled')::boolean,false) AND coalesce((p->>'orderingEnabled')::boolean,false),
 'whatsappEnabled',coalesce((v->>'whatsappEnabled')::boolean,false) AND coalesce((p->>'whatsappEnabled')::boolean,false),
 'whatsappPhone',CASE WHEN coalesce((p->>'whatsappEnabled')::boolean,false) THEN v->>'whatsappPhone' ELSE NULL END);END;$$;
REVOKE ALL ON FUNCTION ops.service_availability(uuid,uuid),ops.merchant_profile(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.service_availability(uuid,uuid),ops.merchant_profile(uuid,uuid) TO anon,authenticated;
-- Public/tenant consumers get only availability, never platform configuration.
CREATE FUNCTION ops.platform_public_availability(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('orderingEnabled',coalesce((ops.platform_effective_policy(p_business_id,p_branch_id)->>'orderingEnabled')::boolean,false),
 'whatsappEnabled',coalesce((ops.platform_effective_policy(p_business_id,p_branch_id)->>'whatsappEnabled')::boolean,false));
$$;
DO $$DECLARE r record;BEGIN
 FOR r IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ops' AND p.proname IN('platform_require','platform_validate_policy','platform_policy_guard','platform_effective_policy','platform_gate','platform_control_save','platform_admission_save','platform_member_save','platform_runtime_guard','platform_control_snapshot','platform_public_availability') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.sig);
 END LOOP;
END;$$;
GRANT EXECUTE ON FUNCTION ops.platform_control_snapshot(uuid,uuid),ops.platform_control_save(uuid,uuid,uuid,bigint,jsonb,text),ops.platform_admission_save(uuid,uuid,uuid,bigint,text,text),ops.platform_member_save(uuid,text,text,boolean,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.platform_public_availability(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
