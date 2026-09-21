export type CampaignFormat = 'post' | 'story';
export type SocialNetwork = 'instagram';
export const FORMATS = Object.freeze({post:{width:1080,height:1350},story:{width:1080,height:1920}});
export interface CampaignSnapshot {
 productId:string; name:string; description:string; quantityLabel:string; options:string[];
 priceMinor:string; businessName:string; branchName:string; caption:string;
 version:string; checkedAt:string; productUrl:string;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION=/^[a-f0-9]{64}$/;
export function campaignRequest(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_CAMPAIGN_REQUEST');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['productId','jobId','expectedVersion','format'].includes(k))||typeof v.productId!=='string'||!UUID.test(v.productId)
  ||v.jobId!==null&&v.jobId!==undefined&&(typeof v.jobId!=='string'||!UUID.test(v.jobId))
  ||typeof v.expectedVersion!=='string'||!VERSION.test(v.expectedVersion)||!['post','story'].includes(String(v.format)))throw Error('INVALID_CAMPAIGN_REQUEST');
 return {productId:v.productId,jobId:(v.jobId??null) as string|null,expectedVersion:v.expectedVersion,format:v.format as CampaignFormat};
}
export function publicationRequest(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_PUBLICATION_REQUEST');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['operationId','productId','jobId','expectedVersion','format','network'].includes(k))
  ||typeof v.operationId!=='string'||!UUID.test(v.operationId)||typeof v.productId!=='string'||!UUID.test(v.productId)
  ||v.jobId!==null&&v.jobId!==undefined&&(typeof v.jobId!=='string'||!UUID.test(v.jobId))
  ||typeof v.expectedVersion!=='string'||!VERSION.test(v.expectedVersion)||!['post','story'].includes(String(v.format))||v.network!=='instagram')throw Error('INVALID_PUBLICATION_REQUEST');
 return {operationId:v.operationId,productId:v.productId,jobId:(v.jobId??null) as string|null,expectedVersion:v.expectedVersion,format:v.format as CampaignFormat,network:v.network as SocialNetwork};
}
export function publicationCancelRequest(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_PUBLICATION_REQUEST');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['operationId','publicationId'].includes(k))||typeof v.operationId!=='string'||!UUID.test(v.operationId)||typeof v.publicationId!=='string'||!UUID.test(v.publicationId))throw Error('INVALID_PUBLICATION_REQUEST');
 return {operationId:v.operationId,publicationId:v.publicationId};
}
export function formatMinor(value:string){
 if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(value))throw Error('INVALID_PRICE');
 const n=BigInt(value);if(n>9223372036854775807n)throw Error('INVALID_PRICE');
 return (n/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+(n%100n).toString().padStart(2,'0')+' TL';
}
export function productUrl(id:string){
 if(!UUID.test(id))throw Error('INVALID_PRODUCT_ID');
 return 'https://sariyerborekcisi.menugo.app/bahcesehir?urun='+encodeURIComponent(id);
}
export function readCampaign(value:unknown):CampaignSnapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_CAMPAIGN_SNAPSHOT');
 const v=value as Record<string,unknown>;
 for(const [k,max] of Object.entries({name:250,description:5000,quantityLabel:250,businessName:250,branchName:250,caption:5500}))
  if(typeof v[k]!=='string'||(v[k] as string).length>max)throw Error('INVALID_CAMPAIGN_SNAPSHOT');
 if(!String(v.name).trim()||typeof v.productId!=='string'||!UUID.test(v.productId)||typeof v.version!=='string'||!VERSION.test(v.version)
  ||typeof v.checkedAt!=='string'||!Number.isFinite(Date.parse(v.checkedAt))||!Array.isArray(v.options)||v.options.length>100||v.options.some(x=>typeof x!=='string'||x.length>250))throw Error('INVALID_CAMPAIGN_SNAPSHOT');
 formatMinor(v.priceMinor as string);
 return Object.freeze({productId:v.productId,name:v.name as string,description:v.description as string,quantityLabel:v.quantityLabel as string,
  options:[...v.options] as string[],priceMinor:v.priceMinor as string,businessName:v.businessName as string,branchName:v.branchName as string,
  caption:v.caption as string,version:v.version,checkedAt:v.checkedAt,productUrl:productUrl(v.productId)});
}
/** Only public product links; never add visit tokens, actor ids or credential state. */
export function campaignCaption(s:CampaignSnapshot){return `${s.caption}\n\n${formatMinor(s.priceMinor)}${s.quantityLabel?' · '+s.quantityLabel:''}\n${s.businessName} · ${s.branchName}\nMenü ve güncel bilgiler: ${s.productUrl}`;}
