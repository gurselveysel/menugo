import {actor,rpc,scope,json,failed,origin,body,Failure} from '@/lib/api';
import {readPublicationInput,PublicationInputError} from '@/src/studio/publication';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:Request){
 try { origin(req);const {s}=await actor();return json(await rpc(s,'studio_text_publication',{...scope,p_action:'list'})); }
 catch(e){return failed(e);}
}
export async function POST(req:Request){
 try {
  origin(req);const {s}=await actor();const {action,payload}=readPublicationInput(await body(req));
  return json(await rpc(s,'studio_text_publication',{...scope,p_action:action,p_payload:payload}));
 } catch(e){return failed(e instanceof PublicationInputError?new Failure(e.code,400):e);}
}
