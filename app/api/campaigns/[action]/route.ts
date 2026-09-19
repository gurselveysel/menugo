import {actor,rpc,scope,json,failed,origin,uuid,body,Failure} from '@/lib/api';
import {campaignRequest,readCampaign,campaignCaption} from '@/src/campaigns/contracts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=15;
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){
 try{
  origin(req);const {s}=await actor(),{action}=await params;
  if(action==='catalogue')return json(await rpc(s,'campaign_snapshot',scope));
  if(action!=='preview')throw new Failure('NOT_FOUND',404);
  const q=new URL(req.url).searchParams;
  return json(readCampaign(await rpc(s,'campaign_snapshot',{...scope,p_product_id:uuid(q.get('productId')),p_job_id:q.get('jobId')?uuid(q.get('jobId')):null})));
 }catch(e){return failed(e);}
}
/** Read-only validation even though POST is used. No model, payment or social side effects. */
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){
 try{
  origin(req);const {s}=await actor(),{action}=await params;
  if(action!=='export')throw new Failure('NOT_FOUND',404);
  let request;try{request=campaignRequest(await body(req));}catch(e){if(e instanceof Failure)throw e;throw new Failure('INVALID_CAMPAIGN_REQUEST');}
  const snapshot=readCampaign(await rpc(s,'campaign_snapshot',{...scope,p_product_id:request.productId,p_job_id:request.jobId,p_expected_version:request.expectedVersion}));
  return json({snapshot,caption:campaignCaption(snapshot),format:request.format});
 }catch(e){return failed(e);}
}
