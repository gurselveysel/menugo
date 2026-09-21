-- Human-approved purchasing and recipe cost journals.
-- No provider output is trusted as a financial command and no stock/accounting/catalogue rows are mutated.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE ops.purchase_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 studio_job_id uuid NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision>=0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 invoice_number text,
 invoice_date date,
 currency text NOT NULL CHECK(currency='TRY'),
 total_minor bigint NOT NULL CHECK(total_minor>=0),
 posted_by uuid NOT NULL REFERENCES auth.users(id),
 posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(business_id,branch_id,id),
 UNIQUE(business_id,branch_id,studio_job_id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id),
 FOREIGN KEY(business_id,branch_id,studio_job_id) REFERENCES ops.studio_jobs(business_id,branch_id,id),
 CHECK(invoice_number IS NULL OR (length(invoice_number)<=100 AND invoice_number !~ '[[:cntrl:]]'))
);

CREATE TABLE ops.purchase_entry_lines (
 business_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 purchase_id uuid NOT NULL,
 line_no integer NOT NULL CHECK(line_no BETWEEN 1 AND 200),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name !~ '[[:cntrl:]]'),
 quantity_text text NOT NULL CHECK(length(quantity_text)<=60 AND quantity_text !~ '[[:cntrl:]]'),
 unit_text text NOT NULL CHECK(length(unit_text)<=40 AND unit_text !~ '[[:cntrl:]]'),
 net_minor bigint NOT NULL CHECK(net_minor>=0),
 tax_minor bigint NOT NULL CHECK(tax_minor>=0),
 gross_minor bigint NOT NULL CHECK(gross_minor>=0 AND net_minor+tax_minor=gross_minor),
 source_page integer NOT NULL CHECK(source_page BETWEEN 1 AND 8),
 source_text text NOT NULL CHECK(length(source_text) BETWEEN 1 AND 300 AND source_text !~ '[[:cntrl:]]'),
 PRIMARY KEY(purchase_id,line_no),
 FOREIGN KEY(business_id,branch_id,purchase_id) REFERENCES ops.purchase_entries(business_id,branch_id,id)
);

CREATE TABLE ops.recipe_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 product_id uuid NOT NULL REFERENCES public.menu_items(id),
 recipe_name text NOT NULL CHECK(length(recipe_name) BETWEEN 1 AND 120 AND recipe_name !~ '[[:cntrl:]]'),
 version bigint NOT NULL CHECK(version>0),
 portions integer NOT NULL CHECK(portions BETWEEN 1 AND 1000),
 overhead_minor bigint NOT NULL CHECK(overhead_minor>=0),
 total_minor bigint NOT NULL CHECK(total_minor>=0),
 currency text NOT NULL CHECK(currency='TRY'),
 cost_basis text NOT NULL CHECK(cost_basis='human-verified-input'),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(business_id,branch_id,id),
 UNIQUE(business_id,branch_id,product_id,recipe_name,version),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);

CREATE TABLE ops.recipe_ingredients (
 business_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 recipe_version_id uuid NOT NULL,
 line_no integer NOT NULL CHECK(line_no BETWEEN 1 AND 100),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160 AND name !~ '[[:cntrl:]]'),
 unit text NOT NULL CHECK(unit IN('g','ml','piece')),
 pack_quantity bigint NOT NULL CHECK(pack_quantity>0),
 pack_cost_minor bigint NOT NULL CHECK(pack_cost_minor>=0),
 recipe_quantity bigint NOT NULL CHECK(recipe_quantity>0),
 edible_yield_bps integer NOT NULL CHECK(edible_yield_bps BETWEEN 1 AND 10000),
 PRIMARY KEY(recipe_version_id,line_no),
 FOREIGN KEY(business_id,branch_id,recipe_version_id) REFERENCES ops.recipe_versions(business_id,branch_id,id)
);

CREATE TABLE ops.cost_commands (
 business_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES auth.users(id),
 operation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('post-invoice','save-recipe')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(business_id,branch_id,actor_user_id,operation_id),
 FOREIGN KEY(business_id,branch_id) REFERENCES ops.branch_settings(business_id,branch_id)
);

CREATE INDEX purchase_entries_branch_time ON ops.purchase_entries(business_id,branch_id,posted_at DESC);
CREATE INDEX recipe_versions_branch_product ON ops.recipe_versions(business_id,branch_id,product_id,created_at DESC);

DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['purchase_entries','purchase_entry_lines','recipe_versions','recipe_ingredients','cost_commands'] LOOP
  EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT,INSERT ON ops.%I TO service_role',t);
  EXECUTE format('CREATE POLICY no_direct_cost_access ON ops.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
 END LOOP;
END;$$;

CREATE FUNCTION ops.studio_cost_ledger(p_business_id uuid,p_branch_id uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE
 c ops.cost_commands%ROWTYPE;j ops.studio_jobs%ROWTYPE;p ops.purchase_entries%ROWTYPE;r ops.recipe_versions%ROWTYPE;
 h text;op_id uuid;job_id uuid;expected_revision bigint;product_v uuid;line jsonb;idx integer;
 invoice_total numeric:=0;computed_total numeric:=0;net_v bigint;tax_v bigint;gross_v bigint;
 recipe_total numeric:=0;overhead_v bigint;pack_v bigint;cost_v bigint;used_v bigint;yield_v integer;portions_v integer;
 max_minor constant numeric:=9223372036854775807;version_v bigint;result_v jsonb;source_hash_v text;recipe_name_v text;
BEGIN
 PERFORM ops.import_assert_manager(p_business_id,p_branch_id);
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>100000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END IF;

 IF p_action='list' THEN
  RETURN jsonb_build_object(
   'scopeKey',p_business_id::text||':'||p_branch_id::text||':'||auth.uid()::text,
   'purchases',coalesce((SELECT jsonb_agg(x ORDER BY x->>'postedAt' DESC) FROM(
     SELECT jsonb_build_object('id',e.id,'jobId',e.studio_job_id,'invoiceNumber',e.invoice_number,'invoiceDate',e.invoice_date,'currency',e.currency,'totalMinor',e.total_minor::text,'postedAt',e.posted_at,
       'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('lineNo',l.line_no,'name',l.name,'quantityText',l.quantity_text,'unitText',l.unit_text,'netMinor',l.net_minor::text,'taxMinor',l.tax_minor::text,'grossMinor',l.gross_minor::text,'page',l.source_page,'sourceText',l.source_text) ORDER BY l.line_no),'[]') FROM ops.purchase_entry_lines l WHERE l.purchase_id=e.id)) x
     FROM ops.purchase_entries e WHERE e.business_id=p_business_id AND e.branch_id=p_branch_id ORDER BY e.posted_at DESC LIMIT 20
   )q),'[]'),
   'recipes',coalesce((SELECT jsonb_agg(x ORDER BY x->>'createdAt' DESC) FROM(
     SELECT jsonb_build_object('id',v.id,'productId',v.product_id,'productName',m.name,'name',v.recipe_name,'version',v.version::text,'portions',v.portions,'overheadMinor',v.overhead_minor::text,'totalMinor',v.total_minor::text,'currency',v.currency,'costBasis',v.cost_basis,'createdAt',v.created_at,
       'ingredients',(SELECT coalesce(jsonb_agg(jsonb_build_object('lineNo',i.line_no,'name',i.name,'unit',i.unit,'packQuantity',i.pack_quantity::text,'packCostMinor',i.pack_cost_minor::text,'recipeQuantity',i.recipe_quantity::text,'edibleYieldBps',i.edible_yield_bps) ORDER BY i.line_no),'[]') FROM ops.recipe_ingredients i WHERE i.recipe_version_id=v.id)) x
     FROM ops.recipe_versions v JOIN public.menu_items m ON m.id=v.product_id AND m.business_id=v.business_id AND m.branch_id=v.branch_id
     WHERE v.business_id=p_business_id AND v.branch_id=p_branch_id ORDER BY v.created_at DESC LIMIT 30
   )q),'[]'),
   'catalogue',ops.import_catalogue(p_business_id,p_branch_id)
  );
 END IF;

 IF p_action NOT IN('post-invoice','save-recipe') OR p_payload->>'operationId' IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END IF;
 BEGIN op_id:=(p_payload->>'operationId')::uuid;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END;
 h:=encode(sha256(convert_to((p_payload-'operationId')::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('cost:'||p_business_id::text||':'||p_branch_id::text,0));
 SELECT * INTO c FROM ops.cost_commands WHERE business_id=p_business_id AND branch_id=p_branch_id AND actor_user_id=auth.uid() AND operation_id=op_id;
 IF FOUND THEN
  IF c.action<>p_action OR c.request_hash<>h THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT';END IF;
  RETURN c.result||jsonb_build_object('duplicate',true);
 END IF;
 PERFORM 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;

 IF p_action='post-invoice' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>4 OR p_payload->>'jobId' IS NULL OR p_payload->>'revision' IS NULL OR p_payload->>'confirmed' IS DISTINCT FROM 'true' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END IF;
  BEGIN job_id:=(p_payload->>'jobId')::uuid;expected_revision:=(p_payload->>'revision')::bigint;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END;
  SELECT * INTO j FROM ops.studio_jobs WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='STUDIO_JOB_NOT_FOUND';END IF;
  IF j.kind<>'invoice' OR j.state<>'approved' OR j.reviewed_by IS NULL OR j.result IS NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE='APPROVED_INVOICE_REQUIRED';END IF;
  IF j.revision<>expected_revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_REVISION_CHANGED';END IF;
  IF j.result->>'kind'<>'invoice' OR j.result->>'draftOnly'<>'true' OR j.result->>'currency'<>'TRY' OR jsonb_typeof(j.result->'lines')<>'array' OR jsonb_array_length(j.result->'lines') NOT BETWEEN 1 AND 200 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVOICE_RECONCILIATION_REQUIRED';END IF;
  IF j.result->>'totalMinor' IS NULL OR NOT(j.result->>'totalMinor' ~ '^(0|[1-9][0-9]{0,18})$') OR (j.result->>'totalMinor')::numeric>max_minor THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVOICE_RECONCILIATION_REQUIRED';END IF;
  invoice_total:=(j.result->>'totalMinor')::numeric;computed_total:=0;idx:=0;
  FOR line IN SELECT value FROM jsonb_array_elements(j.result->'lines') LOOP
   idx:=idx+1;
   IF jsonb_typeof(line)<>'object' OR coalesce(line->>'name','')='' OR length(line->>'name')>200 OR coalesce(line->>'sourceText','')='' OR length(line->>'sourceText')>300
      OR line->>'netMinor' IS NULL OR line->>'taxMinor' IS NULL OR line->>'grossMinor' IS NULL
      OR NOT(line->>'netMinor' ~ '^(0|[1-9][0-9]{0,18})$') OR NOT(line->>'taxMinor' ~ '^(0|[1-9][0-9]{0,18})$') OR NOT(line->>'grossMinor' ~ '^(0|[1-9][0-9]{0,18})$')
      OR (line->>'netMinor')::numeric>max_minor OR (line->>'taxMinor')::numeric>max_minor OR (line->>'grossMinor')::numeric>max_minor
      OR NOT(coalesce(line->>'page','') ~ '^[1-8]$') THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVOICE_RECONCILIATION_REQUIRED';END IF;
   net_v:=(line->>'netMinor')::bigint;tax_v:=(line->>'taxMinor')::bigint;gross_v:=(line->>'grossMinor')::bigint;
   IF net_v>9223372036854775807-tax_v OR net_v+tax_v<>gross_v THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVOICE_RECONCILIATION_REQUIRED';END IF;
   computed_total:=computed_total+gross_v::numeric;
   IF computed_total>max_minor THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVOICE_RECONCILIATION_REQUIRED';END IF;
  END LOOP;
  IF computed_total<>invoice_total THEN RAISE SQLSTATE 'PT409' USING MESSAGE='INVOICE_RECONCILIATION_REQUIRED';END IF;
  source_hash_v:=encode(sha256(convert_to(j.result::text,'UTF8')),'hex');
  SELECT * INTO p FROM ops.purchase_entries WHERE business_id=p_business_id AND branch_id=p_branch_id AND studio_job_id=j.id;
  IF FOUND THEN
   IF p.source_hash<>source_hash_v OR p.source_revision<>j.revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE='PURCHASE_SOURCE_CONFLICT';END IF;
   result_v:=jsonb_build_object('purchaseId',p.id,'posted',true,'alreadyPosted',true,'totalMinor',p.total_minor::text);
  ELSE
   INSERT INTO ops.purchase_entries(business_id,branch_id,studio_job_id,source_revision,source_hash,invoice_number,invoice_date,currency,total_minor,posted_by)
   VALUES(p_business_id,p_branch_id,j.id,j.revision,source_hash_v,nullif(j.result->>'invoiceNumber',''),nullif(j.result->>'invoiceDate','')::date,'TRY',invoice_total::bigint,auth.uid()) RETURNING * INTO p;
   idx:=0;
   FOR line IN SELECT value FROM jsonb_array_elements(j.result->'lines') LOOP
    idx:=idx+1;
    INSERT INTO ops.purchase_entry_lines(business_id,branch_id,purchase_id,line_no,name,quantity_text,unit_text,net_minor,tax_minor,gross_minor,source_page,source_text)
    VALUES(p_business_id,p_branch_id,p.id,idx,line->>'name',coalesce(line->>'quantityText',''),coalesce(line->>'unitText',''),(line->>'netMinor')::bigint,(line->>'taxMinor')::bigint,(line->>'grossMinor')::bigint,(line->>'page')::integer,line->>'sourceText');
   END LOOP;
   result_v:=jsonb_build_object('purchaseId',p.id,'posted',true,'alreadyPosted',false,'totalMinor',p.total_minor::text);
  END IF;

 ELSE
  IF (SELECT count(*) FROM jsonb_object_keys(p_payload))<>8 OR p_payload->>'productId' IS NULL OR p_payload->>'name' IS NULL OR p_payload->>'portions' IS NULL OR p_payload->>'overheadMinor' IS NULL OR jsonb_typeof(p_payload->'ingredients')<>'array' OR p_payload->>'confirmed' IS DISTINCT FROM 'true' THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END IF;
  BEGIN product_v:=(p_payload->>'productId')::uuid;portions_v:=(p_payload->>'portions')::integer;overhead_v:=(p_payload->>'overheadMinor')::bigint;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END;
  recipe_name_v:=btrim(p_payload->>'name');
  IF recipe_name_v='' OR length(recipe_name_v)>120 OR recipe_name_v ~ '[[:cntrl:]]' OR portions_v NOT BETWEEN 1 AND 1000 OR overhead_v<0 OR jsonb_array_length(p_payload->'ingredients') NOT BETWEEN 1 AND 100 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END IF;
  PERFORM 1 FROM public.menu_items WHERE business_id=p_business_id AND branch_id=p_branch_id AND id=product_v FOR SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PRODUCT_NOT_FOUND';END IF;
  recipe_total:=overhead_v::numeric;idx:=0;
  FOR line IN SELECT value FROM jsonb_array_elements(p_payload->'ingredients') LOOP
   idx:=idx+1;
   IF jsonb_typeof(line)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(line))<>7 OR btrim(coalesce(line->>'name',''))='' OR length(line->>'name')>160 OR line->>'unit' NOT IN('g','ml','piece')
      OR NOT(coalesce(line->>'packQuantity','') ~ '^[1-9][0-9]{0,18}$') OR NOT(coalesce(line->>'packCostMinor','') ~ '^(0|[1-9][0-9]{0,18})$') OR NOT(coalesce(line->>'recipeQuantity','') ~ '^[1-9][0-9]{0,18}$') OR NOT(coalesce(line->>'edibleYieldBps','') ~ '^[1-9][0-9]{0,4}$') THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END IF;
   BEGIN pack_v:=(line->>'packQuantity')::bigint;cost_v:=(line->>'packCostMinor')::bigint;used_v:=(line->>'recipeQuantity')::bigint;yield_v:=(line->>'edibleYieldBps')::integer;EXCEPTION WHEN others THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END;
   IF pack_v<=0 OR used_v<=0 OR cost_v<0 OR yield_v NOT BETWEEN 1 AND 10000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_COST_INPUT';END IF;
   recipe_total:=recipe_total+(cost_v::numeric*used_v::numeric*10000::numeric)/(pack_v::numeric*yield_v::numeric);
   IF recipe_total>max_minor+1 THEN RAISE SQLSTATE 'PT400' USING MESSAGE='AMOUNT_OUT_OF_RANGE';END IF;
  END LOOP;
  recipe_total:=floor(recipe_total+0.5);
  IF recipe_total>max_minor THEN RAISE SQLSTATE 'PT400' USING MESSAGE='AMOUNT_OUT_OF_RANGE';END IF;
  SELECT coalesce(max(version),0)+1 INTO version_v FROM ops.recipe_versions WHERE business_id=p_business_id AND branch_id=p_branch_id AND product_id=product_v AND recipe_name=recipe_name_v;
  INSERT INTO ops.recipe_versions(business_id,branch_id,product_id,recipe_name,version,portions,overhead_minor,total_minor,currency,cost_basis,created_by)
  VALUES(p_business_id,p_branch_id,product_v,recipe_name_v,version_v,portions_v,overhead_v,recipe_total::bigint,'TRY','human-verified-input',auth.uid()) RETURNING * INTO r;
  idx:=0;
  FOR line IN SELECT value FROM jsonb_array_elements(p_payload->'ingredients') LOOP
   idx:=idx+1;
   INSERT INTO ops.recipe_ingredients(business_id,branch_id,recipe_version_id,line_no,name,unit,pack_quantity,pack_cost_minor,recipe_quantity,edible_yield_bps)
   VALUES(p_business_id,p_branch_id,r.id,idx,btrim(line->>'name'),line->>'unit',(line->>'packQuantity')::bigint,(line->>'packCostMinor')::bigint,(line->>'recipeQuantity')::bigint,(line->>'edibleYieldBps')::integer);
  END LOOP;
  result_v:=jsonb_build_object('recipeId',r.id,'saved',true,'version',r.version::text,'totalMinor',r.total_minor::text,'portionMinMinor',(r.total_minor/r.portions)::text,'portionMaxMinor',((r.total_minor+r.portions-1)/r.portions)::text);
 END IF;

 INSERT INTO ops.cost_commands(business_id,branch_id,actor_user_id,operation_id,action,request_hash,result)
 VALUES(p_business_id,p_branch_id,auth.uid(),op_id,p_action,h,result_v);
 RETURN result_v||jsonb_build_object('duplicate',false);
END;$$;

REVOKE ALL ON FUNCTION ops.studio_cost_ledger(uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION ops.studio_cost_ledger(uuid,uuid,text,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
