import 'server-only';
import {StudioError} from '@/src/studio/operations';
import {COPY_SCHEMA, INVOICE_SCHEMA, STUDIO_PROMPT, parseCopy, parseInvoice, photoInstruction, type ProductSource, type StudioKind, type PhotoStyle} from '@/src/studio/contracts';
export const TEXT_MODEL = 'google/gemini-2.5-flash';
export const IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview';
export interface StudioInput {kind:StudioKind; sources:ProductSource[]; language:'tr'|'en'; style:PhotoStyle; attachment?:{mime:string;data:string;pages:number}}
export async function readBounded(response:Response,limit:number):Promise<unknown>{
 const reader=response.body?.getReader();if(!reader)throw new StudioError('AI_RESULT_UNKNOWN');const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>limit){await reader.cancel();throw new StudioError('AI_OUTPUT_TOO_LARGE');}chunks.push(p.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(e){if(e instanceof StudioError)throw e;throw new StudioError('AI_RESULT_UNKNOWN');}
}
export function buildStudioRequest(input:StudioInput){
 const image=input.kind==='photo-enhance';
 if(image&&(!input.attachment||!['image/jpeg','image/png','image/webp'].includes(input.attachment.mime)))throw new StudioError('PHOTO_REQUIRED');
 if(input.kind==='invoice'&&!input.attachment)throw new StudioError('INVOICE_REQUIRED');
 if(!image&&input.kind!=='invoice'&&!input.sources.length)throw new StudioError('PRODUCT_REQUIRED');
 const task=input.kind==='invoice'?'Extract only the invoice facts visible in this original document. Retain original quantity/unit strings; never assume net vs tax-included amounts. Omit bank/account/customer addresses and personal data. Each item needs page number and a verbatim short source snippet. Unknown fields are null. Do not calculate VAT or infer tax rates.':image?photoInstruction(input.style):JSON.stringify({task:input.kind,language:input.language,sources:input.sources});
 const content:unknown[]=[{type:'text',text:task}];
 if(input.attachment){const a=input.attachment;content.push(a.mime==='application/pdf'?{type:'file',file:{filename:'source.pdf',file_data:`data:${a.mime};base64,${a.data}`}}:{type:'image_url',image_url:{url:`data:${a.mime};base64,${a.data}`}});}
 return {model:image?IMAGE_MODEL:TEXT_MODEL,stream:false,max_tokens:image?3000:10000,messages:[{role:'system',content:STUDIO_PROMPT},{role:'user',content}],...(image?{modalities:['text','image']}:{temperature:0,response_format:{type:'json_schema',json_schema:{name:'studio_draft',strict:true,schema:input.kind==='invoice'?INVOICE_SCHEMA:COPY_SCHEMA}}})};
}
/** One external attempt; network ambiguity MUST NOT trigger an automatic billable retry. */
export async function runStudio(input:StudioInput,credential:string){
 const request=buildStudioRequest(input);let response:Response;
 try{response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(60000),redirect:'error',cache:'no-store'});}catch{throw new StudioError('AI_RESULT_UNKNOWN');}
 if(!response.ok){await response.body?.cancel();throw new StudioError([401,403].includes(response.status)?'AI_ACCESS_REQUIRED':response.status===402?'AI_CREDIT_REQUIRED':response.status===429?'AI_RATE_LIMIT':'AI_RESULT_UNKNOWN');}
 const value=await readBounded(response,input.kind==='photo-enhance'?14500000:400000) as Record<string,any>;
 const choice=value?.choices?.[0],message=choice?.message;
 if(message?.refusal)throw new StudioError('AI_REFUSAL');
 if(choice?.finish_reason!=='stop'||!message)throw new StudioError('AI_OUTPUT_INCOMPLETE');
 const usage=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?String(v):'0';
 const meta={model:request.model,inputTokens:usage(value.usage?.prompt_tokens),outputTokens:usage(value.usage?.completion_tokens)};
 if(input.kind==='photo-enhance'){
  if(!Array.isArray(message.images)||message.images.length!==1||message.images[0]?.type!=='image_url')throw new StudioError('INVALID_IMAGE_OUTPUT');
  const url=message.images[0]?.image_url?.url;
  if(typeof url!=='string')throw new StudioError('INVALID_IMAGE_OUTPUT');
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if(!match)throw new StudioError('INVALID_IMAGE_OUTPUT');
  const bytes=Buffer.from(match[2]!,'base64');
  if(bytes.length<12||bytes.length>10485760||bytes.toString('base64')!==match[2])throw new StudioError('INVALID_IMAGE_OUTPUT');
  return {...meta,draft:{kind:'photo-enhance' as const,mime:match[1]!,data:match[2]!,draftOnly:true,requiresOriginalComparison:true}};
 }
 let parsed:unknown;try{parsed=JSON.parse(message.content);}catch{throw new StudioError('INVALID_DRAFT');}
 return {...meta,draft:input.kind==='invoice'?parseInvoice(parsed,input.attachment?.pages??8):parseCopy(input.kind,parsed,input.sources)};
}
