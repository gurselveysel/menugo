// Actual Next SSR + API handlers + browser; isolated Auth/RPC test server.
import{createServer}from'node:http';import{spawn}from'node:child_process';import fs from'node:fs';import assert from'node:assert/strict';import{chromium as playwright}from'playwright-core';import chromium from'@sparticuz/chromium';
const base='http://localhost:3417',sb='http://127.0.0.1:5457',out='public/qa/platform-control',checks=[],calls=[],errors=[];
const id=n=>`99999999-9999-4999-8999-${String(n).padStart(12,'0')}`;
const defaults={aiEnabled:true,importsEnabled:true,studioPublicationEnabled:true,orderingEnabled:true,whatsappEnabled:true,crmEvaluationEnabled:true,dailyAiLimit:50};
const branches=[{businessId:id(1),branchId:id(2),name:'Test Restoran / Merkez'},{businessId:id(1),branchId:id(3),name:'Test Restoran / İkinci Şube'}];
let role='platform_owner',transport,server,browser,unknownOnce=false;const changes=[],cfg=new Map([['global',{version:'0',settings:{...defaults}}]]),receipts=new Map();fs.mkdirSync(out,{recursive:true});
function principal(){return{userId:id(9),role,canManageAi:['platform_owner','ai_admin'].includes(role),canManageOperations:['platform_owner','ops_admin'].includes(role),canManageSecurity:['platform_owner','security_admin'].includes(role),canManageMembers:role==='platform_owner'};}
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
try{
 transport=createServer((req,res)=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>{try{
 const path=new URL(req.url,sb).pathname,v=JSON.parse(text||'{}');calls.push({path,v});
 if(path==='/auth/v1/user')return send(res,200,{id:id(9),email:'owner@control.test',email_confirmed_at:new Date().toISOString(),aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},identities:[],created_at:new Date().toISOString()});
 const fn=path.split('/').at(-1),denied=role==='restaurant';
 if(denied)return send(res,403,{code:'PT403',message:'PLATFORM_ADMIN_REQUIRED'});
 if(fn==='platform_principal')return send(res,200,principal());
 if(fn==='platform_control_snapshot'){
 const c=cfg.get(v.p_branch_id??'global')??{version:'0',settings:{}},g=cfg.get('global').settings;
 const effective={...g,...c.settings,dailyAiLimit:Math.min(g.dailyAiLimit,c.settings.dailyAiLimit??50)};for(const k of Object.keys(defaults).filter(k=>k!=='dailyAiLimit'))effective[k]=g[k]&&(c.settings[k]??true);
 return send(res,200,{...principal(),...c,globalSettings:g,effective,branches,changes,audit:[],members:[{userId:id(9),email:'owner@control.test',role:'platform_owner',active:true}],rules:{paidAiFallback:false,paidAiBudgetMinor:'0'},...(v.p_branch_id?{admission:{mode:'direct',version:'4'},features:{payments_enabled:false,loyalty_enabled:false,sms_enabled:false,daas_enabled:false},readiness:{products:76,approvedPrices:71,tables:1,staff:1,aiRoutes:0,expiredAiAttestations:0},queues:{aiUnknown:0,paymentUnknown:0,courierDead:0,courierPending:0,smsUnknown:0,crmLastRun:null}}:{})});}
 if(fn==='platform_control_save'){
 if(!principal().canManageAi&&!principal().canManageOperations)return send(res,403,{code:'PT403',message:'PLATFORM_PERMISSION_REQUIRED'});
 if(receipts.has(v.p_operation_id))return send(res,200,receipts.get(v.p_operation_id));
 const scope=v.p_branch_id??'global',old=cfg.get(scope)??{version:'0',settings:{}};
 if(String(v.p_expected_version)!==old.version)return send(res,409,{code:'PT409',message:'PLATFORM_VERSION_CHANGED'});
 const result={version:String(BigInt(old.version)+1n),scope};cfg.set(scope,{version:result.version,settings:v.p_settings});receipts.set(v.p_operation_id,result);changes.unshift({id:String(changes.length+1),action:'policy',scope,createdAt:new Date().toISOString(),reason:v.p_reason,before:old.settings,after:v.p_settings});
 if(unknownOnce){unknownOnce=false;return send(res,503,{code:'PT503',message:'LOST_RESPONSE'});}return send(res,200,result);}
 if(fn==='platform_admission_save')return send(res,200,{mode:v.p_mode,version:String(BigInt(v.p_expected_version)+1n)});
 if(fn==='platform_member_save')return send(res,200,{saved:true,userId:id(10)});
 return send(res,404,{code:'PT404',message:'NOT_FOUND'});
 }catch(e){errors.push(String(e));send(res,500,{code:'PT500',message:'FIXTURE_FAILED'});}});});
 await new Promise(r=>transport.listen(5457,'127.0.0.1',r));
 const command=process.env.MENUGO_TEST_DEV?['dev','--webpack']:['start'];
 server=spawn(process.execPath,['node_modules/next/dist/bin/next',...command,'-p','3417'],{stdio:['ignore','pipe','pipe'],env:{...process.env,SUPABASE_SERVER_URL:sb,NEXT_PUBLIC_SUPABASE_URL:sb,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'isolated-test-publishable',NEXT_TELEMETRY_DISABLED:'1'}});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 for(let i=0;i<150;i++){try{if((await fetch(base+'/giris')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await playwright.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});const ctx=await browser.newContext(),page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 const unauth=await page.request.get(base+'/api/platform/control/state');assert.equal(unauth.status(),401);checks.push('company API refuses missing session');
 await page.goto(base+'/platform',{waitUntil:'networkidle'});assert.ok(page.url().includes('/giris?next='));checks.push('server page redirects missing company session');
 const exp=Math.floor(Date.now()/1000)+3600,part=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const session={access_token:part({alg:'HS256',typ:'JWT'})+'.'+part({sub:id(9),exp,role:'authenticated',aud:'authenticated'})+'.test',refresh_token:'isolated-test-refresh',expires_at:exp,expires_in:3600,token_type:'bearer',user:{id:id(9)}};
 await ctx.addCookies([{name:'sb-127-auth-token',value:'base64-'+part(session),domain:'localhost',path:'/',httpOnly:false,sameSite:'Lax'}]);
 role='restaurant';assert.equal((await page.request.get(base+'/api/platform/control/state')).status(),403);checks.push('restaurant owner cannot query company configuration');
 assert.equal((await page.goto(base+'/platform',{waitUntil:'networkidle'})).status(),404);checks.push('no company form leaks in forbidden SSR');
 role='platform_owner';await page.goto(base+'/platform',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Genel bakış',exact:true}).waitFor();await page.getByLabel('Yönetim kapsamı').waitFor();
 await page.getByLabel('Yönetim kapsamı').selectOption(id(2));await page.getByText('Onaylı fiyat',{exact:true}).waitFor();checks.push('observed branch readiness loads without providers or writes');assert.equal(calls.filter(c=>c.path.endsWith('_save')).length,0);
 for(const width of[320,360,390,768,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push('control fits width '+width);if([390,1440].includes(width))await page.screenshot({path:`${out}/overview-${width}.png`,fullPage:true});}
 const nav=page.getByRole('navigation',{name:'Şirket yönetimi bölümleri'});
 for(const tab of['Modüller & limitler','Güvenlik & erişim','Şirket ekibi','Entegrasyonlar','İş kuyrukları','Veri & saklama','Değişiklik geçmişi','Alan adı & yayın']){await nav.getByRole('button',{name:tab,exact:true}).click();await page.getByRole('heading',{name:tab,exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push('tab accessible '+tab);}
 await nav.getByRole('button',{name:'Modüller & limitler',exact:true}).click();await page.getByLabel('Günlük AI işi tavanı').fill('15');await page.getByLabel('Değişiklik gerekçesi').fill('Şubede kontrollü kullanım');await page.getByRole('button',{name:'Politikayı kaydet',exact:true}).click();await page.getByRole('button',{name:'Değişikliği uygula',exact:true}).click();await page.getByRole('status').filter({hasText:'Kaydedildi.'}).waitFor();checks.push('policy save persists scoped version and reason');
 const saveCall=calls.filter(c=>c.path.endsWith('platform_control_save')).at(-1);assert.equal(saveCall.v.p_branch_id,id(2));assert.equal(saveCall.v.p_settings.dailyAiLimit,15);assert.match(saveCall.v.p_operation_id,/^[0-9a-f-]{36}$/);
 await page.getByLabel('Değişiklik gerekçesi').waitFor();await page.waitForTimeout(150);unknownOnce=true;await page.getByLabel('Günlük AI işi tavanı').fill('14');await page.getByLabel('Değişiklik gerekçesi').fill('Second operation test');await page.getByRole('button',{name:'Politikayı kaydet',exact:true}).click();await page.getByRole('button',{name:'Değişikliği uygula',exact:true}).click();await page.getByRole('alert').filter({hasText:'Sonuç doğrulanamadı'}).waitFor();const first=calls.filter(c=>c.path.endsWith('platform_control_save')).at(-1).v;
 assert.equal(await page.getByLabel('Yönetim kapsamı').isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Politikayı kaydet',exact:true}).isDisabled(),true);checks.push('unknown write disables conflicting scope or new command');await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'Aynı işlemi kontrol et / yeniden dene'}).waitFor();assert.equal(calls.filter(c=>c.path.endsWith('platform_control_save')).length,2);checks.push('unknown operation survives page reload without auto-send');
 await page.getByRole('button',{name:'Aynı işlemi kontrol et / yeniden dene'}).click();await page.getByRole('status').filter({hasText:'Kaydedildi.'}).waitFor();const repeated=calls.filter(c=>c.path.endsWith('platform_control_save')).at(-1).v;assert.deepEqual(first,repeated);checks.push('unknown write repeats same immutable operation and payload');
 const cross=await page.request.post(base+'/api/platform/control/policy',{headers:{Origin:'https://attacker.invalid'},data:{}});assert.equal(cross.status(),403);checks.push('cross origin company writes blocked');
 const bad=await page.request.post(base+'/api/platform/control/policy',{headers:{Origin:base},data:{operationId:id(20),version:'0',settings:{paidFallback:true},reason:'Invalid paid attempt'}});assert.equal(bad.status(),400);checks.push('paid fallback cannot be injected');
 const legacy=await page.request.post(base+'/api/merchant/table-policy',{headers:{Origin:base},data:{mode:'direct'}});assert.equal(legacy.status(),403);checks.push('legacy restaurant security setter explicitly closed');
 role='auditor';await page.goto(base+'/platform',{waitUntil:'networkidle'});await nav.getByRole('button',{name:'Modüller & limitler',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Politikayı kaydet',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('link',{name:'AI sağlayıcıları ↗'}).count(),0);checks.push('auditor has no configuration actions or AI admin link');
 role='ops_admin';await page.goto(base+'/platform',{waitUntil:'networkidle'});await nav.getByRole('button',{name:'Modüller & limitler',exact:true}).click();assert.equal(await page.getByLabel('Günlük AI işi tavanı').isDisabled(),true);checks.push('operations role cannot edit AI quotas');
 role='restaurant';const revoked=await page.request.get(base+'/api/platform/control/state');assert.equal(revoked.status(),403);checks.push('same session loses company access after revocation');
 assert.deepEqual(errors,[]);checks.push('no page or fixture errors');fs.writeFileSync(out+'/results.json',JSON.stringify({passed:checks.length,checks,authRpcTestDouble:true,productionWrites:0,realProviderCalls:0},null,2));console.log('PLATFORM CONTROL UI PASS',checks.length);
}catch(e){console.error('PLATFORM CONTROL UI FAILED',e,errors);process.exitCode=1;if(browser)for(const c of browser.contexts())for(const p of c.pages()){try{console.error((await p.locator('body').innerText()).slice(-2000));await p.screenshot({path:out+'/failure.png',fullPage:true});}catch{}}}finally{if(browser)await browser.close();server?.kill('SIGTERM');transport?.close();}
