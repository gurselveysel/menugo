// Protocol and fail-closed tests, NOT real model quality tests.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const root='supabase/functions/menugo-llm/',dir='test-results/open-source-unit';fs.mkdirSync(dir,{recursive:true});
for(const name of ['core','open-source','menu-contracts','studio-contracts','studio-operations']){const source=fs.readFileSync(root+name+'.ts','utf8').replaceAll(".ts'",".mjs'");fs.writeFileSync(dir+'/'+name+'.mjs',ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);}
const c=await import('../'+dir+'/core.mjs'),w=await import('../'+dir+'/open-source.mjs');
const id='33333333-3333-4333-8333-333333333333',key='SYNTHETIC_LOCAL_PROXY_KEY_12345';
const base={provider:'self_hosted',model:'qwen3.5:4b',key,kind:'test',request:{},context:{}};
const response=(data,extra={})=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)},...extra}],usage:{prompt_tokens:12,completion_tokens:4}}));
for(const model of w.SELF_HOSTED_MODELS)test('self-hosted structured JSON '+model,()=>{const r=c.buildProviderRequest({...base,model});assert.equal(r.url,'https://ai.menugo.app/v1/chat/completions');assert.equal(r.body.response_format.type,'json_schema');assert.equal(r.body.response_format.json_schema.strict,true);assert.equal(r.body.stream,false);assert.equal(r.body.tools,undefined);assert.equal(r.headers.Authorization,'Bearer '+key);assert.ok(!JSON.stringify(r.body).includes(key));if(model.startsWith('qwen'))assert.equal(r.body.reasoning_effort,'none');else assert.equal(r.body.chat_template_kwargs.enable_thinking,false);});
for(const model of ['qwen3.5:cloud','https://evil.test','llama3.1','Qwen/fake'])test('model allowlist '+model,()=>assert.throws(()=>c.buildProviderRequest({...base,model}),/LLM_MODEL_NOT_ALLOWED/));
test('validated request references server-owned studio job only',()=>{const r=c.validateRequest({businessId:id,branchId:id,operationId:id,kind:'studio',input:{studioId:id,studioLease:id}});assert.equal(r.kind,'studio');assert.throws(()=>c.validateRequest({businessId:id,branchId:id,operationId:id,kind:'studio',input:{studioId:id,studioLease:id,context:{price:1}}}),/INVALID_LLM_REQUEST/);});
test('successful local probe is verified, tokens remain strings',async()=>{const r=await c.generate(base,async()=>response({status:'MENUGO_OK'}));assert.equal(r.result.verified,true);assert.equal(r.inputTokens,'12');assert.equal(r.provider,'self_hosted');});
test('invalid model answer fails before marked verified',async()=>assert.rejects(()=>c.generate(base,async()=>response({status:'ok'})),/LLM_TEST_FAILED/));
for(const extra of [{finish_reason:'length'},{message:{content:'{}',tool_calls:[{}]}},{message:{refusal:'no'}}])test('incomplete/refused/tool output blocked '+JSON.stringify(extra),async()=>assert.rejects(()=>c.generate(base,async()=>response({},extra)),/LLM_OUTPUT_INCOMPLETE|LLM_REFUSAL/));
for(const mime of ['image/png','image/jpeg','image/webp'])test('vision accepts only inline data '+mime,()=>{const r=c.buildProviderRequest({...base,kind:'menu-extract',context:{mime,data:'aGVsbG8='}});assert.equal(r.body.messages[1].content[1].type,'image_url');assert.ok(r.body.messages[1].content[1].image_url.url.startsWith('data:'+mime));});
test('PDF cannot be silently forwarded to unsupported chat endpoint',async()=>{let calls=0;await assert.rejects(()=>c.generate({...base,kind:'menu-extract',context:{mime:'application/pdf',data:'aGVsbG8='}},async()=>{calls++;return response({});}),/LLM_PDF_PAGES_REQUIRED/);assert.equal(calls,0);});
test('unknown mime and remote image payload rejected',()=>{assert.throws(()=>c.buildProviderRequest({...base,kind:'menu-extract',context:{mime:'image/svg+xml',data:'aGVsbG8='}}));assert.throws(()=>c.buildProviderRequest({...base,kind:'menu-extract',context:{mime:'image/png',data:'https://example.test/private'}}));});
const src={id,name:'Çay',description:'Demli çay',ingredients:null,serving:'Bardak',options:[],priceMinor:'2500',version:'1'};
const studio={...base,kind:'studio',request:{studioId:id,studioLease:id},context:{studioKind:'product-copy',input:{language:'tr'},sources:[src]}};
test('studio output stays draft with existing product identity',async()=>{const r=await c.generate(studio,async()=>response({title:'Çay',body:'Bardakta demli çay.',options:[],sourceIds:[id],warnings:[]}));assert.equal(r.result.draft.draftOnly,true);assert.equal(r.result.draft.sourceIds[0],id);});
test('studio invented references cannot be applied',async()=>assert.rejects(()=>c.generate(studio,async()=>response({title:'Çay',body:'x',options:[],sourceIds:['invented'],warnings:[]})),/LLM_INVALID_OUTPUT/));
test('photo generation is not pretended by the language model',()=>assert.throws(()=>c.buildProviderRequest({...studio,context:{...studio.context,studioKind:'photo-enhance'}}),/LLM_IMAGE_ENGINE_REQUIRED/));
test('invoice extraction preserves unknown amount, no inferred total',async()=>{const d={...studio,context:{...studio.context,studioKind:'invoice',input:{language:'tr',attachment:{mime:'image/png',data:'aGVsbG8=',pages:1}}}};const r=await c.generate(d,async()=>response({currency:'TRY',invoiceNumber:null,invoiceDate:null,totalMinor:null,lines:[{name:'Un',quantityText:'1',unitText:'kg',netMinor:null,taxMinor:null,grossMinor:'12300',page:1,sourceText:'Un 1 kg 123,00'}],warnings:['Toplam okunamadı']}));assert.equal(r.result.draft.totalMinor,null);assert.equal(r.result.draft.lines[0].grossMinor,'12300');});
test('network uncertainty does not retry or fail over to paid provider',async()=>{let calls=0;await assert.rejects(()=>c.generate(base,async(url)=>{calls++;assert.equal(url,w.OPEN_ENDPOINT);throw new Error('timeout');}),/LLM_RESULT_UNKNOWN/);assert.equal(calls,1);});
for(const [status,code] of [[401,'LLM_KEY_INVALID'],[429,'LLM_RATE_LIMIT'],[503,'LLM_PROVIDER_UNAVAILABLE']])test('private gateway error '+status,async()=>assert.rejects(()=>c.generate(base,async()=>new Response('{}',{status})),new RegExp(code)));
test('response redirects never forwarded with key',async()=>{await c.generate(base,async(_url,init)=>{assert.equal(init.redirect,'error');return response({status:'MENUGO_OK'});});});
test('edge and Next contracts are identical',()=>{assert.equal(fs.readFileSync(root+'studio-contracts.ts','utf8'),fs.readFileSync('src/studio/contracts.ts','utf8').replace("'./operations'","'./studio-operations.ts'"));assert.equal(fs.readFileSync(root+'studio-operations.ts','utf8'),fs.readFileSync('src/studio/operations.ts','utf8'));assert.equal(fs.readFileSync(root+'menu-contracts.ts','utf8'),fs.readFileSync('lib/ai-menu/contracts.ts','utf8'));});
test('production routes have explicit self-host policy, no gateway credential path',()=>{for(const path of ['app/api/studio/[action]/route.ts','app/api/ai-menu/[action]/route.ts']){const text=fs.readFileSync(path,'utf8');assert.ok(text.includes('requireOpenSource'));assert.ok(!text.includes('gatewayCredential'));assert.ok(!text.includes('invokeStudio('));}assert.ok(fs.readFileSync(root+'index.ts','utf8').includes("['self_hosted','openrouter_free'].includes"));});


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
