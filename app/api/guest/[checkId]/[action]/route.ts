import {randomBytes} from 'node:crypto';
import {cookies} from 'next/headers';
import {origin,scope,client,actor,rpc,json,failed,body,uuid,revision,Failure} from '@/lib/api';
import {guestContext,guestCookie} from '@/lib/guest';
import {cartInput} from '@/lib/orders/validation';
import {buildVoiceDraft} from '@/lib/voice-order';
export const dynamic='force-dynamic';export const runtime='nodejs';
type Context={params:Promise<{checkId:string;action:string}>};
export async function GET(req:Request,ctx:Context){try{
 origin(req);const params=await ctx.params;const id=uuid(params.checkId);const{s,secret}=await guestContext(id);
 const names:Record<string,string>={cart:'guest_snapshot',orders:'guest_orders',recommendations:'guest_recommendations',feedback:'guest_feedback'};
 if(!names[params.action])throw new Failure('NOT_FOUND',404);
 return json(await rpc(s,names[params.action],{...scope,p_check_id:id,p_secret:secret}));
}catch(e){return failed(e);}}
export async function POST(req:Request,ctx:Context){try{
 origin(req);const {checkId,action}=await ctx.params;const id=uuid(checkId);const data=await body(req);
 if(action==='join'){
  if(Object.keys(data).some(k=>k!=='token')||typeof data.token!=='string'||!/^[0-9a-f]{64}$/.test(data.token))throw new Failure('INVALID_TABLE_INVITATION',400);
  const s=await client();const jar=await cookies();const old=jar.get(guestCookie(id))?.value;
  if(old&&/^[0-9a-f]{64}$/.test(old)){try{return json(await rpc(s,'guest_snapshot',{...scope,p_check_id:id,p_secret:old}));}catch(e){if(!(e instanceof Failure)||e.status!==401)throw e;}}
  const secret=randomBytes(32).toString('hex');
  const snap=await rpc(s,'guest_join',{...scope,p_check_id:id,p_invite:data.token,p_secret:secret});
  jar.set(guestCookie(id),secret,{httpOnly:true,secure:new URL(req.url).protocol==='https:',sameSite:'lax',path:'/',maxAge:8*3600});
  return json(snap);
 }
 const{s,secret}=await guestContext(id);const args={...scope,p_check_id:id,p_secret:secret};
 if(action==='cart'){
  const v=cartInput(data);return json(await rpc(s,'guest_cart_mutate',{...args,p_operation_id:v.operationId,p_product_id:v.productId,p_delta:v.delta,p_expected_revision:v.expectedRevision,p_option:v.option??null}));
 }
 if(action==='order'){
  if(Object.keys(data).some(k=>!['operationId','expectedRevision'].includes(k)))throw new Failure('INVALID_INPUT');
  return json(await rpc(s,'guest_order_submit',{...args,p_operation_id:uuid(data.operationId),p_expected_revision:revision(data.expectedRevision)}),201);
 }
 if(action==='voice-draft'){
  if(Object.keys(data).some(k=>k!=='transcript')||typeof data.transcript!=='string'||data.transcript.trim().length<1||data.transcript.length>1000)throw new Failure('INVALID_INPUT');
  const catalogue=await rpc(s,'catalogue',scope);const items=Array.isArray(catalogue?.items)?catalogue.items:[];
  return json(buildVoiceDraft(data.transcript,items));
 }
 if(action==='service'){if(!['waiter','bill'].includes(String(data.kind)))throw new Failure('INVALID_INPUT');return json(await rpc(s,'guest_service',{...args,p_kind:data.kind}));}
 if(action==='cancel'){
  if(typeof data.reason!=='string'||data.reason.trim().length<1||data.reason.length>300)throw new Failure('REASON_REQUIRED');
  return json(await rpc(s,'guest_cancel_request',{...args,p_order_id:uuid(data.orderId),p_reason:data.reason.trim()}));
 }
 if(action==='feedback'){if(Object.keys(data).some(k=>!['operationId','rating','comment'].includes(k))||!Number.isInteger(data.rating)||Number(data.rating)<1||Number(data.rating)>5||typeof data.comment!=='string'||data.comment.length>500)throw new Failure('INVALID_FEEDBACK');return json(await rpc(s,'guest_feedback',{...args,p_operation_id:uuid(data.operationId),p_rating:data.rating,p_comment:data.comment.trim()}));}
 if(action==='link'){const{ s:authorized }=await actor();return json(await rpc(authorized,'guest_link',args));}
 throw new Failure('NOT_FOUND',404);
}catch(e){return failed(e);}}
