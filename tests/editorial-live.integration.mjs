// Production GET-only checks. No real order, visit, account, payment or model call.
import assert from 'node:assert/strict';import fs from 'node:fs';import {chromium as playwright} from 'playwright-core';import chromium from '@sparticuz/chromium';
const merchant='https://sariyerborekcisi.menugo.app',admin='https://www.menugo.app',out='public/qa/editorial-live',checks=[],errors=[];fs.mkdirSync(out,{recursive:true});let browser;
try{
 const release=await(await fetch(admin+'/release.json',{cache:'no-store',signal:AbortSignal.timeout(20000)})).json();assert.equal(release.version,'menugo-editorial-branding-20260919-r17');assert.equal(release.onlinePayments,false);assert.equal(release.automatedCourier,false);checks.push('production r17; provider gates unchanged');
 const cat=await(await fetch(merchant+'/api/catalogue',{signal:AbortSignal.timeout(20000)})).json();assert.equal(cat.items.length,76);assert.equal(cat.items.filter(p=>p.priceApproved&&p.priceMinor!==null).length,71);checks.push('76 catalogue records / 71 approved prices retained');
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const ctx=await browser.newContext();const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 for(const host of [merchant,admin]){
  for(const width of [320,360,390,768,1024,1440]){
   await page.setViewportSize({width,height:900});let response=await page.goto(host+'/bahcesehir',{waitUntil:'networkidle',timeout:30000});assert.equal(response.status(),200);await page.locator('.merchant-category').first().waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push(host+' responsive '+width);
   assert.equal(await page.locator('.merchant-category>img').count(),5);assert.equal(await page.locator('.editorial-pick').count(),4);
   const prices=await page.locator('.editorial-pick').evaluateAll(es=>es.map(e=>({id:e.getAttribute('data-product-id'),minor:e.querySelector('[data-price-minor]').getAttribute('data-price-minor')})));for(const p of prices)assert.equal(p.minor,cat.items.find(x=>x.id===p.id).priceMinor);checks.push(host+' artwork and actual prices '+width);
   assert.equal(await page.locator('.editorial-callout img').getAttribute('data-menugo-tone'),'dark');assert.equal(await page.locator('.merchant-powered img').getAttribute('data-menugo-tone'),'light');
   assert.deepEqual(await page.locator('.merchant-footer,.merchant-powered,.merchant-bottom').evaluateAll(es=>es.map(e=>getComputedStyle(e).backgroundColor)),['rgb(255, 255, 255)','rgb(255, 255, 255)','rgb(255, 255, 255)']);checks.push(host+' correct dark/light logo and white footer '+width);
   if(host===merchant&&(width===390||width===1440)){await page.screenshot({path:out+'/full-'+width+'.png',fullPage:true});}
  }
 }
 await page.goto(merchant+'/bahcesehir',{waitUntil:'networkidle'});await page.locator('.editorial-pick').first().click();await page.getByRole('dialog').waitFor();assert.equal(await page.locator('.editorial-product-visual img').count(),1);await page.getByLabel('Pencereyi kapat').click();checks.push('featured card opens live interactive detail');
 await page.getByRole('button',{name:'WhatsApp sipariş',exact:true}).click();await page.getByRole('dialog').waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes('Menüden ürün'));await page.getByLabel('Pencereyi kapat').click();checks.push('WhatsApp list opens without sending a message');
 await page.setViewportSize({width:1440,height:900});await page.goto(admin+'/giris',{waitUntil:'networkidle'});assert.equal(await page.locator('.login-powered img').getAttribute('data-menugo-tone'),'dark');checks.push('login dark brand');
 await page.goto(admin+'/',{waitUntil:'networkidle'});assert.equal(await page.locator('img[src="/media/menugo.png"]').count(),0);assert.ok(await page.locator('img[src="/media/menugo-transparent-r8.png"]').count()>0);checks.push('platform marketing uses canonical original logo');
 for(const path of ['/api/merchant/snapshot','/api/llm/settings','/api/ai-menu/list']){const r=await ctx.request.get(admin+path);assert.equal(r.status(),401,path);checks.push('private endpoint remains protected '+path);}
 await page.setViewportSize({width:390,height:844});await page.goto(merchant+'/siparis',{waitUntil:'networkidle'});assert.equal(await page.locator('input[type=email],input[type=password],.entry-code').count(),0);await page.getByRole('button',{name:/Kamerayı aç ve masa QR/}).waitFor();checks.push('code-free and camera entry intact; no camera opened');
 assert.deepEqual(errors,[]);checks.push('no browser errors');
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,production:true,apiMocked:false,dbWrites:false,providerCalls:0,release:release.version,at:new Date().toISOString()},null,2));console.log('EDITORIAL LIVE PASS',checks.length);
}catch(e){console.error(e);fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors},null,2));if(browser)for(const c of browser.contexts())for(const p of c.pages())await p.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}finally{if(browser)await browser.close();}
