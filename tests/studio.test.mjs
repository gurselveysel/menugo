// Pure contracts and provider doubles. No real AI account, customer data or network charges.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const root='test-results/studio-unit';fs.mkdirSync(root,{recursive:true});
for(const [name,path] of [['operations','src/studio/operations.ts'],['contracts','src/studio/contracts.ts'],['gateway','lib/studio/gateway.ts']]){
 const source=fs.readFileSync(path,'utf8').replace("import 'server-only';",'').replaceAll("from './operations'","from './operations.mjs'").replaceAll("from '@/src/studio/operations'","from './operations.mjs'").replaceAll("from '@/src/studio/contracts'","from './contracts.mjs'");
 fs.writeFileSync(`${root}/${name}.mjs`,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
}
const m=await import('../'+root+'/operations.mjs'),c=await import('../'+root+'/contracts.mjs'),g=await import('../'+root+'/gateway.mjs');
const ingredient={id:'flour',unit:'g',packQuantity:'1000',packCostMinor:'12345',recipeQuantity:'100',edibleYieldBps:10000};
test('normalized package cost: full recipe then round',()=>{const v=m.costRecipe([ingredient],3);assert.equal(v.totalMinor,'1235');assert.deepEqual(v.portionCostsMinor,['412','412','411']);});
test('no per-line rounding drift',()=>{const v=m.costRecipe([1,2,3].map(n=>({...ingredient,id:String(n),packQuantity:'3',packCostMinor:'1',recipeQuantity:'1'})),1);assert.equal(v.totalMinor,'1');});
test('yield and overhead are integer rational calculations',()=>assert.equal(m.costRecipe([{...ingredient,packCostMinor:'10000',recipeQuantity:'500',edibleYieldBps:5000}],2,'100').totalMinor,'10100'));
test('portion sum conserves 20000 combinations',()=>{for(let n=0;n<2000;n++)for(let p=1;p<=10;p++){const v=m.costRecipe([{...ingredient,packQuantity:'1',recipeQuantity:'1',packCostMinor:String(n)}],p);assert.equal(v.portionCostsMinor.reduce((s,x)=>s+BigInt(x),0n),BigInt(n));}});
for(const value of ['1e3','NaN','-1','1.234','1,000.01','1 000','00.12'])test('ambiguous decimal rejected '+value,()=>assert.throws(()=>m.decimalToScaled(value)));
for(const [value,expected] of [['12,34',1234n],['0.01',1n],['123',12300n],['1.2',120n]])test('decimal accepted '+value,()=>assert.equal(m.decimalToScaled(value),expected));
for(const delta of [{edibleYieldBps:0},{unit:'kg'},{packCostMinor:123},{packQuantity:'0'},{recipeQuantity:'0'},{packCostMinor:'9223372036854775808'}])test('recipe validation '+JSON.stringify(delta),()=>assert.throws(()=>m.costRecipe([{...ingredient,...delta}],1)));
test('duplicate ingredients rejected instead of accidentally double costing',()=>assert.throws(()=>m.costRecipe([ingredient,ingredient],1)));
test('partial invoice is not a reconciled invoice',()=>{const r=m.reconcileInvoice([{name:'Unknown',netMinor:null,taxMinor:null,grossMinor:null}],null);assert.equal(r.consistent,false);assert.equal(r.computedTotalMinor,null);});
test('invoice tax and total mismatches fail review',()=>{const r=m.reconcileInvoice([{name:'Cheese',netMinor:'100',taxMinor:'20',grossMinor:'110'}],'120');assert.deepEqual(r.issues,['LINE_1_MISMATCH','INVOICE_TOTAL_MISMATCH']);});
test('invoice consistent still requires review',()=>{const r=m.reconcileInvoice([{name:'Cheese',netMinor:'100',taxMinor:'20',grossMinor:'120'}],'120');assert.equal(r.consistent,true);assert.equal(r.requiresHumanReview,true);});
const days=[['2026-08-01','10'],['2026-08-08','20'],['2026-08-15','30'],['2026-08-22','40']].map(([date,units])=>({date,units,open:true,complete:true,stockout:false}));
test('insufficient history is not a forecast',()=>assert.equal(m.productionEstimate(days.slice(0,3),'2026-08-29').status,'insufficient_data'));
test('same weekday median excludes unavailable stock',()=>{const r=m.productionEstimate([...days,{date:'2026-08-28',units:'999',open:true,complete:true,stockout:false}],'2026-08-29');assert.equal(r.suggestedUnits,'25');assert.equal(r.samples,4);assert.equal(r.automaticPurchase,false);});
for(const changes of [{stockout:true},{complete:false},{open:false}])test('unknown and closed days not silently zeroed '+JSON.stringify(changes),()=>assert.equal(m.productionEstimate([...days.slice(0,3),{...days[3],...changes}],'2026-08-29').status,'insufficient_data'));
test('invalid/future/duplicate dates rejected',()=>{assert.throws(()=>m.productionEstimate(days,'2026-02-30'));assert.throws(()=>m.productionEstimate(days,'2026-07-01'));assert.throws(()=>m.productionEstimate([...days,days[0]],'2026-08-29'));});
const source={id:'p1',name:'Çay',description:'Siyah çay',ingredients:null,serving:'Bardak',options:[],priceMinor:'2500',version:'v1'};
const copy={title:'Çay',body:'Siyah çay.',options:[],sourceIds:['p1'],warnings:[]};
test('output references must be provided by server',()=>{assert.equal(c.parseCopy('product-copy',copy,[source]).draftOnly,true);assert.throws(()=>c.parseCopy('campaign',{...copy,sourceIds:['p2']},[source]));assert.throws(()=>c.parseCopy('campaign',{...copy,sourceIds:[]},[source]));});
test('extra model action fields rejected',()=>assert.throws(()=>c.parseCopy('product-copy',{...copy,sql:'delete from products'},[source])));
const invoice={currency:'TRY',invoiceNumber:null,invoiceDate:null,totalMinor:'120',lines:[{name:'Un',quantityText:'1',unitText:'kg',netMinor:'100',taxMinor:'20',grossMinor:'120',page:1,sourceText:'Un 1 kg 1,20'}],warnings:[]};
test('invoice preserves unnormalized unit text as draft',()=>assert.equal(c.parseInvoice(invoice).lines[0].unitText,'kg'));
for(const bad of [{...invoice,currency:'USD'},{...invoice,totalMinor:1.2},{...invoice,lines:[{...invoice.lines[0],page:9}]},{...invoice,bankAccount:'private'}])test('invoice schema rejects '+JSON.stringify(bad).slice(0,50),()=>assert.throws(()=>c.parseInvoice(bad)));
test('photo instruction protects authentic dish and brand',()=>{const p=c.photoInstruction('white');for(const s of ['Preserve','portion size','Do not add ingredients','No new food','untrusted'])assert.ok(p.includes(s));assert.throws(()=>c.photoInstruction('other'));});
const oldFetch=globalThis.fetch;async function stub(fn,run){globalThis.fetch=fn;try{await run();}finally{globalThis.fetch=oldFetch;}}
const input={kind:'product-copy',sources:[source],language:'tr',style:'white'};
const response=content=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:20,completion_tokens:10}}));
test('provider one allowed endpoint, no tools, structured draft',async()=>stub(async(url,init)=>{assert.equal(url,'https://ai-gateway.vercel.sh/v1/chat/completions');const body=JSON.parse(init.body);assert.equal(body.tools,undefined);assert.equal(body.response_format.type,'json_schema');assert.equal(init.redirect,'error');return response(copy);},async()=>assert.equal((await g.runStudio(input,'synthetic')).draft.draftOnly,true)));
test('invoice original file, no OCR rasterization or remote file fetch',()=>{const r=g.buildStudioRequest({...input,kind:'invoice',sources:[],attachment:{mime:'application/pdf',data:'cGRm',pages:1}});assert.equal(r.messages[1].content[1].file.file_data,'data:application/pdf;base64,cGRm');});
test('provider uncertainty never auto-retries',async()=>{let n=0;await stub(async()=>{n++;throw Error('contains-secret');},async()=>await assert.rejects(g.runStudio(input,'synthetic'),/AI_RESULT_UNKNOWN/));assert.equal(n,1);});
test('image URLs must be inline rather than SSRF destinations',async()=>stub(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{images:[{type:'image_url',image_url:{url:'https://169.254.169.254/latest/meta-data/'}}]}}]})),async()=>await assert.rejects(g.runStudio({...input,kind:'photo-enhance',attachment:{mime:'image/png',data:'cG5n',pages:1}},'synthetic'),/INVALID_IMAGE_OUTPUT/)));
test('source attachment required for image editing',()=>assert.throws(()=>g.buildStudioRequest({...input,kind:'photo-enhance'}),/PHOTO_REQUIRED/));
test('image request uses documented modalities',()=>assert.deepEqual(g.buildStudioRequest({...input,kind:'photo-enhance',attachment:{mime:'image/png',data:'cG5n',pages:1}}).modalities,['text','image']));
for(const code of [401,402,429,500])test('provider HTTP failure '+code,async()=>stub(async()=>new Response('',{status:code}),async()=>await assert.rejects(g.runStudio(input,'synthetic'))));
