/** Company configuration contract. No secrets, arbitrary URLs, or paid-service flags. */
export const policyFields = [
 {key:'aiEnabled',label:'AI üretimi',help:'Yeni AI işlerini ve henüz gönderilmemiş model çağrılarını durdurabilir. Mevcut sonuçlar silinmez.',permission:'ai'},
 {key:'importsEnabled',label:'AI menü aktarımı',help:'Yeni menü belgelerinin aktarımı ve modelle çıkarımı. Mevcut katalog korunur.',permission:'ai'},
 {key:'studioPublicationEnabled',label:'İncelenmiş metin ve fotoğrafları yayımlama',help:'Yeni metin ve ürün fotoğrafı uygulamalarını durdurur. Önceki yayınları geri alma çalışmaya devam eder.',permission:'ai'},
 {key:'socialPublicationEnabled',label:'Sosyal yayın isteği',help:'İşletmelerin incelenmiş kampanya için sosyal yayın isteği oluşturmasını kontrol eder. Sağlayıcı bağlantısı veya dış hesaba gönderim bu anahtarla kendiliğinden açılmaz.',permission:'operations'},
 {key:'orderingEnabled',label:'Yeni masa siparişi',help:'Merkezi güvenlik anahtarı. Mevcut siparişlerin kabulü, servisi ve kasa kapanışı etkilenmez.',permission:'operations'},
 {key:'whatsappEnabled',label:'WhatsApp sipariş talebi',help:'Yeni fiyat doğrulanmış WhatsApp talebi hazırlamayı kontrol eder; mesaj göndermez.',permission:'operations'},
 {key:'crmEvaluationEnabled',label:'CRM aday değerlendirmesi',help:'21 gün ve diğer kampanya aday taramalarını kontrol eder. SMS gönderimini açmaz.',permission:'operations'},
] as const;
export type PolicyKey=typeof policyFields[number]['key'];
export type Policy=Partial<Record<PolicyKey,boolean>> & {dailyAiLimit?:number};
export type Principal={userId:string;role:string;canManageAi:boolean;canManageOperations:boolean;canManageSecurity:boolean;canManageMembers:boolean};
export type Branch={businessId:string;branchId:string;name:string};
export type Change={id:string;actorId:string;action:string;scope:string;createdAt:string;reason:string;before:Policy;after:Policy};
export type Member={userId:string;email:string;role:string;active:boolean};
export type ControlState=Principal&{version:string;settings:Policy;globalSettings:Policy;effective:Policy;branches:Branch[];members:Member[];changes:Change[];audit:{action:string;createdAt:string;branchId:string|null}[];features?:Record<string,boolean>;branchOrdering?:Record<string,boolean>;admission?:{mode:string;version:string};readiness?:Record<string,number>;queues?:Record<string,number|string|null>};
export const roleNames:Record<string,string>={platform_owner:'Platform sahibi',ai_admin:'AI yöneticisi',ops_admin:'Platform operasyon yöneticisi',security_admin:'Güvenlik yöneticisi',auditor:'Salt okunur denetçi'};
export function validatePolicy(value:unknown):Policy{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_PLATFORM_POLICY');
 for(const[k,v]of Object.entries(value)){
  if(policyFields.some(f=>f.key===k)){if(typeof v!=='boolean')throw Error('INVALID_PLATFORM_POLICY');}
  else if(k==='dailyAiLimit'){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>50)throw Error('INVALID_PLATFORM_LIMIT');}
  else throw Error('UNKNOWN_PLATFORM_SETTING');
 }
 return value as Policy;
}
export function strictKeys(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).some(k=>!keys.includes(k)))throw Error('INVALID_PLATFORM_REQUEST');}
export function reason(v:unknown){if(typeof v!=='string'||v.trim().length<5||v.trim().length>300)throw Error('INVALID_PLATFORM_REQUEST');return v.trim();}
