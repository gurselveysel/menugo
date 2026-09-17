import {client} from '@/lib/api';import {trustedHost} from '@/lib/config';

export async function GET(req:Request){const u=new URL(req.url);if(!trustedHost(u.host))return new Response('Invalid host',{status:403});const code=u.searchParams.get('code');if(code){const s=await client();const{error}=await s.auth.exchangeCodeForSession(code);if(!error)return Response.redirect(u.origin+'/panel',303);}return Response.redirect(u.origin+'/giris?error=verification',303);}
