import {redirect,notFound} from 'next/navigation';
import {actor,rpc,Failure} from '@/lib/api';
import {AiSuiteAcceptance} from '@/components/AiSuiteAcceptance';
import '../control.css';
export const dynamic='force-dynamic';
export const metadata={title:'MenüGO | AI kabul durumu',robots:{index:false,follow:false}};
export default async function Page(){
 let snapshot;
 try{const{s}=await actor();snapshot=await rpc(s,'ai_suite_acceptance_snapshot');}
 catch(e){if(e instanceof Failure&&e.status===401)redirect('/giris?next=%2Fplatform%2Fkabul');if(e instanceof Failure&&e.status===403)notFound();throw e;}
 return <AiSuiteAcceptance data={snapshot}/>;
}
