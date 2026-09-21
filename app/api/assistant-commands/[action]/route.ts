import {actor,rpc,scope,json,failed,origin,body,uuid,Failure} from '@/lib/api';
export const runtime='nodejs';export const dynamic='force-dynamic';
type Context={params:Promise<{action:string}>};
function reason(v:unknown){if(typeof v!=='string'||v.trim().length<5||v.trim().length>200||/[\u0000-\u001f\u007f]/.test(v))throw new Failure('INVALID_ASSISTANT_COMMAND');return v.trim();}
function strict(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).sort().join(',')!==[...keys].sort().join(','))throw new Failure('INVALID_ASSISTANT_COMMAND');}
export async function GET(req:Request,ctx:Context){try{origin(req);const {action}=await ctx.params;if(action!=='status')throw new Failure('NOT_FOUND',404);const{s}=await actor();return json(await rpc(s,'assistant_command',{...scope,p_action:'list',p_payload:{}}));}catch(e){return failed(e);}}
export async function POST(req:Request,ctx:Context){try{origin(req);const {action}=await ctx.params;const{s}=await actor();const b=await body(req);
 if(action==='apply'){strict(b,['operationId','productId','expectedUpdatedAt','available','confirmed','reason']);if(typeof b.available!=='boolean'||b.confirmed!==true||typeof b.expectedUpdatedAt!=='string'||b.expectedUpdatedAt.length>60||Number.isNaN(Date.parse(b.expectedUpdatedAt)))throw new Failure('INVALID_ASSISTANT_COMMAND');return json(await rpc(s,'assistant_command',{...scope,p_action:'set-product-availability',p_payload:{operationId:uuid(b.operationId),productId:uuid(b.productId),expectedUpdatedAt:b.expectedUpdatedAt,available:b.available,confirmed:true,reason:reason(b.reason)}}));}
 if(action==='undo'){strict(b,['operationId','commandId','confirmed','reason']);if(b.confirmed!==true)throw new Failure('INVALID_ASSISTANT_COMMAND');return json(await rpc(s,'assistant_command',{...scope,p_action:'undo-product-availability',p_payload:{operationId:uuid(b.operationId),commandId:uuid(b.commandId),confirmed:true,reason:reason(b.reason)}}));}
 throw new Failure('NOT_FOUND',404);
}catch(e){return failed(e);}}
