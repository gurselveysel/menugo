// Production smoke is read-only: no provider call, source upload, customer or menu write.
import assert from 'node:assert/strict';import fs from 'node:fs';import {chromium as playwright} from 'playwright-core';import chromium from '@sparticuz/chromium';
const admin='https://www.menugo.app',base='https://sariyerborekcisi.menugo.app',out='public/qa/ai-menu-live';const checks=[],errors=[];let browser;fs.mkdirSync(out,{recursive:true});
try{
 const r=await fetch(admin+'/release.json',{cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);const release=await r.json();assert.equal(release.version,'menugo-ai-menu-studio-20260919-r15');assert.equal(release.aiMenuImport,true);assert.equal(release.aiPhotoStudio,false);checks.push('production r15 declares menu import, not unimplemented photo studio');
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 for(const host of [admin,base]){
  for(const action of ['list','source','snapshot']){const r=await context.request.get(host+'/api/ai-menu/'+action);assert.equal(r.status(),401);assert.ok((r.headers()['cache-control']||'').includes('no-store'));checks.push('unauthenticated private '+action+' blocked on '+host);}
 }
 const catalogue=await context.request.get(base+'/api/catalogue');assert.equal(catalogue.status(),200);const cat=await catalogue.json();assert.equal(cat.items.length,76);assert.equal(cat.items.filter(x=>x.priceApproved&&x.priceMinor!==null).length,71);checks.push('existing 76 products and 71 approved prices unchanged');
 for(const width of [320,360,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  for(const path of ['/isletme','/siparis','/bahcesehir']){const r=await page.goto((path==='/isletme'?admin:base)+path,{waitUntil:'networkidle',timeout:30000});assert.equal(r.status(),200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);if(path==='/isletme')assert.equal(await page.locator('.ai-studio').count(),0);if(path==='/siparis')assert.equal(await page.locator('input[type=password],input[type=email]').count(),0);checks.push('live page responsive/private '+path+' '+width);}
 }
 await page.goto(base+'/siparis',{waitUntil:'networkidle'});await page.getByRole('button',{name:/Kamerayı aç ve masa QR/}).waitFor();checks.push('existing camera entry remains available; no camera opened');
 assert.deepEqual(errors,[]);checks.push('no unhandled browser errors');
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,production:true,apiMocked:false,sourceUploaded:false,providerCalls:0,dbWrites:false,authenticatedStudioTested:false,release:release.version},null,2));console.log('AI MENU LIVE READ-ONLY PASS',checks.length);
}catch(e){console.error(e);fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors},null,2));process.exitCode=1;}finally{if(browser)await browser.close();}
