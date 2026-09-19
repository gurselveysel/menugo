// Real Next routes/SSR, isolated Auth/RPC test double. No real credentials or model calls.
import{createServer}from'node:http';import{spawn}from'node:child_process';import fs from'node:fs';import assert from'node:assert/strict';import{chromium as playwright}from'playwright-core';import chromium from'@sparticuz/chromium';
const base='http://localhost:3417',sb='http://127.0.0.1:5457',out='public/qa/platform-ai',checks=[],calls=[],errors=[];
const id=n=>`77777777-7777-4777-8777-${String(n).padStart(12,'0')}`;
const branches=[{businessId:id(1),branchId:id(2),name:'Test Restoran A'},{businessId:id(3),branchId:id(4),name:'Test Restoran B'}];
let role='platform',version=0,configured=false,transport,server,browser;fs.mkdirSync(out,{recursive:true});
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
try{
 transport=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{try{
  const path=new URL(req.url,sb).pathname,v=JSON.parse(text||'{}');calls.push({path,v});
  if(path==='/auth/v1/user')return send(res,200,{id:id(9),email:'platform@example.test',email_confirmed_at:new Date().toISOString(),aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},identities:[],created_at:new Date().toISOString()});
  const fn=path.split('/').at(-1);
  if(['platform_principal','platform_ai_console'].includes(fn)){if(role!=='platform')return send(res,403,{code:'PT403',message:'PLATFORM_ADMIN_REQUIRED'});return send(res,200,{userId:id(9),role:'ai_admin',canManageAi:true,branches});}
  if(fn==='free_ai_settings'){
   if(role!=='platform')return send(res,403,{code:'PT403',message:'PLATFORM_ADMIN_REQUIRED'});
   if(v.p_action==='save'){assert.equal(v.p_payload.apiKey,'SYNTHETIC_TEST_KEY_NOT_REAL_123456');assert.equal(v.p_branch_id,id(2));version++;configured=true;}
   return send(res,200,{version:String(version),canManage:true,paidFallback:false,routes:configured?[{provider:'groq_free',model:'openai/gpt-oss-20b',priority:10,dailyLimit:20,enabled:true,hasKey:true,publicContentAllowed:true,privateContentAllowed:false}]:[]});
  }
  if(fn==='llm_settings')return send(res,200,{configured,enabled:configured,provider:'free_router',verified:false,version:String(version),dailyLimit:50,usedToday:0,canManage:role==='platform',model:null});
  return send(res,404,{code:'PT404',message:'NOT_FOUND'});
 }catch(e){errors.push(String(e));return send(res,500,{code:'PT500',message:'FIXTURE_FAILED'});}});});
 await new Promise(r=>transport.listen(5457,'127.0.0.1',r));
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,SUPABASE_SERVER_URL:sb,NEXT_PUBLIC_SUPABASE_URL:sb,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'isolated-test-publishable',NEXT_TELEMETRY_DISABLED:'1'}});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 for(let i=0;i<100;i++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const ctx=await browser.newContext(),page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 const unauth=await page.request.get(base+'/api/platform/ai/context');assert.equal(unauth.status(),401);checks.push('no session receives 401 at company API');
 await page.goto(base+'/platform/yapay-zeka',{waitUntil:'networkidle'});assert.ok(page.url().includes('/giris?next='));checks.push('company page redirects unauthenticated user to scoped login');
 const exp=Math.floor(Date.now()/1000)+3600,part=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const session={access_token:part({alg:'HS256',typ:'JWT'})+'.'+part({sub:id(9),exp,role:'authenticated',aud:'authenticated'})+'.test',refresh_token:'isolated-test-refresh',expires_at:exp,expires_in:3600,token_type:'bearer',user:{id:id(9)}};
 await ctx.addCookies([{name:'sb-127-auth-token',value:'base64-'+part(session),domain:'localhost',path:'/',httpOnly:false,sameSite:'Lax'}]);
 role='restaurant';
 const forbidden=await page.request.get(base+'/api/platform/ai/context');assert.equal(forbidden.status(),403);checks.push('verified restaurant owner still receives 403');
 const hidden=await page.goto(base+'/platform/yapay-zeka',{waitUntil:'networkidle'});assert.equal(hidden.status(),404);assert.equal(await page.getByLabel('API anahtarı',{exact:true}).count(),0);checks.push('forbidden server rendering contains no provider form');
 role='platform';
 await page.goto(base+'/platform/yapay-zeka',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'AI kontrol merkezi',exact:true}).waitFor();await page.locator('.free-ai-settings form').first().waitFor();checks.push('explicit company role opens central configuration');
 assert.equal(calls.filter(c=>c.path.includes('/functions/')).length,0);checks.push('page load makes no AI request');
 for(const width of[320,360,390,768,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'platform width '+width);checks.push('platform fits '+width);if([390,1440].includes(width))await page.screenshot({path:`${out}/platform-${width}.png`,fullPage:true});}
 const form=page.locator('.free-ai-settings form').first();await form.locator('input[name=key]').fill('SYNTHETIC_TEST_KEY_NOT_REAL_123456');await form.locator('input[name=public]').check();await form.locator('input[name=free]').check();await form.locator('input[name=consent]').check();await form.getByRole('button',{name:'Ücretsiz bağlantıyı kaydet'}).click();await page.getByRole('status').filter({hasText:'Bağlantı kaydedildi'}).waitFor();
 assert.ok(calls.some(c=>c.v.p_action==='save'));assert.ok(!await page.locator('body').innerText().then(t=>t.includes('SYNTHETIC_TEST_KEY_NOT_REAL_123456')));checks.push('only explicit save sends synthetic key; status does not echo key');
 await page.getByLabel('Yönetilecek işletme şubesi').selectOption(id(4));await page.waitForTimeout(400);assert.ok(calls.some(c=>c.v.p_branch_id===id(4)));checks.push('target selector changes scoped configuration request');
 const legacy=await page.request.post(base+'/api/llm/free-save',{headers:{Origin:base},data:{}});assert.equal(legacy.status(),403);checks.push('legacy merchant config POST remains closed even to platform role');
 const cross=await page.request.post(base+'/api/platform/ai/free-save?businessId='+id(1)+'&branchId='+id(2),{headers:{Origin:'https://attacker.invalid'},data:{}});assert.equal(cross.status(),403);checks.push('cross origin configuration write denied');
 role='restaurant';const revoked=await page.request.get(base+'/api/platform/ai/free-status?businessId='+id(1)+'&branchId='+id(2));assert.equal(revoked.status(),403);checks.push('permission revocation affects next request with same session');
 assert.deepEqual(errors,[]);checks.push('no React or isolated backend fixture errors');fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,authRpcTestDouble:true,realProviderCalls:0,realCredentials:0},null,2));console.log('PLATFORM AI UI PASS',checks.length);
}catch(e){console.error('PLATFORM UI FAILED',e,errors);process.exitCode=1;if(browser)for(const c of browser.contexts())for(const p of c.pages()){try{console.error((await p.locator('body').innerText()).slice(-3000));await p.screenshot({path:out+'/failure.png',fullPage:true});}catch{}}}finally{if(browser)await browser.close();server?.kill('SIGTERM');transport?.close();}
