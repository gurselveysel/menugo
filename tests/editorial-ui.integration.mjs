// Real Next.js UI with controlled catalogue: no live business mutations or provider calls.
import {chromium as playwright} from 'playwright-core';import chromium from '@sparticuz/chromium';import {spawn} from 'node:child_process';import fs from 'node:fs';import assert from 'node:assert/strict';
const base='http://localhost:3417',out='public/qa/editorial-r17',checks=[],errors=[];fs.mkdirSync(out,{recursive:true});
let log='',browser;const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
const cat=JSON.parse(fs.readFileSync('data/catalog.json')).map((p,i)=>({id:'33333333-3333-4333-8333-'+String(i+1).padStart(12,'0'),sourceId:p[0],name:p[1],category:p[2],description:p[5],quantityLabel:p[7],options:p[6],priceMinor:p[4]===null?null:String(p[4]*100),available:true,priceApproved:p[4]!==null,canOrder:p[4]!==null}));
cat.find(p=>p.name==='Kova Waffle').priceMinor='25775';let rawRequests=[];
try{
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/giris')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}assert.ok(ready,log);
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
 const ctx=await browser.newContext();await ctx.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;rawRequests.push({p,method:route.request().method()});let data;
  if(p==='/api/catalogue')data={items:cat,orderingEnabled:true};
  else if(p==='/api/merchant/profile')data={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',tagline:'Lezzetin en güzel hâli.',phone:'0539 483 00 31',hours:[],address:null,about:'Menüden çeşitler.',whatsappEnabled:true,whatsappPhone:'905394830031',orderingEnabled:true,updatedAt:'2026-09-17T12:00:00Z'};
  else if(p==='/api/guest/visits'||p==='/api/merchant/product-information')data=[];
  else if(p==='/api/merchant/availability')data={orderingEnabled:true,paused:false,estimatedMinutes:null};
  else if(p==='/api/merchant/quote')data={totalMinor:'25775',url:'https://wa.me/905394830031?text=test'};
  else{await route.fulfill({status:401,contentType:'application/json',body:'{"error":"UNAUTHENTICATED"}'});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 for(const width of [320,360,390,700,768,1024,1440]){
  await page.setViewportSize({width,height:920});await page.goto(base+'/bahcesehir',{waitUntil:'networkidle'});await page.locator('.merchant-category').first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push('menu fits '+width);
  assert.equal(await page.locator('.merchant-category').count(),6);assert.equal(await page.locator('.merchant-category>img').count(),5);checks.push('only actual categories with relevant artwork '+width);
  assert.equal(await page.locator('.editorial-pick').count(),4);assert.equal(await page.locator('.editorial-pick strong[data-price-minor="25775"]').count(),1);checks.push('real text/live price featured cards '+width);
  const colors=await page.locator('.merchant-footer,.merchant-powered,.merchant-bottom').evaluateAll(es=>es.map(e=>getComputedStyle(e).backgroundColor));assert.deepEqual(colors,['rgb(255, 255, 255)','rgb(255, 255, 255)','rgb(255, 255, 255)']);checks.push('white footer retained '+width);
  assert.equal(await page.locator('.editorial-callout img[data-menugo-tone=dark]').getAttribute('src'),'/media/menugo-on-dark-r17.png');assert.equal(await page.locator('.merchant-powered img[data-menugo-tone=light]').getAttribute('src'),'/media/menugo-transparent-r8.png');checks.push('context-specific logos '+width);
  if(width===390||width===1440){await page.screenshot({path:out+'/menu-'+width+'.png',fullPage:true});}
 }
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/bahcesehir',{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'Kova Waffle · Ürünü incele',exact:true}).click();await page.getByRole('dialog').waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes('257'));assert.equal(await page.locator('.editorial-product-visual img').count(),1);checks.push('featured card opens functional product detail');await page.getByRole('button',{name:'WhatsApp sipariş listeme ekle'}).click();
 await page.getByRole('button',{name:'WhatsApp sipariş',exact:true}).click();await page.locator('.merchant-quote-total strong').getByText(/257/).waitFor();assert.equal(await page.getByRole('link',{name:/WhatsApp’ta/}).getAttribute('href'),'https://wa.me/905394830031?text=test');checks.push('WhatsApp uses existing server quote, never embedded mockup prices');await page.getByLabel('Pencereyi kapat').click();
 await page.locator('.menu-tools summary').click();await page.getByLabel('Ürün sıralaması').selectOption('price-asc');assert.equal(await page.locator('.merchant-product').count(),76);checks.push('all current catalogue products remain in filters');
 await page.locator('.merchant-tabs button').last().click();await page.locator('.merchant-about').waitFor();assert.equal(await page.locator('.merchant-about .merchant-gallery button').count(),2);checks.push('about and original store photos preserved');
 for(const mode of ['light','dark']){await page.emulateMedia({colorScheme:mode});await page.setViewportSize({width:1440,height:900});await page.goto(base+'/giris',{waitUntil:'networkidle'});assert.equal(await page.locator('.login-powered img').getAttribute('data-menugo-tone'),'dark');const s=await page.locator('.login-powered').evaluate(e=>getComputedStyle(e).backgroundColor);assert.equal(s,'rgba(0, 0, 0, 0)');checks.push('dark login logo independent of OS theme '+mode);}
 for(const route of ['/siparis','/hesabim','/garson','/mutfak','/kasa','/isletme','/yardim','/menu-yazdir']){await page.setViewportSize({width:360,height:900});await page.goto(base+route,{waitUntil:'networkidle'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('img[src="/media/menugo.png"]').count(),0);checks.push('shared interface preserved '+route);}
 assert.deepEqual(errors,[]);checks.push('no uncaught UI errors');
 // The unchanged role gates POST session/claim; fixtures reject both with 401.
 const allowedPostPaths=new Set(['/api/merchant/quote','/api/session','/api/merchant/claim']);
 assert.deepEqual(rawRequests.filter(x=>x.method==='POST'&&!allowedPostPaths.has(x.p)),[]);checks.push('only fixture quote and denied role-bootstrap POSTs; no order/payment/customer mutation');
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,apiFixtures:true,physicalDeviceTest:false,productionWrites:false},null,2));console.log('EDITORIAL UI PASS',checks.length);
}catch(e){console.error('EDITORIAL UI FAIL',e.message,errors,log.slice(-1200));if(browser)for(const ctx of browser.contexts())for(const p of ctx.pages())await p.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors,rawRequests},null,2));process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
