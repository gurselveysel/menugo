-- r34: restaurant-reviewed social publication intents. No provider credentials and no external post side effects.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Company-only gate. Existing global policy is migrated fail-closed for social delivery requests.
CREATE OR REPLACE FUNCTION ops.platform_validate_policy(p_settings jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE k text;v jsonb;BEGIN
 IF p_settings IS NULL OR jsonb_typeof(p_settings)<>'object' OR length(p_settings::text)>2000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_POLICY';END IF;
 FOR k,v IN SELECT * FROM jsonb_each(p_settings) LOOP
  IF k IN('aiEnabled','importsEnabled','studioPublicationEnabled','socialPublicationEnabled','orderingEnabled','whatsappEnabled','crmEvaluationEnabled') THEN
   IF jsonb_typeof(v)<>'boolean' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_POLICY';END IF;
  ELSIF k='dailyAiLimit' THEN
   IF jsonb_typeof(v)<>'number' OR v::text!~'^[0-9]{1,2}$' OR (v::text)::int NOT BETWEEN 1 AND 50 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PLATFORM_LIMIT';END IF;
  ELSE RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_PLATFORM_SETTING';END IF;
 END LOOP;
END;$$;

UPDATE ops.platform_control_policies
 SET settings=settings||'{"socialPublicationEnabled":false}'::jsonb,updated_at=clock_timestamp()
 WHERE scope_key='global' AND NOT settings?'socialPublicationEnabled';

CREATE OR REPLACE FUNCTION ops.platform_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 PERFORM ops.platform_validate_policy(NEW.settings);
 IF NEW.scope_key='global' AND NOT NEW.settings ?& ARRAY['aiEnabled','importsEnabled','studioPublicationEnabled','socialPublicationEnabled','orderingEnabled','whatsappEnabled','crmEvaluationEnabled','dailyAiLimit'] THEN RAISE SQLSTATE 'PT400' USING MESSAGE='GLOBAL_POLICY_REQUIRED';END IF;
 RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION ops.platform_effective_policy(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
 'aiEnabled',(g.settings->>'aiEnabled')::boolean AND coalesce((b.settings->>'aiEnabled')::boolean,true),
 'importsEnabled',(g.settings->>'importsEnabled')::boolean AND coalesce((b.settings->>'importsEnabled')::boolean,true),
 'studioPublicationEnabled',(g.settings->>'studioPublicationEnabled')::boolean AND coalesce((b.settings->>'studioPublicationEnabled')::boolean,true),
 'socialPublicationEnabled',(g.settings->>'socialPublicationEnabled')::boolean AND coalesce((b.settings->>'socialPublicationEnabled')::boolean,true),
 'orderingEnabled',(g.settings->>'orderingEnabled')::boolean AND coalesce((b.settings->>'orderingEnabled')::boolean,true),
 'whatsappEnabled',(g.settings->>'whatsappEnabled')::boolean AND coalesce((b.settings->>'whatsappEnabled')::boolean,true),
 'crmEvaluationEnabled',(g.settings->>'crmEvaluationEnabled')::boolean AND coalesce((b.settings->>'crmEvaluationEnabled')::boolean,true),
 'dailyAiLimit',least((g.settings->>'dailyAiLimit')::int,coalesce((b.settings->>'dailyAiLimit')::int,50)))
 FROM ops.platform_control_policies g LEFT JOIN ops.platform_control_policies b ON b.business_id=p_business_id AND b.branch_id=p_branch_id
 WHERE g.scope_key='global';
$$;

CREATE TABLE ops.social_publication_intents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL,branch_id uuid NOT NULL,product_id uuid NOT NULL,job_id uuid,
 requested_by uuid NOT NULL REFERENCES auth.users(id),operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 network text NOT NULL CHECK(network IN('instagram')),
 format text NOT NULL CHECK(format IN('post','story')),
 source_version text NOT NULL CHECK(source_version~'^[a-f0-9]{64}$'),
 packet jsonb NOT NULL CHECK(jsonb_typeof(packet)='object'),
 state text NOT NULL DEFAULT 'awaiting_platform_connection' CHECK(state IN('awaiting_platform_connection','cancelled','dispatched','failed')),
 external_ref text,
 cancel_operation_id uuid,cancelled_by uuid REFERENCES auth.users(id),cancelled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 UNIQUE(requested_by,operation_id),UNIQUE(cancelled_by,cancel_operation_id),
 CHECK((state='cancelled')=(cancelled_at IS NOT NULL)),
 CHECK(external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 500)
);
CREATE INDEX social_publication_intents_scope ON ops.social_publication_intents(business_id,branch_id,created_at DESC);
ALTER TABLE ops.social_publication_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.social_publication_intents FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY social_publication_no_direct_access ON ops.social_publication_intents AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION ops.campaign_publication_status(p_business_id uuid,p_branch_id uuid,p_product_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE enabled boolean;BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 enabled:=coalesce((ops.platform_effective_policy(p_business_id,p_branch_id)->>'socialPublicationEnabled')::boolean,false);
 RETURN jsonb_build_object('enabled',enabled,'dispatchConfigured',false,'items',(
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'productId',x.product_id,'network',x.network,'format',x.format,'state',x.state,'sourceVersion',x.source_version,'createdAt',x.created_at,'updatedAt',x.updated_at) ORDER BY x.created_at DESC),'[]'::jsonb)
  FROM (SELECT * FROM ops.social_publication_intents i WHERE i.business_id=p_business_id AND i.branch_id=p_branch_id AND (p_product_id IS NULL OR i.product_id=p_product_id) ORDER BY i.created_at DESC LIMIT 20)x));
