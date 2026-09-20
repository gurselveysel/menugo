// Real new React components inside a separate Next harness, controlled API/session responses.
// No provider calls, live app writes, live credentials or production state.
import {chromium as pw} from 'playwright-core';import chromium from '@sparticuz/chromium';import sharp from 'sharp';import {spawn} from 'node:child_process';import fs from 'node:fs';import assert from 'node:assert/strict';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','.test-build/photo-app','-p','3417'],{stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
const base='http://localhost:3417',out='test-results/photo-ui';fs.mkdirSync(out,{recursive:true});
const p='55555555-5555-4555-8555-555555555555',j='88888888-8888-4888-8888-888888888888',aid='99999999-9999-4999-8999-999999999999',pub='77777777-7777-4777-8777-777777777777';
const pic=await sharp({create:{width:320,height:220,channels:3,background:'#b5692b'}}).webp().toBuffer();
const preview={jobId:j,productId:p,productName:'Sarıyer Özel Sandviç',jobRevision:'3',sourceHash:'a'.repeat(64),imageHash:'b'.repeat(64),overlayVersion:'0',ready:true,reason:null,beforeUrl:null,sourceUrl:'/api/studio/source?id='+j,draftUrl:'/api/studio/image?id='+j};
const checks=[],errors=[],writes=[];let browser,applied=false,dropped=false,stale=false,pictures=true,currentOp=null;
const ok=(name,v)=>{assert.ok(v,name);checks.push(name);};
try{
 for(let i=0;i<80;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await pw.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const context=await browser.newContext({viewport:{width:390,height:900}});const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let v={};
  if(path==='/api/studio/source'||path==='/api/studio/image'||path.startsWith('/api/menu-photo/'))return route.fulfill({status:pictures?200:404,contentType:'image/webp',body:pictures?pic:Buffer.from('')});
  if(path==='/api/studio/photo-publication'){
   if(req.method()==='GET')v={scopeKey:p+':'+j+':'+aid,jobs:applied?[]:[{id:j,sourceName:'Sarıyer Özel Sandviç'}],history:applied?[{id:pub,action:'apply',createdAt:'2026-09-20T00:00:00Z',canUndo:true,receipt:{productId:p}}]:[]};
   else{const data=req.postDataJSON();writes.push(data);
    if(data.action==='preview')v={...preview,ready:!stale,reason:stale?'STUDIO_SOURCE_CHANGED':null};
    if(data.action==='apply'){assert.equal(data.confirmed,true);assert.equal(Object.keys(data).length,8);applied=true;currentOp=data.operationId;if(!dropped){dropped=true;return route.abort('failed');}v={publicationId:pub,operationId:data.operationId,action:'apply',productId:p,version:'1',cataloguePricesChanged:false};}
    if(data.action==='undo'){applied=false;v={publicationId:aid,operationId:data.operationId,action:'undo',productId:p,version:'2',cataloguePricesChanged:false};}
   }
  }else if(path==='/api/guest/visits'||path==='/api/merchant/product-information')v=[];
  else if(path==='/api/merchant/profile')v={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',phone:'0539 483 00 31',tagline:'Lezzetin en güzel hâli.',about:'',address:null,mapQuery:null,hours:[],whatsappEnabled:true,whatsappPhone:'905394830031',orderingEnabled:true};
  else if(path==='/api/catalogue')v={items:[{id:p,name:'Sarıyer Özel Sandviç',category:'sandvic',description:'Deneme açıklaması',quantityLabel:null,options:[],priceMinor:'18000',available:true,priceApproved:true,canOrder:true,...(applied?{photoUrl:'/api/menu-photo/'+p+'/'+aid}:{} )}]};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(v)});
 });
 await page.goto(base,{waitUntil:'networkidle'});const panel=page.locator('.studio-photo-publication');await panel.waitFor();ok('photo studio mount makes no mutation',writes.length===0);
 await page.getByLabel('İncelenmiş ürün fotoğrafı',{exact:true}).selectOption(j);await panel.getByRole('button',{name:'Fotoğrafı karşılaştır',exact:true}).click();await page.getByAltText('Orijinal ürün fotoğrafı').waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.studio-photo-preview img')].every(i=>i.complete&&i.naturalWidth>0));
 const apply=panel.getByRole('button',{name:'Fotoğrafı ürün kartına uygula',exact:true});ok('photo publish requires comparison confirmation',!await apply.isEnabled());
 for(const width of [320,360,390,768,1440]){await page.setViewportSize({width,height:900});ok('photo comparison no horizontal overflow '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await panel.screenshot({path:out+'/photo-'+width+'.png'});}
 await panel.getByRole('checkbox').check();await apply.click();await panel.getByRole('button',{name:'Aynı fotoğraf işlemini kontrol et'}).waitFor();
 ok('unknown result blocks another publication',!await apply.isEnabled());ok('unknown operation stored for reload',await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('menugo-photo-publication:'))));
 const before=writes.length;await page.reload({waitUntil:'networkidle'});await panel.getByRole('button',{name:'Aynı fotoğraf işlemini kontrol et'}).waitFor();ok('reload does not resend a pending publication',writes.length===before);
 await panel.getByRole('button',{name:'Aynı fotoğraf işlemini kontrol et'}).click();await panel.getByRole('status').filter({hasText:'İncelenen fotoğraf ürün kartına uygulandı.'}).waitFor();
 const attempts=writes.filter(x=>x.action==='apply');assert.deepEqual(attempts[0],attempts[1]);ok('lost response retries exact proof and operation ID',attempts.length===2&&attempts[1].operationId===currentOp);
 const customer=await context.newPage();customer.setDefaultTimeout(8000);await customer.goto(base+'/menu?urun='+p,{waitUntil:'domcontentloaded',timeout:15000});await customer.locator('.merchant-published-detail').waitFor();ok('reviewed photo displayed in actual customer product modal',await customer.locator('.merchant-published-detail').evaluate(i=>i.naturalWidth===320));ok('photo publication does not change price',await customer.locator('.merchant-detail-price').textContent().then(v=>v.includes('180')));
 await customer.getByRole('button',{name:'Pencereyi kapat'}).click();ok('product list renders reviewed photo',await customer.locator('.merchant-published-photo').count()===1);
 for(const width of [320,390,768,1440]){await customer.setViewportSize({width,height:900});ok('photo merchant responsive '+width,await customer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}await customer.screenshot({path:out+'/customer-photo-1440.png',fullPage:true});await customer.close();
 await panel.getByRole('button',{name:'Bu fotoğrafı geri al',exact:true}).click();ok('undo requires separate confirmation',writes.filter(x=>x.action==='undo').length===0);await panel.getByRole('button',{name:'Fotoğrafı geri almayı onayla',exact:true}).click();await panel.getByRole('status').filter({hasText:'Fotoğraf yayını geri alındı.'}).waitFor();ok('undo sends immutable publication reference only',Object.keys(writes.find(x=>x.action==='undo')).length===4);
 stale=true;await panel.getByLabel('İncelenmiş ürün fotoğrafı',{exact:true}).selectOption(j);await panel.getByRole('button',{name:'Fotoğrafı karşılaştır',exact:true}).click();await panel.getByRole('alert').waitFor();ok('stale source cannot publish',!await apply.isEnabled());
 stale=false;pictures=false;await panel.getByLabel('İncelenmiş ürün fotoğrafı',{exact:true}).selectOption('');await panel.getByLabel('İncelenmiş ürün fotoğrafı',{exact:true}).selectOption(j);await panel.getByRole('button',{name:'Fotoğrafı karşılaştır',exact:true}).click();await panel.getByRole('alert').waitFor();ok('failed comparison image blocks confirmation',!await panel.getByRole('checkbox').isEnabled());
 await context.unroute('**/api/**');
 for(const method of ['get','post']){const r=method==='get'?await page.request.get(base+'/api/studio/photo-publication'):await page.request.post(base+'/api/studio/photo-publication',{headers:{Origin:base},data:{action:'preview',jobId:j}});ok('actual route denies sessionless '+method,r.status()===401);}
 ok('React has no uncaught page errors',errors.length===0);
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,build:'isolated actual-component Next harness (NOT whole application)',apiFixtures:true,realProviderCalls:0,liveDatabaseWrites:0},null,2));console.log('PHOTO UI PASS',checks.length);
}catch(e){console.error('PHOTO UI FAILED',e.stack,errors,logs.slice(-1200));process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
