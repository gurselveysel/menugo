import {client,rpc,scope} from '@/lib/api';
import {trustedHost} from '@/lib/config';
import {accountDestination,safeDestination} from '@/lib/auth-destination';
export const dynamic='force-dynamic';
function redirectTo(url:string){return new Response(null,{status:303,headers:{Location:url,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','Vary':'Cookie'}});}
export async function GET(req:Request){
 const u=new URL(req.url);if(!trustedHost(u.host))return new Response('Invalid host',{status:403});
 const next=safeDestination(u.searchParams.get('next'));
 try{
  const code=u.searchParams.get('code');if(!code||code.length>4096)return redirectTo(u.origin+'/giris?error=verification');
  const s=await client();const{error}=await s.auth.exchangeCodeForSession(code);
  if(error)return redirectTo(u.origin+'/giris?error=verification');
  const{data}=await s.auth.getUser();if(!data.user)return redirectTo(u.origin+'/giris?error=verification');
  try{await rpc(s,'bootstrap_owner');}catch{}
  const membership=await rpc(s,'staff_bootstrap',scope);
  return redirectTo(u.origin+accountDestination(membership.role??null,'merchant',next));
 }catch{return redirectTo(u.origin+'/giris?error=verification');}
}
