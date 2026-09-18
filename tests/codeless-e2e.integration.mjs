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
 await q('update ops.branch_settings set ordering_enabled=true,dine_in_enabled=true where branch_id=$1',[br]);await q("insert into ops.dining_tables(id,business_id,branch_id,table_code,display_name)values($1,$2,$3,'14','Masa 14')",[table,b,br]);let cid;await anon();
 transport=createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{queue=queue.then(async()=>{try{const path=new URL(req.url,'http://127.0.0.1').pathname;calls.push(path);const name=path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];if(!name||!['guest_join','guest_snapshot','guest_cart_mutate','guest_order_submit','guest_service','guest_orders','guest_cancel_request','guest_recommendations','catalogue','merchant_profile','product_information_read','table_entry_info','table_entry_status','table_entry_request','table_entry_claim','table_guest_status','table_guest_join'].includes(name)){res.writeHead(401,{'content-type':'application/json'});res.end('{"message":"UNAUTHORIZED"}');return;}
 const args=JSON.parse(data||'{}'),keys=Object.keys(args);if(keys.some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('Invalid named argument');await anon();const values=keys.map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]);
 const out=(await q(`select ops.${name}(${keys.map((k,i)=>`${k} := $${i+1}`).join(',')}) as j`,values))[0].j;
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
 if(['table_guest_join','guest_cart_mutate','guest_order_submit'].includes(name)){for(const c of channels){if(c.topic.includes('check:'))c.ws.send(JSON.stringify({topic:c.topic,event:'broadcast',payload:{event:'changed',payload:{revision:out.revision},type:'broadcast'},ref:null}));}}
 }catch(e){console.error('FIXTURE RPC ERROR',e.message,e.detail);res.writeHead(/^PT\d+$/.test(e.code)?Number(e.code.slice(2)):500,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code??'XX000',message:e.message,details:e.detail??null}));}});});});await new Promise(r=>transport.listen(5449,'127.0.0.1',r));
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,SUPABASE_SERVER_URL:'http://127.0.0.1:5449',NEXT_TELEMETRY_DISABLED:'1'}});server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
 for(let n=0;n<90;n++){try{if((await fetch(base+'/siparis')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
 browser=await playwright.launch({args:chromium.args.filter(a=>!a.startsWith('--disable-web-security')&&a!=='--single-process'),executablePath:await chromium.executablePath(),headless:true});const contexts=[],pages=[];


 for(let i=0;i<4;i++){
 const context=await browser.newContext({viewport:{width:390,height:844}});contexts.push(context);
 await context.route('**/*.supabase.co/**',r=>r.abort());
 await context.routeWebSocket('**/realtime/v1/websocket**',ws=>{ws.onMessage(raw=>{try{const m=JSON.parse(String(raw));if(m.event==='phx_join'){channels.push({ws,topic:m.topic});ws.send(JSON.stringify({topic:m.topic,event:'phx_reply',payload:{status:'ok',response:{}},ref:m.ref}));}if(m.event==='heartbeat')ws.send(JSON.stringify({topic:m.topic,event:'phx_reply',payload:{status:'ok',response:{}},ref:m.ref}));}catch{}});});
 const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/masaya-katil?masa='+table,{waitUntil:'networkidle'});
 await page.waitForURL('**/siparis?check=*',{timeout:15000});
 await page.getByRole('button',{name:'Misafir Sandviç ekle'}).waitFor();
 const current=new URL(page.url()).searchParams.get('check');if(i===0)cid=current;else assert.equal(current,cid);
 ok('visitor '+i+' opens ordering without code or login',await page.locator('input[type=email],input[type=password],.entry-code').count()===0);
 const jar=await context.cookies();const secret=jar.find(c=>c.name.startsWith('menugo_visit_'));ok('HttpOnly capability visitor '+i,secret?.httpOnly&&secret.sameSite==='Lax'&&!page.url().includes(secret.value));
 }
 ok('no code-request or staff-decision RPCs',calls.every(p=>!p.endsWith('/table_entry_request')&&!p.endsWith('/table_entry_decide')&&!p.endsWith('/table_entry_claim')));
 const snapshot=i=>pages[i].request.get(base+'/api/guest/'+cid+'/cart').then(r=>r.json());
 const orders=i=>pages[i].request.get(base+'/api/guest/'+cid+'/orders').then(r=>r.json());
 const mutateCount=()=>calls.filter(p=>p.endsWith('/guest_cart_mutate')).length;
 await pages[0].locator('.guest-main[data-cart-revision="4"]').waitFor();
 await pages[0].getByRole('button',{name:'Misafir Sandviç ekle'}).click();await pages[0].locator('.guest-dock strong').filter({hasText:'150,00'}).waitFor();
 for(let i=1;i<4;i++){const state=await snapshot(i);ok('visitor '+i+' cannot inspect other selections',state.lines.length===0&&state.totalMinor==='0'&&state.billMinor==='0');}
 await pages[0].getByRole('button',{name:'Benim seçimlerim',exact:true}).click();await pages[0].getByRole('button',{name:'Seçimlerimi siparişe gönder'}).click();await pages[0].getByText('Benim siparişim',{exact:false}).waitFor();await pages[0].getByText('İşletme kabulü bekleniyor',{exact:true}).waitFor();
 const order=(await orders(0))[0];ok('first customer order awaits acceptance',order.status==='submitted');
 for(let i=1;i<4;i++){ok('visitor '+i+' cannot read another order',(await orders(i)).length===0);ok('visitor '+i+' cannot see table financial total',(await snapshot(i)).billMinor==='0');}
 // Simulated staff action through real SQL, transport transactions serialized.
 await queue;queue=queue.then(async()=>{await auth();await q('select ops.reject_submitted_order($1,$2,$3,$4)',[b,br,order.id,'Test: stok bitti']);await anon();});await queue;
 await pages[0].reload({waitUntil:'networkidle'});await pages[0].getByRole('button',{name:'Siparişlerim',exact:true}).click();await pages[0].getByText('İşletme tarafından kabul edilmedi',{exact:true}).waitFor();ok('rejected status visible only to order owner',(await orders(0))[0].rejected&& (await orders(1)).length===0);ok('rejection removes own bill debt',(await snapshot(0)).billMinor==='0');
 await pages[1].reload({waitUntil:'networkidle'});await pages[1].getByRole('button',{name:'Misafir Sandviç ekle'}).click();await pages[1].locator('.guest-dock strong').filter({hasText:'150,00'}).waitFor();await pages[1].getByRole('button',{name:'Benim seçimlerim',exact:true}).click();await pages[1].getByRole('button',{name:'Seçimlerimi siparişe gönder'}).click();await pages[1].getByText('Benim siparişim',{exact:false}).waitFor();
 const second=(await orders(1))[0];await queue;queue=queue.then(async()=>{await auth();await q('select ops.console_action($1,$2,$3,$4::jsonb)',[b,br,'order-status',JSON.stringify({orderId:second.id,status:'accepted'})]);await anon();});await queue;
 ok('accepted order remains personal',(await orders(1))[0].status==='accepted'&&(await orders(2)).length===0);
 await contexts[2].setOffline(true);await pages[2].getByText('İnternet bağlantısı kesildi.',{exact:false}).waitFor();ok('offline blocks new product intent',await pages[2].getByRole('button',{name:'Misafir Sandviç ekle'}).isDisabled());const count=mutateCount();await contexts[2].setOffline(false);await pages[2].waitForTimeout(500);ok('reconnect makes no automatic cart write',count===mutateCount());
 // A stranger has no access even knowing a check ID.
 const outsider=await browser.newContext();ok('outsider cannot read guest cart',(await outsider.request.get(base+'/api/guest/'+cid+'/cart')).status()===401);ok('outsider cannot read orders',(await outsider.request.get(base+'/api/guest/'+cid+'/orders')).status()===401);await outsider.close();
 const csrf=await pages[0].request.post(base+'/api/table/'+table,{headers:{Origin:'https://attacker.example'},data:{action:'join'}});ok('cross-origin join blocked',csrf.status()===403);
 fs.mkdirSync('public/qa/codeless',{recursive:true});
 for(const width of [320,360,390,768,1024,1440]){await pages[1].setViewportSize({width,height:900});ok('own order screen no overflow '+width,await pages[1].evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await pages[1].screenshot({path:`public/qa/codeless/order-${width}.png`,fullPage:true});}
 await queue;queue=queue.then(async()=>{await db.exec('reset role');ok('4 visitors use 1 adisyon',(await q('select count(*)::integer as n from ops.checks'))[0].n===1);ok('4 visitors have 4 private capabilities',(await q('select count(*)::integer as n from ops.guest_sessions'))[0].n===4);ok('no admission requests persisted',(await q('select count(*)::integer as n from ops.table_access_requests'))[0].n===0);ok('no customer Auth users created',(await q('select count(*)::integer as n from auth.users'))[0].n===1);});await queue;
 ok('no authentication endpoint needed for guest workflow',calls.every(p=>!p.startsWith('/auth/')));assert.deepEqual(errors,[]);
 fs.writeFileSync('public/qa/codeless/results.json',JSON.stringify({passed:results.length,tests:results,realNextHttp:true,isolatedPGlite:true,simulatedTransport:true,physicalPhones:false,productionWrites:false},null,2));console.log('CODELESS HTTP BROWSER SQL PASS',results.length);
}catch(e){if(browser){for(const c of browser.contexts())for(const p of c.pages())console.error('PAGE TEXT',(await p.locator('body').innerText()).slice(0,2000));}console.error('CODELESS E2E FAILED',e.message,errors,logs.slice(-2000));process.exitCode=1;}finally{if(browser)await browser.close();server?.kill('SIGTERM');if(transport)await new Promise(r=>transport.close(r));await queue.catch(()=>{});await db.close();}
