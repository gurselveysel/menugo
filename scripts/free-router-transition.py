from pathlib import Path


def replace(path: str, old: str, new: str, count: int | None = None) -> None:
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    expected = count if count is not None else 1
    if actual != expected:
        raise SystemExit(f"{path}: expected {expected} occurrences, found {actual}: {old[:90]!r}")
    p.write_text(text.replace(old, new))


# One OpenAI-compatible wire, but two explicitly separate trust boundaries.
Path('supabase/functions/menugo-llm/open-source.ts').write_text(r'''/**
 * Audited OpenAI-compatible open/free-model transport.
 * - self_hosted: operator-controlled HTTPS endpoint, no cloud fallback.
 * - openrouter_free: managed Free Models Router only. The model slug is pinned to
 *   openrouter/free, ZDR + data-collection denial are required per request, and
 *   unsupported required parameters fail closed.
 *
 * An adapter existing here does not mean a credential is configured or a real
 * model has passed acceptance.
 */
export const OPEN_ENDPOINT = 'https://ai.menugo.app/v1/chat/completions';
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const SELF_HOSTED_MODELS = ['qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B'] as const;
export const OPENROUTER_MODELS = ['openrouter/free'] as const;
export const OPEN_MODELS = [...SELF_HOSTED_MODELS,...OPENROUTER_MODELS] as const;

export function openSourceWire(model: string, key: string, prompt: string, text: string, schema: unknown, maxTokens: number, attachment: {mime:string;data:string}|null) {
 if (!(OPEN_MODELS as readonly string[]).includes(model)) throw new Error('LLM_MODEL_NOT_ALLOWED');
 if (typeof key!=='string'||key.length<20||key.length>512||/[\s\u0000-\u001f]/.test(key)) throw new Error('LLM_KEY_REQUIRED');
 const content: unknown[] = [{type:'text',text}];
 if(attachment){
  if(attachment.mime==='application/pdf') throw new Error('LLM_PDF_PAGES_REQUIRED');
  if(!['image/png','image/jpeg','image/webp'].includes(attachment.mime)||attachment.data.length>2796204||!attachment.data.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) throw new Error('INVALID_LLM_REQUEST');
  content.push({type:'image_url',image_url:{url:`data:${attachment.mime};base64,${attachment.data}`}});
 }
 const common = {
  model,stream:false,temperature:0,max_tokens:maxTokens,
  messages:[{role:'system',content:prompt},{role:'user',content}],
  response_format:{type:'json_schema',json_schema:{name:'menugo_draft',strict:true,schema}}
 };
 if(model==='openrouter/free') return {
  url:OPENROUTER_ENDPOINT,
  headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','HTTP-Referer':'https://www.menugo.app','X-Title':'MenuGO'},
  body:{...common,provider:{zdr:true,data_collection:'deny',require_parameters:true}}
 };
 return {
  url:OPEN_ENDPOINT,
  headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
  body:{...common,...(model.startsWith('qwen')?{reasoning_effort:'none'}:{chat_template_kwargs:{enable_thinking:false}})}
 };
}
''')

replace(
    'supabase/functions/menugo-llm/core.ts',
    "import {openSourceWire,OPEN_MODELS} from './open-source.ts';",
    "import {openSourceWire,SELF_HOSTED_MODELS,OPENROUTER_MODELS} from './open-source.ts';",
)
replace(
    'supabase/functions/menugo-llm/core.ts',
    "export const MODELS:Record<string,readonly string[]>={self_hosted:OPEN_MODELS,openai:['gpt-4.1-mini','gpt-4.1'],gemini:['gemini-2.5-flash']};",
    "export const MODELS:Record<string,readonly string[]>={self_hosted:SELF_HOSTED_MODELS,openrouter_free:OPENROUTER_MODELS,openai:['gpt-4.1-mini','gpt-4.1'],gemini:['gemini-2.5-flash']};",
)
replace(
    'supabase/functions/menugo-llm/core.ts',
    "if(d.provider==='self_hosted'){try{return {...openSourceWire(d.model,d.key,prompt,text,schema,max,attachment),grounding};}",
    "if(d.provider==='self_hosted'||d.provider==='openrouter_free'){try{return {...openSourceWire(d.model,d.key,prompt,text,schema,max,attachment),grounding};}",
)
replace(
    'supabase/functions/menugo-llm/core.ts',
    "if(d.provider==='self_hosted'){const c=value?.choices?.[0];",
    "if(d.provider==='self_hosted'||d.provider==='openrouter_free'){const c=value?.choices?.[0];",
)
replace(
    'supabase/functions/menugo-llm/index.ts',
    "if(d.provider!=='self_hosted')throw new LlmError('LLM_OPEN_SOURCE_REQUIRED',409);",
    "if(!['self_hosted','openrouter_free'].includes(d.provider))throw new LlmError('LLM_OPEN_SOURCE_REQUIRED',409);",
)
replace(
    'lib/llm/client.ts',
    "/** Explicit self-host policy. Status reads do not call any model or credit endpoint. */",
    "/** Explicit free/open-model policy. Status reads do not call any model or credit endpoint. */",
)
replace(
    'lib/llm/client.ts',
    "if(status.provider!=='self_hosted')throw new Failure('LLM_OPEN_SOURCE_REQUIRED',409);",
    "if(!['self_hosted','openrouter_free'].includes(status.provider||''))throw new Failure('LLM_OPEN_SOURCE_REQUIRED',409);",
)

