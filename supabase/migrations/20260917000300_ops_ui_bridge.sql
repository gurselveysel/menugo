-- MenüGO integration bridge. New operations remain under ops; catalog remains read-only.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TABLE ops.check_members (
 business_id uuid NOT NULL, branch_id uuid NOT NULL, check_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 active boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL,
 joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(check_id,user_id),
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id)
);
CREATE TABLE ops.check_channels (
 business_id uuid NOT NULL, branch_id uuid NOT NULL, check_id uuid PRIMARY KEY,
 channel_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 token_hash text NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id)
);
CREATE TABLE ops.owner_invites (email text PRIMARY KEY, business_id uuid NOT NULL, branch_id uuid NOT NULL,
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id));
CREATE TABLE ops.api_throttles (user_id uuid NOT NULL, bucket text NOT NULL, window_at timestamptz NOT NULL,
 hits integer NOT NULL CHECK(hits>=0), PRIMARY KEY(user_id,bucket));

CREATE OR REPLACE FUNCTION ops.can_read_check(p_business_id uuid,p_branch_id uuid,p_check_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM ops.checks c WHERE c.business_id=p_business_id AND c.branch_id=p_branch_id AND c.id=p_check_id
 AND (c.opened_by_user_id=auth.uid() OR ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','cashier','waiter'])
 OR EXISTS(SELECT 1 FROM ops.check_members m WHERE m.check_id=c.id AND m.user_id=auth.uid() AND m.active AND m.expires_at>now())));
