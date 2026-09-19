/** Self-hosted protocol. The deployment operator provisions this TLS hostname.
 * A model is not running just because this adapter exists. No cloud fallback.
 */
export const OPEN_ENDPOINT = 'https://ai.menugo.app/v1/chat/completions';
export const OPEN_MODELS = ['qwen3.5:4b','qwen3.5:9b','Qwen/Qwen3.5-4B','Qwen/Qwen3.5-9B'] as const;
export function openSourceWire(model: string, key: string, prompt: string, text: string, schema: unknown, maxTokens: number, attachment: {mime:string;data:string}|null) {
 if (!(OPEN_MODELS as readonly string[]).includes(model)) throw new Error('LLM_MODEL_NOT_ALLOWED');
 if (typeof key!=='string'||key.length<20||key.length>512||/[\s\u0000-\u001f]/.test(key)) throw new Error('LLM_KEY_REQUIRED');
 const content: unknown[] = [{type:'text',text}];
 if(attachment){
  if(attachment.mime==='application/pdf') throw new Error('LLM_PDF_PAGES_REQUIRED');
  if(!['image/png','image/jpeg','image/webp'].includes(attachment.mime)||attachment.data.length>2796204||!attachment.data.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) throw new Error('INVALID_LLM_REQUEST');
  content.push({type:'image_url',image_url:{url:`data:${attachment.mime};base64,${attachment.data}`}});
 }
 return {url:OPEN_ENDPOINT,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:{
  model,stream:false,temperature:0,max_tokens:maxTokens,
  messages:[{role:'system',content:prompt},{role:'user',content}],
  response_format:{type:'json_schema',json_schema:{name:'menugo_draft',strict:true,schema}},
  ...(model.startsWith('qwen')?{reasoning_effort:'none'}:{chat_template_kwargs:{enable_thinking:false}})
 }};
}
