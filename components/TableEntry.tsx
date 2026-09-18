'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {api,explain} from './transport';
export function TableEntry(){
 const[id,setId]=useState(''),[data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[offline,setOffline]=useState(false);
 const claiming=useRef(false);
 useEffect(()=>{const value=new URLSearchParams(location.search).get('masa')??'';if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))setId(value);else setError('Geçerli masa QR kodunu okutun veya personelimizden yardım isteyin.');},[]);
 useEffect(()=>{
  if(!id)return;let alive=true;
  async function refresh(){
   if(!navigator.onLine){if(alive)setOffline(true);return;}
   if(document.visibilityState!=='visible')return;
   try{const next=await api('/api/table/'+id);if(!alive)return;setData(next);setError('');setOffline(false);
    if(['approved','claimed'].includes(next.request.state)&&!claiming.current){
     claiming.current=true;
     try{const result=await api('/api/table/'+id,{action:'claim'});if(alive)location.replace('/siparis?check='+encodeURIComponent(result.checkId));}
     catch(e){if(alive)setError(explain(e));claiming.current=false;}
    }
   }catch(e){if(alive)setError(explain(e));}
  }
  void refresh();const timer=setInterval(()=>void refresh(),5000);
  const visible=()=>void refresh(),off=()=>setOffline(true);
  window.addEventListener('online',visible);window.addEventListener('offline',off);document.addEventListener('visibilitychange',visible);
  return()=>{alive=false;clearInterval(timer);window.removeEventListener('online',visible);window.removeEventListener('offline',off);document.removeEventListener('visibilitychange',visible);};
 },[id]);
 async function start(){if(busy||offline)return;setBusy(true);setError('');try{
  if(['expired','declined','finished'].includes(data?.request?.state))await api('/api/table/'+id,{action:'restart'});
  const result=await api('/api/table/'+id,{action:'request'});setData((d:any)=>({...d,request:result}));
 }catch(e){setError(explain(e));}finally{setBusy(false);}}
 const state=data?.request?.state;
 return <div className="guest-site"><header className="guest-header"><Link href="/bahcesehir"><img src="/media/sariyer-brand-transparent-r8.webp" alt="Meşhur Sarıyer Börekçisi Sandviç" width={600} height={200}/></Link><Link href="/hesabim">Siparişlerim</Link></header>
 <main className="guest-welcome entry-welcome"><span className="guest-kicker">BAHÇEŞEHİR · ÜYELİKSİZ SİPARİŞ</span><h1>{data?.table?.tableName??'Masanıza hoş geldiniz.'}</h1>
 {offline&&<p className="notice" role="status">Bağlantı kesildi. İnternet geldiğinde katılım durumu yenilenecek; yeni istek gönderilmez.</p>}
 {state==='pending'?<><h2>Personelimize bu kodu gösterin</h2><div className="entry-code" aria-label={'Katılım kodunuz '+data.request.code}>{data.request.code}</div><p>Kodunuz masanızda doğrulandığında sipariş ekranı otomatik açılır. E-posta veya parola gerekmez.</p><p className="helper">Katılım onayı bekleniyor…</p></>:['approved','claimed'].includes(state)?<p>Masanız onaylandı. Sipariş ekranı açılıyor…</p>:<><p>Menüyü hemen inceleyebilirsiniz. Masadan sipariş için aşağıdaki düğmeye dokunun ve oluşan kodu personelimize gösterin.</p>{state==='expired'&&<p className="notice">Önceki talebin süresi doldu. Yeni bir katılım talebi oluşturabilirsiniz.</p>}{state==='declined'&&<p className="notice">Katılım onaylanmadı. Lütfen personelimizle görüşün.</p>}{state==='finished'&&<p className="notice">Önceki ziyaretiniz sona erdi. Yeni ziyaretiniz için tekrar katılın.</p>}
 {data?.table?.enabled?<button className="guest-primary full" disabled={busy||offline} onClick={()=>void start()}>{busy?'İstek kaydediliyor…':'Bu masadan sipariş vermek istiyorum'}</button>:data&&<p className="notice">Şu anda siparişinizi personelimiz alıyor. Menüyü incelemeye devam edebilirsiniz.</p>}</>}
 {error&&<p role="alert" className="notice">{error}</p>}<div className="guest-welcome-actions"><Link className="btn" href="/bahcesehir">Menüyü incele</Link><a className="btn" href="tel:+905394830031">İşletmeyi ara</a></div><Link className="text-button" href="/yardim">Nasıl kullanılır?</Link></main>
 <footer className="guest-footer"><a href="https://www.menugo.app/"><img src="/media/menugo-transparent-r8.png" alt="MenüGO — Yeni Nesil Dijital Menü" width={560} height={147}/></a></footer></div>;
}
