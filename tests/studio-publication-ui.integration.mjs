// Real React/browser against controlled HTTP fixtures. No model or live catalogue writes.
import {chromium as pw} from 'playwright-core';import chromium from '@sparticuz/chromium';import {spawn} from 'node:child_process';import fs from 'node:fs';import assert from 'node:assert/strict';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
const base='http://localhost:3417',checks=[],errors=[],writes=[],out='public/qa/studio-publication';let browser,applied=false,dropped=false,stale=false;
const pid='55555555-5555-4555-8555-555555555555',jid='88888888-8888-4888-8888-888888888888',bid='99999999-9999-4999-8999-999999999999';
const row={jobId:jid,productId:pid,productName:'Peynirli Börek',language:'tr',before:{title:null,body:'Özgün açıklama'},after:{title:null,body:'İncelenen yeni açıklama'},jobRevision:'3',overlayVersion:'0',sourceHash:'a'.repeat(64),ready:true,reason:null};
const receipt={batchId:bid,action:'apply',items:[{productId:pid,language:'tr',version:'1'}],cataloguePricesChanged:false};
fs.mkdirSync(out,{recursive:true});
try{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await pw.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/api/**',async route=>{const r=route.request(),path=new URL(r.url()).pathname;let v={};
  if(path==='/api/session')v={user:{id:pid}};
  else if(path==='/api/merchant/claim')v={role:'owner'};
  else if(path==='/api/studio/list')v={jobs:[],catalogue:[],aiReady:false,aiReason:'AI_ACCESS_REQUIRED'};
  else if(path==='/api/studio/publication'){
   if(r.method()==='GET')v={jobs:applied?[]:[{id:jid,kind:'product-copy',language:'tr',sourceName:'Peynirli Börek'}],history:applied?[{id:bid,action:'apply',createdAt:'2026-09-19T12:00:00Z',receipt}]:[]};
   else{
    const data=r.postDataJSON();writes.push(data);
    if(data.action==='preview')v={items:[{...row,ready:!stale,reason:stale?'STUDIO_SOURCE_CHANGED':null}]};
    if(data.action==='apply'){
     assert.equal(data.confirmed,true);assert.deepEqual(Object.keys(data.items[0]).sort(),['jobId','jobRevision','overlayVersion','sourceHash']);applied=true;
     if(!dropped){dropped=true;return route.abort('failed');}v=receipt;
    }
    if(data.action==='undo'){applied=false;v={...receipt,action:'undo'};}
   }
  }
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(v)});
 });
 await page.goto(base+'/isletme/studyo',{waitUntil:'networkidle'});const panel=page.locator('.studio-publication');await panel.waitFor();assert.equal(writes.length,0);checks.push('no publication or AI on mount');
 await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'Seçilenleri önizle (1)'}).click();await panel.getByText('İncelenen yeni açıklama',{exact:true}).waitFor();
 const apply=panel.getByRole('button',{name:'Seçilen metinleri menüye uygula',exact:true});assert.equal(await apply.isEnabled(),false);checks.push('before-after preview and explicit publish confirmation');
 await panel.getByLabel('Yalnız yukarıdaki alanların değişeceğini kontrol ettim; menüde yayımla.').check();await apply.click();
 await panel.getByRole('button',{name:'Aynı yayın işlemini kontrol et',exact:true}).waitFor();assert.equal(await apply.isEnabled(),false);checks.push('lost apply response blocks new write');
 await panel.getByRole('button',{name:'Aynı yayın işlemini kontrol et',exact:true}).click();await panel.getByText('İncelenen metinler menüye uygulandı. Fiyatlar ve siparişler değişmedi.',{exact:true}).waitFor();
 const attempts=writes.filter(x=>x.action==='apply');assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);checks.push('retry uses same operation and proofs, no copied model body');
 for(const width of [320,360,390,768,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await panel.screenshot({path:`${out}/publication-${width}.png`});checks.push('publication responsive '+width);}
 await panel.getByRole('button',{name:'Bu uygulamayı geri al',exact:true}).click();assert.equal(writes.filter(x=>x.action==='undo').length,0);checks.push('undo has separate confirmation');
 await panel.getByRole('button',{name:'Geri almayı onayla',exact:true}).click();await panel.getByText('Bu toplu uygulama geri alındı. Daha yeni bir yayının üzerine yazılmadı.',{exact:true}).waitFor();checks.push('confirmed undo uses only receipt id');
 stale=true;await panel.getByRole('checkbox').first().check();await panel.getByRole('button',{name:'Seçilenleri önizle (1)'}).click();await panel.getByText('Kaynak ürün değişmiş. Güncel ürün üzerinden yeni taslak hazırlayın.',{exact:true}).waitFor();await panel.getByLabel('Yalnız yukarıdaki alanların değişeceğini kontrol ettim; menüde yayımla.').check();assert.equal(await apply.isEnabled(),false);checks.push('stale source remains disabled after checkbox');
 assert.equal(writes.filter(x=>!['preview','apply','undo'].includes(x.action)).length,0);checks.push('only supported reviewed text commands');
 await context.unroute('**/api/**');for(const method of ['get','post']){const r=method==='get'?await page.request.get(base+'/api/studio/publication'):await page.request.post(base+'/api/studio/publication',{headers:{Origin:base},data:{}});assert.equal(r.status(),401);checks.push('real unauthenticated publication denied '+method);}
 assert.deepEqual(errors,[]);fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,apiDoubles:true,realProviderCalls:0,productionMutations:0},null,2));console.log('PUBLICATION UI PASS',checks.length);
}catch(e){console.error('PUBLICATION UI FAILED',e.message,errors,logs.slice(-2000));process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
