/** Only identifiers/version proofs cross the write boundary, never model text or prices. */
export class PublicationInputError extends Error {
 constructor(public readonly code: string) { super(code); this.name='PublicationInputError'; }
}
export type PublicationAction='preview'|'apply'|'undo';
export type PublicationItem={jobId:string;jobRevision:string;sourceHash:string;overlayVersion:string};
export type PreviewRow=PublicationItem & {productId:string;productName:string;language:'tr'|'en';before:{title:string|null;body:string|null};after:{title:string|null;body:string};ready:boolean;reason:string|null};
export type PublicationCommand={action:'apply';operationId:string;confirmed:true;items:PublicationItem[]} | {action:'undo';operationId:string;confirmed:true;batchId:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const fail=():never=>{throw new PublicationInputError('INVALID_PUBLICATION_INPUT');};
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return fail();return value as Record<string,unknown>;}
function exact(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))fail();}
function id(v:unknown){if(typeof v!=='string'||!UUID.test(v))return fail();return v.toLowerCase();}
function rev(v:unknown){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(v)||BigInt(v)>9223372036854775807n)return fail();return v;}
export function readPublicationInput(value:unknown):{action:PublicationAction;payload:Record<string,unknown>}{
 const v=record(value), action=v.action;
 if(!['preview','apply','undo'].includes(String(action)))return fail();
 if(action==='undo'){
  exact(v,['action','operationId','confirmed','batchId']);if(v.confirmed!==true)return fail();
  return {action,payload:{operationId:id(v.operationId),confirmed:true,batchId:id(v.batchId)}};
 }
 exact(v,action==='apply'?['action','operationId','confirmed','items']:['action','items']);
 if(!Array.isArray(v.items)||v.items.length<1||v.items.length>20)throw new PublicationInputError('PUBLICATION_SELECTION_LIMIT');
 const seen=new Set<string>();
 const items=v.items.map(x=>{
  const p=record(x);exact(p,action==='apply'?['jobId','jobRevision','sourceHash','overlayVersion']:['jobId']);
  const jobId=id(p.jobId);if(seen.has(jobId))throw new PublicationInputError('DUPLICATE_PUBLICATION_JOB');seen.add(jobId);
  if(action==='preview')return {jobId};
  if(typeof p.sourceHash!=='string'||!HASH.test(p.sourceHash))return fail();
  return {jobId,jobRevision:rev(p.jobRevision),sourceHash:p.sourceHash,overlayVersion:rev(p.overlayVersion)};
 });
 if(action==='apply'){
  if(v.confirmed!==true)return fail();
  return {action,payload:{operationId:id(v.operationId),confirmed:true,items}};
 }
 return {action:'preview',payload:{items}};
}
export function applyCommand(rows:readonly PreviewRow[],operationId:string):PublicationCommand {
 if(rows.some(r=>!r.ready))throw new PublicationInputError('STUDIO_SOURCE_CHANGED');
 const value={action:'apply',operationId,confirmed:true,items:rows.map(({jobId,jobRevision,sourceHash,overlayVersion})=>({jobId,jobRevision,sourceHash,overlayVersion}))};
 readPublicationInput(value);
 return value as PublicationCommand;
}
