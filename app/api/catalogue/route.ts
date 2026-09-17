import {client,rpc,json,failed,origin,scope} from '@/lib/api';export const dynamic='force-dynamic';
export async function GET(req:Request){try{origin(req);return json(await rpc(await client(),'catalogue',scope));}catch(e){return failed(e);}}
