import 'server-only';
import {rpc,scope,type client} from '@/lib/api';
import {extractMenu} from './provider';
import {initialReview,type Product} from './review';
import {messages} from './contracts';
export interface ClaimedImport {claimed:boolean;lease:string;data:string;mime:string;catalogue:Product[];}
/** One bounded invocation on a committed lease; no automatic paid retries. */
export async function processImport(s:Awaited<ReturnType<typeof client>>,jobId:string,claimed:ClaimedImport,token:string){
 let result;
 try{result=await extractMenu(claimed.data,claimed.mime,token);}catch(e){
  const code=e instanceof Error&&messages[e.message]?e.message:'AI_RESULT_UNKNOWN';
  await rpc(s,'ai_menu_job',{...scope,p_action:'finish',p_job_id:jobId,p_payload:{lease:claimed.lease,error:code}});return;
 }
 // A failed final save must NOT trigger another generation. Lease expiry is
 // exposed as unknown so the operator decides whether a paid retry is warranted.
 await rpc(s,'ai_menu_job',{...scope,p_action:'finish',p_job_id:jobId,p_payload:{lease:claimed.lease,draft:result.draft,rows:initialReview(result.draft,claimed.catalogue),model:result.model,inputTokens:result.inputTokens,outputTokens:result.outputTokens}});
}
