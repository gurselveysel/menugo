import {actor,rpc,scope,json,failed,origin,uuid,body,Failure} from '@/lib/api';
import {campaignRequest,publicationRequest,publicationCancelRequest,readCampaign,campaignCaption} from '@/src/campaigns/contracts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=15;
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){
 try{
  origin(req);const {s}=await actor(),{action}=await params;
  if(action==='catalogue')return json(await rpc(s,'campaign_snapshot',scope));
  const q=new URL(req.url).searchParams;
  if(action==='publication-status')return json(await rpc(s,'campaign_publication_status',{...scope,p_product_id:q.get('productId')?uuid(q.get('productId')):null}));
  if(action!=='preview')throw new Failure('NOT_FOUND',404);
  return json(readCampaign(await rpc(s,'campaign_snapshot',{...scope,p_product_id:uuid(q.get('productId')),p_job_id:q.get('jobId')?uuid(q.get('jobId')):null})));
 }catch(e){return failed(e);}
}
/** Campaign export is validation only. Publication requests are an audited internal queue; this route never calls a social provider. */
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){
 try{
  origin(req);const {s}=await actor(),{action}=await params,v=await body(req);
  if(action==='export'){
   let request;try{request=campaignRequest(v);}catch(e){if(e instanceof Failure)throw e;throw new Failure('INVALID_CAMPAIGN_REQUEST');}
   const snapshot=readCampaign(await rpc(s,'campaign_snapshot',{...scope,p_product_id:request.productId,p_job_id:request.jobId,p_expected_version:request.expectedVersion}));
   return json({snapshot,caption:campaignCaption(snapshot),format:request.format});
  }
  if(action==='publication-request'){
   let request;try{request=publicationRequest(v);}catch{throw new Failure('INVALID_PUBLICATION_REQUEST',400);}
   return json(await rpc(s,'campaign_publication_request',{...scope,p_operation_id:request.operationId,p_product_id:request.productId,p_job_id:request.jobId,p_expected_version:request.expectedVersion,p_format:request.format,p_network:request.network}));
  }
  if(action==='publication-cancel'){
   let request;try{request=publicationCancelRequest(v);}catch{throw new Failure('INVALID_PUBLICATION_REQUEST',400);}
   return json(await rpc(s,'campaign_publication_cancel',{...scope,p_operation_id:request.operationId,p_publication_id:request.publicationId}));
  }
  throw new Failure('NOT_FOUND',404);
 }catch(e){return failed(e);}
}
