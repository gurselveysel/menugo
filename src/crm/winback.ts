/** CRM policy is server-only. No provider URLs, mock sends or automatically granted consent. */
export type SmsLease={id:string;leaseToken:string;businessId:string;branchId:string;customerId:string;idempotencyKey:string;campaignId:string};
export type SendPermit={id:string;idempotencyKey:string;businessId:string;branchId:string;customerId:string;phone:string;senderRef:string;providerRef:string;template:string};
export interface SmsProvider{send(request:{phone:string;senderRef:string;text:string;idempotencyKey:string},signal:AbortSignal):Promise<{providerRef:string}>;}
export interface WinbackPorts{
 enabled:boolean;
 claim():Promise<SmsLease|null>;
 /** Refresh official IYS snapshot with separate transport. Must update DB revision on changes. */
 refreshPermission(lease:SmsLease):Promise<void>;
 /** Lock customer+outbox, check permission/last order/cooldown/hour gates again; mark sending. */
 prepare(lease:SmsLease):Promise<SendPermit|null>;
 /** Controlled backend generates per-customer optout link, registered brand and real offer link. */
 render(permit:SendPermit):Promise<string>;
 provider(accountRef:string):SmsProvider;
 finish(lease:SmsLease,state:'accepted'|'unknown'|'failed',ref:string|null,reason:string|null):Promise<boolean>;
}
export async function runWinbackOnce(ports:WinbackPorts):Promise<{state:string}>{
 if(!ports.enabled)return {state:'disabled'};
 const lease=await ports.claim();if(!lease)return {state:'empty'};
 // Any failure before prepare leaves a reclaimable leased item. Never resends 'sending'.
 await ports.refreshPermission(lease);
 const permit=await ports.prepare(lease);if(!permit)return {state:'suppressed'};
 let provider:SmsProvider;let text:string;
 try{provider=ports.provider(permit.providerRef);text=await ports.render(permit);if(!/^\+[1-9]\d{7,14}$/.test(permit.phone)||!text||text.length>1000||/[{}]/.test(text))throw Error('INVALID_RENDER');}
 catch{await ports.finish(lease,'failed',null,'CONFIGURATION_REQUIRED');return {state:'failed'};}
 let receipt:{providerRef:string};
 try{receipt=await provider.send({phone:permit.phone,senderRef:permit.senderRef,text,idempotencyKey:permit.idempotencyKey},AbortSignal.timeout(8000));
 if(!receipt.providerRef)throw Error('INVALID_RECEIPT');}catch{await ports.finish(lease,'unknown',null,'PROVIDER_RESULT_UNCERTAIN');return {state:'unknown'};}
 // If DB commit response is lost, leave sending/unknown for read-only provider reconciliation.
 const saved=await ports.finish(lease,'accepted',receipt.providerRef,null);
 if(!saved)throw Error('SMS_RESULT_NOT_COMMITTED');return {state:'accepted'};
}
export type Candidate={nowMs:number;lastPaidCompletedMs:number|null;lastSentMs:number|null;inactivityDays:number;cooldownDays:number;phoneVerified:boolean;localConsent:boolean;iysGranted:boolean;iysCheckedMs:number;alreadyQueued:boolean};
export function eligible(c:Candidate):boolean{
 if(!Number.isSafeInteger(c.inactivityDays)||c.inactivityDays<7||c.inactivityDays>365||!Number.isSafeInteger(c.cooldownDays)||c.cooldownDays<7)throw Error('INVALID_POLICY');
 const day=86400000;
 return c.lastPaidCompletedMs!==null&&c.lastPaidCompletedMs<=c.nowMs-c.inactivityDays*day&&c.phoneVerified&&c.localConsent&&c.iysGranted&&c.iysCheckedMs<=c.nowMs&&c.iysCheckedMs>=c.nowMs-day&&!c.alreadyQueued&&(c.lastSentMs===null||c.lastSentMs<=c.nowMs-c.cooldownDays*day);
}
