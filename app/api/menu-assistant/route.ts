import {body,client,failed,json,origin,rpc,scope,Failure} from '@/lib/api';
import {answerMenuQuestion} from '@/lib/customer-menu-assistant';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function POST(req:Request){try{origin(req);const b=await body(req);if(Object.keys(b).some(k=>k!=='question')||typeof b.question!=='string'||b.question.trim().length<2||b.question.length>300)throw new Failure('INVALID_MENU_QUESTION');const catalogue=await rpc(await client(),'catalogue_with_studio_text',scope);if(!catalogue||!Array.isArray(catalogue.items))throw new Failure('CATALOGUE_UNAVAILABLE',503);return json(answerMenuQuestion(b.question.trim(),catalogue.items));}catch(e){return failed(e);}}
