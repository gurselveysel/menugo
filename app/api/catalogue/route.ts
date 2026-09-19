import {client,rpc,json,failed,origin,scope} from '@/lib/api';export const dynamic='force-dynamic';
export async function GET(req:Request){try{origin(req);return json(await rpc(await client(),'catalogue_with_studio_text',scope));}catch(e){return failed(e);}}
