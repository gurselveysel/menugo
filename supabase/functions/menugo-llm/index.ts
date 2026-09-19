import {generate,validateRequest,readLimited,LlmError} from './core.ts';
const out=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const code=(e:unknown)=>e instanceof LlmError?e.code:'LLM_RESULT_UNKNOWN';
async function readBody(req:Request){const reader=req.body?.getReader();if(!reader)throw new LlmError('INVALID_LLM_REQUEST');let n=0;const parts:Uint8Array[]=[];const timer=setTimeout(()=>{void reader.cancel();},8000);try{for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>10000){await reader.cancel();throw new LlmError('BODY_TOO_LARGE',413);}parts.push(x.value);}const b=new Uint8Array(n);let i=0;for(const p of parts){b.set(p,i);i+=p.length;}return JSON.parse(new TextDecoder().decode(b));}catch(e){if(e instanceof LlmError)throw e;throw new LlmError('INVALID_LLM_REQUEST');}finally{clearTimeout(timer);}}
Deno.serve(async req=>{
 if(req.method!=='POST')return out({error:{code:'METHOD_NOT_ALLOWED'}},405);
 const url=Deno.env.get('SUPABASE_URL')!,anon=Deno.env.get('SUPABASE_ANON_KEY')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 let lease:{id:string;lease:string}|null=null;let generated=false;
 const db=async(name:string,args:unknown,token:string,admin=false)=>{
  const r=await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:admin?service:anon,Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Profile':'ops','Accept-Profile':'ops'},body:JSON.stringify(args),signal:AbortSignal.timeout(8000)});
  const v=await readLimited(r,3200000);if(!r.ok)throw new LlmError(typeof v.message==='string'&&/^[A-Z0-9_]{1,80}$/.test(v.message)?v.message:'LLM_DATABASE_UNAVAILABLE',/^PT\d{3}$/.test(v.code)?Number(v.code.slice(2)):503);return v;
 };
 try{
  // Explicit custom authentication, including valid user lookup. The public anon
  // key and service-role bearer are NOT accepted as an end-user identity.
  const header=req.headers.get('Authorization');if(!header?.startsWith('Bearer '))throw new LlmError('UNAUTHENTICATED',401);const token=header.slice(7);
  const a=await fetch(url+'/auth/v1/user',{headers:{apikey:anon,Authorization:header},signal:AbortSignal.timeout(6000)});
  if(!a.ok){await a.body?.cancel();throw new LlmError(a.status>=500?'AUTH_UNAVAILABLE':'UNAUTHENTICATED',a.status>=500?503:401);}
  const user=await a.json();if(!user.id)throw new LlmError('UNAUTHENTICATED',401);
  const v=validateRequest(await readBody(req));
  const claimed=await db('llm_claim',{p_business_id:v.businessId,p_branch_id:v.branchId,p_operation_id:v.operationId,p_kind:v.kind,p_request:v.request},token);
  if(!claimed.claimed){if(claimed.state==='succeeded'&&claimed.result)return out({...claimed,replayed:true});throw new LlmError(claimed.error||(['reserved','sending'].includes(claimed.state)?'LLM_IN_PROGRESS':'LLM_RESULT_UNKNOWN'),409);}
  lease={id:claimed.id,lease:claimed.lease};
  const d=await db('llm_dispatch',{p_run_id:lease.id,p_lease:lease.lease},service,true);
  const result=await generate(d);generated=true;
  // No key or request prompt is returned or logged.
  const saved=await db('llm_finish',{p_run_id:lease.id,p_lease:lease.lease,p_result:result.result,p_input:result.inputTokens,p_output:result.outputTokens},service,true);
  lease=null;return out({...saved,replayed:false});
 }catch(e){
  const error=generated?'LLM_SAVE_UNKNOWN':code(e);
  if(lease){try{await db('llm_finish',{p_run_id:lease.id,p_lease:lease.lease,p_error:error},service,true);}catch{/* Unknown retained by lease; never repeat a paid request automatically. */}}
  return out({error:{code:error}},e instanceof LlmError?e.status:503);
 }
});
