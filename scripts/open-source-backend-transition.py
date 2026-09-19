"""One-time, reviewable source migration. Only run on the dedicated feature branch."""
from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
def read(p):return (root/p).read_text()
def write(p,s):
 f=root/p;f.parent.mkdir(parents=True,exist_ok=True);f.write_text(s)
assert "OPEN_MODELS" not in read('supabase/functions/menugo-llm/core.ts'), 'Transition already applied'
models=['qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B']
sql=read('supabase/migrations/20260919001800_ops_llm.sql')
funcs=sql[sql.index('CREATE FUNCTION ops.llm_settings'):sql.index('CREATE FUNCTION ops.llm_finish')].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
funcs=funcs.replace("p_payload->>'provider' NOT IN('openai','gemini')","p_payload->>'provider' NOT IN('openai','gemini','self_hosted')")
funcs=funcs.replace("(p_payload->>'provider'='gemini' AND p_payload->>'model'='gemini-2.5-flash'))", "(p_payload->>'provider'='gemini' AND p_payload->>'model'='gemini-2.5-flash') OR (p_payload->>'provider'='self_hosted' AND p_payload->>'model' IN("+','.join("'"+m+"'" for m in models)+")))")
funcs=funcs.replace("p_kind NOT IN('test','assistant','menu-extract')","p_kind NOT IN('test','assistant','menu-extract','studio')")
funcs=funcs.replace("IF NOT c.enabled THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_DISABLED';END IF;", "IF c.provider<>'self_hosted' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_OPEN_SOURCE_REQUIRED';END IF;\n IF NOT c.enabled THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_DISABLED';END IF;")
funcs=funcs.replace("j ops.menu_import_jobs%ROWTYPE;context", "j ops.menu_import_jobs%ROWTYPE;sj ops.studio_jobs%ROWTYPE;context")
funcs=funcs.replace("IF r.kind='menu-extract' THEN", "IF c.provider<>'self_hosted' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_OPEN_SOURCE_REQUIRED';END IF;\n IF r.kind='menu-extract' THEN")
funcs=funcs.replace(" ELSIF r.kind='assistant' THEN", """ ELSIF r.kind='studio' THEN
  SELECT * INTO sj FROM ops.studio_jobs WHERE business_id=r.business_id AND branch_id=r.branch_id AND id=(r.request->>'studioId')::uuid;
  IF NOT FOUND OR sj.created_by<>r.actor_id OR sj.state<>'running' OR sj.lease_token IS DISTINCT FROM (r.request->>'studioLease')::uuid OR sj.lease_until<=clock_timestamp() OR sj.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE='STUDIO_LEASE_LOST';END IF;
  IF sj.kind='photo-enhance' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='LLM_IMAGE_ENGINE_REQUIRED';END IF;
  context:=jsonb_build_object('studioKind',sj.kind,'sources',sj.source_snapshot,'input',sj.request);
 ELSIF r.kind='assistant' THEN""")
