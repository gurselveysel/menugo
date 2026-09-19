import 'server-only';
import {type client,rpc,scope,Failure} from '@/lib/api';
import type {LlmStatus} from './messages';
export async function llmStatus(s:Awaited<ReturnType<typeof client>>):Promise<LlmStatus>{return rpc(s,'llm_settings',{...scope,p_action:'status'});}
/** Only the user's verified session goes to the Edge bridge; never a provider key. */
export async function invokeLlm(s:Awaited<ReturnType<typeof client>>,operationId:string,kind:'test'|'assistant'|'menu-extract'|'studio',input:Record<string,unknown>){
 const {data,error}=await s.auth.getSession();if(error||!data.session)throw new Failure('UNAUTHENTICATED',401);
 const base=process.env.SUPABASE_SERVER_URL||process.env.NEXT_PUBLIC_SUPABASE_URL;if(!base)throw new Failure('LLM_CONNECTION_UNAVAILABLE',503);
 let response:Response;
 try{response=await fetch(base.replace(/\/$/,'')+'/functions/v1/menugo-llm',{method:'POST',headers:{Authorization:'Bearer '+data.session.access_token,apikey:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,'Content-Type':'application/json'},body:JSON.stringify({businessId:scope.p_business_id,branchId:scope.p_branch_id,operationId,kind,input}),signal:AbortSignal.timeout(65000),cache:'no-store',redirect:'error'});}catch{throw new Failure('LLM_RESULT_UNKNOWN',503);}
 const reader=response.body?.getReader();if(!reader)throw new Failure('LLM_RESULT_UNKNOWN',503);const parts:Uint8Array[]=[];let length=0;
 try{for(;;){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>350000){await reader.cancel();throw new Failure('LLM_INVALID_OUTPUT',502);}parts.push(r.value);}const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!response.ok)throw new Failure(/^[A-Z0-9_]{1,80}$/.test(value?.error?.code)?value.error.code:'LLM_CONNECTION_UNAVAILABLE',response.status);return value;}catch(e){if(e instanceof Failure)throw e;throw new Failure('LLM_RESULT_UNKNOWN',503);}
}

/** Explicit free/open-model policy. Status reads do not call any model or credit endpoint. */
export async function requireOpenSource(s:Awaited<ReturnType<typeof client>>,kind?:string){
 const status=await llmStatus(s);
 if(!status.configured)throw new Failure('LLM_SERVER_REQUIRED',503);
 if(!['self_hosted','openrouter_free'].includes(status.provider||''))throw new Failure('LLM_OPEN_SOURCE_REQUIRED',409);
 if(!status.enabled)throw new Failure('LLM_DISABLED',409);
 if(kind==='photo-enhance')throw new Failure('LLM_IMAGE_ENGINE_REQUIRED',409);
 if(kind!=='test'&&!status.verified)throw new Failure('LLM_TEST_REQUIRED',409);
 return status;
}
