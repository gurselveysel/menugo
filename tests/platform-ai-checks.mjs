// Security acceptance: real SQL, isolated Supabase auth/Vault fixtures only.
export async function platformAiChecks({q,db,auth,check,rejects,b,br,users,op}){
 await auth(users[0]);
 const config={version:'0',provider:'openrouter_free',model:'openrouter/free',apiKey:'TEST_ONLY_PLATFORM_CREDENTIAL_123456',dailyLimit:20,priority:10,accountId:'',enabled:true,publicContentAllowed:true,privateContentAllowed:true,freePlanConfirmed:true,consent:true};
 const free=(a='status',v={})=>q('select ops.free_ai_settings($1,$2,$3,$4::jsonb) j',[b,br,a,JSON.stringify(v)]);
 await rejects('restaurant owner is not a platform admin',()=>q('select ops.platform_principal()'),'PLATFORM_ADMIN_REQUIRED');
 for(const a of ['status','save','remove'])await rejects('restaurant owner cannot '+a+' provider config',()=>free(a,config),'PLATFORM_ADMIN_REQUIRED');
 await rejects('restaurant owner cannot run credential test through direct RPC',()=>q("select ops.llm_claim($1,$2,$3,'test','{}')",[b,br,op(71001)]),'PLATFORM_ADMIN_REQUIRED');
 await rejects('restaurant cannot self-elevate platform role',()=>q("insert into ops.platform_staff(user_id,role,active,reason) values($1,'platform_owner',true,'self promotion')",[users[0]]),'42501');
 const publicStatus=(await q("select ops.llm_settings($1,$2,'status','{}') j",[b,br]))[0].j;
 check('restaurant status has no config entitlement',publicStatus.canManage===false&&publicStatus.model===null&&publicStatus.testError===null&&publicStatus.version==='0');
 await db.exec('reset role');
 const platform=op(71002);
 await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[platform,'ai-admin@example.test']);
 await q("insert into ops.platform_staff(user_id,role,active,reason) values($1,'ai_admin',true,'Isolated test company administrator')",[platform]);
 await auth(platform);
 check('platform principal independent of restaurant membership',(await q('select ops.platform_principal() j'))[0].j.role==='ai_admin');
 check('central console returns branch configuration targets',(await q('select ops.platform_ai_console() j'))[0].j.branches.some(x=>x.branchId===br));
 await rejects('platform role alone does not expose customer catalogue management',()=>q("select ops.ai_menu_job($1,$2,'list',null,'{}')",[b,br]),'MANAGER_REQUIRED');
 const saved=(await free('save',config))[0].j;
 check('platform can store and mask credentials',saved.canManage&&saved.routes.length===1&&!JSON.stringify(saved).includes(config.apiKey));
 const claim=(await q("select ops.llm_claim($1,$2,$3,'test','{}') j",[b,br,op(71003)]))[0].j;
 check('platform test is reserved without restaurant role',claim.claimed===true);
 await db.exec('reset role');await db.exec('set role service_role');
 const dispatch=(await q('select ops.llm_dispatch($1,$2) j',[claim.id,claim.lease]))[0].j;
 check('platform diagnostic dispatch does not fetch business data',Object.keys(dispatch.context).length===0);
 check('platform test quota can be reserved',(await q("select ops.free_ai_attempt($1,$2,'openrouter_free',1,'start') j",[claim.id,claim.lease]))[0].j.allowed===true);
 await q("select ops.free_ai_attempt($1,$2,'openrouter_free',1,'success',null,'fixture/free')",[claim.id,claim.lease]);
 await q("select ops.llm_finish($1,$2,'{\"verified\":true}',null,0,0)",[claim.id,claim.lease]);
 await auth(users[0]);
 const usage=(await q("select ops.llm_settings($1,$2,'status','{}') j",[b,br]))[0].j;
 check('restaurant can use company configured AI without managing keys',usage.configured&&usage.verified&&!usage.canManage&&usage.model===null);
 await rejects('configured restaurant owner still cannot edit route',()=>free('remove',{version:saved.version,provider:'openrouter_free'}),'PLATFORM_ADMIN_REQUIRED');
 await auth(platform);
 const pending=(await q("select ops.llm_claim($1,$2,$3,'test','{}') j",[b,br,op(71004)]))[0].j;
 await db.exec('reset role');await q('update ops.platform_staff set active=false where user_id=$1',[platform]);
 await auth(platform);await rejects('revoked platform admin cannot read settings',()=>free(),'PLATFORM_ADMIN_REQUIRED');
 await db.exec('reset role');await db.exec('set role service_role');
 await rejects('revocation cancels queued platform test authorization',()=>q('select ops.llm_dispatch($1,$2)',[pending.id,pending.lease]),'PLATFORM_ADMIN_REQUIRED');
 await db.exec('reset role');await q('update ops.platform_staff set active=true where user_id=$1',[platform]);await auth(platform);
 await free('remove',{version:saved.version,provider:'openrouter_free'});
 await db.exec('reset role');
 check('technical configuration writes are recorded centrally',(await q("select count(*)::int n from ops.platform_audit_events where action='free-ai-save'"))[0].n>0);
 await rejects('audit entries cannot be changed',()=>q("update ops.platform_audit_events set action='edited'"),'PLATFORM_AUDIT_APPEND_ONLY');
 // Reset only isolated fixture data before the existing LLM acceptance block.
 await q('delete from ops.ai_free_attempts where run_id in(select id from ops.llm_runs where actor_id=$1)',[platform]);
 await q('delete from ops.llm_runs where actor_id=$1',[platform]);await q('delete from ops.llm_connections where business_id=$1 and branch_id=$2',[b,br]);
 await q("insert into ops.platform_staff(user_id,role,active,reason) values($1,'platform_owner',true,'Remaining isolated provider regression fixtures')",[users[0]]);
}
