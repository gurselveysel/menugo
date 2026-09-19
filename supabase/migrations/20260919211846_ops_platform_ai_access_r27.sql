-- AI control plane core: platform staff is independent from restaurant staff.
-- Dependency-free phase. Free-router overrides are installed after the free AI schema exists.
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
COMMIT;