header="""-- Open-source inference policy. No catalogue, price, order, credential or DNS changes.
-- Extends existing Vault-backed direct connection and committed run/lease ledger.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_provider_check;
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_model_check;
ALTER TABLE ops.llm_connections DROP CONSTRAINT llm_connections_check;
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_provider_check CHECK(provider IN('openai','gemini','self_hosted'));
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_model_check CHECK(model IN('gpt-4.1-mini','gpt-4.1','gemini-2.5-flash','qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B'));
ALTER TABLE ops.llm_connections ADD CONSTRAINT llm_connections_check CHECK((provider='openai' AND model IN('gpt-4.1-mini','gpt-4.1')) OR (provider='gemini' AND model='gemini-2.5-flash') OR (provider='self_hosted' AND model IN('qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B')));
ALTER TABLE ops.llm_runs DROP CONSTRAINT llm_runs_kind_check;
ALTER TABLE ops.llm_runs ADD CONSTRAINT llm_runs_kind_check CHECK(kind IN('test','assistant','menu-extract','studio'));
"""
write('supabase/migrations/20260919002200_ops_open_source_llm.sql',header+funcs+"\nREVOKE ALL ON FUNCTION ops.llm_settings(uuid,uuid,text,jsonb),ops.llm_claim(uuid,uuid,uuid,text,jsonb),ops.llm_dispatch(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;\nGRANT EXECUTE ON FUNCTION ops.llm_settings(uuid,uuid,text,jsonb),ops.llm_claim(uuid,uuid,uuid,text,jsonb) TO authenticated;\nGRANT EXECUTE ON FUNCTION ops.llm_dispatch(uuid,uuid) TO service_role;\nCOMMIT;\n")
write('supabase/functions/menugo-llm/open-source.ts',r'''/** Self-hosted protocol. The deployment operator provisions this TLS hostname.
 * A model is not running just because this adapter exists. No cloud fallback.
 */
export const OPEN_ENDPOINT = 'https://ai.menugo.app/v1/chat/completions';
export const OPEN_MODELS = ['qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B'] as const;
export function openSourceWire(model: string, key: string, prompt: string, text: string, schema: unknown, maxTokens: number, attachment: {mime:string;data:string}|null) {
 if (!(OPEN_MODELS as readonly string[]).includes(model)) throw new Error('LLM_MODEL_NOT_ALLOWED');
 if (typeof key!=='string'||key.length<20||key.length>512||/[\s\u0000-\u001f]/.test(key)) throw new Error('LLM_KEY_REQUIRED');
 const content: unknown[] = [{type:'text',text}];
 if(attachment){
  if(attachment.mime==='application/pdf') throw new Error('LLM_PDF_PAGES_REQUIRED');
  if(!['image/png','image/jpeg','image/webp'].includes(attachment.mime)||attachment.data.length>2796204||!attachment.data.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) throw new Error('INVALID_LLM_REQUEST');
  content.push({type:'image_url',image_url:{url:`data:${attachment.mime};base64,${attachment.data}`}});
 }
 return {url:OPEN_ENDPOINT,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:{
  model,stream:false,temperature:0,max_tokens:maxTokens,
  messages:[{role:'system',content:prompt},{role:'user',content}],
  response_format:{type:'json_schema',json_schema:{name:'menugo_draft',strict:true,schema}},
  ...(model.startsWith('qwen')?{reasoning_effort:'none'}:{chat_template_kwargs:{enable_thinking:false}})
 }};
}
''')
write('supabase/functions/menugo-llm/studio-operations.ts',read('src/studio/operations.ts'))
write('supabase/functions/menugo-llm/studio-contracts.ts',read('src/studio/contracts.ts').replace("from './operations'","from './studio-operations.ts'"))
p='supabase/functions/menugo-llm/core.ts';s=read(p)
s="import {openSourceWire,OPEN_MODELS} from './open-source.ts';\nimport {COPY_SCHEMA,INVOICE_SCHEMA,STUDIO_PROMPT,parseCopy,parseInvoice} from './studio-contracts.ts';\n"+s
s=s.replace("{openai:['gpt-4.1-mini'","{self_hosted:OPEN_MODELS,openai:['gpt-4.1-mini'")
s=s.replace(" else if(v.kind==='menu-extract')", " else if(v.kind==='studio'){if(Object.keys(r).some(k=>!['studioId','studioLease'].includes(k)))throw new LlmError('INVALID_LLM_REQUEST');request={studioId:uuid(r.studioId),studioLease:uuid(r.studioLease)};}\n else if(v.kind==='menu-extract')")
s=s.replace("'test'|'assistant'|'menu-extract',request", "'test'|'assistant'|'menu-extract'|'studio',request")
s=s.replace(" }else if(d.kind==='assistant')", """ }else if(d.kind==='studio'){
  const c=obj(d.context),i=obj(c.input);if(!['product-copy','translation','campaign','invoice'].includes(c.studioKind))throw new LlmError('LLM_IMAGE_ENGINE_REQUIRED');
  if(!Array.isArray(c.sources)||!['tr','en'].includes(i.language))throw new LlmError('LLM_CONTEXT_INVALID');
  prompt=STUDIO_PROMPT;schema=c.studioKind==='invoice'?INVOICE_SCHEMA:COPY_SCHEMA;max=10000;
  text=c.studioKind==='invoice'?'Extract visible invoice facts only. Retain original quantity/unit strings, source page number and short verbatim sourceText. Unknown amounts are null. Do not infer tax or include personal addresses/bank accounts.':JSON.stringify({task:c.studioKind,language:i.language,sources:c.sources});
  if(i.attachment)attachment={mime:i.attachment.mime,data:i.attachment.data};
  if(c.studioKind==='invoice'&&!attachment)throw new LlmError('INVALID_LLM_REQUEST');
 }else if(d.kind==='assistant')""")
