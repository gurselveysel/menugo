'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,explain} from './transport';
import {Card} from './Shell';
import {TableQR} from './TableQR';

type EntryRequest={id:string;tableId:string;tableName:string;createdAt:string;expiresAt:string};
type RequestsProps={tableId?:string|null;showEmpty?:boolean;onCounts?:(counts:Record<string,number>)=>void;onClear?:()=>void};

export function TableAccessRequests({tableId=null,showEmpty=false,onCounts,onClear}:RequestsProps={}){
 const[rows,setRows]=useState<EntryRequest[]>([]),[codes,setCodes]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const alive=useRef(false),running=useRef(false);const onCountsRef=useRef(onCounts);onCountsRef.current=onCounts;
 const load=useCallback(async()=>{
  if(running.current)return;
  if(!navigator.onLine){if(alive.current){setError('Bağlantı kesildi. Katılım onayı için internet bağlantısını kontrol edin.');setLoading(false);}return;}
  running.current=true;
  try{
   const data=await api('/api/merchant/table-requests');
   if(!Array.isArray(data))throw new Error('INVALID_SERVER_RESPONSE');
   if(alive.current){setRows(data);setError('');const counts:Record<string,number>={};for(const row of data)counts[row.tableId]=(counts[row.tableId]??0)+1;onCountsRef.current?.(counts);}
  }catch(e){if(alive.current)setError(explain(e));}
  finally{running.current=false;if(alive.current)setLoading(false);}
 },[]);
 useEffect(()=>{
  alive.current=true;const refresh=()=>{if(document.visibilityState==='visible')void load();};
  refresh();const timer=setInterval(refresh,5000);
  document.addEventListener('visibilitychange',refresh);window.addEventListener('online',refresh);
  return()=>{alive.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);};
 },[load]);
 async function decide(id:string,approve:boolean){
  if(busy)return;setBusy(true);setError('');
  try{await api('/api/merchant/table-decision',{id,approve,code:codes[id]??''});setRows(v=>v.filter(x=>x.id!==id));setCodes(v=>{const n={...v};delete n[id];return n;});await load();}
  catch(e){setError(explain(e));}finally{setBusy(false);}
 }
 if(!rows.length&&!error&&!showEmpty&&!tableId)return null;
 const filtered=tableId?rows.filter(r=>r.tableId===tableId):rows;
 return <Card className="table-access-card"><section id="table-access-requests" tabIndex={-1}>
  <div className="section-heading"><div><h2>Katılım istekleri <span className="tag">{filtered.length}</span></h2><p>Adisyonu açın. Müşterinin telefonundaki dört haneli kodu girip onaylayın.</p></div><button type="button" className="btn" disabled={busy} onClick={()=>void load()}>İstekleri yenile</button></div>
  {tableId&&<button type="button" className="text-button" onClick={onClear}>Tüm masaları göster</button>}
  {error&&<p className="notice" role="alert">{error}</p>}
  {!filtered.length&&!error&&<p className="helper" role="status">{loading?'Katılım istekleri yükleniyor…':'Bekleyen katılım isteği yok. Müşteri masanın QR’sini okutunca talebi burada görünür.'}</p>}
  {filtered.map(r=><div className="entry-request" key={r.id}><div><strong>{r.tableName}</strong><small>{new Date(r.createdAt).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}</small></div><label>Telefondaki kod<input aria-label={r.tableName+' katılım kodu'} inputMode="numeric" autoComplete="off" pattern="[0-9]{4}" maxLength={4} value={codes[r.id]??''} onChange={e=>setCodes(v=>({...v,[r.id]:e.target.value.replace(/[^0-9]/g,'')}))}/></label><button type="button" className="btn primary" disabled={busy||!/^[0-9]{4}$/.test(codes[r.id]??'')} onClick={()=>void decide(r.id,true)}>Müşteri masada · onayla</button><button type="button" className="btn" disabled={busy} onClick={()=>void decide(r.id,false)}>Reddet</button></div>)}
 </section></Card>;
}

export function PermanentTableQR({table}:{table:{id:string;name:string}}){
 const[open,setOpen]=useState(false);
 const url='https://sariyerborekcisi.menugo.app/masaya-katil?masa='+encodeURIComponent(table.id);
 return <><button type="button" className="btn table-show-qr" onClick={()=>setOpen(true)} aria-label={table.name+' · QR göster'}>▣ QR göster</button><TableQR open={open} url={url} tableName={table.name} kind="permanent" onClose={()=>setOpen(false)}/></>;
}
