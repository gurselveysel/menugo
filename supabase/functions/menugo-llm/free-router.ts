import {generate,readLimited,LlmError,preparePrompt,parseAnswer,type Dispatch} from './core.ts';
import {sortedRoutes,assertFreeWire,CLOUDFLARE_TEXT_MODEL,type FreeRoute} from './free-policy.ts';
import {photoInstruction,parseCopy} from './studio-contracts.ts';
export type RoutingDispatch=Dispatch&{routes:FreeRoute[]};
export interface RoutingHooks {
 before:(route:FreeRoute)=>Promise<boolean>;
 after:(route:FreeRoute,outcome:'success'|'rejected'|'unknown',code:string|null,model:string|null)=>Promise<void>;
}
const bytesToBase64=(bytes:Uint8Array)=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
const cloudflareAccount=(r:FreeRoute)=>{if(!r.accountId||!(/^[a-f0-9]{32}$/i).test(r.accountId))throw new LlmError('LLM_ACCOUNT_REQUIRED');return r.accountId;};
export async function cloudflareImage(d:Dispatch,r:FreeRoute,fetcher:typeof fetch=fetch){
 assertFreeWire(r);const accountId=cloudflareAccount(r);
 const a=d.context?.input?.modelAttachment||d.context?.input?.attachment;
 if(d.kind!=='test'&&(!a||!['image/png','image/jpeg','image/webp'].includes(a.mime)||typeof a.data!=='string'||a.data.length>2796204||!(/^[A-Za-z0-9+/]+={0,2}$/).test(a.data)))throw new LlmError('INVALID_LLM_REQUEST');
 const form=new FormData();form.set('prompt',d.kind==='test'?'A small blue circle on a plain white background, no text.':photoInstruction(d.context.input.style));form.set('width',d.kind==='test'?'256':'1024');form.set('height',d.kind==='test'?'256':'1024');
 if(d.kind!=='test'){const bytes=Uint8Array.from(atob(a.data),c=>c.charCodeAt(0));form.set('input_image_0',new Blob([bytes],{type:a.mime}),'source');}
 let response:Response;
 try{response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${r.model}`,{method:'POST',headers:{Authorization:`Bearer ${r.key}`},body:form,redirect:'error',signal:AbortSignal.timeout(40000)});}catch{throw new LlmError('LLM_RESULT_UNKNOWN',503);}
 if(!response.ok){await response.body?.cancel();throw new LlmError(response.status===429?'LLM_RATE_LIMIT':[401,403].includes(response.status)?'LLM_KEY_INVALID':response.status===402?'LLM_CREDIT_REQUIRED':'LLM_PROVIDER_UNAVAILABLE',503);}
 const v=await readLimited(response,5800000);const data=v?.result?.image;
 if(v.success===false||typeof data!=='string'||data.length>5500000||!(/^[A-Za-z0-9+/]+={0,2}$/).test(data))throw new LlmError('LLM_INVALID_OUTPUT');
 let b:Uint8Array;try{b=Uint8Array.from(atob(data),c=>c.charCodeAt(0));}catch{throw new LlmError('LLM_INVALID_OUTPUT');}
 const png=b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71,jpg=b[0]===255&&b[1]===216&&b[2]===255,webp=new TextDecoder().decode(b.subarray(0,4))==='RIFF'&&new TextDecoder().decode(b.subarray(8,12))==='WEBP';
 if(!png&&!jpg&&!webp)throw new LlmError('LLM_INVALID_OUTPUT');
 return {provider:r.provider,model:r.model,result:d.kind==='test'?{verified:true}:{draft:{kind:'photo-enhance',mime:png?'image/png':jpg?'image/jpeg':'image/webp',data:bytesToBase64(b),draftOnly:true}},inputTokens:'0',outputTokens:'0'};
}
/** Text-only fallback on the same Workers Free credential. No attachment is forwarded here. */
export async function cloudflareText(d:Dispatch,r:FreeRoute,fetcher:typeof fetch=fetch){
 assertFreeWire(r);const accountId=cloudflareAccount(r);const prepared=preparePrompt(d);
 if(prepared.attachment||d.kind==='menu-extract'||(d.kind==='studio'&&!['product-copy','translation','campaign'].includes(d.context?.studioKind))||!['test','assistant','studio'].includes(d.kind))throw new LlmError('LLM_CAPABILITY_UNAVAILABLE',409);
 const body={model:CLOUDFLARE_TEXT_MODEL,stream:false,max_completion_tokens:d.kind==='test'?256:prepared.max,response_format:{type:'json_schema',json_schema:{name:'menugo_draft',strict:true,schema:prepared.schema}},messages:[{role:'system',content:prepared.prompt},{role:'user',content:prepared.text}],temperature:0,options:{rejectIfBusy:true}};
 let response:Response,value:any;
 try{response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${r.key}`,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(40000)});try{value=await readLimited(response);}catch(e){if(response.ok)throw e;value={};}}catch(e){if(e instanceof LlmError)throw e;throw new LlmError('LLM_RESULT_UNKNOWN',503);}
 if(!response.ok){const paid=Array.isArray(value?.errors)&&value.errors.some((x:any)=>x?.code===5035);throw new LlmError(paid||response.status===402?'LLM_CREDIT_REQUIRED':response.status===429?'LLM_RATE_LIMIT':[401,403].includes(response.status)?'LLM_KEY_INVALID':'LLM_PROVIDER_UNAVAILABLE',503);}
 const c=value?.choices?.[0];if(c?.message?.refusal)throw new LlmError('LLM_REFUSAL');if(c?.finish_reason!=='stop'||typeof c?.message?.content!=='string'||c.message.tool_calls?.length)throw new LlmError('LLM_OUTPUT_INCOMPLETE',502);
 let parsed:any;try{parsed=JSON.parse(c.message.content);}catch{throw new LlmError('LLM_INVALID_OUTPUT',502);}
 let result:any;
 if(d.kind==='test'){if(parsed.status!=='MENUGO_OK')throw new LlmError('LLM_TEST_FAILED');result={verified:true};}
 else if(d.kind==='studio'){try{result={draft:parseCopy(d.context.studioKind,parsed,d.context.sources)};}catch{throw new LlmError('LLM_INVALID_OUTPUT',502);}}
 else {const grounding=prepared.grounding!;const answer=parseAnswer(parsed,grounding.sources);result={...answer,sources:grounding.sources.filter(x=>answer.sourceIds.includes(x.id)),sourceScope:grounding.sourceScope,capturedAt:grounding.capturedAt,draftOnly:true};}
 const tokens=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0?String(n):'0';return {provider:r.provider,model:CLOUDFLARE_TEXT_MODEL,result,inputTokens:tokens(value.usage?.prompt_tokens),outputTokens:tokens(value.usage?.completion_tokens)};
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
   const photo=d.kind==='studio'&&d.context?.studioKind==='photo-enhance';
   const result=route.provider==='cloudflare_free'?(photo?await cloudflareImage(d,route,timedFetch):await cloudflareText(d,route,timedFetch)):await generate({...d,...route},timedFetch);
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
