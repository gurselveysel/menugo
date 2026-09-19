// UI acceptance with fixtures, or read-only live verification with VISUAL_LIVE=1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium as playwright} from 'playwright-core';
import chromium from '@sparticuz/chromium';
const live=process.env.VISUAL_LIVE==='1';
const base=live?'https://sariyerborekcisi.menugo.app':'http://localhost:3417';
const out='public/qa/visual-handover'+(live?'-live':'');fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[],requests=[];let browser,server,log='';
try{
 if(!live){
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/giris')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}assert.ok(ready,log);
 }
 const fixture=JSON.parse(fs.readFileSync('data/catalog.json')).map((p,i)=>({id:'33333333-3333-4333-8333-'+String(i+1).padStart(12,'0'),sourceId:p[0],name:p[1],category:p[2],description:p[5],quantityLabel:p[7],options:p[6],priceMinor:p[4]===null?null:String(p[4]*100),available:true,priceApproved:p[4]!==null,canOrder:p[4]!==null}));
 const catalogue=live?(await(await fetch(base+'/api/catalogue')).json()).items:fixture;
 const release=await(await fetch(base+'/release.json')).json();assert.equal(release.version,'menugo-visual-handover-20260919-r18');assert.equal(release.onlinePayments,false);assert.equal(release.customerAccountRequired,false);checks.push('r18, no compulsory account, unchanged payment gates');
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
 const ctx=await browser.newContext();
 if(!live)await ctx.route('**/api/**',async route=>{
  const p=new URL(route.request().url()).pathname;let data;
  if(p==='/api/catalogue')data={items:fixture,orderingEnabled:true};
  else if(p==='/api/merchant/profile')data={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',phone:'0539 483 00 31',tagline:'Lezzetin en güzel hâli.',about:'Menüden çeşitler.',hours:[],address:null,whatsappEnabled:true,whatsappPhone:'905394830031',orderingEnabled:true,updatedAt:'2026-09-17T12:00:00Z'};
  else if(p==='/api/guest/visits'||p==='/api/merchant/product-information')data=[];
  else if(p==='/api/merchant/availability')data={orderingEnabled:true,paused:false,estimatedMinutes:null};
  else{await route.fulfill({status:401,contentType:'application/json',body:'{"error":"UNAUTHENTICATED"}'});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({path:new URL(r.url()).pathname,method:r.method()}));
 for(const width of [320,360,390,700,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  for(const scheme of ['light','dark']){
   await page.emulateMedia({colorScheme:scheme});
   const r=await page.goto(base+'/siparis',{waitUntil:'networkidle',timeout:30000});assert.equal(r.status(),200);
   const scan=page.getByRole('button',{name:/Kamerayı aç ve masa QR/});await scan.waitFor();await page.locator('aside[data-surface=dark]').waitFor();
   assert.equal(await page.locator('input[type=password],input[type=email],.entry-code').count(),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const button=await scan.boundingBox();assert.ok(button.y+button.height<=900,'camera primary must remain visible '+width);
   assert.equal(await page.locator('aside img[data-menugo-tone=dark]').getAttribute('src'),'/media/menugo-on-dark-r17.png');
   assert.equal(await page.locator('.guest-footer img[data-menugo-tone=light]').getAttribute('src'),'/media/menugo-transparent-r8.png');
   assert.equal(await page.locator('.guest-footer').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
   await page.locator('aside').scrollIntoViewIfNeeded();await page.waitForFunction(()=>[...document.querySelectorAll('aside img')].every(i=>i.complete&&i.naturalWidth>0));
   checks.push('welcome fits, camera visible, 3 images and correct surface logos '+width+' '+scheme);
  }
  if(width===390||width===1440)await page.screenshot({path:out+'/siparis-'+width+'.png',fullPage:true});
  await page.goto(base+'/bahcesehir',{waitUntil:'networkidle'});await page.locator('.editorial-pick').first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.locator('.editorial-pick').count(),4);
  const cards=await page.locator('.editorial-pick').evaluateAll(es=>es.map(e=>({id:e.dataset.productId,minor:e.querySelector('[data-price-minor]').dataset.priceMinor})));
  for(const p of cards)assert.equal(p.minor,catalogue.find(x=>x.id===p.id).priceMinor);
  assert.equal(await page.locator('.merchant-footer').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  checks.push('merchant images and server prices retained '+width);
  if(width===390||width===1440)await page.screenshot({path:out+'/menu-'+width+'.png',fullPage:true});
 }
 await page.setViewportSize({width:390,height:900});await page.goto(base+'/siparis',{waitUntil:'networkidle'});await page.getByRole('link',{name:/Lezzetleri keşfet/}).click();await page.locator('.merchant-category').first().waitFor();checks.push('real menu navigation, not a flattened mockup');
 for(const path of ['/api/merchant/snapshot','/api/llm/settings','/api/ai-menu/list']){const r=await ctx.request.get(base+path);assert.equal(r.status(),401);checks.push('private API protected '+path);}
 assert.deepEqual(requests.filter(r=>r.method!=='GET'&&r.method!=='HEAD'),[]);assert.deepEqual(errors,[]);checks.push('no business writes, camera opens or browser errors');
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,production:live,apiFixtures:!live,physicalDeviceTest:false,writesPerformed:false,release:release.version,at:new Date().toISOString()},null,2));console.log('VISUAL HANDOVER PASS '+checks.length);
}catch(e){console.error(e,log.slice(-1000));fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors,requests},null,2));if(browser)for(const c of browser.contexts())for(const p of c.pages())await p.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}finally{if(browser)await browser.close();if(server)server.kill('SIGTERM');}