$$;
CREATE OR REPLACE FUNCTION ops.assert_command_actor(p_business_id uuid,p_branch_id uuid,p_check_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT ops.can_read_check(p_business_id,p_branch_id,p_check_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='CHECK_NOT_FOUND'; END IF;
END;$$;
CREATE FUNCTION ops.throttle(p_bucket text,p_limit integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v integer;
BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 INSERT INTO ops.api_throttles VALUES(auth.uid(),p_bucket,clock_timestamp(),1)
 ON CONFLICT(user_id,bucket) DO UPDATE SET
 hits=CASE WHEN ops.api_throttles.window_at<clock_timestamp()-interval '1 minute' THEN 1 ELSE ops.api_throttles.hits+1 END,
 window_at=CASE WHEN ops.api_throttles.window_at<clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE ops.api_throttles.window_at END
 RETURNING hits INTO v;
 IF v>p_limit THEN RAISE SQLSTATE 'PT429' USING MESSAGE='RATE_LIMITED'; END IF;
END;$$;
-- Coherent snapshot under the same parent-row lock as all cart writers.
CREATE FUNCTION ops.get_cart_snapshot(p_business_id uuid,p_branch_id uuid,p_check_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE c ops.checks%ROWTYPE; channel uuid; data jsonb;
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 SELECT channel_id INTO channel FROM ops.check_channels WHERE check_id=c.id;
 IF channel IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_CHANNEL_MISSING';END IF;
 data:=ops.cart_result(c.id,NULL);
 RETURN data || jsonb_build_object('businessId',c.business_id,'branchId',c.branch_id,'viewerUserId',auth.uid(),
 'channelId',channel,'status',c.status,'canMutate',c.status='open' AND EXISTS(SELECT 1 FROM ops.branch_settings s
 WHERE s.business_id=c.business_id AND s.branch_id=c.branch_id AND s.ordering_enabled));
END;$$;
CREATE FUNCTION ops.start_table(p_business_id uuid,p_branch_id uuid,p_table_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE c ops.checks%ROWTYPE; token text; chan ops.check_channels%ROWTYPE;
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 PERFORM 1 FROM ops.dining_tables WHERE id=p_table_id AND business_id=p_business_id AND branch_id=p_branch_id AND active FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='TABLE_NOT_FOUND';END IF;
 SELECT * INTO c FROM ops.checks WHERE table_id=p_table_id AND business_id=p_business_id AND branch_id=p_branch_id AND status IN('open','checkout') FOR UPDATE;
 IF NOT FOUND THEN INSERT INTO ops.checks(business_id,branch_id,table_id,opened_by_user_id,service_mode)
 VALUES(p_business_id,p_branch_id,p_table_id,auth.uid(),'dine_in') RETURNING * INTO c;END IF;
 IF c.status<>'open' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CHECK_NOT_OPEN';END IF;
 token:=encode(extensions.gen_random_bytes(32),'hex');
 INSERT INTO ops.check_channels(business_id,branch_id,check_id,token_hash,expires_at)
 VALUES(p_business_id,p_branch_id,c.id,encode(sha256(convert_to(token,'UTF8')),'hex'),clock_timestamp()+interval '10 minutes')
 ON CONFLICT(check_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at;
 INSERT INTO ops.check_members VALUES(p_business_id,p_branch_id,c.id,auth.uid(),true,clock_timestamp()+interval '8 hours',now())
 ON CONFLICT(check_id,user_id) DO UPDATE SET active=true,expires_at=EXCLUDED.expires_at;
 RETURN jsonb_build_object('checkId',c.id,'token',token,'expiresInSeconds',600);
END;$$;
CREATE FUNCTION ops.join_table(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='2s' AS $$
DECLARE c ops.checks%ROWTYPE; x ops.check_channels%ROWTYPE;
BEGIN
 PERFORM ops.throttle('join-table',10);
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 SELECT * INTO x FROM ops.check_channels WHERE check_id=c.id FOR SHARE;
 IF c.status<>'open' OR x.expires_at IS NULL OR x.expires_at<=clock_timestamp() OR length(p_token)<>64
 OR x.token_hash IS DISTINCT FROM encode(sha256(convert_to(p_token,'UTF8')),'hex') THEN
 RAISE SQLSTATE 'PT403' USING MESSAGE='INVALID_TABLE_INVITATION';END IF;
 IF (SELECT count(*) FROM ops.check_members WHERE check_id=c.id AND active AND expires_at>now())>=16
 AND NOT EXISTS(SELECT 1 FROM ops.check_members WHERE check_id=c.id AND user_id=auth.uid()) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='TABLE_CAPACITY';END IF;
 INSERT INTO ops.check_members VALUES(p_business_id,p_branch_id,c.id,auth.uid(),true,clock_timestamp()+interval '8 hours',now())
 ON CONFLICT(check_id,user_id) DO UPDATE SET active=true,expires_at=EXCLUDED.expires_at;
 RETURN ops.get_cart_snapshot(p_business_id,p_branch_id,c.id);
END;$$;
CREATE FUNCTION ops.revoke_member(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner','manager','waiter','cashier']) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 PERFORM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 UPDATE ops.check_members SET active=false WHERE check_id=p_check_id AND user_id=p_user_id;
 UPDATE ops.check_channels SET channel_id=gen_random_uuid(),expires_at=clock_timestamp() WHERE check_id=p_check_id;
 UPDATE ops.checks SET revision=revision+1 WHERE id=p_check_id;
END;$$;
CREATE FUNCTION ops.receive_check_topic(p_topic text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM ops.check_channels x WHERE 'check:'||x.channel_id::text=p_topic
 AND ops.can_read_check(x.business_id,x.branch_id,x.check_id));$$;
CREATE FUNCTION ops.emit_check_signal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ch uuid;
BEGIN
 SELECT channel_id INTO ch FROM ops.check_channels WHERE check_id=NEW.id;
 IF ch IS NOT NULL THEN PERFORM realtime.send(jsonb_build_object('revision',NEW.revision::text),'changed','check:'||ch::text,true); END IF;
 RETURN NULL;
END;$$;
CREATE TRIGGER check_changed AFTER UPDATE ON ops.checks FOR EACH ROW EXECUTE FUNCTION ops.emit_check_signal();
CREATE POLICY menugo_check_private ON realtime.messages FOR SELECT TO authenticated
 USING(extension='broadcast' AND ops.receive_check_topic((SELECT realtime.topic())));
-- The client never receives broadcast INSERT permission.
CREATE FUNCTION ops.bootstrap_owner() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u record; i record; n integer:=0;
BEGIN
 SELECT id,email,email_confirmed_at INTO u FROM auth.users WHERE id=auth.uid();
 IF u.id IS NULL OR u.email_confirmed_at IS NULL THEN RAISE SQLSTATE 'PT403' USING MESSAGE='VERIFIED_OWNER_REQUIRED';END IF;
 FOR i IN SELECT * FROM ops.owner_invites WHERE email=lower(u.email) LOOP
 INSERT INTO ops.branch_staff(business_id,branch_id,user_id,role) VALUES(i.business_id,i.branch_id,u.id,'owner') ON CONFLICT DO NOTHING;
 n:=n+1;END LOOP;
 IF n=0 THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_INVITATION_REQUIRED';END IF;
 RETURN jsonb_build_object('linked',true);
END;$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['check_members','check_channels','owner_invites','api_throttles'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT ALL ON ops.%I TO service_role',t);
 END LOOP;
END;$$;
REVOKE ALL ON FUNCTION ops.get_cart_snapshot(uuid,uuid,uuid),ops.start_table(uuid,uuid,uuid),ops.join_table(uuid,uuid,uuid,text),ops.revoke_member(uuid,uuid,uuid,uuid),ops.receive_check_topic(text),ops.bootstrap_owner(),ops.throttle(text,integer),ops.emit_check_signal() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.get_cart_snapshot(uuid,uuid,uuid),ops.start_table(uuid,uuid,uuid),ops.join_table(uuid,uuid,uuid,text),ops.revoke_member(uuid,uuid,uuid,uuid),ops.receive_check_topic(text),ops.bootstrap_owner() TO authenticated;
-- Revoked memberships invalidate owner-independent channels by rotation above.
COMMIT;
