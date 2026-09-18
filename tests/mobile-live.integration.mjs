// GET-only production layout checks; no table, customer, or order is created.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium as playwright} from 'playwright-core';
import chromium from '@sparticuz/chromium';
const out='public/qa/mobile-live',checks=[],errors=[];fs.mkdirSync(out,{recursive:true});let browser;
try{
 const release=await(await fetch('https://www.menugo.app/release.json',{cache:'no-store',signal:AbortSignal.timeout(20000)})).json();assert.equal(release.version,'menugo-mobile-qr-20260918-r11');checks.push('release r11 on production');
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 for(const base of ['https://sariyerborekcisi.menugo.app','https://www.menugo.app']){
  for(const width of [320,360,390,412,640,700,768,1024,1440]){
   await page.setViewportSize({width,height:900});const response=await page.goto(base+'/bahcesehir',{waitUntil:'networkidle',timeout:30000});assert.equal(response.status(),200);await page.locator('.merchant-category').first().waitFor();
   const metric=await page.evaluate(()=>{const logo=document.querySelector('.merchant-wordmark').getBoundingClientRect(),header=document.querySelector('.merchant-header').getBoundingClientRect();const controls=[...document.querySelector('.merchant-header').children].map(n=>n.getBoundingClientRect());const img=document.querySelector('.merchant-cover>img'),r=img.getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth,center:Math.abs(logo.left+logo.width/2-header.left-header.width/2),overlap:controls[0].right>controls[1].left||controls[1].right>controls[2].left,ratio:r.width/r.height,native:img.naturalWidth/img.naturalHeight};});
   assert.equal(metric.overflow,false);assert.equal(metric.overlap,false);assert.ok(metric.center<2);if(width<=700)assert.ok(Math.abs(metric.ratio-metric.native)<.02);checks.push(base+' '+width+': fits, centered, full mobile image');
   if(width===390&&base.includes('sariyerborekcisi'))await page.screenshot({path:out+'/menu-390.png'});
   await page.evaluate(()=>scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));await page.waitForTimeout(80);assert.ok(await page.evaluate(()=>document.querySelector('.merchant-footer>small').getBoundingClientRect().bottom<=document.querySelector('.merchant-bottom').getBoundingClientRect().top));checks.push(base+' '+width+': footer clears dock');
  }
 }
 for(const path of ['/siparis','/yardim','/garson']){await page.setViewportSize({width:390,height:844});const response=await page.goto('https://sariyerborekcisi.menugo.app'+path,{waitUntil:'networkidle'});assert.equal(response.status(),200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push(path+' live responsive');}
 const protectedResponse=await page.request.get('https://www.menugo.app/api/merchant/table-requests');assert.equal(protectedResponse.status(),401);checks.push('staff entry requests remain protected');assert.deepEqual(errors,[]);
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,production:true,writes:false,staffUiTestedWithFixtureSeparately:true},null,2));console.log('LIVE MOBILE PASS',checks.length);
}catch(e){console.error(e);fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors},null,2));process.exitCode=1;}finally{if(browser)await browser.close();}
