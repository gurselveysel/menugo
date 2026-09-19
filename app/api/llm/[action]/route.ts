import {actor,rpc,scope,json,failed,origin,body,uuid,revision,Failure} from '@/lib/api';
import {llmStatus,invokeLlm,requireOpenSource} from '@/lib/llm/client';
import {llmModels} from '@/lib/llm/messages';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=90;
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const {s}=await actor();const status=await llmStatus(s);const {action}=await params;
 if(action!=='status')throw new Failure('NOT_FOUND',404);
 const menu=await rpc(s,'ai_menu_job',{...scope,p_action:'list'});
 return json({...status,products:menu.catalogue.map((p:any)=>({id:p.id,name:p.name})),models:llmModels});
}catch(e){return failed(e);}}
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const {s}=await actor();const status=await llmStatus(s);const {action}=await params;const v=await body(req);
 if(action==='settings'){
  if(!status.canManage)throw new Failure('OWNER_REQUIRED',403);
  if(Object.keys(v).some(k=>!['version','provider','model','apiKey','dailyLimit','enabled','consent'].includes(k)))throw new Failure('INVALID_LLM_SETTINGS');
  if(v.provider!=='self_hosted'||typeof v.model!=='string'||!(llmModels as Record<string,readonly (readonly string[])[]>)[String(v.provider)]?.some(x=>x[0]===v.model)||!Number.isInteger(v.dailyLimit)||Number(v.dailyLimit)<1||Number(v.dailyLimit)>100||typeof v.enabled!=='boolean'||v.consent!==true)throw new Failure('INVALID_LLM_SETTINGS');
  if(v.apiKey!==undefined&&(typeof v.apiKey!=='string'||v.apiKey.length>512||/[\s\u0000-\u001f]/.test(v.apiKey)))throw new Failure('INVALID_LLM_KEY');
  return json(await rpc(s,'llm_settings',{...scope,p_action:'save',p_payload:{...v,version:revision(v.version)}}));
 }
 if(action==='disconnect'){if(!status.canManage)throw new Failure('OWNER_REQUIRED',403);return json(await rpc(s,'llm_settings',{...scope,p_action:'disconnect',p_payload:{version:revision(v.version)}}));}
 if(action==='test'){await requireOpenSource(s,'test');return json(await invokeLlm(s,uuid(v.operationId),'test',{}));}
 if(action==='ask'){
  await requireOpenSource(s);
  if(Object.keys(v).some(k=>!['operationId','task','question','productId','day'].includes(k))||typeof v.question!=='string'||v.question.length>1500||!['menu','description','translation','campaign','daily'].includes(String(v.task)))throw new Failure('INVALID_LLM_REQUEST');
  return json(await invokeLlm(s,uuid(v.operationId),'assistant',{task:v.task,question:v.question,productId:v.productId?uuid(v.productId):null,...(v.day?{day:v.day}:{})}));
 }
 throw new Failure('NOT_FOUND',404);
}catch(e){return failed(e);}}
