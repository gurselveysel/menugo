-- Human-confirmed allowlisted assistant commands. No arbitrary SQL, price, payment or provider action.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.assistant_commands(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES auth.users(id),
 operation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('set-product-availability','undo-product-availability')),
 product_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE RESTRICT,
 reverses_command_id uuid REFERENCES ops.assistant_commands(id) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 before_value jsonb NOT NULL CHECK(jsonb_typeof(before_value)='object'),
 after_value jsonb NOT NULL CHECK(jsonb_typeof(after_value)='object'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 200 AND reason !~ '[[:cntrl:]]'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(business_id,branch_id,actor_user_id,operation_id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);
CREATE UNIQUE INDEX assistant_commands_one_undo ON ops.assistant_commands(reverses_command_id) WHERE reverses_command_id IS NOT NULL;
CREATE INDEX assistant_commands_branch_time ON ops.assistant_commands(business_id,branch_id,created_at DESC);
ALTER TABLE ops.assistant_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.assistant_commands FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON ops.assistant_commands TO service_role;
CREATE POLICY no_direct_assistant_command_access ON ops.assistant_commands AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION ops.assistant_command(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE c ops.assistant_commands%ROWTYPE;target ops.assistant_commands%ROWTYPE;m public.menu_items%ROWTYPE;op_id uuid;product_v uuid;command_v uuid;expected_ts timestamptz;desired boolean;reason_v text;h text;before_v jsonb;after_v jsonb;result_v jsonb;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>5000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END IF;
 IF p_action='list' THEN
  RETURN jsonb_build_object(
   'scopeKey',p_business_id::text||':'||p_branch_id::text||':'||auth.uid()::text,
   'products',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',mi.id,'name',mi.name,'available',mi.available,'updatedAt',mi.updated_at) ORDER BY mi.sort_order,mi.source_id),'[]') FROM public.menu_items mi WHERE mi.business_id=p_business_id AND mi.branch_id=p_branch_id),
   'history',(SELECT coalesce(jsonb_agg(row_value ORDER BY created_at DESC),'[]') FROM (SELECT jsonb_build_object('id',x.id,'action',x.action,'productId',x.product_id,'productName',mi.name,'before',x.before_value,'after',x.after_value,'reason',x.reason,'createdAt',x.created_at,'reversesCommandId',x.reverses_command_id) AS row_value,x.created_at FROM ops.assistant_commands x JOIN public.menu_items mi ON mi.id=x.product_id AND mi.business_id=x.business_id AND mi.branch_id=x.branch_id WHERE x.business_id=p_business_id AND x.branch_id=p_branch_id ORDER BY x.created_at DESC LIMIT 40) recent)
  );
 END IF;
 IF p_action NOT IN('set-product-availability','undo-product-availability') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END IF;
 IF p_payload->>'operationId' IS NULL OR p_payload->>'confirmed' IS DISTINCT FROM 'true' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END IF;
 BEGIN op_id:=(p_payload->>'operationId')::uuid;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END;
 reason_v:=btrim(coalesce(p_payload->>'reason',''));IF length(reason_v) NOT BETWEEN 5 AND 200 OR reason_v ~ '[[:cntrl:]]' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END IF;
 h:=encode(sha256(convert_to((p_payload-'operationId')::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('assistant-command:'||p_business_id::text||':'||p_branch_id::text,0));
 SELECT * INTO c FROM ops.assistant_commands WHERE business_id=p_business_id AND branch_id=p_branch_id AND actor_user_id=auth.uid() AND operation_id=op_id;
 IF FOUND THEN IF c.action<>p_action OR c.request_hash<>h THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;RETURN c.result||jsonb_build_object('duplicate',true);END IF;

 IF p_action='set-product-availability' THEN
  PERFORM ops.platform_gate(p_business_id,p_branch_id,'aiEnabled');
  IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>6 OR jsonb_typeof(p_payload->'available')<>'boolean' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END IF;
  BEGIN product_v:=(p_payload->>'productId')::uuid;expected_ts:=(p_payload->>'expectedUpdatedAt')::timestamptz;desired:=(p_payload->>'available')::boolean;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END;
  SELECT * INTO m FROM public.menu_items WHERE id=product_v AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
  IF m.updated_at<>expected_ts THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_CHANGED';END IF;
  IF m.available=desired THEN RAISE SQLSTATE 'PT409' USING MESSAGE='ALREADY_IN_STATE';END IF;
  before_v:=jsonb_build_object('available',m.available,'updatedAt',m.updated_at);
  UPDATE public.menu_items SET available=desired,updated_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
  after_v:=jsonb_build_object('available',m.available,'updatedAt',m.updated_at);
  result_v:=jsonb_build_object('commandId',gen_random_uuid(),'productId',m.id,'productName',m.name,'available',m.available,'updatedAt',m.updated_at,'priceChanged',false,'duplicate',false);
  INSERT INTO ops.assistant_commands(id,business_id,branch_id,actor_user_id,operation_id,action,product_id,request_hash,before_value,after_value,reason,result)
  VALUES((result_v->>'commandId')::uuid,p_business_id,p_branch_id,auth.uid(),op_id,p_action,m.id,h,before_v,after_v,reason_v,result_v);
  INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,subject_id,details) VALUES(p_business_id,p_branch_id,auth.uid(),'assistant-set-product-availability',m.id,jsonb_build_object('commandId',result_v->>'commandId','before',before_v,Iafter',after_v,'reason',reason_v));
  RETURN result_v;
 END IF;

 IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>4 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END IF;
 BEGIN command_v:=(p_payload->>'commandId')::uuid;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_ASSISTANT_COMMAND';END;
 SELECT * INTO target FROM ops.assistant_commands WHERE id=command_v AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND OR target.action<>'set-product-availability' THEN RAISE SQLSTATE 'PT404' USING MESSAGE='COMMAND_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM ops.assistant_commands WHERE reverses_command_id=target.id) THEN RAISE SQLSTATE 'PT409' USING MESSAGE='COMMAND_ALREADY_UNDONE';END IF;
 SELECT * INTO M FROM public.menu_items WHERE id=target.product_id AND business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
 IF m.updated_at<>(target.after_value->>'updatedAt')::timestamptz OR m.available<>(target.after_value->>'available')::boolean THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PRODUCT_CHANGED';END IF;
 before_v:=jsonb_build_object('available',m.available,'updatedAt',m.updated_at);
 UPDATE public.menu_items SET available=(target.before_value->>'available')::boolean,updated_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
 after_v:=jsonb_build_object('available',m.available,'updatedAt',m.updated_at);
 result_v:=jsonb_build_object('commandId',gen_random_uuid(),'productId',m.id,'productName',m.name,'available',m.available,'updatedAt',m.updated_at,'reversedCommandId',target.id,'priceChanged',false,'duplicate',false);
 INSERT INTO ops.assistant_commands(id,business_id,branch_id,actor_user_id,operation_id,action,product_id,reverses_command_id,request_hash,before_value,after_value,reason,result)
 VALUES((result_v->>'commandId')::uuid,p_business_id,p_branch_id,auth.uid(),op_id,p_action,m.id,target.id,h,before_v,after_v,reason_v,result_v);
 INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,subject_id,details) VALUES(p_business_id,p_branch_id,auth.uid(),'assistant-undo-product-availability',m.id,jsonb_build_object('commandId',result_v->>'commandId','reversedCommandId',target.id,'before',before_v,'after',after_v,'reason',reason_v));
 RETURN result_v;
END;$$;
REVOKE ALL ON FUNCTION ops.assistant_command(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.assistant_command(uuid,uuid,text,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
