import {randomBytes} from 'node:crypto';
import {cookies} from 'next/headers';
import {body,client,failed,Failure,json,origin,rpc,scope,uuid} from '@/lib/api';
import {guestCookie} from '@/lib/guest';
export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{tableId:string}>};
const cookieName=(id:string)=>'menugo_entry_'+id;
const valid=(v:string|undefined):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export async function GET(req:Request,ctx:Context){
 try{
  origin(req);const id=uuid((await ctx.params).tableId);const s=await client();
  const table=await rpc(s,'table_entry_info',{...scope,p_table_id:id});
  const jar=await cookies();let secret=jar.get(cookieName(id))?.value;
  if(!valid(secret)){
   secret=randomBytes(32).toString('hex');
   jar.set(cookieName(id),secret,{httpOnly:true,secure:new URL(req.url).protocol==='https:',sameSite:'lax',path:'/',maxAge:8*3600});
  }
  const request=await rpc(s,'table_entry_status',{...scope,p_table_id:id,p_secret:secret});
  return json({table,request});
 }catch(e){return failed(e);}
}
export async function POST(req:Request,ctx:Context){
 try{
  origin(req);const id=uuid((await ctx.params).tableId);const data=await body(req);
  if(Object.keys(data).some(k=>k!=='action')||!['request','claim','restart'].includes(String(data.action)))throw new Failure('INVALID_INPUT');
  const jar=await cookies();let secret=jar.get(cookieName(id))?.value;
  if(!valid(secret))throw new Failure('ENTRY_SESSION_REQUIRED',401);
  const s=await client();
  if(data.action==='restart'){
   const previous=await rpc(s,'table_entry_status',{...scope,p_table_id:id,p_secret:secret});
   if(!['expired','finished','declined','idle'].includes(previous.state))throw new Failure('ENTRY_ALREADY_PENDING',409);
   secret=randomBytes(32).toString('hex');
   jar.set(cookieName(id),secret,{httpOnly:true,secure:new URL(req.url).protocol==='https:',sameSite:'lax',path:'/',maxAge:8*3600});
   return json({state:'idle'});
  }
  if(data.action==='request')return json(await rpc(s,'table_entry_request',{...scope,p_table_id:id,p_secret:secret}));
  const cart=await rpc(s,'table_entry_claim',{...scope,p_table_id:id,p_secret:secret});
  uuid(cart.checkId);
  jar.set(guestCookie(cart.checkId),secret,{httpOnly:true,secure:new URL(req.url).protocol==='https:',sameSite:'lax',path:'/',maxAge:8*3600});
  return json({checkId:cart.checkId});
 }catch(e){return failed(e);}
}
