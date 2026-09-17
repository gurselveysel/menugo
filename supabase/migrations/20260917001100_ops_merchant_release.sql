-- MenüGO merchant r7. Existing catalogue rows/prices remain unchanged.
-- No payment/courier/SMS provider is activated by this migration.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.branch_profiles (
 business_id uuid NOT NULL,branch_id uuid NOT NULL,
 tagline text NOT NULL DEFAULT 'Lezzetin en güzel hâli.',
 about_text text NOT NULL DEFAULT 'Meşhur Sarıyer Börekçisi Sandviç. Kahvaltıdan sandviçe, waffle’dan kahveye; lezzetli bir mola için menümüzü keşfedin.',
 whatsapp_phone text,whatsapp_enabled boolean NOT NULL DEFAULT false,
 address text,hours jsonb NOT NULL DEFAULT '[]',map_query text,
 version bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,branch_id),FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 CHECK(whatsapp_phone IS NULL OR whatsapp_phone ~ '^[1-9][0-9]{7,14}$'),
 CHECK(length(tagline)<=120 AND length(about_text)<=1200),CHECK(address IS NULL OR length(address)<=500),
 CHECK(map_query IS NULL OR length(map_query)<=500),CHECK(jsonb_typeof(hours)='array' AND jsonb_array_length(hours)<=7)
);
INSERT INTO ops.branch_profiles(business_id,branch_id) SELECT business_id,branch_id FROM ops.branch_settings;
ALTER TABLE ops.branch_staff ADD COLUMN display_name text CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 80);
CREATE TABLE ops.staff_invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,
 email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 5 AND 254 AND position('@' in email)>1),
 display_name text NOT NULL CHECK(length(btrim(display_name)) BETWEEN 1 AND 80),
 role text NOT NULL CHECK(role IN('manager','waiter','kitchen','cashier')),
 created_by uuid NOT NULL REFERENCES auth.users(id),claimed_by uuid REFERENCES auth.users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','claimed','revoked')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);
CREATE UNIQUE INDEX staff_invite_pending_email ON ops.staff_invites(business_id,branch_id,email) WHERE status='pending';
CREATE TABLE ops.service_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL,branch_id uuid NOT NULL,check_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES auth.users(id),kind text NOT NULL CHECK(kind IN('waiter','bill')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done')),
 handled_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),handled_at timestamptz,
 FOREIGN KEY(business_id,branch_id,check_id) REFERENCES ops.checks(business_id,branch_id,id)
);
CREATE UNIQUE INDEX service_one_pending_kind ON ops.service_requests(check_id,kind) WHERE status='pending';
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['branch_profiles','staff_invites','service_requests'] LOOP
 EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON ops.%I TO service_role',t);
 EXECUTE format('CREATE POLICY client_no_access ON ops.%I FOR ALL TO anon,authenticated USING (false) WITH CHECK(false)',t);
 END LOOP;END;$$;