END;$$;

CREATE FUNCTION ops.campaign_publication_request(
 p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_product_id uuid,p_job_id uuid,
 p_expected_version text,p_format text,p_network text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE req jsonb;rh text;snap jsonb;packet jsonb;old ops.social_publication_intents%ROWTYPE;rowv ops.social_publication_intents%ROWTYPE;BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 PERFORM ops.platform_gate(p_business_id,p_branch_id,'socialPublicationEnabled');
 IF p_operation_id IS NULL OR p_product_id IS NULL OR p_expected_version IS NULL OR p_expected_version!~'^[a-f0-9]{64}$' OR p_format NOT IN('post','story') OR p_network<>'instagram' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PUBLICATION_REQUEST';END IF;
 req:=jsonb_build_object('businessId',p_business_id,'branchId',p_branch_id,'productId',p_product_id,'jobId',p_job_id,'expectedVersion',p_expected_version,'format',p_format,'network',p_network);
 rh:=encode(sha256(convert_to(req::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text||':'||p_branch_id::text||':social-publication',0));
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 PERFORM ops.platform_gate(p_business_id,p_branch_id,'socialPublicationEnabled');
 SELECT * INTO old FROM ops.social_publication_intents WHERE requested_by=auth.uid() AND operation_id=p_operation_id;
 IF FOUND THEN
  IF old.request_hash<>rh THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
  RETURN jsonb_build_object('id',old.id,'state',old.state,'sourceVersion',old.source_version,'createdAt',old.created_at,'dispatchConfigured',false,'replayed',true);
 END IF;
 snap:=ops.campaign_snapshot(p_business_id,p_branch_id,p_product_id,p_job_id,p_expected_version)-'checkedAt';
 packet:=jsonb_build_object('schema','menugo.social-publication.v1','network',p_network,'format',p_format,'snapshot',snap,'caption',snap->>'caption');
 INSERT INTO ops.social_publication_intents(business_id,branch_id,product_id,job_id,requested_by,operation_id,request_hash,network,format,source_version,packet)
 VALUES(p_business_id,p_branch_id,p_product_id,p_job_id,auth.uid(),p_operation_id,rh,p_network,p_format,p_expected_version,packet) RETURNING * INTO rowv;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,subject_id,details)
 VALUES(p_business_id,p_branch_id,auth.uid(),'social-publication-requested',rowv.id,jsonb_build_object('productId',p_product_id,'network',p_network,'format',p_format,'sourceVersion',p_expected_version));
 RETURN jsonb_build_object('id',rowv.id,'state',rowv.state,'sourceVersion',rowv.source_version,'createdAt',rowv.created_at,'dispatchConfigured',false,'replayed',false);
END;$$;

CREATE FUNCTION ops.campaign_publication_cancel(p_business_id uuid,p_branch_id uuid,p_operation_id uuid,p_publication_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE rowv ops.social_publication_intents%ROWTYPE;existing ops.social_publication_intents%ROWTYPE;BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_operation_id IS NULL OR p_publication_id IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PUBLICATION_REQUEST';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text||':'||p_branch_id::text||':social-publication',0));
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 SELECT * INTO existing FROM ops.social_publication_intents WHERE business_id=p_business_id AND branch_id=p_branch_id AND cancelled_by=auth.uid() AND cancel_operation_id=p_operation_id;
 IF FOUND THEN
  IF existing.id<>p_publication_id THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
  RETURN jsonb_build_object('id',existing.id,'state',existing.state,'updatedAt',existing.updated_at,'replayed',true);
 END IF;
 SELECT * INTO rowv FROM ops.social_publication_intents WHERE id=p_publication_id AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PUBLICATION_NOT_FOUND';END IF;
 IF rowv.state='cancelled' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PUBLICATION_ALREADY_CANCELLED';END IF;
 IF rowv.state<>'awaiting_platform_connection' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PUBLICATION_NOT_CANCELLABLE';END IF;
 UPDATE ops.social_publication_intents SET state='cancelled',cancel_operation_id=p_operation_id,cancelled_by=auth.uid(),cancelled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=rowv.id RETURNING * INTO rowv;
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,subject_id,details)
 VALUES(p_business_id,p_branch_id,auth.uid(),'social-publication-cancelled',rowv.id,jsonb_build_object('productId',rowv.product_id));
 RETURN jsonb_build_object('id',rowv.id,'state',rowv.state,'updatedAt',rowv.updated_at,'replayed',false);
END;$$;

REVOKE ALL ON FUNCTION ops.campaign_publication_status(uuid,uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION ops.campaign_publication_request(uuid,uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION ops.campaign_publication_cancel(uuid,uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION ops.campaign_publication_status(uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.campaign_publication_request(uuid,uuid,uuid,uuid,uuid,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.campaign_publication_cancel(uuid,uuid,uuid,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
