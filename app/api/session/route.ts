import {actor,rpc,json,failed,origin} from '@/lib/api';import {BRANCH} from '@/lib/config';
export const dynamic='force-dynamic';export async function GET(req:Request){try{origin(req);const{s,user}=await actor();return json({...BRANCH,userId:user.id});}catch(e){return failed(e);}}
export async function POST(req:Request){try{origin(req);const{s}=await actor();return json(await rpc(s,'bootstrap_owner'));}catch(e){return failed(e);}}
