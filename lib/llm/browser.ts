/** Explicitly initiated, bounded LLM requests. Never auto-retry paid calls. */
export async function llmApi<T=any>(path:string,data?:unknown):Promise<T>{
 if(!/^\/api\/llm\/(status|settings|disconnect|test|ask)$/.test(path))throw new Error('INVALID_LLM_REQUEST');
 const inference=path.endsWith('/test')||path.endsWith('/ask');
 let response:Response;
 try{response=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(inference?75000:15000)});}catch{throw new Error(inference?'LLM_RESULT_UNKNOWN':'LLM_CONNECTION_UNAVAILABLE');}
 try{const value=await response.json();if(!response.ok)throw new Error(/^[A-Z0-9_]{1,80}$/.test(value?.error?.code)?value.error.code:'LLM_CONNECTION_UNAVAILABLE');return value as T;}catch(e){if(e instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(e.message))throw e;throw new Error(inference?'LLM_RESULT_UNKNOWN':'LLM_CONNECTION_UNAVAILABLE');}
}
