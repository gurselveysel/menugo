import {actor,rpc,json,failed,origin,body,uuid,revision,Failure} from '@/lib/api';
import {invokeLlm} from '@/lib/llm/client';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=90;
const target=(req:Request)=>{const q=new URL(req.url).searchParams;return {p_business_id:uuid(q.get('businessId')),p_branch_id:uuid(q.get('branchId'))};};
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){
 try{
  origin(req);const {s}=await actor();await rpc(s,'platform_principal');
  const {action}=await params;
  if(action==='context')return json(await rpc(s,'platform_ai_console'));
  const scope=target(req);
  if(action==='free-status')return json(await rpc(s,'free_ai_settings',{...scope,p_action:'status'}));
  if(action==='status')return json(await rpc(s,'llm_settings',{...scope,p_action:'status'}));
  throw new Failure('NOT_FOUND',404);
 }catch(e){return failed(e);}
}
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){
 try{
  origin(req);const {s}=await actor();await rpc(s,'platform_principal');
  const {action}=await params,scope=target(req),v=await body(req);
  if(action==='free-save'||action==='free-remove'){
   const fields=action==='free-save'?['version','provider','model','apiKey','priority','dailyLimit','accountId','enabled','publicContentAllowed','privateContentAllowed','freePlanConfirmed','consent']:['version','provider'];
   if(Object.keys(v).some(k=>!fields.includes(k)))throw new Failure('INVALID_LLM_SETTINGS');
   revision(v.version);
   return json(await rpc(s,'free_ai_settings',{...scope,p_action:action==='free-save'?'save':'remove',p_payload:v}));
  }
  if(action==='test'){
   if(Object.keys(v).some(k=>k!=='operationId'))throw new Failure('INVALID_LLM_REQUEST');
   // llm_claim checks current platform membership again; Edge dispatch does too.
   return json(await invokeLlm(s,uuid(v.operationId),'test',{},scope));
  }
  throw new Failure('NOT_FOUND',404);
 }catch(e){return failed(e);}
}