# Type-safe browser configuration: no paid provider can be selected by this UI.
replace(
    'lib/llm/messages.ts',
    "LLM_OPEN_SOURCE_REQUIRED:'Bu sürüm yalnız kendi sunucunuzdaki açık kaynak modelleri kullanır. Ücretli API’ye otomatik geçiş yapılmaz.',",
    "LLM_OPEN_SOURCE_REQUIRED:'Bu sürüm yalnız ücretsiz model yönlendiricisini veya kendi açık model sunucunuzu kullanır. Ücretli API’ye otomatik geçiş yapılmaz.',",
)
replace(
    'lib/llm/messages.ts',
    "export const llmModels={self_hosted:[['qwen3.5:4b','Qwen3.5 4B · Ollama'],['qwen3.5:9b','Qwen3.5 9B · Ollama'],['Qwen/Qwen3.5-4B','Qwen3.5 4B · vLLM'],['Qwen/Qwen3.5-9B','Qwen3.5 9B · vLLM']],openai:[['gpt-4.1-mini','GPT-4.1 mini'],['gpt-4.1','GPT-4.1']],gemini:[['gemini-2.5-flash','Gemini 2.5 Flash']]} as const;",
    "export const llmModels={openrouter_free:[['openrouter/free','OpenRouter · Ücretsiz Modeller Router']],self_hosted:[['qwen3.5:4b','Qwen3.5 4B · Ollama'],['qwen3.5:9b','Qwen3.5 9B · Ollama'],['Qwen/Qwen3.5-4B','Qwen3.5 4B · vLLM'],['Qwen/Qwen3.5-9B','Qwen3.5 9B · vLLM']],openai:[['gpt-4.1-mini','GPT-4.1 mini'],['gpt-4.1','GPT-4.1']],gemini:[['gemini-2.5-flash','Gemini 2.5 Flash']]} as const;",
)
replace(
    'lib/llm/messages.ts',
    "provider:'openai'|'gemini'|'self_hosted'|null;",
    "provider:'openai'|'gemini'|'self_hosted'|'openrouter_free'|null;",
)

