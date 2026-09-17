import {cookies} from 'next/headers';import {client,rpc,json,origin,scope,failed} from '@/lib/api';
export const dynamic='force-dynamic';
export async function GET(req:Request){try{origin(req);const s=await client();const jars=(await cookies()).getAll().filter(c=>/^menugo_visit_[0-9a-f-]{36}$/.test(c.name)&&/^[0-9a-f]{64}$/.test(c.value)).slice(-16);const result=[];
 for(const cookie of jars){const id=cookie.name.slice('menugo_visit_'.length);try{const snap=await rpc(s,'guest_snapshot',{...scope,p_check_id:id,p_secret:cookie.value});result.push({checkId:id,tableName:snap.tableName,status:snap.status,seat:snap.seat,ownBillMinor:snap.ownBillMinor});}catch{}}
 return json(result);
}catch(e){return failed(e);}}
