import {actor,rpc,scope,json,failed,origin,body,uuid,revision,Failure} from '@/lib/api';
import {llmStatus,invokeLlm,requireOpenSource} from '@/lib/llm/client';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=90;
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const {s}=await actor();const status=await llmStatus(s);const {action}=await params;
 if(action==='free-status')throw new Failure('PLATFORM_ADMIN_REQUIRED',403);
 if(action!=='status')throw new Failure('NOT_FOUND',404);
 const menu=await rpc(s,'ai_menu_job',{...scope,p_action:'list'});
 return json({...status,canManage:false,model:null,version:'0',testError:null,products:menu.catalogue.map((p:any)=>({id:p.id,name:p.name}))});
}catch(e){return failed(e);}}
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const {s}=await actor();const status=await llmStatus(s);const {action}=await params;const v=await body(req);
 if(['free-save','free-remove','settings','disconnect','test'].includes(action))throw new Failure('PLATFORM_ADMIN_REQUIRED',403);
 if(action==='ask'){
  await requireOpenSource(s);
  if(Object.keys(v).some(k=>!['operationId','task','question','productId','day'].includes(k))||typeof v.question!=='string'||v.question.length>1500||!['menu','description','translation','campaign','daily'].includes(String(v.task)))throw new Failure('INVALID_LLM_REQUEST');
  return json(await invokeLlm(s,uuid(v.operationId),'assistant',{task:v.task,question:v.question,productId:v.productId?uuid(v.productId):null,...(v.day?{day:v.day}:{})}));
 }
 throw new Failure('NOT_FOUND',404);
}catch(e){return failed(e);}}
