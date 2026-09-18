// Actual QR decoding in browser, virtual camera only. All API reads/writes use local fixtures.
import assert from'node:assert/strict';import fs from'node:fs';import{spawn}from'node:child_process';
import{chromium as pw}from'playwright-core';import chromium from'@sparticuz/chromium';import QRCode from'qrcode';
const base='http://localhost:3417',out='public/qa/scanner',checks=[],errors=[];fs.mkdirSync(out,{recursive:true});
const id='11111111-1111-4111-8111-111111111111',tablePath='/masaya-katil?masa='+id,check='22222222-2222-4222-8222-222222222222';
const qr=await QRCode.toDataURL('https://sariyerborekcisi.menugo.app'+tablePath,{width:600,margin:4});
const png=await QRCode.toBuffer('https://sariyerborekcisi.menugo.app'+tablePath,{width:600,margin:4});
const invalidPng=await QRCode.toBuffer('https://evil.example/checkout',{width:400,margin:4});
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe']});let logs='',browser;
server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
async function session(mode='deny',width=390){
 const context=await browser.newContext({viewport:{width,height:844}});const metrics={requests:0,stops:0,posts:0};
 await context.exposeBinding('qrMetric',(_,name)=>{metrics[name]++;});
 await context.addInitScript(({mode,qr})=>{
  const make=async()=>{const c=document.createElement('canvas');c.width=640;c.height=640;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,640,640);if(mode==='qr'){const image=new Image();image.src=qr;await image.decode();ctx.drawImage(image,20,20,600,600);}const stream=c.captureStream(5);for(const t of stream.getTracks()){const stop=t.stop.bind(t);t.stop=()=>{window.qrMetric('stops');stop();};}return stream;};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async options=>{window.qrMetric('requests');if(options.audio!==false)throw Error('Audio requested');if(mode==='deny')throw new DOMException('denied','NotAllowedError');if(mode==='late')return new Promise(resolve=>window.resolveQrCamera=async()=>resolve(await make()));return make();}}});
 },{mode,qr});
 await context.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;if(req.method()!=='GET')metrics.posts++;
  let data;
  if(path==='/api/catalogue')data={items:[],name:'Meşhur Sarıyer Börekçisi Sandviç',branchName:'Bahçeşehir'};
  else if(path==='/api/merchant/product-information'||path==='/api/guest/visits')data=[];
  else if(path==='/api/table/'+id){data=req.method()==='GET'?{table:{tableId:id,tableName:'Masa 14',entryMode:'direct',enabled:true},request:{state:'idle'}}:{checkId:check};}
  else if(path==='/api/guest/'+check+'/cart')data={businessId:id,branchId:id,checkId:check,viewerUserId:id,channelId:id,revision:'1',currency:'TRY',status:'open',canMutate:true,totalMinor:'0',ownTotalMinor:'0',billMinor:'0',ownBillMinor:'0',lines:[],seat:1,tableName:'Masa 14'};
  else if(path.endsWith('/orders')||path.endsWith('/recommendations'))data=[];
  else if(path.endsWith('/feedback'))data={eligible:false,submitted:false};
  else if(path==='/api/merchant/availability')data={orderingEnabled:true,paused:false,estimatedMinutes:null};
  else if(path.includes('/realtime'))return route.fulfill({status:503,json:{}});
  else return route.fulfill({status:401,json:{error:'TEST_UNAUTHENTICATED'}});
  return route.fulfill({status:200,json:data});
 });
 await context.route('**/*.supabase.co/**',r=>r.fulfill({status:503,json:{}}));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return{context,page,metrics};
}
try{
 for(let n=0;n<100;n++){try{const r=await fetch(base+'/siparis');if(r.ok)break;}catch{}if(n===99)throw Error(logs);await new Promise(r=>setTimeout(r,300));}
 browser=await pw.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:true});
 for(const width of[320,390,768,1440]){
  const{context,page,metrics}=await session('deny',width);await page.goto(base+'/siparis',{waitUntil:'networkidle'});
  assert.equal(metrics.requests,0);checks.push('no camera on page load '+width);
  await page.getByRole('button',{name:'Kamerayı aç ve masa QR’sini tara'}).click();
  await page.getByRole('alert').filter({hasText:'Kamera izni verilmedi'}).waitFor();assert.equal(metrics.requests,1);checks.push('denial handled '+width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push('responsive '+width);
  assert.equal(metrics.posts,0);checks.push('no orders created by scanner '+width);
  if(width===390)await page.screenshot({path:out+'/camera-denied-390.png'});
  await page.getByLabel('QR tarayıcıyı kapat').click();assert.equal(await page.getByRole('dialog').count(),0);checks.push('close '+width);
  await context.close();
 }
 {
  const{context,page,metrics}=await session('qr');await page.goto(base+'/siparis',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Kamerayı aç ve masa QR’sini tara'}).click();
  await page.waitForURL('**/siparis?check='+check,{timeout:20000});assert.ok(metrics.requests===1&&metrics.stops>=1);checks.push('actual virtual-camera QR decoded, stream stopped, same-origin table route');assert.equal(metrics.posts,1);checks.push('only fixture join, no order POST');await context.close();
 }
 {
  const{context,page,metrics}=await session();await page.goto(base+'/siparis',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Kamerayı aç ve masa QR’sini tara'}).click();await page.getByRole('alert').waitFor();
  await page.getByLabel('QR fotoğrafı',{exact:true}).setInputFiles({name:'wrong.png',mimeType:'image/png',buffer:invalidPng});await page.getByRole('alert').filter({hasText:'bağlantısı değil'}).waitFor();assert.equal(new URL(page.url()).pathname,'/siparis');checks.push('foreign QR refused');
  await page.getByLabel('QR fotoğrafı',{exact:true}).setInputFiles({name:'table.png',mimeType:'image/png',buffer:png});await page.waitForURL('**/siparis?check='+check);checks.push('actual photo QR decode after permission denial');await context.close();
 }
 {
  const{context,page,metrics}=await session('blank');await page.goto(base+'/siparis',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Kamerayı aç ve masa QR’sini tara'}).click();await page.getByRole('button',{name:'Kamerayı durdur'}).waitFor();await page.getByRole('button',{name:'Kamerayı durdur'}).click();assert.ok(metrics.stops>=1);checks.push('manual pause stops tracks');await page.getByLabel('QR tarayıcıyı kapat').click();await context.close();
 }
 {
  const{context,page,metrics}=await session('late');await page.goto(base+'/siparis',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Kamerayı aç ve masa QR’sini tara'}).click();await page.waitForFunction(()=>typeof window.resolveQrCamera==='function');await page.getByLabel('QR tarayıcıyı kapat').click();await page.evaluate(()=>window.resolveQrCamera());await page.waitForTimeout(150);assert.ok(metrics.stops>=1);checks.push('late permission grant stopped after close');await context.close();
 }
 {
  const{context,page,metrics}=await session();await page.goto(base+tablePath,{waitUntil:'networkidle'});await page.waitForURL('**/siparis?check='+check);assert.equal(metrics.requests,0);assert.equal(await page.getByRole('button',{name:'Kamerayı aç ve masa QR’sini tara'}).count(),0);checks.push('existing valid table QR requires no second scan');await context.close();
 }
 assert.deepEqual(errors,[]);checks.push('no uncaught browser errors');fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,errors,physicalCamera:false,production:false,backend:'isolated route fixtures',source:'real jsQR decoder'},null,2));console.log('CAMERA QR PASS',checks.length);
}catch(e){fs.writeFileSync(out+'/failure.json',JSON.stringify({error:e.message,checks,errors,logs:logs.slice(-3000)},null,2));console.error(e);process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');}
