import {redirect,notFound} from 'next/navigation';
import {actor,rpc,Failure} from '@/lib/api';
import {PlatformControl} from '@/components/PlatformControl';
import './control.css';
export const dynamic='force-dynamic';
export const metadata={title:'MenüGO | Şirket Yönetim Merkezi',robots:{index:false,follow:false}};
export default async function Page(){
 let principal;
 try{const{s}=await actor();principal=await rpc(s,'platform_principal');}
 catch(e){if(e instanceof Failure&&e.status===401)redirect('/giris?next=%2Fplatform');if(e instanceof Failure&&e.status===403)notFound();throw e;}
 return <PlatformControl principal={principal}/>;
}
