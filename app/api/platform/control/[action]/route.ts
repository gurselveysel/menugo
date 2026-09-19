import {actor,rpc,json,failed,origin,body,uuid,revision,Failure} from '@/lib/api';
import {validatePolicy,strictKeys,reason,roleNames} from '@/src/platform/control';
import {PUBLIC_HOSTS,RELEASE} from '@/lib/config';
export const dynamic='force-dynamic';
export const runtime='nodejs';
function target(req:Request){const q=new URL(req.url).searchParams;if([...q.keys()].some(k=>!['businessId','branchId'].includes(k)))throw new Failure('INVALID_PLATFORM_SCOPE');
 const b=q.get('businessId'),br=q.get('branchId');if(!b&&!br)return{p_business_id:null,p_branch_id:null};return{p_business_id:uuid(b),p_branch_id:uuid(br)};}
export async function GET(req:Request,{params}:{params:Promise<{action:string}>}){
 try{origin(req);const{s}=await actor();await rpc(s,'platform_principal');if((await params).action!=='state')throw new Failure('NOT_FOUND',404);
 const value=await rpc(s,'platform_control_snapshot',target(req));
 return json({...value,runtime:{release:RELEASE,hosts:[...PUBLIC_HOSTS].filter(h=>!h.endsWith('.vercel.app')),externalAuthSettings:'provider-console-required',automatedBackupVerification:'not-verified',providerSetupChanges:false}});
 }catch(e){return failed(e);}}
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){
 try{origin(req);const{s}=await actor();await rpc(s,'platform_principal');const{action}=await params,v=await body(req),scope=target(req);
 try{
 if(action==='policy'){strictKeys(v,['operationId','version','settings','reason']);return json(await rpc(s,'platform_control_save',{...scope,p_operation_id:uuid(v.operationId),p_expected_version:revision(v.version),p_settings:validatePolicy(v.settings),p_reason:reason(v.reason)}));}
 if(action==='admission'){strictKeys(v,['operationId','version','mode','reason']);if(!scope.p_branch_id||!['direct','staff_approved'].includes(String(v.mode)))throw Error('INVALID_PLATFORM_REQUEST');return json(await rpc(s,'platform_admission_save',{...scope,p_operation_id:uuid(v.operationId),p_expected_version:revision(v.version),p_mode:v.mode,p_reason:reason(v.reason)}));}
 if(action==='member'){strictKeys(v,['operationId','email','role','active','previous','reason']);if(typeof v.email!=='string'||v.email.length>254||!/^\S+@\S+\.\S+$/.test(v.email)||!Object.hasOwn(roleNames,String(v.role))||typeof v.active!=='boolean'||!v.previous||typeof v.previous!=='object'||Array.isArray(v.previous))throw Error('INVALID_PLATFORM_REQUEST');return json(await rpc(s,'platform_member_save',{p_operation_id:uuid(v.operationId),p_email:v.email,p_role:v.role,p_active:v.active,p_previous:v.previous,p_reason:reason(v.reason)}));}
 throw new Failure('NOT_FOUND',404);
 }catch(e){if(e instanceof Failure)throw e;if(e instanceof Error&&['INVALID_PLATFORM_POLICY','INVALID_PLATFORM_LIMIT','UNKNOWN_PLATFORM_SETTING','INVALID_PLATFORM_REQUEST'].includes(e.message))throw new Failure(e.message,400);throw e;}
 }catch(e){return failed(e);}}
