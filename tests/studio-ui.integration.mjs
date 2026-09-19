// Real Next/React browser tests with explicit authenticated API doubles; no live AI calls.
import {chromium as pw} from 'playwright-core';import chromium from '@sparticuz/chromium';import {spawn} from 'node:child_process';import fs from 'node:fs';import assert from 'node:assert/strict';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
const base='http://localhost:3417',checks=[],errors=[],writes=[],out='public/qa/studio';let browser,role='owner',ready=false,approved=false,createAttempts=0,raceMode=false,raceCalls=0;const createOperationIds=[];
const pid='55555555-5555-4555-8555-555555555555',jid='88888888-8888-4888-8888-888888888888';
const item={id:pid,name:'Peynirli Börek',description:'Peynirli börek',ingredients:'Peynir, un',serving:'Porsiyon',options:[],priceMinor:'15000',version:'v1'};
const result={id:jid,kind:'product-copy',state:'review',revision:'2',source_snapshot:[item],hasSource:false,result:{kind:'product-copy',title:'Peynirli Börek',body:'Peynirli börek.',options:[],warnings:[],sourceIds:[pid],draftOnly:true}};
fs.mkdirSync(out,{recursive:true});
try{
 for(let i=0;i<90;i++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
 browser=await pw.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let value={};
  if(req.method()==='POST')writes.push({path,body:req.postDataJSON()});
  if(path==='/api/session')value={user:{id:pid}};
  else if(path==='/api/merchant/claim')value={role};
  else if(path==='/api/studio/list')value={jobs:createAttempts>=2?[{id:jid,kind:'product-copy',state:approved?'approved':'review'}]:[],catalogue:[item],aiReady:ready,aiReason:ready?null:'AI_CREDIT_REQUIRED'};
  else if(path==='/api/studio/get'){
   if(raceMode){raceCalls++;const state=raceCalls===1?'review':'approved';if(raceCalls===1)await new Promise(r=>setTimeout(r,160));value={...result,state};}
   else value={...result,state:approved?'approved':'review'};
  }
  else if(path==='/api/studio/create'){
   const body=req.postDataJSON();assert.equal(body.kind,'product-copy');createAttempts++;createOperationIds.push(body.operationId);
   if(createAttempts===1)return route.abort('failed');
   value={id:jid,state:'queued',duplicate:createAttempts>2};
  }
  else if(path==='/api/studio/approve'){assert.equal(req.postDataJSON().comparedOriginal,true);approved=true;value={approved:true,applied:false};}
  else if(path==='/api/studio/discard')value={discarded:true};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto(base+'/isletme/studyo',{waitUntil:'networkidle'});await page.locator('.business-studio').waitFor();checks.push('owner studio mounted behind role check');
 assert.equal(writes.filter(x=>x.path==='/api/studio/create').length,0);assert.equal(await page.getByRole('button',{name:'Taslak üret',exact:true}).isEnabled(),false);checks.push('mount never runs AI; missing credit disables generation');
 await page.getByRole('button',{name:'Reçete maliyeti',exact:true}).click();await page.getByLabel('Paket miktarı',{exact:true}).fill('1000');await page.getByLabel('Paket maliyeti (TL)',{exact:true}).fill('123,45');await page.getByLabel('Reçetede kullanılan',{exact:true}).fill('100');await page.getByLabel('Porsiyon sayısı',{exact:true}).fill('3');await page.getByRole('button',{name:'Maliyeti hesapla'}).click();assert.ok((await page.locator('.studio-cost-result').innerText()).includes('12,35'));checks.push('recipe calculator works without AI and preserves cents');
 for(const width of [320,360,390,768,1024,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'recipe layout '+width);checks.push('recipe responsive '+width);}
 ready=true;await page.getByRole('button',{name:'İçerik & Görsel',exact:true}).click();await page.getByRole('button',{name:'Listeyi yenile'}).click();await page.getByLabel('Ne hazırlayalım?').selectOption('product-copy');await page.getByRole('button',{name:'Taslak üret',exact:true}).click();
 await page.getByRole('button',{name:'Bekleyen işlemi güvenle kontrol et'}).waitFor();assert.equal(createAttempts,1);assert.equal(await page.getByRole('button',{name:'Taslak üret',exact:true}).isEnabled(),false);checks.push('lost create response is retained as one pending operation and blocks a new paid intent');
 await page.getByRole('button',{name:'Bekleyen işlemi güvenle kontrol et'}).click();await page.getByRole('heading',{name:'Peynirli Börek',exact:true}).waitFor();assert.equal(createAttempts,2);assert.equal(createOperationIds[1],createOperationIds[0]);checks.push('retry reuses the exact operationId so server idempotency can recover without a second job');
 const approve=page.getByRole('button',{name:'İncelenmiş taslağı kaydet'});assert.equal(await approve.isEnabled(),false);await page.getByRole('checkbox').check();await approve.click();await page.getByText('İncelenmiş taslak',{exact:true}).first().waitFor();checks.push('review requires explicit comparison and is not publishing');
 raceMode=true;raceCalls=0;const refresh=page.getByRole('button',{name:'Durumu kontrol et'});await refresh.evaluate(el=>{el.click();el.click();});await page.waitForTimeout(260);assert.equal(raceCalls,2);assert.equal(await page.getByRole('checkbox').count(),0);checks.push('late older job response cannot overwrite a newer approved state');
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'studio layout '+width);await page.screenshot({path:`${out}/studio-${width}.png`,fullPage:true});checks.push('studio responsive '+width);}
 assert.equal(writes.filter(x=>/payment|catalogue|publish|apply/.test(x.path)).length,0);checks.push('no financial catalogue or social writes');
 role='waiter';await page.reload({waitUntil:'networkidle'});await page.locator('.role-gate').waitFor();assert.equal(await page.locator('.business-studio').count(),0);checks.push('waiter denied spending interface');
 await context.unroute('**/api/**');for(const action of ['list','get','create','approve']){const r=['list','get'].includes(action)?await page.request.get(base+'/api/studio/'+action):await page.request.post(base+'/api/studio/'+action,{headers:{Origin:base},data:{}});assert.equal(r.status(),401);checks.push('real unauthenticated route denied '+action);}
 assert.deepEqual(errors,[]);fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,apiDoubles:true,realProviderCalls:0,productionTransactions:0,createAttempts,operationIdsReused:createOperationIds[0]===createOperationIds[1],staleResponseRaceProtected:true},null,2));console.log('STUDIO UI PASS',checks.length);
}catch(e){console.error('STUDIO UI FAILED',e.message,errors,logs.slice(-2000));process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}