CREATE FUNCTION ops.merchant_profile(p_business_id uuid,p_branch_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('name',b.name,'branchName',br.name,'phone',br.phone,'tagline',p.tagline,'about',p.about_text,
 'address',p.address,'mapQuery',p.map_query,'hours',p.hours,'version',p.version::text,
 'whatsappEnabled',p.whatsapp_enabled,'whatsappPhone',CASE WHEN p.whatsapp_enabled THEN p.whatsapp_phone ELSE NULL END,
 'orderingEnabled',s.ordering_enabled AND s.dine_in_enabled,
 'updatedAt',(SELECT max(updated_at) FROM public.menu_items WHERE branch_id=br.id AND business_id=b.id AND price_approved))
 FROM ops.branch_profiles p JOIN public.businesses b ON b.id=p.business_id JOIN public.branches br ON br.id=p.branch_id AND br.business_id=b.id
 JOIN ops.branch_settings s ON s.branch_id=p.branch_id AND s.business_id=p.business_id
 WHERE p.business_id=p_business_id AND p.branch_id=p_branch_id;
$$;

CREATE FUNCTION ops.staff_bootstrap(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u record;r ops.staff_invites%ROWTYPE;v_role text;
BEGIN
 SELECT id,email,email_confirmed_at INTO u FROM auth.users WHERE id=auth.uid();
 IF u.id IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 IF u.email_confirmed_at IS NOT NULL THEN
  FOR r IN SELECT * FROM ops.staff_invites WHERE business_id=p_business_id AND branch_id=p_branch_id AND email=lower(u.email)
   AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE LOOP
   INSERT INTO ops.branch_staff(business_id,branch_id,user_id,role,active,display_name)
   VALUES(r.business_id,r.branch_id,u.id,r.role,true,r.display_name)
   ON CONFLICT(business_id,branch_id,user_id) DO UPDATE SET role=EXCLUDED.role,active=true,display_name=EXCLUDED.display_name
   WHERE ops.branch_staff.role<>'owner';
   UPDATE ops.staff_invites SET status='claimed',claimed_by=u.id WHERE id=r.id;
  END LOOP;
 END IF;
 SELECT role INTO v_role FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id AND user_id=u.id AND active;
 RETURN jsonb_build_object('role',v_role,'emailVerified',u.email_confirmed_at IS NOT NULL,'userId',u.id);
END;$$;

CREATE FUNCTION ops.merchant_manage(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r ops.branch_staff%ROWTYPE;profile ops.branch_profiles%ROWTYPE;h jsonb;v_email text;v_role text;v_id uuid;staff jsonb;invites jsonb;requests jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 SELECT * INTO r FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id AND user_id=auth.uid() AND active FOR SHARE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 IF p_action IN('save-profile','invite-staff','revoke-invite','revoke-staff') AND r.role NOT IN('owner','manager') THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;
 IF p_action='save-profile' THEN
  SELECT * INTO profile FROM ops.branch_profiles WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
  IF (p_payload->>'version')::bigint IS DISTINCT FROM profile.version THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PROFILE_CHANGED';END IF;
  IF jsonb_typeof(p_payload->'hours') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'hours') NOT IN(0,7) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_HOURS';END IF;
  IF jsonb_array_length(p_payload->'hours')=7 AND (SELECT count(DISTINCT value->>'day') FROM jsonb_array_elements(p_payload->'hours') WHERE value->>'day' ~ '^[0-6]$')<>7 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_HOURS';END IF;
  FOR h IN SELECT value FROM jsonb_array_elements(p_payload->'hours') LOOP
   IF jsonb_typeof(h->'closed') IS DISTINCT FROM 'boolean' OR (h->>'closed'='false' AND
    (coalesce(h->>'open','')!~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' OR coalesce(h->>'close','')!~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$')) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_HOURS';END IF;
  END LOOP;
  IF jsonb_typeof(p_payload->'whatsappEnabled') IS DISTINCT FROM 'boolean' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PROFILE';END IF;
  IF p_payload->>'whatsappEnabled'='true' AND coalesce(p_payload->>'whatsappPhone','')!~'^[1-9][0-9]{7,14}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PHONE';END IF;
  UPDATE ops.branch_profiles SET tagline=btrim(p_payload->>'tagline'),about_text=btrim(p_payload->>'about'),
   whatsapp_phone=nullif(p_payload->>'whatsappPhone',''),whatsapp_enabled=(p_payload->>'whatsappEnabled')::boolean,
   address=nullif(btrim(p_payload->>'address'),''),map_query=nullif(btrim(p_payload->>'mapQuery'),''),hours=p_payload->'hours',version=version+1,updated_at=clock_timestamp()
   WHERE business_id=p_business_id AND branch_id=p_branch_id;
 ELSIF p_action='invite-staff' THEN
  v_email:=lower(btrim(p_payload->>'email'));v_role:=p_payload->>'role';
  IF v_role='manager' AND r.role<>'owner' THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_REQUIRED';END IF;
  IF r.role<>'owner' AND EXISTS(SELECT 1 FROM ops.branch_staff st JOIN auth.users au ON au.id=st.user_id WHERE st.business_id=p_business_id AND st.branch_id=p_branch_id AND st.role IN('owner','manager') AND lower(au.email)=v_email) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='OWNER_REQUIRED';END IF;
   IF EXISTS(SELECT 1 FROM ops.branch_staff s JOIN auth.users u ON u.id=s.user_id WHERE s.business_id=p_business_id AND s.branch_id=p_branch_id AND s.role='owner' AND lower(u.email)=v_email) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='OWNER_ROLE_PROTECTED';END IF;
  INSERT INTO ops.staff_invites(business_id,branch_id,email,display_name,role,created_by)
   VALUES(p_business_id,p_branch_id,v_email,btrim(p_payload->>'name'),v_role,auth.uid())
   ON CONFLICT(business_id,branch_id,email) WHERE status='pending' DO UPDATE SET role=EXCLUDED.role,display_name=EXCLUDED.display_name,expires_at=clock_timestamp()+interval '7 days';
 ELSIF p_action='revoke-invite' THEN
  UPDATE ops.staff_invites SET status='revoked' WHERE id=(p_payload->>'id')::uuid AND business_id=p_business_id AND branch_id=p_branch_id AND status='pending' AND (role<>'manager' OR r.role='owner');
 ELSIF p_action='revoke-staff' THEN
  v_id:=(p_payload->>'id')::uuid;
  IF v_id=auth.uid() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CANNOT_REVOKE_SELF';END IF;
  UPDATE ops.branch_staff SET active=false WHERE business_id=p_business_id AND branch_id=p_branch_id AND user_id=v_id AND role<>'owner' AND (role<>'manager' OR r.role='owner');
 ELSIF p_action='resolve-request' THEN
  IF r.role NOT IN('owner','manager','waiter','cashier') THEN RAISE SQLSTATE 'PT403' USING MESSAGE='FLOOR_STAFF_REQUIRED';END IF;
  UPDATE ops.service_requests SET status='done',handled_at=clock_timestamp(),handled_by=auth.uid() WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=(p_payload->>'id')::uuid AND status='pending';
 ELSIF p_action<>'snapshot' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_ACTION';END IF;
 IF p_action<>'snapshot' THEN INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details) VALUES(p_business_id,p_branch_id,auth.uid(),'merchant-'||p_action,jsonb_build_object('subject',coalesce(p_payload->>'id','profile')));END IF;
 IF r.role IN('owner','manager') THEN
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.user_id,'name',coalesce(s.display_name,u.email),'email',u.email,'role',s.role,'active',s.active) ORDER BY s.role,s.created_at),'[]') INTO staff FROM ops.branch_staff s JOIN auth.users u ON u.id=s.user_id WHERE s.business_id=p_business_id AND s.branch_id=p_branch_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name,'email',email,'role',role,'status',status,'expiresAt',expires_at) ORDER BY created_at DESC),'[]') INTO invites FROM ops.staff_invites WHERE business_id=p_business_id AND branch_id=p_branch_id AND status='pending';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',sr.id,'kind',sr.kind,'table',t.display_name,'at',sr.created_at) ORDER BY sr.created_at),'[]') INTO requests FROM ops.service_requests sr JOIN ops.checks c ON c.id=sr.check_id JOIN ops.dining_tables t ON t.id=c.table_id WHERE sr.business_id=p_business_id AND sr.branch_id=p_branch_id AND sr.status='pending' AND c.status IN('open','checkout');
 RETURN jsonb_build_object('role',r.role,'profile',ops.merchant_profile(p_business_id,p_branch_id),'staff',coalesce(staff,'[]'),'invites',coalesce(invites,'[]'),'requests',requests);
