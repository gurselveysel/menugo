// Real Next routes, browser HttpOnly cookies and SQL transactions/constraints.
// Synthetic local PostgREST/Auth/Realtime transport. No production records/messages.
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';import {chromium as playwright} from 'playwright-core';import chromium from '@sparticuz/chromium';
const results=[],errors=[];const ok=(name,value=true)=>{assert.ok(value,name);results.push(name);};const db=new PGlite();const q=async(s,a=[])=>(await db.query(s,a)).rows;let transport,server,browser;let logs='';let calls=[];const base='http://localhost:3417',b='11111111-1111-4111-8111-111111111111',br='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333331';const uid='55555555-5555-4555-8555-555555555555';const table='99999999-9999-4999-8999-999999999999';let queue=Promise.resolve();const channels=[];
async function anon(){await db.exec('reset role');await q("select set_config('request.jwt.claims','{}',false)");await db.exec('set role anon');}
async function auth(){await db.exec('reset role');await q("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})]);await db.exec('set role authenticated');}
try{
 const fixture=fs.readFileSync('tests/sql.integration.mjs','utf8');const ddl=fixture.split('await db.exec(`')[1].split('`);')[0];await db.exec(ddl);
 await q('insert into auth.users values($1,$2,now())',[owner,'guest-test-owner@example.test']);
 await q('insert into public.businesses values($1,$2,$3)',[b,'sariyerborekcisi','Meşhur Sarıyer Börekçisi Sandviç']);await q('insert into public.branches values($1,$2,$3,$4,$5)',[br,b,'bahcesehir','Bahçeşehir','0539 483 00 31']);
 await q("insert into public.menu_items(id,business_id,branch_id,source_id,name,source_price,approved_price,price_approved) values($1,$2,$3,'GUEST-TEST','Misafir Sandviç',150,150,true)",[uid,b,br]);
 for(const f of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));
 await q("insert into ops.branch_staff(business_id,branch_id,user_id,role,active) values($1,$2,$3,'owner',true)",[b,br,owner]);
 await q('update ops.branch_settings set ordering_enabled=true,dine_in_enabled=true where branch_id=$1',[br]);await q("insert into ops.dining_tables(id,business_id,branch_id,table_code,display_name)values($1,$2,$3,'14','Masa 14')",[table,b,br]);await auth();const invitation=(await q('select ops.start_table($1,$2,$3) as j',[b,br,table]))[0].j;const cid=invitation.checkId;await anon();
 transport=createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{queue=queue.then(async()=>{try{const path=new URL(req.url,'http://127.0.0.1').pathname;calls.push(path);const name=path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];if(!name||!['guest_join','guest_snapshot','guest_cart_mutate','guest_order_submit','guest_service','guest_orders','guest_cancel_request','guest_recommendations','catalogue','merchant_profile','product_information_read','table_entry_info','table_entry_status','table_entry_request','table_entry_claim'].includes(name)){res.writeHead(401,{'content-type':'application/json'});res.end('{"message":"UNAUTHORIZED"}');return;}
 const args=JSON.parse(data||'{}'),keys=Object.keys(args);if(keys.some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('Invalid named argument');await anon();const values=keys.map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]);
 const out=(await q(`select ops.${name}(${keys.map((k,i)=>`${k} := $${i+1}`).join(',')}) as j`,values))[0].j;
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
 if(['guest_cart_mutate','guest_order_submit'].includes(name)){for(const c of channels){if(c.topic.includes('check:'))c.ws.send(JSON.stringify({topic:c.topic,event:'broadcast',payload:{event:'changed',payload:{revision:out.revision},type:'broadcast'},ref:null}));}}
 }catch(e){console.error('FIXTURE RPC ERROR',e.message,e.detail);res.writeHead(/^PT\d+$/.test(e.code)?Number(e.code.slice(2)):500,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code??'XX000',message:e.message,details:e.detail??null}));}});});});await new Promise(r=>transport.listen(5449,'127.0.0.1',r));
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,SUPABASE_SERVER_URL:'http://127.0.0.1:5449',NEXT_TELEMETRY_DISABLED:'1'}});server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
 for(let n=0;n<90;n++){try{if((await fetch(base+'/siparis')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
 browser=await playwright.launch({args:chromium.args.filter(a=>!a.startsWith('--disable-web-security')&&a!=='--single-process'),executablePath:await chromium.executablePath(),headless:true});const contexts=[],pages=[];

 const context=await browser.newContext({viewport:{width:390,height:844}});await context.route('**/*.supabase.co/**',r=>r.abort());
 await context.routeWebSocket('**/realtime/v1/websocket**',ws=>{ws.onMessage(raw=>{try{const m=JSON.parse(String(raw));if(m.event==='phx_join')ws.send(JSON.stringify({topic:m.topic,event:'phx_reply',payload:{status:'ok',response:{}},ref:m.ref}));}catch{}});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/masaya-katil?masa='+table,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'Masa 14',exact:true}).waitFor();
 ok('public table entry never requests email/password',await page.locator('input[type=email],input[type=password]').count()===0);
 ok('entry page GET does not create participation request',calls.filter(x=>x.endsWith('/table_entry_request')).length===0);
 await page.getByRole('button',{name:'Bu masadan sipariş vermek istiyorum'}).click();
 await page.locator('.entry-code').waitFor();const code=(await page.locator('.entry-code').innerText()).trim();ok('four digit code displayed only after explicit request',/^\d{4}$/.test(code));
 const entryCookie=(await context.cookies()).find(x=>x.name.startsWith('menugo_entry_'));ok('entry capability kept HttpOnly, not URL',entryCookie?.httpOnly&&entryCookie.sameSite==='Lax'&&!page.url().includes(entryCookie.value));
 await queue;
 queue=queue.then(async()=>{await auth();const entries=(await q('select ops.table_entry_pending($1,$2) as j',[b,br]))[0].j;ok('staff request feed omits code',entries.length===1&&!('code' in entries[0]));await q('select ops.table_entry_decide($1,$2,$3,$4,true)',[b,br,entries[0].id,code]);await anon();});await queue;
 await page.waitForURL('**/siparis?check=*',{timeout:15000});await page.getByRole('button',{name:'Misafir Sandviç ekle'}).waitFor();
 const visitorCookie=(await context.cookies()).find(x=>x.name.startsWith('menugo_visit_'));ok('approved visitor cookie HttpOnly',visitorCookie?.httpOnly);ok('customer admits to active check, no registration',new URL(page.url()).searchParams.get('check')===cid&&await page.locator('input[type=email]').count()===0);
 await queue;queue=queue.then(async()=>{await auth();await q('select ops.close_empty_check($1,$2,$3)',[b,br,cid]);await anon();});await queue;
 await page.goto(base+'/masaya-katil?masa='+table,{waitUntil:'networkidle'});await page.getByText('Önceki ziyaretiniz sona erdi.',{exact:false}).waitFor();
 ok('re-scanning cannot reuse closed visit',new URL(page.url()).pathname==='/masaya-katil');
 fs.mkdirSync('public/qa/handover',{recursive:true});
 for(const width of [360,390,768,1024,1440]){await page.setViewportSize({width,height:900});ok('persistent table QR no overflow '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`public/qa/handover/table-entry-${width}.png`,fullPage:true});}
 for(const path of ['/yardim','/parola']){await page.goto(base+path,{waitUntil:'networkidle'});for(const width of [360,390,768,1440]){await page.setViewportSize({width,height:900});ok('no overflow '+path+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}await page.screenshot({path:'public/qa/handover/'+path.slice(1)+'.png',fullPage:true});}
 await context.close();assert.deepEqual(errors,[]);
 fs.writeFileSync('public/qa/handover/results.json',JSON.stringify({passed:results.length,tests:results,transport:'Actual Next table endpoints and HttpOnly cookies, isolated PGlite DB, mocked PostgREST transport; no production data',production:false},null,2));console.log('HANDOVER HTTP BROWSER SQL PASS',results.length);
}catch(e){if(browser){for(const c of browser.contexts())for(const p of c.pages())console.error('PAGE TEXT',(await p.locator('body').innerText()).slice(0,2000));}console.error('HANDOVER E2E FAILED',e.message,errors,logs.slice(-2000));process.exitCode=1;}finally{if(browser)await browser.close();server?.kill('SIGTERM');if(transport)await new Promise(r=>transport.close(r));await queue.catch(()=>{});await db.close();}
