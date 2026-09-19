import {actor,rpc,scope,json,failed,origin,body,uuid,revision,Failure} from '@/lib/api';
import {llmStatus,invokeLlm,requireOpenSource} from '@/lib/llm/client';
import {llmModels} from '@/lib/llm/messages';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=90;
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const {s}=await actor();const status=await llmStatus(s);const {action}=await params;
 if(action==='free-status')return json(await rpc(s,'free_ai_settings',{...scope,p_action:'status'}));
 if(action!=='status')throw new Failure('NOT_FOUND',404);
 const menu=await rpc(s,'ai_menu_job',{...scope,p_action:'list'});
 return json({...status,products:menu.catalogue.map((p:any)=>({id:p.id,name:p.name})),models:llmModels});
}catch(e){return failed(e);}}
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const {s}=await actor();const status=await llmStatus(s);const {action}=await params;const v=await body(req);
 if(action==='free-save'||action==='free-remove'){
   const allowed=['version','provider','model','apiKey','priority','dailyLimit','accountId','enabled','publicContentAllowed','privateContentAllowed','freePlanConfirmed','consent'];
   if(Object.keys(v).some(k=>!allowed.includes(k)))throw new Failure('INVALID_LLM_SETTINGS');
   revision(v.version);
   return json(await rpc(s,'free_ai_settings',{...scope,p_action:action==='free-save'?'save':'remove',p_payload:v}));
  }
  if(action==='settings')throw new Failure('LLM_FREE_SETTINGS_REQUIRED',409);
 if(action==='disconnect'){if(!status.canManage)throw new Failure('OWNER_REQUIRED',403);return json(await rpc(s,'llm_settings',{...scope,p_action:'disconnect',p_payload:{version:revision(v.version)}}));}
 if(action==='test'){await requireOpenSource(s,'test');return json(await invokeLlm(s,uuid(v.operationId),'test',{}));}
 if(action==='ask'){
  await requireOpenSource(s);
  if(Object.keys(v).some(k=>!['operationId','task','question','productId','day'].includes(k))||typeof v.question!=='string'||v.question.length>1500||!['menu','description','translation','campaign','daily'].includes(String(v.task)))throw new Failure('INVALID_LLM_REQUEST');
  return json(await invokeLlm(s,uuid(v.operationId),'assistant',{task:v.task,question:v.question,productId:v.productId?uuid(v.productId):null,...(v.day?{day:v.day}:{})}));
 }
 throw new Failure('NOT_FOUND',404);
}catch(e){return failed(e);}}
