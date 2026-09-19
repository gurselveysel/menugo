import 'server-only';
import {rpc,scope,type client} from '@/lib/api';

import {initialReview,type Product} from './review';
import {messages,validateDraft} from './contracts';
import {invokeLlm} from '@/lib/llm/client';
export interface ClaimedImport {claimed:boolean;lease:string;data:string;mime:string;catalogue:Product[];}
/** One bounded invocation on a committed lease; no automatic paid retries. */
export async function processImport(s:Awaited<ReturnType<typeof client>>,jobId:string,claimed:ClaimedImport,token:string,provider:'gateway'|'direct'='gateway'){
 let result;
 try{if(provider==='direct'){const answer=await invokeLlm(s,claimed.lease,'menu-extract',{importId:jobId,importLease:claimed.lease});result={draft:validateDraft(answer.result.draft),model:answer.model,inputTokens:answer.inputTokens??'0',outputTokens:answer.outputTokens??'0'};}else throw new Error('LLM_OPEN_SOURCE_REQUIRED');}catch(e){
  const code=e instanceof Error&&['LLM_RESULT_UNKNOWN','LLM_SAVE_UNKNOWN','LLM_IN_PROGRESS'].includes(e.message)?'AI_RESULT_UNKNOWN':e instanceof Error&&(messages[e.message]||/^LLM_[A-Z_]+$/.test(e.message))?e.message:'AI_RESULT_UNKNOWN';
  await rpc(s,'ai_menu_job',{...scope,p_action:'finish',p_job_id:jobId,p_payload:{lease:claimed.lease,error:code}});return;
 }
 // A failed final save must NOT trigger another generation. Lease expiry is
 // exposed as unknown so the operator decides whether a paid retry is warranted.
 await rpc(s,'ai_menu_job',{...scope,p_action:'finish',p_job_id:jobId,p_payload:{lease:claimed.lease,draft:result.draft,rows:initialReview(result.draft,claimed.catalogue),model:result.model,inputTokens:result.inputTokens,outputTokens:result.outputTokens}});
}