END;$$;

CREATE FUNCTION ops.request_service(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c ops.checks%ROWTYPE;r ops.service_requests%ROWTYPE;
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 SELECT * INTO c FROM ops.lock_check(p_business_id,p_branch_id,p_check_id,NULL);
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 IF c.service_mode<>'dine_in' OR c.status NOT IN('open','checkout') OR p_kind NOT IN('waiter','bill') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVALID_SERVICE_REQUEST';END IF;
 SELECT * INTO r FROM ops.service_requests WHERE check_id=c.id AND kind=p_kind AND status='pending';
 IF FOUND THEN RETURN jsonb_build_object('id',r.id,'status',r.status);END IF;
 PERFORM ops.throttle('service-request',5);
 INSERT INTO ops.service_requests(business_id,branch_id,check_id,user_id,kind) VALUES(p_business_id,p_branch_id,p_check_id,auth.uid(),p_kind) RETURNING * INTO r;
 RETURN jsonb_build_object('id',r.id,'status',r.status);
END;$$;

CREATE FUNCTION ops.my_visits(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'table',x.display_name,'status',x.status,'createdAt',x.created_at,'orderCount',x.n) ORDER BY x.created_at DESC),'[]')
 FROM (SELECT c.*,t.display_name,(SELECT count(*) FROM ops.orders o WHERE o.check_id=c.id) AS n FROM ops.checks c LEFT JOIN ops.dining_tables t ON t.id=c.table_id
 WHERE c.business_id=p_business_id AND c.branch_id=p_branch_id AND auth.uid() IS NOT NULL AND (c.opened_by_user_id=auth.uid() OR EXISTS(SELECT 1 FROM ops.check_members m WHERE m.check_id=c.id AND m.user_id=auth.uid())) ORDER BY c.created_at DESC LIMIT 30)x;
