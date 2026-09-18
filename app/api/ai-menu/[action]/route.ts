import {after} from 'next/server';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {actor,rpc,scope,json,failed,origin,uuid,revision,Failure} from '@/lib/api';
import {fileKind,MAX_FILE,ImportError} from '@/lib/ai-menu/contracts';
import {validateReview} from '@/lib/ai-menu/review';
import {gatewayCredential,checkGatewayAccess,MODEL} from '@/lib/ai-menu/provider';
import {processImport} from '@/lib/ai-menu/worker';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=60;
async function input(req:Request,limit:number){
 if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Failure('JSON_REQUIRED',415);
 const reader=req.body?.getReader();if(!reader)throw new Failure('BODY_REQUIRED');let n=0;const chunks:Uint8Array[]=[];let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;void reader.cancel();},15000);
 try{for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>limit){await reader.cancel();throw new Failure('BODY_TOO_LARGE',413);}chunks.push(x.value);}if(timedOut)throw new Failure('BODY_TIMEOUT',408);const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw new Failure('INVALID_INPUT');return v as Record<string,unknown>;}catch(e){if(e instanceof Failure)throw e;throw new Failure('INVALID_JSON');}finally{clearTimeout(timer);}
}
async function manager(){const {s}=await actor();await rpc(s,'ai_menu_job',{...scope,p_action:'list'});return s;}
function error(e:unknown){if(e instanceof ImportError)return json({error:{code:e.code}},400);return failed(e);}
async function work(s:Awaited<ReturnType<typeof manager>>,id:string,retry=false){const token=await gatewayCredential();if(!token)throw new Failure('AI_NOT_CONFIGURED',503);await checkGatewayAccess(token);const claimed=await rpc(s,'ai_menu_job',{...scope,p_action:'claim',p_job_id:id,p_payload:{retry,model:MODEL}});if(claimed.claimed)after(async()=>{try{await processImport(s,id,claimed,token);}catch{console.error('MENUGO_AI_IMPORT_WORK_UNFINISHED');}});return claimed.claimed===true;}
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const s=await manager(),{action}=await params;const u=new URL(req.url);
 if(action==='list'){const data=await rpc(s,'ai_menu_job',{...scope,p_action:'list'});let reason:string|null=null;const token=await gatewayCredential();if(!token)reason='AI_NOT_CONFIGURED';else try{await checkGatewayAccess(token);}catch(e){reason=e instanceof ImportError?e.code:'AI_UNAVAILABLE';}return json({...data,aiConfigured:reason===null,aiUnavailableReason:reason,model:MODEL});}
 if(action==='source'){const v=await rpc(s,'ai_menu_job',{...scope,p_action:'source',p_job_id:uuid(u.searchParams.get('id'))});const b=Buffer.from(v.data,'base64');return new Response(b,{headers:{'Content-Type':v.mime,'Content-Disposition':v.mime==='application/pdf'?'attachment; filename="menu-source.pdf"':'inline','Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});}
 if(action==='snapshot')return json(await rpc(s,'ai_menu_job',{...scope,p_action:'snapshot',p_job_id:uuid(u.searchParams.get('id'))}));
 throw new Failure('NOT_FOUND',404);
 }catch(e){return error(e);}}
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){try{
 origin(req);const s=await manager(),{action}=await params;
 if(action==='upload'){
  const v=await input(req,2900000);const op=uuid(v.operationId);
  if(typeof v.fileName!=='string'||v.fileName.length>160||typeof v.data!=='string'||!v.data.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(v.data))throw new Failure('INVALID_INPUT');
  const b=Buffer.from(v.data,'base64');if(b.toString('base64')!==v.data)throw new Failure('INVALID_INPUT');const mime=fileKind(b);
  if(mime==='application/pdf'){try{const d=await PDFDocument.load(b,{updateMetadata:false});if(d.getPageCount()>8||d.getPageCount()<1)throw new ImportError('PDF_PAGE_LIMIT');}catch(e){if(e instanceof ImportError)throw e;throw new ImportError('INVALID_PDF');}}
  else{try{const meta=await sharp(b,{limitInputPixels:40000000}).metadata();if(!meta.width||!meta.height||meta.width*meta.height>40000000)throw new ImportError('UNSUPPORTED_FILE');}catch{throw new ImportError('UNSUPPORTED_FILE');}}
  if(b.length>MAX_FILE)throw new ImportError('FILE_SIZE_LIMIT');
  const result=await rpc(s,'ai_menu_job',{...scope,p_action:'create',p_payload:{operationId:op,fileName:v.fileName.replace(/[\u0000-\u001f]/g,'').trim()||'menü',mime,data:v.data}});
  if(!result.duplicate)await work(s,result.id);return json(result,202);
 }
 const v=await input(req,270000);const id=uuid(v.id);
 if(action==='process'){const claimed=await work(s,id,v.retry===true);return json({queued:claimed},202);}
 if(action==='save'||action==='apply'){const rows=validateReview(v.rows);return json(await rpc(s,'ai_menu_job',{...scope,p_action:action,p_job_id:id,p_payload:{revision:revision(v.revision),rows,confirmed:v.confirmed===true}}));}
 if(action==='undo'||action==='delete-source')return json(await rpc(s,'ai_menu_job',{...scope,p_action:action,p_job_id:id}));
 throw new Failure('NOT_FOUND',404);
 }catch(e){return error(e);}}
