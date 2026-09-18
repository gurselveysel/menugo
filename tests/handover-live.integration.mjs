// Production GET-only acceptance. No account, order, payment, SMS or table is created.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium as playwright} from 'playwright-core';
import chromium from '@sparticuz/chromium';
const base='https://sariyerborekcisi.menugo.app';
const admin='https://www.menugo.app';
const out='public/qa/handover-live';fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[];let browser;
try{
 const releaseResponse=await fetch(admin+'/release.json',{cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(releaseResponse.status,200);
 const release=await releaseResponse.json();assert.equal(release.version,'menugo-service-handover-20260918-r10');checks.push('expected production release');
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
 const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 for(const width of [360,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  for(const path of ['/bahcesehir','/siparis','/hesabim','/yardim','/masaya-katil','/parola']){
   const r=await page.goto(base+path,{waitUntil:'networkidle',timeout:30000});assert.equal(r.status(),200,path);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,path+' overflow '+width);
   assert.equal(await page.locator('img').evaluateAll(imgs=>imgs.every(i=>i.complete&&i.naturalWidth>0)),true,path+' images');
   checks.push('live page, responsive, images: '+path+' '+width);
   if(width===390)await page.screenshot({path:out+'/'+path.slice(1)+'-390.png',fullPage:true});
  }
 }
 await page.goto(base+'/siparis',{waitUntil:'networkidle'});assert.equal(await page.locator('input[type=password]').count(),0);checks.push('table order has no mandatory login');
 await page.goto(base+'/parola',{waitUntil:'networkidle'});assert.equal(await page.locator('input[type=email]').count(),1);checks.push('recovery form present; no email sent');
 for(const path of ['/api/merchant/readiness','/api/merchant/table-requests','/api/merchant/snapshot','/api/ops/console']){
  const r=await context.request.get(admin+path);assert.equal(r.status(),401,path);assert.ok((r.headers()['cache-control']||'').includes('no-store'));checks.push('protected and no-store: '+path);
 }
 const callback=await context.request.get(admin+'/auth/callback?next=https%3A%2F%2Fexample.org',{maxRedirects:0});assert.ok([302,303,307,308].includes(callback.status()));assert.equal(new URL(callback.headers().location,admin).origin,admin);checks.push('callback rejects external destination');
 const profileResponse=await context.request.get(base+'/api/merchant/profile');assert.equal(profileResponse.status(),200);const profile=await profileResponse.json();assert.equal(profile.whatsappEnabled,true);assert.equal(profile.whatsappPhone,'905394830031');checks.push('live WhatsApp business profile; no message sent');
 for(const path of ['/isletme','/garson','/mutfak','/kasa']){const r=await page.goto(admin+path,{waitUntil:'networkidle'});assert.equal(r.status(),200);assert.equal(await page.locator('.workspace').count(),0);checks.push('staff page does not expose console without session: '+path);}
 const sw=await context.request.get(base+'/sw.js');assert.equal(sw.status(),200);const script=await sw.text();assert.ok(script.includes('GET'));checks.push('offline service worker is served');
 assert.deepEqual(errors,[]);checks.push('no unhandled browser errors');
 console.log('LIVE HANDOVER PASS',checks.length);
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,release:release.version,live:true,usesSyntheticAPI:false,writesPerformed:false,emailFlowTested:false,generatedAt:new Date().toISOString()},null,2));
}catch(e){fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors},null,2));console.error(e);process.exitCode=1;}finally{if(browser)await browser.close();}
