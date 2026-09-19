// Authorized UI test doubles only. No provider key or business record is changed.
import{chromium as playwright}from'playwright-core';import chromium from'@sparticuz/chromium';import{spawn}from'node:child_process';import fs from'node:fs';import assert from'node:assert/strict';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
const base='http://localhost:3417',checks=[],errors=[],posts=[],out='public/qa/llm',id=n=>`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`;let browser,role='owner',askUnknown=false;
let status={configured:false,enabled:false,provider:null,model:null,version:'0',canManage:true,verified:false,testedAt:null,testError:null,dailyLimit:30,usedToday:0,products:[{id:id(1),name:'Peynirli Börek'}]};
const profile={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',hours:[],version:'1'},catalogue={name:profile.name,branchName:'Bahçeşehir',orderingEnabled:true,items:[]};
const data={role,tables:[],orders:[],deliveries:[],loyalty:[],customers:[],campaigns:[],outbox:[],rules:[],features:{},catalogue,receipts:[],products:[],settings:{},orderingSettings:{}};
fs.mkdirSync(out,{recursive:true});
try{
 for(let i=0;i<90;i++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const ctx=await browser.newContext();const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await ctx.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let v={};if(req.method()==='POST')posts.push({path,body:req.postDataJSON()});
 if(path==='/api/session')v={user:{id:id(100)}};
 else if(path==='/api/merchant/claim')v={role};
 else if(path==='/api/ops/console')v={...data,role};
 else if(path==='/api/merchant/snapshot')v={role,profile,staff:[],invites:[],requests:[]};
 else if(path==='/api/catalogue')v=catalogue;
 else if(path==='/api/merchant/profile')v=profile;
 else if(path==='/api/merchant/readiness')v={tableCount:0,staffCount:1,approvedProducts:1,unpricedProducts:0,orderingEnabled:true,profile};
 else if(path==='/api/merchant/table-policy')v={mode:'direct'};
 else if(path==='/api/merchant/table-requests')v=[];
 else if(path==='/api/merchant/service-dashboard')v={summary:{waitingAcceptance:0,preparing:0,ready:0,overdue:0},guestVisits:0,cancellations:[],visits:[]};
 else if(path==='/api/llm/status')v={...status,canManage:role==='owner'};
 else if(path==='/api/llm/free-status')v={version:status.version,canManage:role==='owner',paidFallback:false,routes:[]};
 else if(path==='/api/llm/free-save'){const s=req.postDataJSON();assert.equal(s.consent,true);assert.equal(s.apiKey,'FAKE_TEST_ONLY_KEY_NOT_A_CREDENTIAL_1234');assert.equal(s.version,status.version);status={...status,configured:true,enabled:s.enabled,provider:'free_router',model:'free-router-v1',version:'1',dailyLimit:s.dailyLimit};v=status;}
 else if(path==='/api/llm/test'){assert.ok(req.postDataJSON().operationId);status={...status,verified:true,usedToday:1};v={state:'succeeded',result:{verified:true},model:status.model};}
 else if(path==='/api/llm/ask'){const s=req.postDataJSON();assert.ok(s.operationId);assert.equal(Object.keys(s).sort().join(','),'day,operationId,productId,question,task');if(askUnknown){askUnknown=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'LLM_RESULT_UNKNOWN'}})});}v={state:'succeeded',model:status.model,result:{answer:'Peynirli börek için kayıtlı açıklamadan hazırlanmış taslak.',warnings:['Porsiyon bilgisi bulunmuyor.'],sourceIds:['product:'+id(1)],sources:[{id:'product:'+id(1),title:'Peynirli Börek',data:{name:'Peynirli Börek',priceMinor:'15000'}}],draftOnly:true,capturedAt:'2026-09-19T00:00:00Z'}};}
 else if(path==='/api/llm/disconnect'){status={...status,configured:false,enabled:false,verified:false,provider:null,model:null,version:'0'};v=status;}
 return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(v)});
 });
 await page.goto(base+'/isletme',{waitUntil:'networkidle'});await page.locator('.sidebar nav button').filter({hasText:'LLM Asistanı'}).click();await page.locator('.llm-studio').waitFor();checks.push('owner assistant tab is mounted');
 assert.equal(await page.getByRole('button',{name:'Taslak yanıt oluştur'}).isEnabled(),false);assert.equal(posts.filter(x=>x.path==='/api/llm/test'||x.path==='/api/llm/ask').length,0);checks.push('no fake inference or paid calls on mount');
 const form=page.locator('.free-ai-settings form').first();
 await form.getByLabel('API anahtarı',{exact:true}).fill('FAKE_TEST_ONLY_KEY_NOT_A_CREDENTIAL_1234');
 await form.getByRole('button',{name:'Ücretsiz bağlantıyı kaydet'}).click();assert.equal(posts.filter(x=>x.path==='/api/llm/free-save').length,0);checks.push('free-plan and data consent are mandatory');
 await form.locator('input[name=free]').check();await form.locator('input[name=consent]').check();await form.locator('input[name=public]').check();await form.locator('input[name=private]').check();await form.getByRole('button',{name:'Ücretsiz bağlantıyı kaydet'}).click();
 await page.getByText('Bağlantı kaydedildi.',{exact:false}).waitFor();assert.equal(await page.getByLabel('API anahtarı',{exact:true}).first().inputValue(),'');assert.equal(await page.evaluate(()=>Object.values(localStorage).join('').includes('FAKE_TEST_ONLY')),false);checks.push('credential cleared and never browser-persisted');
 assert.equal(await page.getByRole('button',{name:'Taslak yanıt oluştur'}).isEnabled(),false);await page.getByRole('button',{name:'Bağlantıyı test et'}).click();await page.getByText('Gerçek model yanıtı alındı.',{exact:false}).waitFor();checks.push('verification UI reflects explicit test result, not saving config');
 for(const width of [320,360,390,768,1024,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'LLM width '+width);checks.push('LLM settings and assistant fit '+width);if([390,1440].includes(width))await page.locator('.llm-studio').screenshot({path:`${out}/assistant-${width}.png`});}
 await page.getByRole('button',{name:'Ürün açıklaması',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Taslak yanıt oluştur'}).isEnabled(),false);await page.getByLabel('İlgili ürün').selectOption(id(1));await page.getByRole('button',{name:'Taslak yanıt oluştur'}).click();await page.getByLabel('LLM yanıtı').waitFor();assert.ok((await page.getByLabel('LLM yanıtı').innerText()).includes('kayıtlı açıklamadan'));checks.push('selected-product answer renders plain text draft');
 await page.getByText('Kullanılan kayıtlar (1)',{exact:true}).click();await page.locator('.llm-source').waitFor();assert.ok((await page.locator('.llm-source').innerText()).includes('15000'));checks.push('answer references server source records');
 assert.equal(posts.filter(x=>/apply|catalogue|payment/.test(x.path)).length,0);checks.push('assistant makes no product payment or catalogue write');
 askUnknown=true;await page.getByRole('button',{name:'Taslak yanıt oluştur'}).click();await page.getByRole('button',{name:'Aynı işlemin sonucunu kontrol et'}).waitFor();const unknownOp=posts.at(-1).body.operationId;await page.getByRole('button',{name:'Aynı işlemin sonucunu kontrol et'}).click();await page.getByLabel('LLM yanıtı').waitFor();assert.equal(posts.at(-1).body.operationId,unknownOp);checks.push('ambiguous request is retried with identical operation key');
 role='manager';await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar nav button').filter({hasText:'LLM Asistanı'}).click();await page.locator('.llm-studio').waitFor();assert.equal(await page.getByLabel('API anahtarı',{exact:true}).count(),0);checks.push('manager can use assistant but cannot enter or read provider key');
 role='waiter';await page.goto(base+'/garson',{waitUntil:'networkidle'});assert.equal(await page.locator('.sidebar nav button').filter({hasText:'LLM Asistanı'}).count(),0);checks.push('waiter has no LLM spending interface');
 await ctx.unroute('**/api/**');for(const action of ['status','free-status','free-save','settings','test','ask']){const response=['status','free-status'].includes(action)?await page.request.get(base+'/api/llm/'+action):await page.request.post(base+'/api/llm/'+action,{headers:{Origin:base},data:{}});assert.equal(response.status(),401,action);checks.push('real Next route rejects unauthenticated '+action);}
 assert.deepEqual(errors,[]);checks.push('no unhandled React errors');fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,apiTestDoubles:true,realProviderCalls:0,realCredentials:0},null,2));console.log('LLM UI PASS',checks.length);
}catch(e){console.error('LLM UI FAILED',e.message,errors,logs.slice(-2000));if(browser)for(const c of browser.contexts())for(const p of c.pages()){try{console.error((await p.locator('body').innerText()).slice(-2000));await p.screenshot({path:out+'/failure.png',fullPage:true});}catch{}}process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
