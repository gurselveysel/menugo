import {actor,body,failed,json,origin,rpc,scope} from '@/lib/api';
import {PhotoInputError,readPhotoCommand} from '@/src/studio/photo-publication';
export const dynamic='force-dynamic';
export async function GET(req:Request){try{origin(req);const{s}=await actor();return json(await rpc(s,'studio_photo_publication',{...scope,p_action:'list',p_payload:{}}));}catch(e){return failed(e);}}
export async function POST(req:Request){try{origin(req);const{s}=await actor();const c=readPhotoCommand(await body(req));return json(await rpc(s,'studio_photo_publication',{...scope,p_action:c.action,p_payload:c.payload}));}catch(e){return e instanceof PhotoInputError?json({error:{code:e.code}},400):failed(e);}}
