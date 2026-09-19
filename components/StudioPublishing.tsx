'use client';
import {useEffect,useRef,useState} from 'react';
import {Card} from './Shell';
import {applyCommand,type PreviewRow,type PublicationCommand} from '@/src/studio/publication';
type Job={id:string;kind:string;sourceName:string;language:string};
type Receipt={batchId:string;action:string;items:{productId:string;language:string;version:string}[]};
type History={id:string;action:string;createdAt:string;receipt:Receipt};
const messages:Record<string,string>={
 STUDIO_SOURCE_CHANGED:'Kaynak ürün değişmiş. Güncel ürün üzerinden yeni taslak hazırlayın.',
 PUBLICATION_CHANGED:'Bu ürünün yayını başka bir işlemde değişti. Önizlemeyi yenileyin; yeni içeriğin üzerine yazılmadı.',
 STUDIO_ALREADY_APPLIED:'Bu taslak daha önce uygulanmış. Yayın geçmişini yenileyin.',
 STUDIO_REVIEW_REQUIRED:'Önce taslağı kaynakla karşılaştırıp incelenmiş olarak kaydedin.',
 IDEMPOTENCY_CONFLICT:'İşlem kimliği uyuşmuyor. Yeni bir yazma yapılmadı; yayın geçmişinden durumu kontrol edin.',
 INVALID_PUBLICATION_DRAFT:'Taslağın metni bu yayın biçimine uygun değil. Metin en fazla 2000 karakter olmalıdır.',
 DUPLICATE_PUBLICATION_TARGET:'Aynı ürün ve dil için birden çok taslak seçilmiş. Birini seçin.',
 PUBLICATION_NOT_FOUND:'Yayın kaydı bulunamadı.',
 PUBLICATION_CONFIRM_REQUIRED:'Önce değişecek alanları kontrol edin.',
 UNAUTHENTICATED:'Oturumunuz sona erdi. Tekrar giriş yapın.',MANAGER_REQUIRED:'Yönetici yetkisi gerekiyor.'
};
class HttpIssue extends Error{constructor(public code:string,public status:number){super(code);}}
async function request(data?:unknown){
 const r=await fetch('/api/studio/publication',{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},credentials:'same-origin',cache:'no-store',body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(15000)});
 const v=await r.json();if(!r.ok)throw new HttpIssue(v.error?.code??'REQUEST_FAILED',r.status);return v;
}
export function StudioPublishing(){
 const [data,setData]=useState<{jobs:Job[];history:History[]}>({jobs:[],history:[]}),[chosen,setChosen]=useState<string[]>([]),[preview,setPreview]=useState<PreviewRow[]|null>(null);
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<PublicationCommand|null>(null),[undo,setUndo]=useState<string|null>(null),[denied,setDenied]=useState(false);
 const lock=useRef(false),pendingRef=useRef<PublicationCommand|null>(null),listSeq=useRef(0),previewSeq=useRef(0),mounted=useRef(false);
 function clearSensitive(){pendingRef.current=null;setPending(null);setPreview(null);setData({jobs:[],history:[]});setChosen([]);setDenied(true);}
 function report(e:unknown){
  if(e instanceof HttpIssue&&[401,403].includes(e.status))clearSensitive();
  setError(e instanceof HttpIssue?(messages[e.code]??'İşlem tamamlanamadı. Değişiklikleri kontrol edip yeniden deneyin.'):'Bağlantı sonucu doğrulanamadı. Bekleyen işlemi aynı kimlikle kontrol edin.');
 }
 async function refresh(){
  const seq=++listSeq.current;
  try{const next=await request();if(!mounted.current||seq!==listSeq.current)return;setData({jobs:Array.isArray(next.jobs)?next.jobs:[],history:Array.isArray(next.history)?next.history:[]});}
  catch(e){if(mounted.current&&seq===listSeq.current)report(e);}
 }
 useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;listSeq.current++;previewSeq.current++;};},[]);
 async function showPreview(){
  if(lock.current||pendingRef.current||!chosen.length)return;lock.current=true;setBusy(true);setError('');setNotice('');const seq=++previewSeq.current;
  try{const next=await request({action:'preview',items:chosen.map(jobId=>({jobId}))});if(!Array.isArray(next.items)||next.items.length!==chosen.length)throw Error('INVALID_RESPONSE');if(mounted.current&&seq===previewSeq.current){setPreview(next.items);setConfirmed(false);}}
  catch(e){if(mounted.current&&seq===previewSeq.current)report(e);}
  finally{lock.current=false;if(mounted.current)setBusy(false);}
 }
 async function send(command:PublicationCommand){
  if(lock.current||denied)return;lock.current=true;setBusy(true);setError('');setNotice('');listSeq.current++;previewSeq.current++;
  pendingRef.current=command;setPending(command);
  try{
   const result=await request(command);
   if(typeof result.batchId!=='string'||result.action!==command.action||!Array.isArray(result.items))throw Error('INVALID_RECEIPT');
   if(!mounted.current)return;
   pendingRef.current=null;setPending(null);setPreview(null);setChosen([]);setUndo(null);setConfirmed(false);
   setNotice(command.action==='apply'?'İncelenen metinler menüye uygulandı. Fiyatlar ve siparişler değişmedi.':'Bu toplu uygulama geri alındı. Daha yeni bir yayının üzerine yazılmadı.');
   await refresh();
  }catch(e){
   if(!mounted.current)return;
   // Only definite rejections can discard an intent. Network/5xx ambiguity keeps its identity.
   if(e instanceof HttpIssue&&[400,404,409,410,422].includes(e.status)){
    pendingRef.current=null;setPending(null);setPreview(null);setConfirmed(false);setUndo(null);
   }
   report(e);await refresh();
  }finally{lock.current=false;if(mounted.current)setBusy(false);}
 }
 function change(id:string,checked:boolean){if(lock.current||pendingRef.current)return;previewSeq.current++;setChosen(old=>checked?[...old,id].slice(0,20):old.filter(x=>x!==id));setPreview(null);setConfirmed(false);}
 function apply(){if(!preview||!confirmed||pendingRef.current)return;try{void send(applyCommand(preview,crypto.randomUUID()));}catch{setError(messages.STUDIO_SOURCE_CHANGED);}}
 return <section className="studio-publication" aria-label="Menüye uygulama ve yayın geçmişi"><Card>
  <p className="eyebrow">İNCELE → MENÜYE UYGULA → GERİ AL</p><h2>Hazır metinleri menünüze taşıyın</h2>
  <p>Türkçe taslakta yalnız açıklama; İngilizce çeviride görünen ad ve açıklama uygulanır. Fiyat, içerik/alerjen, porsiyon ve seçenekler değiştirilmez.</p>
  {error&&<p className="notice" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
  {pending&&<div className="notice" role="status"><strong>İşlemin sonucu bekleniyor.</strong><p>Yeniden deneme aynı işlem kimliğini kullanır; tamamlanan yayın ikinci kez uygulanmaz. Yeni bir işlem başlatmadan sonucu kontrol edin.</p><button className="btn" disabled={busy||denied} onClick={()=>void send(pending)}>Aynı yayın işlemini kontrol et</button></div>}
  {!denied&&<>
   <div className="studio-publication-jobs">{data.jobs.length?data.jobs.map(j=><label className="studio-checkbox" key={j.id}><input type="checkbox" checked={chosen.includes(j.id)} disabled={busy||!!pending||(!chosen.includes(j.id)&&chosen.length>=20)} onChange={e=>change(j.id,e.target.checked)}/><span>{j.sourceName} · {j.language==='en'?'İngilizce ad ve açıklama':'Türkçe açıklama'}</span></label>):<p className="helper">Önce stüdyoda bir açıklama veya İngilizce çeviri hazırlayın, kaynakla karşılaştırıp incelenmiş taslağı kaydedin. Sonra listeyi yenileyin.</p>}</div>
   <div className="studio-publication-actions"><button className="btn" disabled={busy||!!pending} onClick={()=>void refresh()}>Uygulanabilir taslakları yenile</button><button className="btn" disabled={busy||!!pending||!chosen.length} onClick={()=>void showPreview()}>Seçilenleri önizle ({chosen.length})</button></div>
   {preview&&<div className="studio-publication-preview">{preview.map(r=><article key={r.jobId}><h3>{r.productName} · {r.language.toUpperCase()}</h3><div className="studio-compare"><section><h4>Mevcut metin</h4>{r.before.title&&<strong>{r.before.title}</strong>}<p>{r.before.body||'Kayıtlı açıklama yok; özgün menüye dönülür.'}</p></section><section><h4>Uygulanacak metin</h4>{r.after.title&&<strong>{r.after.title}</strong>}<p>{r.after.body}</p></section></div>{!r.ready&&<p role="alert">{messages[r.reason??'']??'Kaynak güncel değil; uygulanamaz.'}</p>}</article>)}
    <label className="studio-checkbox"><input type="checkbox" checked={confirmed} disabled={busy||!!pending} onChange={e=>setConfirmed(e.target.checked)}/>Yalnız yukarıdaki alanların değişeceğini kontrol ettim; menüde yayımla.</label>
    <button className="btn primary" disabled={busy||!!pending||!confirmed||preview.some(r=>!r.ready)} onClick={apply}>Seçilen metinleri menüye uygula</button>
   </div>}
   <h3>Yayın geçmişi</h3>{data.history.length?<div className="studio-publication-history">{data.history.map(h=><article key={h.id}><strong>{h.action==='undo'?'Geri alma':'Metin uygulaması'}</strong><p>{new Date(h.createdAt).toLocaleString('tr-TR')} · {h.receipt?.items?.length??0} ürün/dil</p>{h.action==='apply'&&<button className="btn" disabled={busy||!!pending} onClick={()=>{setUndo(h.id);setConfirmed(false);}}>Bu uygulamayı geri al</button>}{undo===h.id&&<div className="notice"><p>Bu gruptaki tüm metinler önceki kayıtlarına döner. Daha yeni değişiklik varsa işlem hiçbir ürünü değiştirmeden reddedilir.</p><button className="btn" disabled={busy||!!pending} onClick={()=>void send({action:'undo',batchId:h.id,operationId:crypto.randomUUID(),confirmed:true})}>Geri almayı onayla</button><button className="btn" disabled={busy||!!pending} onClick={()=>setUndo(null)}>Vazgeç</button></div>}</article>)}</div>:<p className="helper">Henüz ürünlere uygulanmış bir stüdyo metni yok.</p>}
  </>}
 </Card></section>;
}