$$;

CREATE FUNCTION ops.whatsapp_quote(p_business_id uuid,p_branch_id uuid,p_lines jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE l jsonb;p public.menu_items%ROWTYPE;n integer;price bigint;total bigint:=0;rows jsonb:='[]';choice text;profile ops.branch_profiles%ROWTYPE;seen text[]:='{}';k text;
BEGIN
 SELECT * INTO profile FROM ops.branch_profiles WHERE business_id=p_business_id AND branch_id=p_branch_id;
 IF NOT FOUND OR NOT profile.whatsapp_enabled OR profile.whatsapp_phone IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='WHATSAPP_UNAVAILABLE';END IF;
 IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 30 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_CART';END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
  IF jsonb_typeof(l->'quantity') IS DISTINCT FROM 'number' OR coalesce(l->>'quantity','')!~'^[1-9][0-9]?$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_QUANTITY';END IF;
  n:=(l->>'quantity')::integer;IF n>20 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='QUANTITY_LIMIT';END IF;
  choice:=nullif(l->>'option','');
  SELECT * INTO p FROM public.menu_items WHERE id=(l->>'productId')::uuid AND business_id=p_business_id AND branch_id=p_branch_id;
  IF NOT FOUND OR NOT p.available OR NOT p.price_approved OR p.approved_price IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE';END IF;
  IF NOT ops.option_valid(p.options,CASE WHEN choice IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(choice) END) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED';END IF;
  k:=p.id::text||coalesce(choice,'');IF k=ANY(seen) THEN RAISE SQLSTATE 'PT400' USING MESSAGE='DUPLICATE_CART_LINE';END IF;seen:=array_append(seen,k);
  price:=ops.catalog_minor(p.approved_price::text);total:=total+price*n::bigint;
  rows:=rows||jsonb_build_array(jsonb_build_object('productId',p.id,'name',p.name,'option',choice,'quantity',n,'unitPriceMinor',price::text,'lineTotalMinor',(price*n::bigint)::text));
 END LOOP;
 RETURN jsonb_build_object('currency','TRY','totalMinor',total::text,'lines',rows,'phone',profile.whatsapp_phone);
END;$$;

CREATE FUNCTION ops.option_valid(p_options jsonb,p_selection jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN p_options='[]'::jsonb THEN p_selection='[]'::jsonb ELSE jsonb_typeof(p_selection)='array' AND jsonb_array_length(p_selection)=1 AND jsonb_typeof(p_selection->0)='string' AND p_options @> p_selection END;
$$;

CREATE OR REPLACE FUNCTION ops.cart_mutate_choice(
  p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,
  p_product_id uuid,p_delta integer,p_expected_revision bigint,p_option text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path='' SET lock_timeout='2s' AS $fn$
DECLARE
  request_payload jsonb;
  cached jsonb;
  result jsonb;
  product public.menu_items%ROWTYPE;
  line ops.cart_lines%ROWTYPE;
  line_exists boolean;
  new_quantity integer;
  unit_minor bigint;
  line_count bigint;
  unit_count bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';
  END IF;
  IF p_product_id IS NULL OR p_delta IS NULL
     OR p_delta=0 OR p_delta NOT BETWEEN -999 AND 999 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_CART_INPUT';
  END IF;
  request_payload := jsonb_build_object(
    'productId',p_product_id,'delta',p_delta,'expectedRevision',p_expected_revision::text
  );
  IF p_option IS NOT NULL THEN request_payload:=request_payload||jsonb_build_object('option',p_option);END IF;
  cached := ops.begin_command(p_business_id,p_branch_id,p_check_id,p_operation_id,
    p_expected_revision,'cart',request_payload);
  IF cached IS NOT NULL THEN RETURN cached; END IF;

  SELECT * INTO product FROM public.menu_items
    WHERE id=p_product_id AND business_id=p_business_id AND branch_id=p_branch_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';
  END IF;
  SELECT * INTO line FROM ops.cart_lines
    WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id
      AND product_source_id=product.source_id AND options_snapshot=CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END
    FOR UPDATE;
  line_exists := FOUND;
  IF NOT line_exists AND p_delta<0 THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='CART_LINE_NOT_FOUND';
  END IF;
  new_quantity := CASE WHEN line_exists THEN line.quantity ELSE 0 END + p_delta;
  IF new_quantity<0 OR new_quantity>999 THEN
    RAISE SQLSTATE 'PT422' USING MESSAGE='QUANTITY_OUT_OF_RANGE';
  END IF;

  IF p_delta>0 THEN
    IF product.available IS NOT TRUE OR product.price_approved IS NOT TRUE
       OR product.approved_price IS NULL THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE';
    END IF;
    -- Mevcut giriş sözleşmesinde optionId yok: seçenek gerektiren ürünlerde
    -- gizlice ilk seçeneği seçmek / ek ücreti atlamak yerine güvenli ret.
    IF NOT ops.option_valid(product.options,CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED';
    END IF;
    unit_minor := ops.catalog_minor(product.approved_price::text);
    -- İstemcinin zaten gördüğü satırı sessizce yeniden fiyatlandırma.
    IF line_exists AND line.unit_price_minor<>unit_minor THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRICE_CHANGED',
        DETAIL=jsonb_build_object('productId',product.id,
          'currentUnitPriceMinor',unit_minor::text)::text;
    END IF;
    SELECT count(*),coalesce(sum(quantity),0) INTO line_count,unit_count
      FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id
        AND check_id=p_check_id;
    -- sum(integer) BIGINT döner. Para toplamında sum(bigint) kullanılmaz.
    IF (NOT line_exists AND line_count>=100) OR unit_count+p_delta>500 THEN
      RAISE SQLSTATE 'PT422' USING MESSAGE='CART_LIMIT_EXCEEDED';
    END IF;
  ELSE
    -- Satıştan kalkmış/fiyatı onaysız ürünün AZALTILMASI/SİLİNMESİ serbest.
    -- Bu işlem yeni fiyat veya borç üretmez; mevcut taslak fiyatı korunur.
    unit_minor := line.unit_price_minor;
  END IF;

  IF new_quantity=0 THEN
    DELETE FROM ops.cart_lines WHERE id=line.id
      AND business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id;
  ELSIF line_exists THEN
    UPDATE ops.cart_lines SET quantity=new_quantity
      WHERE id=line.id AND business_id=p_business_id AND branch_id=p_branch_id
        AND check_id=p_check_id;
  ELSE
    INSERT INTO ops.cart_lines(business_id,branch_id,check_id,product_source_id,
      created_by_user_id,client_line_key,quantity,unit_price_minor,options_snapshot)
    VALUES(p_business_id,p_branch_id,p_check_id,product.source_id,auth.uid(),
      gen_random_uuid(),new_quantity,unit_minor,CASE WHEN p_option IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_option) END);
  END IF;
  -- Core trigger'ların artırdığı GERÇEK revizyon okunur; +1 varsayılmaz.
  result := ops.cart_result(p_check_id,p_operation_id);
  INSERT INTO ops.api_commands(actor_user_id,operation_id,business_id,branch_id,
    check_id,command_type,request_payload,response_body)
  VALUES(auth.uid(),p_operation_id,p_business_id,p_branch_id,p_check_id,
    'cart',request_payload,result);
  RETURN result;
END;
$fn$;
CREATE OR REPLACE FUNCTION ops.cart_result(p_check_id uuid,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  c ops.checks%ROWTYPE;
  item record;
  lines jsonb := '[]'::jsonb;
  total_minor bigint := 0;
BEGIN
  SELECT * INTO STRICT c FROM ops.checks WHERE id=p_check_id;
  FOR item IN
    SELECT cl.*, p.id AS product_id,p.name AS product_name
    FROM ops.cart_lines cl JOIN public.menu_items p
      ON p.business_id=cl.business_id AND p.branch_id=cl.branch_id
      AND p.source_id=cl.product_source_id
    WHERE cl.business_id=c.business_id AND cl.branch_id=c.branch_id
      AND cl.check_id=c.id ORDER BY cl.created_at,cl.id
  LOOP
    total_minor := total_minor + item.line_total_minor;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'cartLineId',item.id,'productId',item.product_id,'productName',left(item.product_name||CASE WHEN item.options_snapshot<>'[]'::jsonb THEN ' · '||(item.options_snapshot->>0) ELSE '' END,250),'option',item.options_snapshot->>0,
      'quantity',item.quantity,'unitPriceMinor',item.unit_price_minor::text,
      'lineTotalMinor',item.line_total_minor::text
    ));
  END LOOP;
  RETURN jsonb_build_object(
    'checkId',c.id,'operationId',p_operation_id,'revision',c.revision::text,
    'currency',c.currency,'totalMinor',total_minor::text,'lines',lines
  );
EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT422' USING MESSAGE='AMOUNT_LIMIT_EXCEEDED';
END;
$fn$;
CREATE OR REPLACE FUNCTION ops.order_submit(
  p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,
  p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path='' SET lock_timeout='2s' AS $fn$
DECLARE
  request_payload jsonb;
  cached jsonb;
  result jsonb;
  line ops.cart_lines%ROWTYPE;
  product public.menu_items%ROWTYPE;
  order_row ops.orders%ROWTYPE;
  item ops.order_items%ROWTYPE;
  unit_minor bigint;
  total_minor bigint := 0;
  revision_value bigint;
  line_count bigint;
  unit_count bigint;
  line_no integer := 0;
  charge_count integer := 0;
  fingerprint text;
  output_lines jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';
  END IF;
  request_payload := jsonb_build_object('expectedRevision',p_expected_revision::text);
  cached := ops.begin_command(p_business_id,p_branch_id,p_check_id,p_operation_id,
    p_expected_revision,'order',request_payload);
  IF cached IS NOT NULL THEN RETURN cached; END IF;
  SELECT count(*),coalesce(sum(quantity),0) INTO line_count,unit_count
    FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id
      AND check_id=p_check_id;
  IF line_count=0 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='CART_EMPTY'; END IF;
  IF line_count>100 OR unit_count>500 THEN
    RAISE SQLSTATE 'PT422' USING MESSAGE='CART_LIMIT_EXCEEDED';
  END IF;

  -- Tüm katalog satırları sabit sırayla kilitlenir: fiyat/uygunluk güncellemesi
  -- bu sipariş transaction'ı bitmeden araya giremez. Aynı ürünlü farklı
  -- adisyonlar FOR SHARE ile birbiriyle uyumludur.
  PERFORM p.id FROM public.menu_items p
    JOIN ops.cart_lines cl ON cl.product_source_id=p.source_id
      AND cl.branch_id=p.branch_id AND cl.business_id=p.business_id
    WHERE cl.business_id=p_business_id AND cl.branch_id=p_branch_id
      AND cl.check_id=p_check_id
    ORDER BY p.id FOR SHARE OF p;

  -- Core trigger yeni order için önce draft zorunlu kılar. Sipariş turu
  -- burada oluşturulur; bütün snapshot ve borçlar tamamlanınca submitted olur.
  fingerprint := encode(pg_catalog.sha256(convert_to(jsonb_build_object(
    'actorId',auth.uid(),'businessId',p_business_id,'branchId',p_branch_id,
    'checkId',p_check_id,'operationId',p_operation_id,'payload',request_payload
  )::text,'UTF8')),'hex');
  BEGIN
    INSERT INTO ops.orders(business_id,branch_id,check_id,client_request_id,
      request_fingerprint,submitted_by_user_id,status)
    VALUES(p_business_id,p_branch_id,p_check_id,p_operation_id,fingerprint,auth.uid(),'draft')
    RETURNING * INTO order_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';
  END;

  FOR line IN SELECT * FROM ops.cart_lines
    WHERE business_id=p_business_id AND branch_id=p_branch_id AND check_id=p_check_id
    ORDER BY id FOR UPDATE
  LOOP
    SELECT * INTO product FROM public.menu_items
      WHERE business_id=p_business_id AND branch_id=p_branch_id
        AND source_id=line.product_source_id;
    IF NOT FOUND OR product.available IS NOT TRUE
       OR product.price_approved IS NOT TRUE OR product.approved_price IS NULL THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_NOT_ORDERABLE';
    END IF;
    IF NOT ops.option_valid(product.options,line.options_snapshot) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='OPTION_REQUIRED';
    END IF;
    unit_minor := ops.catalog_minor(product.approved_price::text);
    IF unit_minor<>line.unit_price_minor THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE='PRICE_CHANGED',
        DETAIL=jsonb_build_object('productId',product.id,
          'currentUnitPriceMinor',unit_minor::text)::text;
    END IF;
    line_no := line_no+1;
    INSERT INTO ops.order_items(business_id,branch_id,check_id,order_id,line_no,
      product_source_id,product_name_snapshot,options_snapshot,quantity,
      unit_price_minor,discount_minor)
    VALUES(p_business_id,p_branch_id,p_check_id,order_row.id,line_no,
      product.source_id,left(product.name||CASE WHEN line.options_snapshot<>'[]'::jsonb THEN ' · '||(line.options_snapshot->>0) ELSE '' END,250),line.options_snapshot,line.quantity,unit_minor,0::bigint)
    RETURNING * INTO item;

    -- quantity=3 -> unit_no=1,2,3. Set tabanlı döngü her birim için ayrı INSERT
    -- kaydı oluşturur. Core trigger birim tutarını ayrıca doğrular.
    INSERT INTO ops.bill_charges(business_id,branch_id,check_id,order_id,
      order_item_id,unit_no,kind,amount_minor,currency,status)
    SELECT p_business_id,p_branch_id,p_check_id,order_row.id,item.id,u.unit_no,
      'item',item.unit_price_minor
        - (item.discount_minor / item.quantity::bigint)
        - CASE WHEN u.unit_no::bigint <= item.discount_minor % item.quantity::bigint
               THEN 1::bigint ELSE 0::bigint END,
      'TRY','active'
    FROM generate_series(1,item.quantity) AS u(unit_no);

    total_minor := total_minor+item.net_minor;
    charge_count := charge_count+item.quantity;
    output_lines := output_lines || jsonb_build_array(jsonb_build_object(
      'orderItemId',item.id,'productId',product.id,'productName',item.product_name_snapshot,
      'quantity',item.quantity,'unitPriceMinor',item.unit_price_minor::text,
      'discountMinor',item.discount_minor::text,'grossMinor',item.gross_minor::text,
      'netMinor',item.net_minor::text
    ));
  END LOOP;
  DELETE FROM ops.cart_lines WHERE business_id=p_business_id AND branch_id=p_branch_id
    AND check_id=p_check_id;
  UPDATE ops.orders SET status='submitted',submitted_at=clock_timestamp()
    WHERE id=order_row.id AND business_id=p_business_id AND branch_id=p_branch_id
    RETURNING * INTO order_row;
  SELECT revision INTO revision_value FROM ops.checks WHERE id=p_check_id;
  result := jsonb_build_object('checkId',p_check_id,'operationId',p_operation_id,
    'orderId',order_row.id,'status','submitted','revision',revision_value::text,
    'currency','TRY','totalMinor',total_minor::text,'chargeCount',charge_count,
    'lines',output_lines);
  INSERT INTO ops.api_commands(actor_user_id,operation_id,business_id,branch_id,
    check_id,command_type,request_payload,response_body)
  VALUES(auth.uid(),p_operation_id,p_business_id,p_branch_id,p_check_id,
    'order',request_payload,result);
  RETURN result;
EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE SQLSTATE 'PT422' USING MESSAGE='AMOUNT_LIMIT_EXCEEDED';
END;
$fn$;

CREATE UNIQUE INDEX cart_one_product_variant ON ops.cart_lines(business_id,branch_id,check_id,product_source_id,options_snapshot);
CREATE OR REPLACE FUNCTION ops.catalogue(p_business_id uuid,p_branch_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE x record;rows jsonb:='[]';v_branch record;
BEGIN
 SELECT o.name,b.name AS branch_name,b.phone,s.ordering_enabled INTO v_branch FROM public.businesses o JOIN public.branches b ON b.business_id=o.id
 JOIN ops.branch_settings s ON s.branch_id=b.id AND s.business_id=o.id WHERE o.id=p_business_id AND b.id=p_branch_id;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
 FOR x IN SELECT * FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id ORDER BY sort_order,source_id LOOP
 rows:=rows||jsonb_build_array(jsonb_build_object('id',x.id,'sourceId',x.source_id,'name',x.name,'category',x.category_key,'subcategory',x.subcategory,'description',x.description,
 'quantityLabel',x.quantity_label,'options',x.options,'available',x.available,'priceApproved',x.price_approved,'updatedAt',x.updated_at,
 'priceMinor',CASE WHEN x.price_approved AND x.approved_price IS NOT NULL THEN ops.catalog_minor(x.approved_price::text)::text WHEN x.source_price IS NOT NULL THEN ops.catalog_minor(x.source_price::text)::text ELSE NULL END,
 'canOrder',v_branch.ordering_enabled AND x.price_approved AND x.approved_price IS NOT NULL AND x.available));END LOOP;
 RETURN jsonb_build_object('name',v_branch.name,'branchName',v_branch.branch_name,'phone',v_branch.phone,'orderingEnabled',v_branch.ordering_enabled,'items',rows);
END;$$;
-- Preserve previous console actions as private implementation; narrow the public role transitions.
ALTER FUNCTION ops.console_action(uuid,uuid,text,jsonb) RENAME TO console_action_v6;
REVOKE ALL ON FUNCTION ops.console_action_v6(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION ops.console_action(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;
BEGIN
 SELECT role INTO r FROM ops.branch_staff WHERE business_id=p_business_id AND branch_id=p_branch_id AND user_id=auth.uid() AND active;
 IF r IS NULL THEN RAISE SQLSTATE 'PT403' USING MESSAGE='STAFF_REQUIRED';END IF;
 IF p_action='order-status' AND r NOT IN('owner','manager') THEN
 IF (r='kitchen' AND p_payload->>'status' NOT IN('accepted','preparing','ready'))
  OR (r='waiter' AND p_payload->>'status' NOT IN('accepted','served','completed'))
  OR r='cashier' THEN RAISE SQLSTATE 'PT403' USING MESSAGE='ROLE_ACTION_FORBIDDEN';END IF;END IF;
 RETURN ops.console_action_v6(p_business_id,p_branch_id,p_action,p_payload);
END;$$;
REVOKE ALL ON FUNCTION ops.merchant_profile(uuid,uuid),ops.staff_bootstrap(uuid,uuid),ops.merchant_manage(uuid,uuid,text,jsonb),ops.request_service(uuid,uuid,uuid,text),ops.my_visits(uuid,uuid),ops.whatsapp_quote(uuid,uuid,jsonb),ops.option_valid(jsonb,jsonb),ops.cart_mutate_choice(uuid,uuid,uuid,uuid,uuid,integer,bigint,text),ops.console_action(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.merchant_profile(uuid,uuid),ops.whatsapp_quote(uuid,uuid,jsonb) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION ops.staff_bootstrap(uuid,uuid),ops.merchant_manage(uuid,uuid,text,jsonb),ops.request_service(uuid,uuid,uuid,text),ops.my_visits(uuid,uuid),ops.cart_mutate_choice(uuid,uuid,uuid,uuid,uuid,integer,bigint,text),ops.console_action(uuid,uuid,text,jsonb) TO authenticated;
CREATE FUNCTION ops.customer_orders(p_business_id uuid,p_branch_id uuid,p_check_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE data jsonb;
BEGIN
 PERFORM ops.assert_command_actor(p_business_id,p_branch_id,p_check_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status',o.status,'createdAt',o.created_at,'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',i.product_name_snapshot,'quantity',i.quantity,'amountMinor',i.net_minor::text) ORDER BY i.line_no),'[]'::jsonb) FROM ops.order_items i WHERE i.order_id=o.id AND i.business_id=p_business_id AND i.branch_id=p_branch_id)) ORDER BY o.created_at DESC),'[]') INTO data FROM ops.orders o WHERE o.check_id=p_check_id AND o.business_id=p_business_id AND o.branch_id=p_branch_id AND o.status<>'draft';
 RETURN data;
END;$$;
REVOKE ALL ON FUNCTION ops.customer_orders(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION ops.customer_orders(uuid,uuid,uuid) TO authenticated;
-- Retain backward compatibility without allowing a legacy command to target an arbitrary variant.
CREATE OR REPLACE FUNCTION ops.cart_mutate(p_business_id uuid,p_branch_id uuid,p_check_id uuid,p_operation_id uuid,p_product_id uuid,p_delta integer,p_expected_revision bigint)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
SELECT ops.cart_mutate_choice(p_business_id,p_branch_id,p_check_id,p_operation_id,p_product_id,p_delta,p_expected_revision,NULL);
$$;
REVOKE ALL ON FUNCTION ops.cart_mutate(uuid,uuid,uuid,uuid,uuid,integer,bigint) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION ops.cart_mutate(uuid,uuid,uuid,uuid,uuid,integer,bigint) TO authenticated;
COMMIT;