ui='components/LlmAssistant.tsx'
replace(ui,"useState<'self_hosted'>('self_hosted')","useState<'self_hosted'|'openrouter_free'>('openrouter_free')")
replace(
    ui,
    "setStatus(s);setProvider('self_hosted');setModel(s.provider==='self_hosted'&&s.model?s.model:'qwen3.5:4b');",
    "setStatus(s);const p=s.provider==='self_hosted'?'self_hosted':'openrouter_free';setProvider(p);setModel((s.provider===p&&s.model)?s.model:llmModels[p][0][0]);",
)
replace(ui,"const ready=status?.provider==='self_hosted'&&!!status?.enabled&&!!status?.verified;","const ready=!!status&&['self_hosted','openrouter_free'].includes(status.provider||'')&&!!status.enabled&&!!status.verified;")
replace(ui,"{status?.provider==='self_hosted'?status.model:'Qwen · Kendi sunucunuz'}","{status?.provider==='openrouter_free'?'OpenRouter · Ücretsiz router':status?.provider==='self_hosted'?status.model:'Ücretsiz/açık model bağlantısı'}")
replace(ui,"<h2>Açık kaynak model bağlantısı</h2><p>Qwen modellerini kendi Ollama veya vLLM sunucunuzda çalıştırın. Menü fotoğrafı okuma, açıklama, çeviri ve işletme asistanı aynı güvenli bağlantıyı kullanır. Ücretli API’ye otomatik geçiş yok.</p><p className=\"notice\">Model lisansı ücretsizdir; bilgisayar, elektrik ve sunucu barındırması ayrıca gereklidir. Bu ekran model sunucusu kurmaz. Önce ai.menugo.app üzerinde HTTPS ve erişim anahtarıyla korunan model servisi hazırlanmalıdır.</p>","<h2>Ücretsiz / açık model bağlantısı</h2><p>Sunucu kurmadan OpenRouter’ın yalnız ücretsiz modellere yönlenen <strong>openrouter/free</strong> rotasını kullanabilir veya kendi Ollama/vLLM sunucunuzu seçebilirsiniz. Ücretli modele otomatik geçiş yok.</p><p className=\"notice\">OpenRouter seçeneğinde istek başına sıfır veri saklama (ZDR), veri toplamayı reddetme ve gerekli parametre desteği zorunlu tutulur. Uygun ücretsiz uç nokta yoksa işlem başarısız olur; ücretli modele düşmez.</p>")
replace(ui,"{status.canManage?<details open={!status.configured||status.provider!=='self_hosted'}>","{status.canManage?<details open={!status.configured||!['self_hosted','openrouter_free'].includes(status.provider||'')}>")
replace(ui,"const p=e.target.value as 'self_hosted';","const p=e.target.value as 'self_hosted'|'openrouter_free';")
replace(ui,"<option value=\"self_hosted\">Kendi sunucum · Açık kaynak</option>","<option value=\"openrouter_free\">Sunucusuz · OpenRouter ücretsiz router</option><option value=\"self_hosted\">Kendi sunucum · Açık modeller</option>")
replace(ui,"placeholder={status.configured?'Değiştirmeyecekseniz boş bırakın':'Kendi model sunucunuzun erişim anahtarı'}","placeholder={status.configured?'Değiştirmeyecekseniz boş bırakın':provider==='openrouter_free'?'OpenRouter API anahtarı':'Kendi model sunucunuzun erişim anahtarı'}")
replace(ui,"Seçtiğim menü belgeleri, ürün bilgileri ve günlük özetin bu sağlayıcıya gönderileceğini; verilerin kendi model sunucumda işleneceğini onaylıyorum.","Seçtiğim menü belgeleri, ürün bilgileri ve günlük özetin seçtiğim sağlayıcıya gönderileceğini onaylıyorum. OpenRouter kullanımında veri model sağlayıcısına iletilir; MenüGO isteği ZDR ve veri toplamama koşullarıyla sınırlar.")
replace(ui,"((!status.configured||status.provider!=='self_hosted')&&!key)","((!status.configured||status.provider!==provider)&&!key)")
replace(ui,"disabled={busy||!status.configured||!status.enabled||status.provider!=='self_hosted'}","disabled={busy||!status.configured||!status.enabled||!['self_hosted','openrouter_free'].includes(status.provider||'')}")
replace(ui,"Test, kendi sunucunuzdaki modele tek küçük istek gönderir. Başarılı model yanıtı gelmeden üretim açılmaz. Günlük sınır kaynak tüketimini kontrol eder; ücretli API, kredi alımı veya buluta otomatik geçiş yapılmaz.","Test, seçili ücretsiz/açık model bağlantısına tek küçük istek gönderir. Başarılı model yanıtı gelmeden üretim açılmaz. Günlük sınır kullanımı kontrol eder; ücretli modele geçiş, kredi alımı veya otomatik satın alma yapılmaz.")

# Show the configured transport truthfully in studio status.
replace(
    'app/api/studio/[action]/route.ts',
    "let reason:string|null=null;let model:string|null=null;try{model=(await credential(s)).model;}catch(e){reason=e instanceof Error?e.message:'AI_UNAVAILABLE';}return json({...data,aiReady:reason===null,aiReason:reason,models:{text:model||TEXT_MODEL,image:IMAGE_MODEL},provider:'self_hosted',imageReady:false,pdfReady:false,limits:{daily:10,images:3},sourceRetentionDays:7});",
    "let reason:string|null=null;let model:string|null=null;let provider:string|null=null;try{const ready=await credential(s);model=ready.model;provider=ready.provider;}catch(e){reason=e instanceof Error?e.message:'AI_UNAVAILABLE';}return json({...data,aiReady:reason===null,aiReason:reason,models:{text:model||TEXT_MODEL,image:IMAGE_MODEL},provider:provider||'open_source',imageReady:false,pdfReady:false,limits:{daily:10,images:3},sourceRetentionDays:7});",
)
replace(
    'app/api/ai-menu/[action]/route.ts',
    "async function backend(s:Awaited<ReturnType<typeof manager>>){\n const cfg=await requireOpenSource(s);return {provider:'direct' as const,token:'',model:cfg.model!};\n}",
    "async function backend(s:Awaited<ReturnType<typeof manager>>){\n const cfg=await requireOpenSource(s);return {provider:'direct' as const,token:'',model:cfg.model!,configuredProvider:cfg.provider!};\n}",
)
replace(
    'app/api/ai-menu/[action]/route.ts',
    "let reason:string|null=null;let model=MODEL;let provider='self_hosted';try{const b=await backend(s);model=b.model;provider='self_hosted';}",
    "let reason:string|null=null;let model=MODEL;let provider='open_source';try{const b=await backend(s);model=b.model;provider=b.configuredProvider;}",
)

