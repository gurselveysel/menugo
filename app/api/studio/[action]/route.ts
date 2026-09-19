import {after} from 'next/server';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import {actor,rpc,scope,json,failed,origin,uuid,revision,Failure} from '@/lib/api';
import {gatewayCredential,checkGatewayAccess} from '@/lib/ai-menu/provider';
import {fileKind,ImportError} from '@/lib/ai-menu/contracts';
import {runStudio,type StudioInput,IMAGE_MODEL,TEXT_MODEL} from '@/lib/studio/gateway';
import {STUDIO_KINDS,type StudioKind} from '@/src/studio/contracts';
import {StudioError} from '@/src/studio/operations';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
async function input(req:Request){
 if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Failure('JSON_REQUIRED',415);
 const r=req.body?.getReader();if(!r)throw new Failure('BODY_REQUIRED');let n=0,timed=false;const chunks:Uint8Array[]=[];
 const timer=setTimeout(()=>{timed=true;void r.cancel();},15000);
 try{for(;;){const v=await r.read();if(v.done)break;n+=v.value.length;if(n>2900000){await r.cancel();throw new Failure('BODY_TOO_LARGE',413);}chunks.push(v.value);}if(timed)throw new Failure('BODY_TIMEOUT',408);const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw new Failure('INVALID_INPUT');return v as Record<string,any>;}catch(e){if(e instanceof Failure)throw e;throw new Failure('INVALID_INPUT');}finally{clearTimeout(timer);}
}
async function manager(){const {s}=await actor();await rpc(s,'studio_job',{...scope,p_action:'list'});return s;}
async function credential(){const token=await gatewayCredential();if(!token)throw new Failure('AI_ACCESS_REQUIRED',503);await checkGatewayAccess(token);return token;}
function safeError(e:unknown){if(e instanceof StudioError||e instanceof ImportError)return json({error:{code:e.code}},e.code==='AI_ACCESS_REQUIRED'||e.code==='AI_CREDIT_REQUIRED'?503:400);return failed(e);}
async function start(s:Awaited<ReturnType<typeof manager>>,id:string,token:string){
 const claim=await rpc(s,'studio_job',{...scope,p_action:'claim',p_job_id:id});
 if(claim.claimed)after(async()=>{
  try{
   const result=await runStudio({kind:claim.kind,sources:claim.sources,language:claim.input.language,style:claim.input.style,attachment:claim.input.attachment} as StudioInput,token);
   if(result.draft.kind==='photo-enhance'){
    const meta=await sharp(Buffer.from(result.draft.data,'base64'),{limitInputPixels:40000000}).metadata();
    if(!meta.width||!meta.height||meta.width*meta.height>40000000)throw new StudioError('INVALID_IMAGE_OUTPUT');
    const bytes=await sharp(Buffer.from(result.draft.data,'base64'),{limitInputPixels:40000000}).rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).webp({quality:90}).toBuffer();
    result.draft.data=bytes.toString('base64');result.draft.mime='image/webp';
   }
   await rpc(s,'studio_job',{...scope,p_action:'finish',p_job_id:id,p_payload:{lease:claim.lease,...result}});
  }catch(e){
   const code=e instanceof StudioError?e.code:'AI_SAVE_UNKNOWN';
   try{await rpc(s,'studio_job',{...scope,p_action:'finish',p_job_id:id,p_payload:{lease:claim.lease,error:code}});}catch{console.error('MENUGO_STUDIO_UNFINISHED');}
  }
 });
 return claim.claimed===true;
}
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){
 try{origin(req);const s=await manager(),{action}=await params;
  if(action==='list'){const data=await rpc(s,'studio_job',{...scope,p_action:'list'});let reason:string|null=null;try{await credential();}catch(e){reason=e instanceof Error?e.message:'AI_UNAVAILABLE';}return json({...data,aiReady:reason===null,aiReason:reason,models:{text:TEXT_MODEL,image:IMAGE_MODEL},limits:{daily:10,images:3},sourceRetentionDays:7});}
  const id=uuid(new URL(req.url).searchParams.get('id'));
  if(action==='get'){const j=await rpc(s,'studio_job',{...scope,p_action:'get',p_job_id:id});if(j.result?.kind==='photo-enhance'){delete j.result.data;j.result.imageUrl=`/api/studio/image?id=${encodeURIComponent(id)}`;}return json(j);}
  if(action==='image'||action==='source'){
   const v=action==='source'?await rpc(s,'studio_job',{...scope,p_action:'source',p_job_id:id}):(await rpc(s,'studio_job',{...scope,p_action:'get',p_job_id:id})).result;
   if(!v||typeof v.data!=='string'||!['image/png','image/jpeg','image/webp','application/pdf'].includes(v.mime))throw new Failure('NOT_FOUND',404);
   return new Response(Buffer.from(v.data,'base64'),{headers:{'Content-Type':v.mime,'Content-Disposition':v.mime==='application/pdf'?'attachment; filename="invoice-source.pdf"':'inline','Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  }
  throw new Failure('NOT_FOUND',404);
 }catch(e){return safeError(e);}
}
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){
 try{origin(req);const s=await manager(),{action}=await params;const v=await input(req);
  if(action==='create'){
   if(Object.keys(v).some(k=>!['operationId','kind','productId','language','style','data'].includes(k))||!STUDIO_KINDS.includes(v.kind)||!['tr','en'].includes(v.language)||!['white','cafe','dark-gold'].includes(v.style))throw new Failure('INVALID_INPUT');
   const token=await credential(),operationId=uuid(v.operationId),kind=v.kind as StudioKind;
   const request:Record<string,unknown>={language:v.language,style:v.style};
   if(kind!=='invoice')request.productId=uuid(v.productId);
   if(kind==='invoice'||kind==='photo-enhance'){
    if(typeof v.data!=='string'||v.data.length>2796204||!/^[A-Za-z0-9+/]+={0,2}$/.test(v.data))throw new Failure('INVALID_INPUT');
    const bytes=Buffer.from(v.data,'base64');if(bytes.toString('base64')!==v.data)throw new Failure('INVALID_INPUT');const mime=fileKind(bytes);let pages=1;
    if(mime==='application/pdf'){
     if(kind==='photo-enhance')throw new Failure('PHOTO_REQUIRED');
     const d=await PDFDocument.load(bytes,{updateMetadata:false});pages=d.getPageCount();if(pages<1||pages>8)throw new Failure('PDF_PAGE_LIMIT');
    }else{const m=await sharp(bytes,{limitInputPixels:40000000}).metadata();if(!m.width||!m.height||m.width*m.height>40000000)throw new Failure('INVALID_IMAGE');}
    request.attachment={mime,data:v.data,pages};
   }else if(v.data!==undefined)throw new Failure('UNEXPECTED_ATTACHMENT');
   const result=await rpc(s,'studio_job',{...scope,p_action:'create',p_payload:{operationId,kind,input:request}});
   if(!result.duplicate)await start(s,result.id,token);return json(result,202);
  }
  const id=uuid(v.id);
  if(action==='process'){const token=await credential();return json({started:await start(s,id,token)},202);}
  if(action==='approve')return json(await rpc(s,'studio_job',{...scope,p_action:'approve',p_job_id:id,p_payload:{revision:revision(v.revision),comparedOriginal:v.comparedOriginal===true}}));
  if(action==='discard')return json(await rpc(s,'studio_job',{...scope,p_action:'discard',p_job_id:id}));
  throw new Failure('NOT_FOUND',404);
 }catch(e){return safeError(e);}
}
