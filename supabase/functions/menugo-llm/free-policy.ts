/** Free service != open weights != free web chat. Reviewed 2026-09-21. */
export const FREE_PROVIDERS = ['groq_free','gemini_free','openrouter_free','cloudflare_free'] as const;
export type FreeProvider = typeof FREE_PROVIDERS[number];
export const FREE_MODELS: Record<FreeProvider, readonly string[]> = {
 groq_free: ['openai/gpt-oss-20b','openai/gpt-oss-120b'],
 gemini_free: ['gemini-2.5-flash','gemini-2.5-flash-lite'],
 openrouter_free: ['openrouter/free'],
 cloudflare_free: ['@cf/black-forest-labs/flux-2-klein-4b']
};
export const CLOUDFLARE_TEXT_MODEL='@cf/google/gemma-4-26b-a4b-it' as const;
export interface FreeRoute {provider:FreeProvider;model:string;key:string;priority:number;version:string;accountId:string|null;attestedUntil:string;publicContentAllowed:boolean;privateContentAllowed:boolean}
export function routeEligible(r:FreeRoute,kind:string,context:any,request:any,now=Date.now()):boolean {
 if(!FREE_MODELS[r.provider]?.includes(r.model)||!Number.isInteger(r.priority)||r.priority<1||r.priority>100) return false;
 if(!Number.isFinite(Date.parse(r.attestedUntil))||Date.parse(r.attestedUntil)<=now) return false;
 const photo=kind==='studio'&&context?.studioKind==='photo-enhance';
 if(kind!=='test'&&photo&&r.provider!=='cloudflare_free')return false;
 if(kind!=='test'&&!photo&&r.provider==='cloudflare_free'){
  // The same Workers Free credential may use the separately reviewed Cloudflare-hosted Gemma text fallback.
  // Keep this route text-only: no document/image attachment is forwarded through the chat endpoint.
  const attachment=kind==='menu-extract'?context:context?.input?.attachment;
  if(attachment||kind==='menu-extract'||(kind==='studio'&&!['product-copy','translation','campaign'].includes(context?.studioKind)))return false;
 }
 // Free-text questions/invoices/photos are private. Menu-only uploads require explicit public-use permission.
 // Only structured product-copy/translation/campaign input is eligible for opt-in public routing.
 const publicData=kind==='test'||kind==='menu-extract'||(kind==='studio'&&['product-copy','translation','campaign'].includes(context?.studioKind));
 if(kind!=='test' && (publicData ? !r.publicContentAllowed : !r.privateContentAllowed))return false;
 if(r.provider==='gemini_free'&&(!publicData||!r.publicContentAllowed))return false;
 const attachment=kind==='menu-extract'?context:context?.input?.attachment;
 if(attachment&&r.provider==='groq_free')return false;
 if(attachment?.mime==='application/pdf'&&r.provider!=='gemini_free')return false;
 // Free Gemini upload privacy requires a separate reviewed public-document flow; not inferred from filename.
 return true;
}
export function sortedRoutes(routes:FreeRoute[],kind:string,context:any,request:any,now=Date.now()):FreeRoute[]{
 const seen=new Set<string>();
 return routes.filter(r=>{if(seen.has(r.provider))return false;seen.add(r.provider);return routeEligible(r,kind,context,request,now);})
  .sort((a,b)=>a.priority-b.priority||a.provider.localeCompare(b.provider)).slice(0,3);
}
export function assertFreeWire(d:{provider:string;model:string;key:string;attestedUntil?:string},now=Date.now()){
 if(!FREE_MODELS[d.provider as FreeProvider]?.includes(d.model))throw Error('LLM_PAID_PROVIDER_BLOCKED');
 if(!d.attestedUntil||Date.parse(d.attestedUntil)<=now||!Number.isFinite(Date.parse(d.attestedUntil)))throw Error('LLM_FREE_PLAN_RECONFIRM');
 if(typeof d.key!=='string'||d.key.length<20||d.key.length>512||/[\s\u0000-\u001f]/.test(d.key))throw Error('LLM_KEY_REQUIRED');
}
