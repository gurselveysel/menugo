'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import MenuGoLogo from './MenuGoLogo';
import {FreeAiSettings} from './FreeAiSettings';
import {llmApi as api} from '@/lib/llm/browser';
import {llmMessage,type LlmStatus} from '@/lib/llm/messages';
type Branch={businessId:string;branchId:string;name:string};
export function PlatformAi({branches,role}:{branches:Branch[];role:string}){
 const [selected,setSelected]=useState(branches[0]?.branchId??'');
 const branch=branches.find(b=>b.branchId===selected);
 return <main className="platform-ai"><header><MenuGoLogo alt="MenüGO" width="280" height="74"/><Link className="btn" href="/platform">Şirket kontrol merkezi</Link></header>
 <p className="eyebrow">MENÜGO · ŞİRKET YÖNETİMİ</p><h1>AI kontrol merkezi</h1>
 <p>Sağlayıcılar, erişim anahtarları ve kullanım politikaları burada yönetilir. Restoran işletmecileri yalnız kendilerine açılan araçları kullanır.</p>
 <div className="notice">Yetki: {role==='platform_owner'?'Platform sahibi':'AI yöneticisi'} · Ücretli geçiş kapalı · Anahtarlar okunabilir olarak geri verilmez.</div>
 {branches.length?<><label className="platform-target">Yönetilecek işletme şubesi<select value={selected} onChange={e=>setSelected(e.target.value)}>{branches.map(b=><option key={b.branchId} value={b.branchId}>{b.name}</option>)}</select></label>{branch&&<PlatformBranch key={branch.branchId} branch={branch}/>}</>:<p>Yönetilebilir bir şube bulunamadı.</p>}
 </main>;
}
function PlatformBranch({branch}:{branch:Branch}){
 const [status,setStatus]=useState<LlmStatus|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const alive=useRef(true),epoch=useRef(0),operation=useRef<string|null>(null);
 const url=(a:string)=>`/api/platform/ai/${a}?businessId=${encodeURIComponent(branch.businessId)}&branchId=${encodeURIComponent(branch.branchId)}`;
 async function load(){const g=++epoch.current;try{const s=await api<LlmStatus>(url('status'));if(alive.current&&g===epoch.current)setStatus(s);}catch(e){if(alive.current&&g===epoch.current)setError(llmMessage(e));}}
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;epoch.current++;};},[]);
 async function test(){if(busy)return;setBusy(true);setError('');setMessage('');operation.current??=crypto.randomUUID();try{const r=await api<{result?:{verified?:boolean}}>(url('test'),{operationId:operation.current});if(alive.current&&r.result?.verified){setMessage('Gerçek sağlayıcı yanıtı doğrulandı.');operation.current=null;}await load();}catch(e){if(alive.current)setError(llmMessage(e));if(e instanceof Error&&!['LLM_RESULT_UNKNOWN','LLM_SAVE_UNKNOWN','LLM_IN_PROGRESS','LLM_CONNECTION_UNAVAILABLE'].includes(e.message))operation.current=null;}finally{if(alive.current)setBusy(false);}}
 return <><FreeAiSettings businessId={branch.businessId} branchId={branch.branchId} onSaved={()=>{operation.current=null;void load();}}/>
 <section className="card"><h2>Bağlantı doğrulama</h2><p>Bu düğme gerçek bir ücretsiz model isteği yapar. Kaydetmek, modeli doğrulamış sayılmaz. İşletme hesabına bu teknik işlem yetkisi verilmez.</p>
 {error&&<p className="alert" role="alert">{error}</p>}{message&&<p className="notice" role="status">{message}</p>}
 <button className="btn primary" disabled={busy||!status?.configured||!status.enabled} onClick={()=>void test()}>{busy?'Kontrol ediliyor…':operation.current?'Aynı testin sonucunu kontrol et':'Bağlantıyı test et'}</button>
 <button className="text-button" disabled={busy} onClick={()=>void load()}>Durumu yenile</button></section></>;
}
