import 'server-only';
import {getVercelOidcToken} from '@vercel/oidc';
import {validateDraft,extractionSchema,SYSTEM_PROMPT,ImportError} from './contracts';
export const MODEL='google/gemini-2.5-flash';
export async function gatewayCredential(){if(process.env.AI_GATEWAY_API_KEY)return process.env.AI_GATEWAY_API_KEY;try{return await getVercelOidcToken();}catch{return null;}}
/** Read-only readiness; never purchases credit or performs inference. */
export async function checkGatewayAccess(token:string){
 let response:Response;
 try{response=await fetch('https://ai-gateway.vercel.sh/v1/credits',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000),cache:'no-store'});}catch{throw new ImportError('AI_UNAVAILABLE');}
 if(!response.ok){await response.body?.cancel();throw new ImportError([401,403].includes(response.status)?'AI_ACCESS_REQUIRED':'AI_UNAVAILABLE');}
 let body:unknown;try{body=await response.json();}catch{throw new ImportError('AI_UNAVAILABLE');}
 const balance=(body as {balance?:unknown})?.balance;
 if(typeof balance!=='string'||!/^\d+(\.\d+)?$/.test(balance))throw new ImportError('AI_UNAVAILABLE');
 if(!/[1-9]/.test(balance))throw new ImportError('AI_CREDIT_REQUIRED');
}
export async function extractMenu(base64:string,mime:string,token:string){
 const attachment=mime==='application/pdf'?{type:'file',file:{filename:'menu.pdf',file_data:`data:${mime};base64,${base64}`}}:{type:'image_url',image_url:{url:`data:${mime};base64,${base64}`}};
 let r:Response;
 try{r=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:10000,temperature:0,stream:false,messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:[{type:'text',text:'Extract the attached menu. Preserve prices, portions and source snippets. Return a draft only.'},attachment]}],response_format:{type:'json_schema',json_schema:{name:'menu_draft',strict:true,schema:extractionSchema}}}),signal:AbortSignal.timeout(45000),cache:'no-store'});}catch{throw new ImportError('AI_RESULT_UNKNOWN');}
 if(!r.ok){await r.body?.cancel();throw new ImportError([401,403].includes(r.status)?'AI_ACCESS_REQUIRED':r.status===402?'AI_CREDIT_REQUIRED':r.status===429?'AI_RATE_LIMIT':'AI_UNAVAILABLE');}
 const reader=r.body?.getReader();if(!reader)throw new ImportError('AI_RESULT_UNKNOWN');let size=0,parts:Uint8Array[]=[];
 try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>350000){await reader.cancel();throw new ImportError('AI_OUTPUT_INCOMPLETE');}parts.push(v.value);}}catch(e){if(e instanceof ImportError)throw e;throw new ImportError('AI_RESULT_UNKNOWN');}
 let value:any;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new ImportError('INVALID_AI_RESULT');}
 const choice=value.choices?.[0];if(choice?.message?.refusal)throw new ImportError('AI_REFUSAL');if(choice?.finish_reason!=='stop')throw new ImportError('AI_OUTPUT_INCOMPLETE');
 let draft;try{draft=validateDraft(JSON.parse(choice.message.content));}catch(e){if(e instanceof ImportError)throw e;throw new ImportError('INVALID_AI_RESULT');}
 const usage=value.usage??{};const n=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?String(v):'0';
 return {draft,model:MODEL,inputTokens:n(usage.prompt_tokens),outputTokens:n(usage.completion_tokens),responseId:typeof value.id==='string'?value.id.slice(0,200):null};
}
