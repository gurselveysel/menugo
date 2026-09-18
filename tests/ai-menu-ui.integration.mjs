// Synthetic authorized-role/data UI fixture. No real file is sent to an AI provider.
import {chromium as playwright}from'playwright-core';import chromium from'@sparticuz/chromium';import{spawn}from'node:child_process';import fs from'node:fs';import assert from'node:assert/strict';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);let browser;const base='http://localhost:3417',checks=[],errors=[],posts=[];const id=n=>`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`;
const p={id:id(1),name:'Peynirli Börek',categoryKey:'kahvalti',subcategory:'Kahvaltı',description:'Peynirli',serving:'Porsiyon',options:[],priceMinor:'15000',available:true,updatedAt:'2026-09-19T00:00:00Z'};
const profile={name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir',phone:'0539 483 00 31',hours:[],version:'1'};
const catalogue={name:profile.name,branchName:'Bahçeşehir',orderingEnabled:true,items:[{...p,sourceId:'TIR-1',canOrder:true,priceApproved:true}]};
const data={role:'owner',tables:[],orders:[],deliveries:[],loyalty:[],customers:[],campaigns:[],outbox:[],rules:[],features:{},catalogue,receipts:[],products:[],settings:{},orderingSettings:{}};
let role='owner',configured=true,listJobs=[],job=null;
const reviewRow={name:p.name,categoryKey:'kahvalti',description:p.description,serving:p.serving,priceMinor:'17550',options:[],sourcePage:1,sourceText:'Peynirli Börek 175,50 TL',warnings:[],action:'skip',targetId:p.id,expectedUpdatedAt:p.updatedAt,reviewed:false};
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
 else if(path==='/api/ai-menu/list')v={jobs:listJobs,categories:[{key:'kahvalti',title:'Kahvaltı'},{key:'sicak',title:'Sıcak içecekler'}],catalogue:[p],aiConfigured:configured,model:'TEST_PROVIDER',usedToday:1,dailyLimit:5};
 else if(path==='/api/ai-menu/upload'){const value=req.postDataJSON();assert.ok(value.operationId&&value.data);const duplicate=!!job;if(!job){job={id:id(20),file_name:value.fileName,mime:'image/png',status:'review',revision:'2',review_rows:[reviewRow,{...reviewRow,name:'Çay',categoryKey:'',priceMinor:null,targetId:null,expectedUpdatedAt:null,warnings:['Fiyat okunamadı']}],catalogue_snapshot:[p],extracted:{warnings:[]},error_code:null,sourceAvailable:true,apply_receipt:null};listJobs=[{id:job.id,name:job.file_name,status:job.status,revision:job.revision,createdAt:'2026-09-19T00:00:00Z'}];}v={id:job.id,duplicate};}
 else if(path==='/api/ai-menu/snapshot')v=job;
 else if(path==='/api/ai-menu/source')return route.fulfill({status:200,contentType:'image/png',body:png});
 else if(path==='/api/ai-menu/save'){const x=req.postDataJSON();assert.equal(x.revision,job.revision);job.review_rows=x.rows;job.revision=String(BigInt(job.revision)+1n);v={revision:job.revision};}
 else if(path==='/api/ai-menu/apply'){const x=req.postDataJSON();assert.equal(x.confirmed,true);assert.equal(x.rows[0].reviewed,true);assert.equal(x.rows[0].priceMinor,'17550');job={...job,status:'applied',apply_receipt:{changed:1}};v={changed:1};}
 else if(path==='/api/ai-menu/undo'){job={...job,status:'reverted'};v={status:'reverted'};}
 else if(path==='/api/ai-menu/delete-source'){job={...job,sourceAvailable:false};v={deleted:true};}
 return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(v)});
 });
 fs.mkdirSync('public/qa/ai-menu',{recursive:true});await page.goto(base+'/isletme',{waitUntil:'networkidle'});await page.locator('.sidebar nav button').filter({hasText:'AI Menü Stüdyosu'}).click();await page.getByRole('heading',{name:'Menünüzü çekin.'}).waitFor();checks.push('manager has live studio tab');
 await page.getByLabel('Menü dosyası seç').setInputFiles({name:'sentetik-menu.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'AI ile menü taslağı çıkar'}).click();await page.locator('.ai-review-row').first().waitFor();checks.push('photo file leads to persistent review with source');
 assert.equal(await page.getByLabel('İşlem 1',{exact:true}).inputValue(),'skip');assert.equal(await page.getByLabel('İşlem 2',{exact:true}).inputValue(),'skip');assert.equal(posts.filter(x=>x.path==='/api/ai-menu/apply').length,0);checks.push('AI output is not auto-selected or published');
 for(const width of [320,360,390,768,1024,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'studio width '+width);checks.push('source review fits '+width);if([390,1440].includes(width)){await page.locator('.ai-studio').screenshot({path:`public/qa/ai-menu/studio-${width}.png`});}}
 await page.getByRole('button',{name:'Eşleşenleri seç'}).click();assert.equal(await page.getByLabel('İşlem 1',{exact:true}).inputValue(),p.id);assert.equal(await page.getByLabel('İşlem 2',{exact:true}).inputValue(),'skip');checks.push('select matching targets does not include uncertain new rows');
 assert.equal(await page.getByRole('button',{name:'1 değişikliği menüye uygula'}).isEnabled(),false);checks.push('explicit source review required before apply');
 await page.getByRole('button',{name:'Taslağı kaydet'}).click();await page.getByText('Taslak kaydedildi. Canlı menü değişmedi.',{exact:true}).waitFor();assert.equal(posts.filter(x=>x.path==='/api/ai-menu/apply').length,0);checks.push('save draft is distinct from publication');
 await page.locator('.ai-ack input').check();await page.getByRole('button',{name:'1 değişikliği menüye uygula'}).click();await page.getByRole('heading',{name:'1 ürün değişikliği uygulandı'}).waitFor();checks.push('single reviewed batch sends exact string cents');
 await page.getByRole('button',{name:'Bu aktarımı geri al'}).click();await page.getByText('Geri alma tamamlandı.',{exact:false}).waitFor();checks.push('undo is explicit and retains history notice');
 await page.getByRole('button',{name:'Kaynak dosyayı sil'}).click();await page.getByText('Kaynak saklanmıyor.',{exact:true}).waitFor();checks.push('operator can remove private source independently');
 await page.getByLabel('Menü dosyası seç').setInputFiles({name:'sentetik-menu.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'AI ile menü taslağı çıkar'}).click();await page.getByText('Bu belge daha önce yüklendi.',{exact:false}).waitFor();checks.push('duplicate upload opens existing draft, no second apply');
 configured=false;await page.getByRole('button',{name:'Yenile',exact:true}).last().click();await page.getByText('AI bağlantısı henüz etkin değil.',{exact:false}).waitFor();checks.push('missing provider produces honest unavailable state');
 role='waiter';await page.goto(base+'/garson',{waitUntil:'networkidle'});assert.equal(await page.locator('.sidebar nav button').filter({hasText:'AI Menü Stüdyosu'}).count(),0);checks.push('waiter has no studio tab');
 await ctx.unroute('**/api/**');for(const path of ['/api/ai-menu/list','/api/ai-menu/source?id='+id(20),'/api/ai-menu/snapshot?id='+id(20)]){const response=await page.request.get(base+path);assert.equal(response.status(),401,path);checks.push('real Next route unauthenticated denied '+path.split('?')[0]);}
 assert.deepEqual(errors,[]);checks.push('no unhandled React errors');fs.writeFileSync('public/qa/ai-menu/results.json',JSON.stringify({passed:checks.length,checks,errors,syntheticApi:true,liveAiInference:false,productionWrites:false},null,2));console.log('AI MENU UI PASS',checks.length);
}catch(e){console.error('AI MENU UI FAILED',e.message,errors,logs.slice(-2500));if(browser)for(const c of browser.contexts())for(const p of c.pages()){console.error((await p.locator('body').innerText()).slice(-2500));try{await p.screenshot({path:'public/qa/ai-menu/failure.png',fullPage:true});}catch{}}process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