s=s.replace(" if(d.provider==='openai'){\n  const content", " if(d.provider==='self_hosted'){try{return {...openSourceWire(d.model,d.key,prompt,text,schema,max,attachment),grounding};}catch(e){throw new LlmError(e instanceof Error?e.message:'INVALID_LLM_REQUEST');}}\n if(d.provider==='openai'){\n  const content")
s=s.replace(" if(d.provider==='openai'){\n  if(value.status", " if(d.provider==='self_hosted'){const c=value?.choices?.[0];if(c?.message?.refusal)throw new LlmError('LLM_REFUSAL');if(c?.finish_reason!=='stop'||typeof c?.message?.content!=='string'||c.message.tool_calls?.length)throw new LlmError('LLM_OUTPUT_INCOMPLETE',502);text=c.message.content;usage={input:value.usage?.prompt_tokens,output:value.usage?.completion_tokens};}\n else if(d.provider==='openai'){\n  if(value.status")
s=s.replace(" else{result={...parseAnswer", " else if(d.kind==='studio'){try{const c=d.context;result={draft:c.studioKind==='invoice'?parseInvoice(result,c.input.attachment?.pages??1):parseCopy(c.studioKind,result,c.sources)};}catch{throw new LlmError('LLM_INVALID_OUTPUT',502);}}\n else{result={...parseAnswer")
write(p,s)
p='supabase/functions/menugo-llm/index.ts';s=read(p).replace("const result=await generate(d);", "if(d.provider!=='self_hosted')throw new LlmError('LLM_OPEN_SOURCE_REQUIRED',409);\n  const result=await generate(d);");write(p,s)
p='lib/llm/messages.ts';s=read(p).replace("export const llmMessages:Record<string,string>={", """export const llmMessages:Record<string,string>={
 LLM_SERVER_REQUIRED:'Açık kaynak model sunucusu henüz bağlı değil. Model lisansı ücretsizdir; modelleri çalıştıran bilgisayar veya sunucu ayrıca gereklidir.',
 LLM_OPEN_SOURCE_REQUIRED:'Bu sürüm yalnız kendi sunucunuzdaki açık kaynak modelleri kullanır. Ücretli API’ye otomatik geçiş yapılmaz.',
 LLM_PDF_PAGES_REQUIRED:'Bu açık kaynak bağlantısı görüntü kabul ediyor. PDF sayfalarını fotoğraf/görüntü olarak yükleyin; doğrudan PDF dönüştürme henüz bağlı değil.',
 LLM_IMAGE_ENGINE_REQUIRED:'Ürün fotoğrafı üretimi ayrı bir görsel model sunucusu gerektirir. Metin modeli bu işlemi yapmaz; ücretli modele geçilmedi.',""")