# Re-run the previous audited migration as a new immutable migration, widening only
# the provider/model allowlists and the two fail-closed gates.
base = Path('supabase/migrations/20260919002200_ops_open_source_llm.sql').read_text()
sql = base.replace(
    '-- Open-source inference policy. No catalogue, price, order, credential or DNS changes.',
    '-- Free-router extension. No catalogue, price, order, payment, social-post or DNS changes.'
)
sql = sql.replace("provider IN('openai','gemini','self_hosted')", "provider IN('openai','gemini','self_hosted','openrouter_free')")
sql = sql.replace(
    "model IN('gpt-4.1-mini','gpt-4.1','gemini-2.5-flash','qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B')",
    "model IN('gpt-4.1-mini','gpt-4.1','gemini-2.5-flash','qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B','openrouter/free')"
)
sql = sql.replace(
    "(provider='self_hosted' AND model IN('qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B'))",
    "(provider='self_hosted' AND model IN('qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B')) OR (provider='openrouter_free' AND model='openrouter/free')"
)
sql = sql.replace("p_payload->>'provider' NOT IN('openai','gemini','self_hosted')", "p_payload->>'provider' NOT IN('openai','gemini','self_hosted','openrouter_free')")
sql = sql.replace(
    "(p_payload->>'provider'='self_hosted' AND p_payload->>'model' IN('qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B'))",
    "(p_payload->>'provider'='self_hosted' AND p_payload->>'model' IN('qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B')) OR (p_payload->>'provider'='openrouter_free' AND p_payload->>'model'='openrouter/free')"
)
sql = sql.replace("IF c.provider<>'self_hosted' THEN RAISE", "IF c.provider NOT IN('self_hosted','openrouter_free') THEN RAISE")
if sql.count("openrouter_free") < 6 or sql.count("openrouter/free") < 3 or sql.count("NOT IN('self_hosted','openrouter_free')") != 2:
    raise SystemExit('generated migration did not widen every expected gate')
Path('supabase/migrations/20260919213500_ops_free_router.sql').write_text(sql)

# Extend protocol tests: free router is a distinct provider, never self-hosted or paid.
t='tests/open-source-llm.test.mjs'
replace(t,"for(const model of w.OPEN_MODELS)test('self-hosted structured JSON '+model,()=>{", "for(const model of w.SELF_HOSTED_MODELS)test('self-hosted structured JSON '+model,()=>{")
replace(t,"assert.ok(fs.readFileSync(root+'index.ts','utf8').includes(\"provider!=='self_hosted'\"));", "assert.ok(fs.readFileSync(root+'index.ts','utf8').includes(\"['self_hosted','openrouter_free'].includes\"));")
with Path(t).open('a') as f:
    f.write(r'''

test('managed free router is pinned to zero-price model and privacy filters',()=>{
 const d={...base,provider:'openrouter_free',model:'openrouter/free'};
 const r=c.buildProviderRequest(d);
 assert.equal(r.url,w.OPENROUTER_ENDPOINT);
 assert.equal(r.body.model,'openrouter/free');
 assert.equal(r.body.provider.zdr,true);
 assert.equal(r.body.provider.data_collection,'deny');
 assert.equal(r.body.provider.require_parameters,true);
 assert.equal(r.body.response_format.type,'json_schema');
 assert.equal(r.body.response_format.json_schema.strict,true);
 assert.equal(r.headers.Authorization,'Bearer '+key);
 assert.equal(JSON.stringify(r.body).includes(key),false);
});

test('managed router cannot select auto or paid model slugs',()=>{
 for(const model of ['openrouter/auto','google/gemini-2.5-flash','openai/gpt-5'])
  assert.throws(()=>c.buildProviderRequest({...base,provider:'openrouter_free',model}),/LLM_MODEL_NOT_ALLOWED/);
});

test('managed free router parses one provider response with no retry',async()=>{
 let calls=0;
 const d={...base,provider:'openrouter_free',model:'openrouter/free'};
 const r=await c.generate(d,async(url,init)=>{calls++;assert.equal(url,w.OPENROUTER_ENDPOINT);assert.equal(init.redirect,'error');return response({status:'MENUGO_OK'});});
 assert.equal(r.result.verified,true);assert.equal(r.provider,'openrouter_free');assert.equal(calls,1);
});
''')

print('free-router transition applied')
