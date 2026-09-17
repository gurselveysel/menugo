// Real DOM/CSS and image-alpha checks. Live mode uses GET only; no credentials or writes.
import {chromium as playwright} from 'playwright-core';
import chromium from '@sparticuz/chromium';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const live=Boolean(process.env.BRAND_TEST_BASE_URL);
const base=process.env.BRAND_TEST_BASE_URL||'http://localhost:3417';
const server=live?null:spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
let log='',browser;server?.stdout.on('data',v=>log+=v);server?.stderr.on('data',v=>log+=v);
const checks=[],errors=[];const out='public/qa/branding'+(live?'-live':'');fs.mkdirSync(out,{recursive:true});
const logo='/media/sariyer-brand-transparent-r8.webp';
try{
 if(!live){let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/giris')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert.ok(ready,'server start '+log);}
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
 const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 if(!live) await context.route('**/api/**',async route=>{let data={};const p=new URL(route.request().url()).pathname;if(p==='/api/catalogue')data={orderingEnabled:true,items:[{id:'33333333-3333-4333-8333-000000000001',name:'Klasik Sandviç',category:'sandvic',description:'Test ürünü',options:[],priceMinor:'15000',priceApproved:true,available:true,canOrder:true}]};else if(p==='/api/merchant/profile')data={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',tagline:'Lezzetin en güzel hâli.',hours:[],address:null,whatsappEnabled:true,whatsappPhone:'905394830031',orderingEnabled:true};else {await route.fulfill({status:401,contentType:'application/json',body:'{"error":"UNAUTHENTICATED"}'});return;}await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});});
 for(const width of [360,390,768,1024,1440]){
  await page.setViewportSize({width,height:900});await page.goto(base+'/bahcesehir',{waitUntil:'networkidle'});await page.locator('.merchant-category').first().waitFor({timeout:20000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push('no overflow '+width);
  const colours=await page.locator('.merchant-footer,.merchant-powered,.merchant-bottom').evaluateAll(a=>a.map(el=>getComputedStyle(el).backgroundColor));assert.deepEqual(colours,['rgb(255, 255, 255)','rgb(255, 255, 255)','rgb(255, 255, 255)']);checks.push('white footer and dock '+width);
  assert.equal(await page.locator('.merchant-header img').getAttribute('src'),logo);assert.equal(await page.locator('.merchant-footer-shop').getAttribute('src'),logo);
  const box=await page.locator('.merchant-powered img').evaluate(el=>{const s=getComputedStyle(el);return[s.backgroundColor,s.padding,s.borderRadius]});assert.deepEqual(box,['rgba(0, 0, 0, 0)','0px','0px']);checks.push('no logo tile '+width);
  for(const selector of ['.merchant-header img','.merchant-footer-shop','.merchant-powered img']){
   const alpha=await page.locator(selector).evaluate(async img=>{await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let clear=0,opaque=0;for(let i=3;i<d.length;i+=4){if(d[i]===0)clear++;if(d[i]>=250)opaque++;}return{clear,opaque,pixels:c.width*c.height,corner:d[3]};});assert.equal(alpha.corner,0);assert.ok(alpha.clear>alpha.pixels*.2&&alpha.opaque>alpha.pixels*.03,selector+' genuine alpha');
  }checks.push('three genuine-alpha DOM logos '+width);
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:`${out}/top-${width}.png`});
  await page.evaluate(()=>scrollTo({top:document.body.scrollHeight,behavior:'instant'}));await page.screenshot({path:`${out}/footer-${width}.png`});
 }
 await page.locator('.merchant-tabs button').last().click();await page.locator('.merchant-about').waitFor();checks.push('about tab works');
 for(const path of ['/giris','/hesabim','/siparis','/garson']){
  await page.setViewportSize({width:390,height:844});await page.goto(base+path,{waitUntil:'networkidle'});
  assert.ok(await page.locator(`img[src="${logo}"]`).count()>0,'shared branding '+path);assert.equal(await page.locator('img[src="/media/sariyer-brand.avif"]').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,path);checks.push('shared transparent brand '+path);
 }
 assert.deepEqual(errors,[]);checks.push('no JS runtime errors');
 fs.writeFileSync(`${out}/results.json`,JSON.stringify({passed:checks.length,checks,errors,live,base,noAuthenticatedActions:true,generatedAt:new Date().toISOString()},null,2));
 console.log('BRANDING UI PASS',checks.length,live?'LIVE':'SYNTHETIC API');
}catch(e){console.error('BRANDING UI FAIL',e.message,errors,log.slice(-2000));process.exitCode=1;}finally{if(browser)await browser.close();server?.kill('SIGTERM');}
