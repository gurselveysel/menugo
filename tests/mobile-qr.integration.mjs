// Browser layout and waiter controls against actual Next components.
// API fixtures are isolated; no production table/order/account/message is created.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium as playwright} from 'playwright-core';
import chromium from '@sparticuz/chromium';
const base='http://localhost:3417',out='public/qa/mobile-qr';
fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[],writes=[];const ok=(name,value)=>{assert.ok(value,name);checks.push(name);};
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe']});
let logs='',browser;server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
const id=n=>`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`;
const profile={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',phone:'0539 483 00 31',tagline:'Lezzetin en güzel hâli.',about:'Sandviç, kahvaltı, waffle ve kahve.',address:null,mapQuery:null,hours:[],whatsappEnabled:true,whatsappPhone:'905394830031',orderingEnabled:true,updatedAt:'2026-09-17T12:00:00Z'};
const catalogue={orderingEnabled:true,items:['sandvic','kahvalti','tatli','sicak'].map((c,i)=>({id:id(i+1),name:['Klasik Sandviç','Kahvaltı','Waffle','Çay'][i],category:c,description:'Test ürün.',quantityLabel:null,options:[],priceMinor:'15000',priceApproved:true,available:true,canOrder:true}))};
const tables=[{id:id(10),name:'Masa 14',checkId:id(20),status:'open',revision:'1'},{id:id(11),name:'Bahçe · Uzun İsimli Masa 125',checkId:null,status:'empty',revision:'0'}];
const state={role:'waiter',tables,orders:[],deliveries:[],customers:[],loyalty:[],campaigns:[],outbox:[],rules:[],receipts:[],products:[],features:{payments_enabled:false},catalogue};
let requests=[{id:id(30),tableId:tables[0].id,tableName:'Masa 14',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString()}];
try{
 for(let n=0;n<100;n++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('**/*.supabase.co/**',r=>r.abort());
 await context.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;let data=[];
  if(req.method()==='POST')writes.push({path,body:req.postDataJSON()});
  if(path==='/api/catalogue')data=catalogue;
  else if(path==='/api/merchant/profile')data=profile;
  else if(path==='/api/session')data={userId:id(40)};
  else if(path==='/api/merchant/claim')data={role:'waiter'};
  else if(path==='/api/ops/console')data=state;
  else if(path==='/api/merchant/service-dashboard')data={summary:{waitingAcceptance:0,overdue:0,preparing:0,ready:0},cancellations:[],guestVisits:0,guestOrders:0};
  else if(path==='/api/merchant/table-policy')data={mode:'direct'};
  else if(path==='/api/merchant/table-requests')data=requests;
  else if(path==='/api/merchant/table-decision'){const b=req.postDataJSON();assert.equal(b.code,'4821');assert.equal(b.id,id(30));assert.equal(b.approve,true);requests=[];data={state:'approved'};}
  else if(path==='/api/ops/start-table')data={checkId:tables[0].checkId,token:'a'.repeat(64),expiresInSeconds:600};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const noOverflow=async()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.body.scrollWidth<=innerWidth);
 for(const width of [320,360,390,412,480,640,700,768,900,1024,1440]){
  await page.setViewportSize({width,height:900});await page.goto(base+'/bahcesehir',{waitUntil:'networkidle'});
  await page.locator('.merchant-category').first().waitFor();
  ok('menu no overflow '+width,await noOverflow());
  const metrics=await page.evaluate(()=>{const h=document.querySelector('.merchant-header').getBoundingClientRect();const logo=document.querySelector('.merchant-wordmark').getBoundingClientRect();const controls=[...document.querySelector('.merchant-header').children].map(x=>x.getBoundingClientRect());const img=document.querySelector('.merchant-cover>img');const hero=img.getBoundingClientRect();return{center:Math.abs((logo.left+logo.width/2)-(h.left+h.width/2)),inside:controls.every(x=>x.left>=h.left&&x.right<=h.right),noOverlap:controls[0].right<=controls[1].left&&controls[1].right<=controls[2].left,heroRatio:hero.width/hero.height,nativeRatio:img.naturalWidth/img.naturalHeight,bodyClipped:getComputedStyle(document.body).overflowX==='hidden',htmlClipped:getComputedStyle(document.documentElement).overflowX==='hidden'};});
  ok('centered independent header columns '+width,metrics.center<2&&metrics.inside&&metrics.noOverlap);
  ok('not masking overflow '+width,!metrics.bodyClipped&&!metrics.htmlClipped);
  if(width<=700)ok('whole storefront not cropped '+width,Math.abs(metrics.heroRatio-metrics.nativeRatio)<.02);
  await page.screenshot({path:`${out}/menu-top-${width}.png`});
  await page.locator('.merchant-footer').scrollIntoViewIfNeeded();await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(200);
  const gap=await page.evaluate(()=>document.querySelector('.merchant-bottom').getBoundingClientRect().top-document.querySelector('.merchant-footer>small').getBoundingClientRect().bottom);
  ok('footer stays above fixed dock '+width,gap>=0);
  if(width===390)await page.screenshot({path:out+'/footer-390.png'});
 }
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/bahcesehir',{waitUntil:'networkidle'});
 await page.getByLabel('Arayüz dili').selectOption('en');ok('English header and actions fit',await noOverflow());
 await page.getByLabel('Arayüz dili').selectOption('tr');
 await page.locator('.merchant-category').first().click();await page.waitForTimeout(700);
 ok('sticky tabs do not cover search',await page.evaluate(()=>document.querySelector('.merchant-search').getBoundingClientRect().top>=document.querySelector('.merchant-tabs').getBoundingClientRect().bottom-2));
 await page.getByLabel('Menüde ara').fill('Test');ok('search field uses readable 16px',await page.getByLabel('Menüde ara').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=16));
 await page.goto(base+'/garson',{waitUntil:'networkidle'});await page.locator('.table-card').first().waitFor();
 ok('waiter not shown admin tabs',await page.locator('.sidebar nav').getByText('Personel & Yetkiler').count()===0);
 ok('one table per mobile row',await page.locator('.table-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length===1));
 const writesBefore=writes.length;
 await page.getByRole('button',{name:'Masa 14 · QR göster',exact:true}).click();
 const dialog=page.locator('dialog.table-qr-dialog');const qr=dialog.locator('img.table-qr-image');await qr.waitFor();
 ok('QR display did not create check or request',writes.length===writesBefore);
 ok('native modal is top-layer',await dialog.evaluate(e=>e.matches(':modal')));
 const permanentUrl='https://sariyerborekcisi.menugo.app/masaya-katil?masa='+tables[0].id;
 ok('QR and clipboard target existing secured entry',await dialog.getByLabel('Masa katılım bağlantısı').inputValue()===permanentUrl);
 ok('permanent QR has download and print',await dialog.getByRole('link',{name:'QR’yi kaydet'}).count()===1&&await dialog.getByRole('button',{name:'Masa kartını yazdır'}).count()===1);
 await qr.screenshot({path:out+'/permanent-qr-390.png'});
 await dialog.getByRole('button',{name:'Müşteriye göster · Tam ekran'}).click();
 for(const [width,height] of [[320,568],[390,844],[844,390],[768,1024],[1440,900]]){
  await page.setViewportSize({width,height});
  ok('full-screen QR stays in viewport '+width+'x'+height,await dialog.evaluate(d=>{const r=d.getBoundingClientRect();const q=d.querySelector('img').getBoundingClientRect();const close=d.querySelector('.table-qr-close').getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&q.width>=120&&q.left>=0&&q.right<=innerWidth&&close.top>=0&&close.bottom<=innerHeight;}));
  if(width===390)await page.screenshot({path:out+'/waiter-show-390.png'});
 }
 await page.setViewportSize({width:390,height:844});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 ok('Escape restores body scroll and trigger focus',await page.evaluate(()=>document.body.style.overflow!=='hidden'&&document.activeElement?.getAttribute('aria-label')==='Masa 14 · QR göster'));
 ok('default waiter panel has no guest-code work',await page.locator('.table-access-card').count()===0&&await page.getByLabel('Masa 14 katılım kodu').count()===0);
 await page.locator('.table-card').first().getByRole('button',{name:'Ziyaret QR’sini oluştur'}).click();
 await page.getByRole('button',{name:'Ziyaret QR’sini göster'}).click();await qr.waitFor();
 ok('visit QR has correct short-lived token',(await dialog.getByLabel('Masa katılım bağlantısı').inputValue()).endsWith('token='+'a'.repeat(64)));
 ok('visit QR not offered for print/download',await dialog.getByRole('link',{name:'QR’yi kaydet'}).count()===0&&await dialog.getByRole('button',{name:'Masa kartını yazdır'}).count()===0);
 await page.screenshot({path:out+'/visit-qr-390.png'});await dialog.getByRole('button',{name:'QR penceresini kapat'}).click();
 await page.goto(base+'/siparis',{waitUntil:'networkidle'});ok('customer gets concrete waiter instructions',await page.getByText(/QR göster/).count()>0);ok('no customer password requested',await page.locator('input[type=password]').count()===0);
 await page.goto(base+'/yardim',{waitUntil:'networkidle'});ok('help explains actual QR controls',await page.getByRole('heading',{name:'Garson telefondan QR’yi nasıl gösterir?'}).count()===1);
 assert.deepEqual(errors,[]);ok('no unhandled React/browser errors',true);
 fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,apiFixtures:true,productionWrites:false},null,2));console.log('MOBILE QR PASS',checks.length);
}catch(e){console.error('MOBILE QR FAIL',e.message,errors,logs.slice(-1500));if(browser){for(const c of browser.contexts())for(const p of c.pages()){await p.screenshot({path:out+'/failure.png'}).catch(()=>{});console.error((await p.locator('body').innerText()).slice(-2000));}}fs.writeFileSync(out+'/failure.json',JSON.stringify({message:e.message,checks,errors},null,2));process.exitCode=1;}
finally{if(browser)await browser.close();server.kill('SIGTERM');}
