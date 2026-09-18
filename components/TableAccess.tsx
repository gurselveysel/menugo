'use client';
import {useEffect,useState} from 'react';
import {api,explain} from './transport';
import {Card} from './Shell';
export function TableAccessRequests(){
 const[rows,setRows]=useState<any[]>([]),[codes,setCodes]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let alive=true;const load=()=>{if(navigator.onLine&&document.visibilityState==='visible')void api('/api/merchant/table-requests').then(v=>{if(alive)setRows(v);}).catch(()=>{});};load();const timer=setInterval(load,5000);return()=>{alive=false;clearInterval(timer);};},[]);
 async function decide(id:string,approve:boolean){setBusy(true);setError('');try{await api('/api/merchant/table-decision',{id,approve,code:codes[id]??''});setRows(await api('/api/merchant/table-requests'));setCodes(v=>{const n={...v};delete n[id];return n;});}catch(e){setError(explain(e));}finally{setBusy(false);}}
 if(!rows.length&&!error)return null;
 return <Card className="table-access-card"><h2>Masa katılım talepleri</h2><p>Önce masanın adisyonunu açın. Müşterinin telefonunda gördüğünüz dört haneli kodu girerek masada olduğunu doğrulayın.</p>{error&&<p className="notice" role="alert">{error}</p>}{rows.map(r=><div className="entry-request" key={r.id}><div><strong>{r.tableName}</strong><small>{new Date(r.createdAt).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}</small></div><label>Telefondaki kod<input aria-label={r.tableName+' katılım kodu'} inputMode="numeric" autoComplete="off" pattern="[0-9]{4}" maxLength={4} value={codes[r.id]??''} onChange={e=>setCodes(v=>({...v,[r.id]:e.target.value.replace(/[^0-9]/g,'')}))}/></label><button className="btn primary" disabled={busy||!/^[0-9]{4}$/.test(codes[r.id]??'')} onClick={()=>void decide(r.id,true)}>Müşteri masada · onayla</button><button className="btn" disabled={busy} onClick={()=>void decide(r.id,false)}>Reddet</button></div>)}</Card>;
}
export function PermanentTableQR({table}:{table:{id:string;name:string}}){
 const[open,setOpen]=useState(false),[image,setImage]=useState(''),[message,setMessage]=useState('');
 const url='https://sariyerborekcisi.menugo.app/masaya-katil?masa='+encodeURIComponent(table.id);
 useEffect(()=>{if(!open)return;let alive=true;void import('qrcode').then(q=>q.toDataURL(url,{width:960,margin:4,errorCorrectionLevel:'M'})).then(v=>{if(alive)setImage(v);}).catch(()=>{if(alive)setMessage('QR hazırlanamadı. Yeniden deneyin.');});return()=>{alive=false;};},[open,url]);
 return <><button className="btn" onClick={()=>setOpen(v=>!v)}>{open?'QR’yi kapat':'Kalıcı masa QR’si'}</button>{open&&<section className="permanent-table-qr"><h3>{table.name}</h3>{image&&<img src={image} width={240} height={240} alt={table.name+' kalıcı masa QR kodu'}/>}<p>Basılabilir. Her yeni ziyaret personel onayıyla kendi adisyonuna katılır; önceki müşterinin hesabı açılmaz.</p>{image&&<a className="btn" href={image} download={'Sariyer-'+table.name.replace(/[^a-zA-Z0-9ığüşöçİĞÜŞÖÇ-]/g,'-')+'-QR.png'}>QR’yi kaydet</a>}<button className="btn" onClick={async()=>{try{await navigator.clipboard.writeText(url);setMessage('Bağlantı kopyalandı.');}catch{setMessage(url);}}}>Bağlantıyı kopyala</button><p role="status">{message}</p></section>}</>;
}
