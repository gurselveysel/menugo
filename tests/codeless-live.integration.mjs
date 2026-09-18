// Read-only real-domain checks. Never visit a valid table-join page: it would create a real visit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium as playwright} from 'playwright-core';
import chromium from '@sparticuz/chromium';
const base='https://sariyerborekcisi.menugo.app',admin='https://www.menugo.app';
const table='71c94846-e2ba-4e6d-b3f7-14d43759e862';
const out='public/qa/codeless-live',checks=[],errors=[];let browser;
fs.mkdirSync(out,{recursive:true});
try{
 const rr=await fetch(admin+'/release.json',{cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(rr.status,200);
 const release=await rr.json();assert.equal(release.version,'menugo-codeless-ordering-20260918-r12');checks.push('r12 production release');
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
 const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 for(const width of [320,360,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  for(const path of ['/bahcesehir','/siparis','/hesabim','/yardim']){
   const r=await page.goto(base+path,{waitUntil:'networkidle',timeout:30000});assert.equal(r.status(),200,path);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,path+' overflow '+width);
   assert.equal(await page.locator('input[type=email],input[type=password],.entry-code').count(),0,path+' no compulsory login/code');
   checks.push('public page without mandatory identity/code and no overflow: '+path+' '+width);
   if(width===390)await page.screenshot({path:out+'/'+path.slice(1)+'-390.png',fullPage:true});
  }
 }
 // GET only: setting a capability cookie is not creating a DB visitor or order.
 const infoResponse=await context.request.get(base+'/api/table/'+table);assert.equal(infoResponse.status(),200);
 const info=await infoResponse.json();assert.equal(info.table.entryMode,'direct');assert.equal(info.table.tableName,'Masa 14');assert.equal(info.table.enabled,true);assert.equal(info.request.state,'idle');
 assert.equal('code' in info.request,false);assert.equal('checkId' in info.table,false);assert.equal('billMinor' in info,false);
 assert.ok(infoResponse.headers()['cache-control'].includes('no-store'));checks.push('real table14 direct mode with no admission code or bill disclosure; GET did not join');
 const cookie=(await context.cookies()).find(c=>c.name==='menugo_entry_'+table);assert.ok(cookie?.httpOnly&&cookie.secure&&cookie.sameSite==='Lax');checks.push('secure HttpOnly table capability cookie');
 for(const path of ['/api/merchant/table-policy','/api/merchant/table-requests','/api/merchant/snapshot','/api/ops/console']){
  const r=await context.request.get(admin+path);assert.equal(r.status(),401,path);checks.push('unauthenticated staff read rejected: '+path);
 }
 await page.goto(base+'/yardim',{waitUntil:'networkidle'});assert.ok((await page.locator('body').innerText()).includes('Garsonun katılım onaylaması veya kod kontrol etmesi gerekmez'));checks.push('live help explains order acceptance, not guest code approval');
 for(const path of ['/garson','/mutfak','/kasa']){const r=await page.goto(admin+path,{waitUntil:'networkidle'});assert.equal(r.status(),200);assert.equal(await page.locator('.workspace').count(),0);checks.push('staff workspace not disclosed: '+path);}
 assert.deepEqual(errors,[]);checks.push('no unhandled browser errors');
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,release:release.version,production:true,apiMocked:false,dbWrites:false,orderCreated:false,physicalPhoneTest:false,generatedAt:new Date().toISOString()},null,2));console.log('CODELESS LIVE READ-ONLY PASS',checks.length);
}catch(e){console.error(e);fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors},null,2));process.exitCode=1;}finally{if(browser)await browser.close();}