s=s.replace("export const llmModels={openai:","export const llmModels={self_hosted:[['qwen3.5:4b','Qwen3.5 4B · Ollama'],['qwen3.5:9b','Qwen3.5 9B · Ollama'],['Qwen/Qwen3.5-4B','Qwen3.5 4B · vLLM'],['Qwen/Qwen3.5-9B','Qwen3.5 9B · vLLM']],openai:")
s=s.replace("provider:'openai'|'gemini'|null", "provider:'openai'|'gemini'|'self_hosted'|null");write(p,s)
p='lib/llm/client.ts';s=read(p).replace("kind:'test'|'assistant'|'menu-extract'","kind:'test'|'assistant'|'menu-extract'|'studio'")
s += """\n/** Explicit self-host policy. Status reads do not call any model or credit endpoint. */
export async function requireOpenSource(s:Awaited<ReturnType<typeof client>>,kind?:string){
 const status=await llmStatus(s);
 if(!status.configured)throw new Failure('LLM_SERVER_REQUIRED',503);
 if(status.provider!=='self_hosted')throw new Failure('LLM_OPEN_SOURCE_REQUIRED',409);
 if(!status.enabled)throw new Failure('LLM_DISABLED',409);
 if(kind==='photo-enhance')throw new Failure('LLM_IMAGE_ENGINE_REQUIRED',409);
 if(kind!=='test'&&!status.verified)throw new Failure('LLM_TEST_REQUIRED',409);
 return status;
}
""";write(p,s)
p='app/api/llm/[action]/route.ts';s=read(p).replace("llmStatus,invokeLlm", "llmStatus,invokeLlm,requireOpenSource")
s=s.replace("!['openai','gemini'].includes(String(v.provider))", "v.provider!=='self_hosted'")
s=s.replace("if(action==='test')return json(await invokeLlm(s,uuid(v.operationId),'test',{}));", "if(action==='test'){await requireOpenSource(s,'test');return json(await invokeLlm(s,uuid(v.operationId),'test',{}));}")
s=s.replace("if(action==='ask'){", "if(action==='ask'){\n  await requireOpenSource(s);");write(p,s)
p='app/api/ai-menu/[action]/route.ts';s=read(p)
s=s.replace("import {gatewayCredential,checkGatewayAccess,MODEL} from '@/lib/ai-menu/provider';", "const MODEL='qwen3.5:4b';")
s=s.replace("import {llmStatus} from '@/lib/llm/client';", "import {requireOpenSource} from '@/lib/llm/client';")
a=s.index(' const cfg=await llmStatus(s);');b=s.index('\n}',a)
s=s[:a]+" const cfg=await requireOpenSource(s);return {provider:'direct' as const,token:'',model:cfg.model!};"+s[b:]
s=s.replace("let provider='gateway'", "let provider='self_hosted'")
s=s.replace("const mime=fileKind(b);", "const mime=fileKind(b);\n  if(mime==='application/pdf')throw new Failure('LLM_PDF_PAGES_REQUIRED',415);")
s=re.sub(r"  if\(mime==='application/pdf'\)\{try\{const d=await PDFDocument.*?\n  else\{", "  {", s,flags=re.S);write(p,s)
p='app/api/studio/[action]/route.ts';s=read(p)
s=s.replace("import {gatewayCredential,checkGatewayAccess} from '@/lib/ai-menu/provider';", "import {requireOpenSource,invokeLlm} from '@/lib/llm/client';")
s=s.replace("import {runStudio,type StudioInput,IMAGE_MODEL,TEXT_MODEL} from '@/lib/studio/gateway';", "const TEXT_MODEL='qwen3.5:4b';const IMAGE_MODEL='Bağlı değil · ayrı görsel modeli gerekli';")
s=s.replace("import {STUDIO_KINDS,type StudioKind}", "import {STUDIO_KINDS,parseCopy,parseInvoice,type StudioKind}")
a=s.index('async function credential()');b=s.index('\nfunction safeError',a)
s=s[:a]+"async function credential(s:Awaited<ReturnType<typeof manager>>,kind?:string){return requireOpenSource(s,kind);}"+s[b:]
s=s.replace("id:string,token:string", "id:string")
a=s.index('   const result=await runStudio(');b=s.index("   await rpc(s,'studio_job'",a)
s=s[:a]+"""   const answer=await invokeLlm(s,claim.lease,'studio',{studioId:id,studioLease:claim.lease});
   const raw=answer.result?.draft;
   // Revalidate in Next before storing, independent of Edge model parsing.
   const keys=raw&&typeof raw==='object'?Object.fromEntries(Object.entries(raw).filter(([key])=>!['kind','draftOnly'].includes(key))):raw;
   const draft=claim.kind==='invoice'?parseInvoice(keys,claim.input.attachment?.pages??1):parseCopy(claim.kind,keys,claim.sources);
   const result={draft,model:answer.model,inputTokens:answer.inputTokens??'0',outputTokens:answer.outputTokens??'0'};
"""+s[b:]
s=s.replace("const code=e instanceof StudioError?e.code:'AI_SAVE_UNKNOWN';", "const code=e instanceof StudioError?e.code:e instanceof Failure&&/^LLM_[A-Z_]+$/.test(e.code)?(['LLM_RESULT_UNKNOWN','LLM_SAVE_UNKNOWN','LLM_IN_PROGRESS'].includes(e.code)?'AI_RESULT_UNKNOWN':e.code):'AI_SAVE_UNKNOWN';")
s=s.replace("try{await credential();}", "try{await credential(s);}")
s=s.replace("models:{text:TEXT_MODEL,image:IMAGE_MODEL},limits", "models:{text:TEXT_MODEL,image:IMAGE_MODEL},provider:'self_hosted',imageReady:false,pdfReady:false,limits")
s=s.replace("const token=await credential(),operationId=uuid(v.operationId),kind=v.kind as StudioKind;", "await credential(s,v.kind);const operationId=uuid(v.operationId),kind=v.kind as StudioKind;")
s=s.replace("if(mime==='application/pdf'){\n     if", "if(mime==='application/pdf'){throw new Failure('LLM_PDF_PAGES_REQUIRED',415);\n     if")
a=s.index("    if(mime==='application/pdf'){");b=s.index("    request.attachment=",a)
s=s[:a]+"    if(mime==='application/pdf')throw new Failure('LLM_PDF_PAGES_REQUIRED',415);\n    const m=await sharp(bytes,{limitInputPixels:40000000}).metadata();if(!m.width||!m.height||m.width*m.height>40000000)throw new Failure('INVALID_IMAGE');\n"+s[b:]
s=s.replace('await start(s,result.id,token)','await start(s,result.id)')
s=s.replace("if(action==='process'){const token=await credential();return json({started:await start(s,id,token)},202);}","if(action==='process'){const job=await rpc(s,'studio_job',{...scope,p_action:'get',p_job_id:id});await credential(s,job.kind);return json({started:await start(s,id)},202);}");write(p,s)
p='lib/ai-menu/worker.ts';s=read(p).replace("import {extractMenu} from './provider';",'').replace("else result=await extractMenu(claimed.data,claimed.mime,token)","else throw new Error('LLM_OPEN_SOURCE_REQUIRED')");write(p,s)
