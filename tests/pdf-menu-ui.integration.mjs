// Real local PDF.js browser rendering; synthetic authorized API only. No real inference or customer writes.
import {PDFDocument,rgb,degrees} from 'pdf-lib';import sharp from 'sharp';import {chromium as playwright}from'playwright-core';import chromium from'@sparticuz/chromium';import{spawn}from'node:child_process';import fs from'node:fs';import assert from'node:assert/strict';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);let browser;const base='http://localhost:3417',checks=[],errors=[],posts=[];const id=n=>`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`;
const p={id:id(1),name:'Peynirli Börek',categoryKey:'kahvalti',subcategory:'Kahvaltı',description:'Peynirli',serving:'Porsiyon',options:[],priceMinor:'15000',available:true,updatedAt:'2026-09-19T00:00:00Z'};
const profile={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',phone:'0539 483 00 31',hours:[],version:'1'};
const catalogue={name:profile.name,branchName:'Bahçeşehir',orderingEnabled:true,items:[{...p,sourceId:'TIR-1',canOrder:true,priceApproved:true}]};
const data={role:'owner',tables:[],orders:[],deliveries:[],loyalty:[],customers:[],campaigns:[],outbox:[],rules:[],features:{},catalogue,receipts:[],products:[],settings:{},orderingSettings:{}};
let role='owner',configured=true,listJobs=[],job=null;const receipts=new Map();let failPage=0;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5KkAAAAASUVORK5CYII=','base64');
try{
 for(let i=0;i<90;i++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const ctx=await browser.newContext();const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await ctx.route('**/api/**',async route=>{const req=route.request(),u=new URL(req.url()),path=u.pathname;let v={};if(req.method()==='POST')posts.push({path,body:req.postDataJSON()});
 if(path==='/api/session')v={user:{id:id(100)}};
 else if(path==='/api/merchant/claim')v={role};
 else if(path==='/api/ops/console')v={...data,role};
 else if(path==='/api/merchant/snapshot')v={role,profile,staff:[],invites:[],requests:[]};
 else if(path==='/api/catalogue')v=catalogue;
 else if(path==='/api/merchant/profile')v=profile;
 else if(path==='/api/merchant/readiness')v={tableCount:0,staffCount:1,approvedProducts:1,unpricedProducts:0,orderingEnabled:true,profile};
 else if(path==='/api/merchant/table-policy')v={mode:'direct'};
 else if(path==='/api/merchant/table-requests')v=[];
 else if(path==='/api/merchant/service-dashboard')v={summary:{waitingAcceptance:0,preparing:0,ready:0,overdue:0},guestVisits:0,cancellations:[],visits:[]};
 else if(path==='/api/ai-menu/list')v={jobs:listJobs,categories:[{key:'kahvalti',title:'Kahvaltı'}],catalogue:[p],aiConfigured:configured,model:'TEST_PROVIDER',usedToday:1,dailyLimit:5};
 else if(path==='/api/ai-menu/upload'){
  const value=req.postDataJSON();assert.match(value.fileName,/sayfa [0-9]+\.jpg$/);assert.ok(value.operationId);const bytes=Buffer.from(value.data,'base64');const meta=await sharp(bytes).metadata();assert.equal(meta.format,'jpeg');assert.ok(meta.width*meta.height<=3000000);assert.ok(bytes.length<=2097152);
  if(!receipts.has(value.operationId))receipts.set(value.operationId,{id:id(20+receipts.size),duplicate:false});
  const receipt=receipts.get(value.operationId);
  if(failPage&&value.fileName.includes('sayfa '+failPage)){failPage=0;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'AI_RESULT_UNKNOWN'}})});}
  job={id:receipt.id,file_name:value.fileName,mime:'image/jpeg',status:'review',revision:'2',review_rows:[],catalogue_snapshot:[p],extracted:{warnings:[]},error_code:null,sourceAvailable:true,apply_receipt:null};listJobs=[{id:job.id,name:job.file_name,status:job.status,revision:job.revision,createdAt:'2026-09-20T00:00:00Z'}];v=receipt;
 }
 else if(path==='/api/ai-menu/snapshot')v=job;
 else if(path==='/api/ai-menu/source')return route.fulfill({status:200,contentType:'image/png',body:png});
 return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(v)});
 });
 fs.mkdirSync('public/qa/pdf-menu',{recursive:true});
 const createPdf=async(count=2)=>{const doc=await PDFDocument.create();for(let n=1;n<=count;n++){const pg=doc.addPage([595,842]);pg.drawRectangle({x:0,y:0,width:595,height:842,color:n===1?rgb(0.8,0.1,0.1):rgb(0.1,0.6,0.1)});pg.drawText('MENU PAGE '+n,{x:60,y:650,size:32});pg.drawText('Tea 25 TL / Sandwich 160 TL',{x:60,y:550,size:18});if(n===2)pg.setRotation(degrees(90));}return Buffer.from(await doc.save());};
 const sample=await createPdf();
 await page.goto(base+'/isletme',{waitUntil:'networkidle'});await page.locator('.sidebar nav button').filter({hasText:'AI Menü Stüdyosu'}).click();
 const section=page.locator('.pdf-menu-preparation');await section.getByRole('heading',{name:'PDF sayfalarını hazırla'}).waitFor();checks.push('PDF entry is in authorized menu studio');
 const before=posts.length;await page.getByLabel('PDF menü belgesi seç').setInputFiles({name:'menu.pdf',mimeType:'application/pdf',buffer:sample});await section.getByText('2 sayfa hazır.',{exact:false}).waitFor({timeout:30000});
 assert.equal(posts.length,before);checks.push('real multipage PDF rendered locally without upload or inference');
 assert.equal(await section.locator('img').count(),2);assert.ok(await section.locator('img').first().evaluate(i=>i.naturalWidth>500));checks.push('actual PDF pixels not mock renderer');
 const raster=await section.locator('img').first().evaluate(async i=>Array.from(new Uint8Array(await(await fetch(i.src)).arrayBuffer())));const raster2=await section.locator('img').nth(1).evaluate(async i=>Array.from(new Uint8Array(await(await fetch(i.src)).arrayBuffer())));
 const stat=await sharp(Buffer.from(raster)).stats();assert.ok(stat.channels[0].mean>stat.channels[1].mean*2);const dimensions=await sharp(Buffer.from(raster2)).metadata();assert.ok(dimensions.width>dimensions.height);checks.push('rendered colors and original page rotation preserved');
 assert.equal(await section.getByRole('button',{name:'0 sayfayı taslak analize gönder'}).isEnabled(),false);checks.push('no page auto-selected, review required');
 for(const width of [320,360,390,768,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push('PDF preparation responsive '+width);if([390,1440].includes(width))await section.screenshot({path:`public/qa/pdf-menu/pdf-${width}.png`});}
 await page.getByLabel('Sayfa 2 seç',{exact:true}).check();await section.getByRole('checkbox',{name:'Seçtiğim sayfaların okunurluğunu',exact:false}).check();await section.getByRole('button',{name:'1 sayfayı taslak analize gönder'}).click();await section.getByText('Seçilen sayfalar taslak olarak kaydedildi.',{exact:false}).waitFor();assert.equal(posts.filter(p=>p.path==='/api/ai-menu/upload').length,1);assert.match(posts.at(-1).body.fileName,/sayfa 2/);checks.push('only selected page uploads to existing draft endpoint with original page filename');
 assert.equal(posts.filter(p=>p.path==='/api/ai-menu/apply').length,0);checks.push('no automatic catalogue publication');
 await page.getByLabel('PDF menü belgesi seç').setInputFiles({name:'retry.pdf',mimeType:'application/pdf',buffer:sample});await section.getByText('2 sayfa hazır.',{exact:false}).waitFor();
 await page.getByLabel('Sayfa 1 seç',{exact:true}).check();await page.getByLabel('Sayfa 2 seç',{exact:true}).check();await section.getByRole('checkbox',{name:'Seçtiğim sayfaların okunurluğunu',exact:false}).check();failPage=1;
 const countBefore=posts.filter(p=>p.path==='/api/ai-menu/upload').length;await section.getByRole('button',{name:'2 sayfayı taslak analize gönder'}).click();await section.getByText('Aktarım durdu;', {exact:false}).waitFor();assert.equal(posts.filter(p=>p.path==='/api/ai-menu/upload').length,countBefore+1);checks.push('first uncertain response stops batch; no silent retry');
 await section.getByRole('button',{name:'Aynı sayfa işlemini yeniden dene'}).click();await section.getByText('Seçilen sayfalar taslak olarak kaydedildi.',{exact:false}).waitFor();const attempts=posts.filter(p=>p.path==='/api/ai-menu/upload').slice(countBefore);assert.deepEqual(attempts[0].body,attempts[1].body);assert.equal(attempts.length,3);checks.push('retry uses exact same id and image for ambiguous page then continues');
 configured=false;await page.getByRole('button',{name:'Yenile',exact:true}).last().click();await page.getByLabel('PDF menü belgesi seç').setInputFiles({name:'offline.pdf',mimeType:'application/pdf',buffer:sample});await section.getByText('2 sayfa hazır.',{exact:false}).waitFor();await page.getByLabel('Sayfa 1 seç',{exact:true}).check();await section.getByRole('checkbox',{name:'Seçtiğim sayfaların okunurluğunu',exact:false}).check();assert.equal(await section.getByRole('button',{name:'1 sayfayı taslak analize gönder'}).isEnabled(),false);checks.push('local preparation works without provider; inference fails closed');
 await page.getByLabel('PDF menü belgesi seç').setInputFiles({name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-invalid document')});await section.getByRole('alert').waitFor();assert.equal(await section.locator('img').count(),0);checks.push('invalid PDF cannot reuse old previews');
 await page.getByLabel('PDF menü belgesi seç').setInputFiles({name:'too-many.pdf',mimeType:'application/pdf',buffer:await createPdf(9)});await section.getByText('Tek PDF için 1–8 sayfa destekleniyor.',{exact:false}).waitFor();assert.equal(await section.locator('img').count(),0);checks.push('over-page-limit PDF rejected completely, no silent truncation');
 await ctx.unroute('**/api/**');const unauth=await page.request.get(base+'/api/ai-menu/list');assert.equal(unauth.status(),401);checks.push('real unauthenticated API remains denied');
 assert.deepEqual(errors,[]);checks.push('no unhandled React errors');fs.writeFileSync('public/qa/pdf-menu/results.json',JSON.stringify({passed:checks.length,checks,realPdfRenderer:true,syntheticApi:true,liveAiInference:false,productionWrites:false},null,2));console.log('PDF MENU UI PASS',checks.length);
}catch(e){console.error('PDF MENU UI FAILED',e.stack,errors,logs.slice(-5000));if(browser)for(const c of browser.contexts())for(const p of c.pages()){console.error((await p.locator('body').innerText()).slice(-4000));try{await p.screenshot({path:'public/qa/pdf-menu/failure.png',fullPage:true});}catch{}}process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
