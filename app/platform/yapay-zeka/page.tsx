import {redirect,notFound} from 'next/navigation';
import {actor,rpc,Failure} from '@/lib/api';
import {PlatformAi} from '@/components/PlatformAi';
import './platform.css';
export const dynamic='force-dynamic';
export const metadata={title:'MenüGO | Şirket AI yönetimi',robots:{index:false,follow:false}};
export default async function Page(){
 let context;
 try{const {s}=await actor();context=await rpc(s,'platform_ai_console');}
 catch(e){if(e instanceof Failure&&e.status===401)redirect('/giris?next=%2Fplatform%2Fyapay-zeka');if(e instanceof Failure&&e.status===403)notFound();throw e;}
 return <PlatformAi branches={context.branches} role={context.role}/>;
}
