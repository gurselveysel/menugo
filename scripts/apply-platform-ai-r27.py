"""Expand reviewed platform access patch. No live credentials or customer data."""
from pathlib import Path
import re,json,sys
root=Path('.')
if (root/'supabase/migrations/20260920000100_ops_platform_ai_access.sql').exists():
 print('Platform source already expanded');sys.exit(0)
def write(path,text):
 p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text,encoding='utf-8')
base=(root/'supabase/migrations/20260919233000_ops_free_ai_control.sql').read_text()
def fn(name):
 m=re.search(r'CREATE (?:OR REPLACE )?FUNCTION ops\.'+name+r'\(.*?END;\$\$;',base,re.S)
 assert m,name
 return m.group(0).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
start="""-- AI control plane: platform staff is independent from restaurant staff.
-- No automatic owner/email promotion; bootstrap is a separate audited admin step.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE ops.platform_staff(
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN('platform_owner','ai_admin')),
 active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 granted_by uuid REFERENCES auth.users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 500)
);
CREATE TABLE ops.platform_audit_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_user_id uuid REFERENCES auth.users(id),
 target_user_id uuid REFERENCES auth.users(id),
 business_id uuid,branch_id uuid,
 action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ops.platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.platform_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.platform_staff,ops.platform_audit_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON ops.platform_staff,ops.platform_audit_events TO service_role;
CREATE POLICY platform_staff_closed ON ops.platform_staff AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY platform_audit_closed ON ops.platform_audit_events AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE FUNCTION ops.platform_membership_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO ops.platform_audit_events(actor_user_id,target_user_id,action,details)
 VALUES(auth.uid(),coalesce(NEW.user_id,OLD.user_id),'platform-member-'||lower(TG_OP),
 jsonb_build_object('role',coalesce(NEW.role,OLD.role),'active',CASE WHEN TG_OP='DELETE' THEN false ELSE NEW.active END));
 RETURN coalesce(NEW,OLD);
END;$$;
CREATE TRIGGER platform_membership_audit AFTER INSERT OR UPDATE OR DELETE ON ops.platform_staff FOR EACH ROW EXECUTE FUNCTION ops.platform_membership_audit();
CREATE FUNCTION ops.platform_audit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'PLATFORM_AUDIT_APPEND_ONLY';END;$$;
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.platform_audit_events FOR EACH STATEMENT EXECUTE FUNCTION ops.platform_audit_immutable();
CREATE FUNCTION ops.platform_ai_actor(p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM ops.platform_staff p JOIN auth.users u ON u.id=p.user_id
 WHERE p.user_id=p_actor AND p.active AND p.role IN('platform_owner','ai_admin') AND u.email_confirmed_at IS NOT NULL);
$$;
CREATE FUNCTION ops.platform_principal() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;BEGIN
 IF auth.uid() IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE='UNAUTHENTICATED';END IF;
 IF NOT ops.platform_ai_actor(auth.uid()) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_ADMIN_REQUIRED';END IF;
 SELECT role INTO r FROM ops.platform_staff WHERE user_id=auth.uid();
 RETURN jsonb_build_object('userId',auth.uid(),'role',r,'canManageAi',true);
END;$$;
CREATE FUNCTION ops.platform_assert_ai(p_business_id uuid,p_branch_id uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM ops.platform_principal();
 IF NOT EXISTS(SELECT 1 FROM ops.branch_settings WHERE business_id=p_business_id AND branch_id=p_branch_id) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BRANCH_NOT_FOUND';END IF;
END;$$;
CREATE FUNCTION ops.platform_ai_console() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE principal jsonb;BEGIN
 principal:=ops.platform_principal();
 RETURN principal||jsonb_build_object('branches',(SELECT coalesce(jsonb_agg(jsonb_build_object('businessId',s.business_id,'branchId',s.branch_id,'name',b.name) ORDER BY b.name,s.branch_id),'[]'::jsonb) FROM ops.branch_settings s JOIN public.branches b ON b.id=s.branch_id AND b.business_id=s.business_id));
END;$$;
REVOKE ALL ON FUNCTION ops.platform_membership_audit(),ops.platform_audit_immutable(),ops.platform_ai_actor(uuid),ops.platform_principal(),ops.platform_assert_ai(uuid,uuid),ops.platform_ai_console() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION ops.platform_principal(),ops.platform_ai_console() TO authenticated;
GRANT EXECUTE ON FUNCTION ops.platform_ai_actor(uuid) TO service_role;
"""
settings=fn('free_ai_settings').replace('PERFORM ops.import_assert_manager(p_business_id,p_branch_id);','PERFORM ops.platform_assert_ai(p_business_id,p_branch_id);').replace("owner_ok:=ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner']);","owner_ok:=true;")
settings=settings.replace('Owner supplied no-billing provider credential','MenuGO platform-managed no-billing provider credential')
settings=settings.replace('INSERT INTO ops.operator_events(business_id,branch_id,actor_user_id,kind,details)','INSERT INTO ops.platform_audit_events(business_id,branch_id,actor_user_id,action,details)')
status=fn('llm_settings').replace("PERFORM ops.import_assert_manager(p_business_id,p_branch_id);\n is_owner:=ops.has_branch_role(p_business_id,p_branch_id,ARRAY['owner']);", "is_owner:=ops.platform_ai_actor(auth.uid());\n IF is_owner THEN PERFORM ops.platform_assert_ai(p_business_id,p_branch_id); ELSE PERFORM ops.import_assert_manager(p_business_id,p_branch_id); END IF;\n IF p_action<>'status' AND NOT is_owner THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_ADMIN_REQUIRED';END IF;")
status=status.replace("'model',c.model", "'model',CASE WHEN is_owner THEN c.model ELSE NULL END").replace("'version',coalesce(c.version,0)::text", "'version',CASE WHEN is_owner THEN coalesce(c.version,0)::text ELSE '0' END").replace("'testError',c.last_test_error", "'testError',CASE WHEN is_owner THEN c.last_test_error ELSE NULL END")
claim=fn('llm_claim').replace('PERFORM ops.import_assert_manager(p_business_id,p_branch_id);',"IF p_kind='test' THEN PERFORM ops.platform_assert_ai(p_business_id,p_branch_id); ELSE PERFORM ops.import_assert_manager(p_business_id,p_branch_id); END IF;")
dispatch=fn('llm_dispatch').replace("IF NOT EXISTS(SELECT 1 FROM ops.branch_staff s WHERE s.business_id=r.business_id AND s.branch_id=r.branch_id AND s.user_id=r.actor_id AND s.active AND s.role IN('owner','manager')) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;", "IF r.kind='test' THEN\n IF NOT ops.platform_ai_actor(r.actor_id) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='PLATFORM_ADMIN_REQUIRED';END IF;\n ELSIF NOT EXISTS(SELECT 1 FROM ops.branch_staff s WHERE s.business_id=r.business_id AND s.branch_id=r.branch_id AND s.user_id=r.actor_id AND s.active AND s.role IN('owner','manager')) THEN RAISE SQLSTATE 'PT403' USING MESSAGE='MANAGER_REQUIRED';END IF;")
attempt=fn('free_ai_attempt').replace("IF NOT EXISTS(SELECT 1 FROM ops.branch_staff WHERE business_id=r.business_id AND branch_id=r.branch_id AND user_id=r.actor_id AND active AND role IN('owner','manager')) THEN RETURN jsonb_build_object('allowed',false);END IF;", "IF r.kind='test' THEN\n IF NOT ops.platform_ai_actor(r.actor_id) THEN RETURN jsonb_build_object('allowed',false);END IF;\n ELSIF NOT EXISTS(SELECT 1 FROM ops.branch_staff WHERE business_id=r.business_id AND branch_id=r.branch_id AND user_id=r.actor_id AND active AND role IN('owner','manager')) THEN RETURN jsonb_build_object('allowed',false);END IF;")
write('supabase/migrations/20260920000100_ops_platform_ai_access.sql',start+'\n\n'.join([settings,status,claim,dispatch,attempt])+"\nCOMMIT;\n")
p=root/'components/LlmAssistant.tsx';s=p.read_text().replace("import {FreeAiSettings} from './FreeAiSettings';\n",'')
s=re.sub(r' async function probe\(\).*?\n async function send',' async function send',s,flags=re.S)
a=s.index(' <FreeAiSettings ');z=s.index(' </Card><Card>',a)
s=s[:a]+''' <h2>AI kullanım alanınız</h2><p>Menü açıklaması, çeviri ve paylaşım metinlerini hazırlayın. Sonuçlar yalnız sizin kontrolünüzle yayımlanır.</p>
 <p className="notice">AI altyapısı MenüGO tarafından yönetilir. API anahtarı veya model ayarı yapmanız gerekmez.</p>
 <p>{ready?'AI araçlarınız kullanıma hazır.':'AI hizmetiniz MenüGO tarafından hazırlanıyor. Mevcut menü ve siparişleriniz çalışmaya devam eder.'}</p>
 <p>Bugünkü kullanım: {status?.usedToday??0} / {status?.dailyLimit??0}</p>
 <button className="text-button" disabled={busy} onClick={()=>void load()}>Durumu yenile</button>
'''+s[z:]
s=s.replace("status?.configured?'Bağlantı testi gerekli':'LLM bağlantısı bekleniyor'","status?.configured?'Hizmet hazırlanıyor':'Hizmet hazırlanıyor'").replace("status?.provider==='free_router'?'Ücretsiz görev yönlendiricisi':'Ücretsiz API bağlantısı'","'MenüGO AI'").replace('AI taslağı · {answerModel}','AI taslağı');p.write_text(s)
p=root/'app/api/llm/[action]/route.ts';s=p.read_text().replace("import {llmModels} from '@/lib/llm/messages';\n",'').replace("if(action==='free-status')return json(await rpc(s,'free_ai_settings',{...scope,p_action:'status'}));","if(action==='free-status')throw new Failure('PLATFORM_ADMIN_REQUIRED',403);")
s=s.replace('return json({...status,products:menu.catalogue.map((p:any)=>({id:p.id,name:p.name})),models:llmModels});',"return json({...status,canManage:false,model:null,version:'0',testError:null,products:menu.catalogue.map((p:any)=>({id:p.id,name:p.name}))});")
a=s.index(" if(action==='free-save'");z=s.index(" if(action==='ask')",a);s=s[:a]+" if(['free-save','free-remove','settings','disconnect','test'].includes(action))throw new Failure('PLATFORM_ADMIN_REQUIRED',403);\n"+s[z:];p.write_text(s)
p=root/'lib/llm/messages.ts';s=p.read_text()
replacements={'LLM_SERVER_REQUIRED':'AI hizmeti MenüGO tarafından hazırlanıyor. Mevcut menü ve siparişleriniz etkilenmez.','LLM_KEY_REQUIRED':'Bu AI hizmeti henüz kullanıma açılmadı. MenüGO desteğiyle iletişime geçin.','LLM_TEST_REQUIRED':'AI hizmetinin kontrolü MenüGO tarafından tamamlanıyor.','LLM_FREE_SETTINGS_REQUIRED':'Teknik yapılandırmayı yalnız MenüGO şirket yönetimi değiştirebilir.','LLM_NO_ELIGIBLE_FREE_ROUTE':'Bu işlem için uygun AI hizmeti şu anda kullanılamıyor. Biraz sonra yeniden deneyin.','LLM_KEY_INVALID':'AI hizmetine erişilemiyor. MenüGO desteğine bildirin.','OWNER_REQUIRED':'Bu işlem için MenüGO şirket yönetimi yetkisi gerekiyor.','LLM_FREE_PLAN_RECONFIRM':'Teknik bağlantının MenüGO şirket yönetimince kontrol edilmesi gerekiyor.'}
for key,value in replacements.items():s=re.sub(r' '+key+r":'[^']*'",' '+key+':'+repr(value),s)
s=s.replace('export const llmMessages:Record<string,string>={',"export const llmMessages:Record<string,string>={\n PLATFORM_ADMIN_REQUIRED:'Bu alan yalnız MenüGO şirket yönetimine açıktır.',");p.write_text(s)
p=root/'components/BusinessStudio.tsx';s=p.read_text().replace('Açık kaynak model bağlantısı doğrulanmadı. LLM Asistanı bölümünde kendi model sunucunuzu bağlayın; mevcut menü ve siparişler etkilenmez.','AI hizmetiniz MenüGO tarafından hazırlanıyor; mevcut menü ve siparişler etkilenmez.');p.write_text(s)
p=root/'components/FreeAiSettings.tsx';s=p.read_text().replace('({onSaved}:{onSaved:()=>void})','({onSaved,businessId,branchId}:{onSaved:()=>void;businessId:string;branchId:string})')
s=s.replace(' const [s,setS]'," const endpoint=(action:string)=>'/api/platform/ai/'+action+'?businessId='+encodeURIComponent(businessId)+'&branchId='+encodeURIComponent(branchId);\n const [s,setS]")
s=s.replace("'/api/llm/free-status'","endpoint('free-status')").replace("'/api/llm/free-save'","endpoint('free-save')").replace("'/api/llm/free-remove'","endpoint('free-remove')").replace('Ayarları yalnız işletme sahibi değiştirebilir.','Ayarları yalnız MenüGO şirket yönetimi değiştirebilir.');p.write_text(s)
p=root/'lib/llm/client.ts';s=p.read_text().replace('input:Record<string,unknown>){','input:Record<string,unknown>,target:{p_business_id:string;p_branch_id:string}=scope){').replace('businessId:scope.p_business_id,branchId:scope.p_branch_id','businessId:target.p_business_id,branchId:target.p_branch_id');p.write_text(s)
p=root/'lib/auth-destination.ts';s=p.read_text().replace("'/parola','/yardim'].includes","'/parola','/yardim','/platform/yapay-zeka'].includes");p.write_text(s)
p=root/'components/Login.tsx';s=p.read_text().replace(' async function submit(e:FormEvent)'," async function destination(){if(next?.split('?')[0]==='/platform/yapay-zeka'){try{await api('/api/platform/ai/context');return next;}catch{}}const membership=await api('/api/merchant/claim',{});return accountDestination(membership.role??null,role,next);}\n async function submit(e:FormEvent)")
s=s.replace("const membership=await api('/api/merchant/claim',{});location.assign(accountDestination(membership.role??null,role,next));",'location.assign(await destination());');p.write_text(s)
p=root/'tests/sql.integration.mjs';s=p.read_text();marker=' // Free-only routing: synthetic fixture credentials, no inference or billable calls.';assert marker in s;s=s.replace(marker," await (await import('./platform-ai-checks.mjs')).platformAiChecks({q,db,auth,check,rejects,b,br,users,op});\n\n"+marker).replace("'customer cannot manage routes',()=>free(),'MANAGER_REQUIRED'","'customer cannot manage routes',()=>free(),'PLATFORM_ADMIN_REQUIRED'");p.write_text(s)
p=root/'tests/llm-ui.integration.mjs';s=p.read_text();start=s.index(" const form=page.locator('.free-ai-settings form').first();");end=s.index(' for(const width',start);s=s[:start]+''' assert.equal(await page.locator('.free-ai-settings').count(),0);assert.equal(await page.getByLabel('API anahtarı',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Bağlantıyı test et'}).count(),0);checks.push('restaurant owner cannot see provider configuration or diagnostic controls');
 assert.equal(posts.filter(x=>x.path.includes('free-')||x.path==='/api/llm/test').length,0);checks.push('merchant screen performs no provider configuration calls');
 status={...status,configured:true,enabled:true,provider:'free_router',verified:true,canManage:false};await page.getByRole('button',{name:'Durumu yenile'}).click();await page.getByText('AI araçlarınız kullanıma hazır.',{exact:true}).waitFor();checks.push('company enabled service becomes usable without tenant API key');
'''+s[end:];p.write_text(s)
p=root/'public/release.json';v=json.loads(p.read_text());v['previous']=v['version'];v['version']='menugo-platform-ai-access-20260920-r27';v['platformAiConfigurationOnly']=True;v['restaurantAiConfiguration']=False;p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
p=root/'lib/config.ts';s=re.sub(r"export const RELEASE='[^']+';","export const RELEASE='menugo-platform-ai-access-20260920-r27';",p.read_text());p.write_text(s)
print('Platform source expanded; tests must pass before production deployment.')
