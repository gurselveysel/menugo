import {actor,failed,json,origin,rpc,scope,Failure} from '@/lib/api';
import {readCostLedgerCommand} from '@/src/studio/cost-ledger';
import {StudioError} from '@/src/studio/operations';
export const dynamic='force-dynamic';

async function input(req:Request){
 if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Failure('JSON_REQUIRED',415);
 const reader=req.body?.getReader();if(!reader)throw new Failure('BODY_REQUIRED');let length=0;const chunks:Uint8Array[]=[];const timer=setTimeout(()=>{void reader.cancel();},6000);
 try{for(;;){const v=await reader.read();if(v.done)break;length+=v.value.length;if(length>100000){await reader.cancel();throw new Failure('BODY_TOO_LARGE',413);}chunks.push(v.value);}const bytes=new Uint8Array(length);let p=0;for(const c of chunks){bytes.set(c,p);p+=c.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(e){if(e instanceof Failure)throw e;throw new Failure('INVALID_JSON');}finally{clearTimeout(timer);}
}
function safe(e:unknown){return e instanceof StudioError?json({error:{code:e.code}},400):failed(e);}
export async function GET(req:Request){try{origin(req);const{s}=await actor();return json(await rpc(s,'studio_cost_ledger',{...scope,p_action:'list',p_payload:{}}));}catch(e){return safe(e);}}
export async function POST(req:Request){try{origin(req);const{s}=await actor();const c=readCostLedgerCommand(await input(req));return json(await rpc(s,'studio_cost_ledger',{...scope,p_action:c.action,p_payload:c.payload}));}catch(e){return safe(e);}}
