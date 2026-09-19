'use client';
import MenuGoLogo from '@/components/MenuGoLogo';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {api,explain} from './transport';
import {TableScanner} from './TableScanner';
import {ApprovedTableEntry} from './ApprovedTableEntry';

// Shared promise avoids duplicate initial cookie issuance and POSTs in StrictMode.
// It is scoped to one tab and table, does not retain secrets or cache a visit.
let opening: {id:string; promise:Promise<any>} | null = null;
function openTable(id:string) {
 if(opening?.id===id)return opening.promise;
 const promise=(async()=>{
  const data=await api('/api/table/'+id);
  if(data.table.entryMode==='staff_approved'||!data.table.enabled||['finished','expired'].includes(data.request.state))return data;
  const visit=await api('/api/table/'+id,{action:'join'});
  return {...data,checkId:visit.checkId};
 })();
 opening={id,promise};
 void promise.finally(()=>{if(opening?.promise===promise)opening=null;}).catch(()=>{});
 return promise;
}
export function TableEntry(){
 const [id,setId]=useState(''),[data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[offline,setOffline]=useState(false),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  const value=new URLSearchParams(location.search).get('masa')??'';
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))setId(value);
  else{setError('Masanızdaki QR kodunu okutun. Menüye erişmek için üyelik gerekmez.');setBusy(false);}
 },[]);
 useEffect(()=>{
  if(!id)return;let alive=true;setError('');
  if(!navigator.onLine){setOffline(true);setBusy(false);return;}
  setBusy(true);setOffline(false);
  void openTable(id).then(next=>{
   if(!alive)return;setData(next);
   if(next.checkId)location.replace('/siparis?check='+encodeURIComponent(next.checkId));
  }).catch(e=>{if(alive)setError(explain(e));}).finally(()=>{if(alive)setBusy(false);});
  return()=>{alive=false;};
 },[id,attempt]);
 useEffect(()=>{const off=()=>setOffline(true),on=()=>setOffline(false);window.addEventListener('offline',off);window.addEventListener('online',on);return()=>{window.removeEventListener('offline',off);window.removeEventListener('online',on);};},[]);
 async function newVisit(){
  if(busy||offline)return;setBusy(true);setError('');
  try{await api('/api/table/'+id,{action:'restart'});setData(null);setAttempt(v=>v+1);}
  catch(e){setError(explain(e));setBusy(false);}
 }
 if(data?.table?.entryMode==='staff_approved')return <ApprovedTableEntry/>;
 const ended=['finished','expired'].includes(data?.request?.state);
 return <div className="guest-site"><header className="guest-header"><Link href="/bahcesehir"><img src="/media/sariyer-brand-transparent-r8.webp" width={600} height={200} alt="Meşhur Sarıyer Börekçisi Sandviç"/></Link><Link href="/hesabim">Siparişlerim</Link></header>
 <main className="guest-welcome entry-welcome"><span className="guest-kicker">MASADA SİPARİŞ</span><h1>{data?.table?.tableName??'Hoş geldiniz.'}</h1>
 {ended?<><p>Önceki ziyaretiniz sona erdi. Bu ziyaretinize yeni bir sipariş ekranıyla devam edebilirsiniz.</p><button className="guest-primary full" disabled={busy||offline} onClick={()=>void newVisit()}>Yeni ziyaretimde sipariş ver</button></>:
 data&&!data.table.enabled?<p className="notice">Şu anda siparişinizi personelimiz alıyor. Menüyü inceleyebilirsiniz.</p>:
 <p role="status">{busy?'Menünüz açılıyor…':'QR’yi okutun, ürünlerinizi seçin ve siparişinizi gönderin. Üyelik gerekmez.'}</p>}
 {offline&&<p className="notice" role="status">İnternet bağlantısı kesildi. Bağlantınız geldiğinde yeniden deneyin; yeni istek kendiliğinden gönderilmez.</p>}
 {error&&<p className="notice" role="alert">{error}</p>}
 {(error||offline)&&id&&<button className="btn primary" disabled={busy||offline} onClick={()=>setAttempt(v=>v+1)}>Yeniden dene</button>}
 {!busy&&!id&&<TableScanner/>}<div className="guest-welcome-actions"><Link className="btn" href="/bahcesehir">Menüyü incele</Link><a className="btn" href="tel:+905394830031">İşletmeyi ara</a></div></main>
 <footer className="guest-footer"><MenuGoLogo  width={560} height={147} alt="MenüGO — Yeni Nesil Dijital Menü"/></footer></div>;
}
