// Real rendering/QR/PNG with authenticated API doubles. No model/social/production writes.
import {chromium as pw} from 'playwright-core';import chromium from '@sparticuz/chromium';import {spawn} from 'node:child_process';import fs from 'node:fs';import assert from 'node:assert/strict';import sharp from 'sharp';import jsQR from 'jsqr';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});let logs='';server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
const base='http://localhost:3417',out='public/qa/campaign',checks=[],errors=[],posts=[];let browser,conflict=false,downloads=0;
const pid='55555555-5555-4555-8555-555555555555',second='66666666-6666-4666-8666-666666666666';
const snap={productId:pid,name:'Sarıyer Özel Sandviç',description:'Katalogdaki ürün açıklaması.',quantityLabel:'Porsiyon',options:[],priceMinor:'18000',businessName:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',caption:'Sarıyer Özel Sandviç\nKatalogdaki ürün açıklaması.',version:'a'.repeat(64),checkedAt:'2026-09-19T12:00:00Z'};
fs.mkdirSync(out,{recursive:true});
try{
 for(let i=0;i<120;i++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 browser=await pw.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('download',()=>downloads++);
 await context.route('**/api/campaigns/**',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.pathname.endsWith('catalogue'))return route.fulfill({json:{products:[{...snap, id:pid,available:true},{id:second,name:'Çay',priceMinor:'2500',available:true}],drafts:[]}});
  if(url.pathname.endsWith('publication-status'))return route.fulfill({json:{enabled:false,dispatchConfigured:false,items:[]}});
  if(url.pathname.endsWith('preview')){const id=url.searchParams.get('productId');if(id===pid)await new Promise(r=>setTimeout(r,50));return route.fulfill({json:id===second?{...snap,productId:second,name:'Çay'}:snap});}
  if(url.pathname.endsWith('export')){const data=req.postDataJSON();posts.push(data);if(conflict)return route.fulfill({status:409,json:{error:{code:'CAMPAIGN_SOURCE_CHANGED'}}});assert.equal(data.expectedVersion,snap.version);assert.ok(!('priceMinor'in data));return route.fulfill({json:{snapshot:snap,caption:'Onaylı ürün ve güncel fiyat: 180,00 TL',format:data.format}});}
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(base+'/isletme/kampanya',{waitUntil:'networkidle'});
 await page.getByRole('checkbox').waitFor();await page.waitForFunction(()=>{const c=document.querySelector('canvas');return c&&getComputedStyle(c).visibility==='visible';});
 assert.equal(await page.getByRole('button',{name:'PNG görselini indir'}).isEnabled(),false);checks.push('download requires explicit operator review');
 assert.equal(await page.getByText('Şirket sosyal yayın isteğini henüz açmadı. Bu durum görsel indirmenizi engellemez.').isVisible(),true);checks.push('social publication stays fail closed when company gate disabled');
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:940});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${out}/campaign-${width}.png`,fullPage:true});checks.push('responsive '+width);}
 for(const [format,height] of [['post',1350],['story',1920]]){
  await page.getByLabel('Boyut',{exact:true}).selectOption(format);await page.waitForFunction(()=>getComputedStyle(document.querySelector('canvas')).visibility==='visible');await page.getByRole('checkbox').check();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'PNG görselini indir'}).click();const d=await downloaded;const path=`${out}/sample-${format}.png`;await d.saveAs(path);const m=await sharp(path).metadata();assert.equal(m.width,1080);assert.equal(m.height,height);checks.push(format+' PNG dimensions and successful save');
  const raw=await sharp(path).extract({left:78,top:height-332+44,width:220,height:220}).ensureAlpha().raw().toBuffer();const decoded=jsQR(new Uint8ClampedArray(raw),220,220);assert.ok(decoded);assert.equal(decoded.data,'https://sariyerborekcisi.menugo.app/bahcesehir?urun='+pid);checks.push(format+' actual exported QR decodes exact public product URL');
  const pixel=await sharp(path).extract({left:10,top:height-10,width:1,height:1}).removeAlpha().raw().toBuffer();assert.deepEqual([...pixel],[255,255,255]);checks.push(format+' footer actually white');
 }
 conflict=true;await page.getByRole('checkbox').check();const before=downloads;await page.getByRole('button',{name:'PNG görselini indir'}).click();await page.getByRole('alert').waitFor();await page.waitForTimeout(250);assert.equal(downloads,before);assert.equal(await page.getByRole('checkbox').isChecked(),false);checks.push('stale source blocks download and clears approval');
 conflict=false;await page.getByLabel('Ürün',{exact:true}).selectOption(second);await page.waitForTimeout(100);await page.getByLabel('Ürün',{exact:true}).selectOption(pid);await page.getByLabel('Ürün',{exact:true}).selectOption(second);await page.waitForTimeout(500);assert.equal(await page.locator('canvas').getAttribute('aria-label'),'Çay — paylaşım görseli');checks.push('late prior selection cannot overwrite active preview');
 assert.equal(await page.getByRole('checkbox').isChecked(),false);checks.push('changing product clears previous approval');
 await context.unroute('**/api/campaigns/**');
 for(const action of ['catalogue','preview','publication-status']){const r=await page.request.get(base+'/api/campaigns/'+action);assert.equal(r.status(),401);checks.push('real unauthenticated '+action+' denied');}
 for(const action of ['export','publication-request','publication-cancel']){const r=await page.request.post(base+'/api/campaigns/'+action,{headers:{Origin:base},data:{}});assert.equal(r.status(),401);checks.push('real unauthenticated '+action+' denied');}
 assert.deepEqual(errors,[]);assert.ok(posts.every(p=>Object.keys(p).sort().join(',')==='expectedVersion,format,jobId,productId'));checks.push('no prices or private context in export intent');
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,apiDoubles:true,realQrDecode:true,pngDownloads:downloads,modelCalls:0,socialPublishes:0,catalogueWrites:0,errors},null,2));console.log('CAMPAIGN UI PASS',checks.length);
}catch(e){console.error('CAMPAIGN UI FAILED',e.message,errors,logs.slice(-2500));process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
