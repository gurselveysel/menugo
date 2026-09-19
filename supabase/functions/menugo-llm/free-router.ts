import {generate,readLimited,LlmError,type Dispatch} from './core.ts';
import {sortedRoutes,assertFreeWire,type FreeRoute} from './free-policy.ts';
import {photoInstruction} from './studio-contracts.ts';
export type RoutingDispatch=Dispatch&{routes:FreeRoute[]};
export interface RoutingHooks {
 before:(route:FreeRoute)=>Promise<boolean>;
 after:(route:FreeRoute,outcome:'success'|'rejected'|'unknown',code:string|null,model:string|null)=>Promise<void>;
}
const bytesToBase64=(bytes:Uint8Array)=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
export async function cloudflareImage(d:Dispatch,r:FreeRoute,fetcher:typeof fetch=fetch){
 assertFreeWire(r);
 if(!r.accountId||!(/^[a-f0-9]{32}$/i).test(r.accountId))throw new LlmError('LLM_ACCOUNT_REQUIRED');
 const a=d.context?.input?.modelAttachment||d.context?.input?.attachment;
 if(d.kind!=='test'&&(!a||!['image/png','image/jpeg','image/webp'].includes(a.mime)||typeof a.data!=='string'||a.data.length>2796204||!(/^[A-Za-z0-9+/]+={0,2}$/).test(a.data)))throw new LlmError('INVALID_LLM_REQUEST');
 const form=new FormData();form.set('prompt',d.kind==='test'?'A small blue circle on a plain white background, no text.':photoInstruction(d.context.input.style));form.set('width',d.kind==='test'?'256':'1024');form.set('height',d.kind==='test'?'256':'1024');
 if(d.kind!=='test'){const bytes=Uint8Array.from(atob(a.data),c=>c.charCodeAt(0));form.set('input_image_0',new Blob([bytes],{type:a.mime}),'source');}
 let response:Response;
 try{response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${r.accountId}/ai/run/${r.model}`,{method:'POST',headers:{Authorization:`Bearer ${r.key}`},body:form,redirect:'error',signal:AbortSignal.timeout(40000)});}catch{throw new LlmError('LLM_RESULT_UNKNOWN',503);}
 if(!response.ok){await response.body?.cancel();throw new LlmError(response.status===429?'LLM_RATE_LIMIT':[401,403].includes(response.status)?'LLM_KEY_INVALID':response.status===402?'LLM_CREDIT_REQUIRED':'LLM_PROVIDER_UNAVAILABLE',503);}
 const v=await readLimited(response,5800000);const data=v?.result?.image;
 if(v.success===false||typeof data!=='string'||data.length>5500000||!(/^[A-Za-z0-9+/]+={0,2}$/).test(data))throw new LlmError('LLM_INVALID_OUTPUT');
 let b:Uint8Array;try{b=Uint8Array.from(atob(data),c=>c.charCodeAt(0));}catch{throw new LlmError('LLM_INVALID_OUTPUT');}
 const png=b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71,jpg=b[0]===255&&b[1]===216&&b[2]===255,webp=new TextDecoder().decode(b.subarray(0,4))==='RIFF'&&new TextDecoder().decode(b.subarray(8,12))==='WEBP';
 if(!png&&!jpg&&!webp)throw new LlmError('LLM_INVALID_OUTPUT');
 return {provider:r.provider,model:r.model,result:d.kind==='test'?{verified:true}:{draft:{kind:'photo-enhance',mime:png?'image/png':jpg?'image/jpeg':'image/webp',data:bytesToBase64(b),draftOnly:true}},inputTokens:'0',outputTokens:'0'};
}
/** At most one attempt/provider, no transport-uncertainty retry or refusal bypass. */
export async function generateFree(d:RoutingDispatch,hooks:RoutingHooks,fetcher:typeof fetch=fetch){
 const deadline=AbortSignal.timeout(45000);
 const timedFetch:typeof fetch=(url,init)=>fetcher(url,{...init,signal:AbortSignal.any([deadline,...(init?.signal?[init.signal]:[])])});
 const routes=sortedRoutes(d.routes||[],d.kind,d.context,d.request);
 if(!routes.length)throw new LlmError('LLM_NO_ELIGIBLE_FREE_ROUTE',409);
 for(const route of routes){
  if(deadline.aborted)throw new LlmError('LLM_RESULT_UNKNOWN',503);
  if(!await hooks.before(route))continue;
  try{
   const result=route.provider==='cloudflare_free'?await cloudflareImage(d,route,timedFetch):await generate({...d,...route},timedFetch);
   await hooks.after(route,'success',null,result.model);
   return result;
  }catch(e){
   const code=e instanceof LlmError?e.code:'LLM_RESULT_UNKNOWN';
   // Only explicit quota/auth/capability rejection may choose another provider.
   const rejected=['LLM_RATE_LIMIT','LLM_KEY_INVALID','LLM_CAPABILITY_UNAVAILABLE','LLM_PDF_PAGES_REQUIRED','LLM_CREDIT_REQUIRED'].includes(code);
   await hooks.after(route,rejected?'rejected':'unknown',code,null);
   if(!rejected)throw e;
  }
 }
 throw new LlmError('LLM_FREE_QUOTA_WAIT',429);
}
