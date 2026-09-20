'use client';
import {useEffect,useRef,useState} from 'react';
import {Card} from './Shell';
import {photoApplyCommand,readPhotoCommand,publicPhotoPath,type PhotoPreview,type PhotoCommand} from '@/src/studio/photo-publication';
type History={id:string;action:'apply'|'undo';createdAt:string;canUndo:boolean;receipt:{productId:string}};
type Listing={scopeKey:string;jobs:{id:string;sourceName:string}[];history:History[]};
class RequestError extends Error {constructor(public code:string,public status:number){super(code);}}
const MESSAGES:Record<string,string>={STUDIO_SOURCE_CHANGED:'Ürün bilgisi değişmiş. Güncel ürün üzerinden yeni görsel taslağı hazırlayın.',PUBLICATION_CHANGED:'Daha yeni bir değişiklik var. Üzerine yazılmadı; önizlemeyi yenileyin.',STUDIO_REVIEW_REQUIRED:'Önce fotoğrafı aslıyla karşılaştırıp incelenmiş taslak olarak kaydedin.',STUDIO_ALREADY_APPLIED:'Bu görsel zaten uygulandı. Yayın geçmişini kontrol edin.',INVALID_PHOTO_DRAFT:'Görsel taslağı yayımlamaya uygun değil.',PLATFORM_SERVICE_PAUSED:'Şirket bu hizmeti durdurdu. Önceki yayını geri alabilirsiniz.',IDEMPOTENCY_CONFLICT:'İşlem kimliği uyuşmuyor. Yeni değişiklik yapılmadı; durumu kontrol edin.'};
async function request(command?:unknown){const r=await fetch('/api/studio/photo-publication',{method:command?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:command?{'Content-Type':'application/json'}:{},body:command?JSON.stringify(command):undefined,signal:AbortSignal.timeout(15000)});const v=await r.json();if(!r.ok)throw new RequestError(v.error?.code||'REQUEST_FAILED',r.status);return v;}
export function StudioPhotoPublishing(){
 const [list,setList]=useState<Listing|null>(null),[selected,setSelected]=useState(''),[preview,setPreview]=useState<PhotoPreview|null>(null);
 const [previewKey,setPreviewKey]=useState(0);
 const [confirmed,setConfirmed]=useState(false),[loaded,setLoaded]=useState({source:false,draft:false}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState<PhotoCommand|null>(null),[undo,setUndo]=useState<string|null>(null),[denied,setDenied]=useState(false);
 const mounted=useRef(false),lock=useRef(false),epoch=useRef(0),key=useRef<string|null>(null),pendingRef=useRef<PhotoCommand|null>(null);
 function setIntent(c:PhotoCommand|null){if(key.current){if(c)sessionStorage.setItem(key.current,JSON.stringify(c));else sessionStorage.removeItem(key.current);}pendingRef.current=c;setPending(c);}
 function report(e:unknown){if(e instanceof RequestError&&[401,403].includes(e.status)){epoch.current++;setDenied(true);setList(null);setPreview(null);setSelected('');setError('Oturum veya yetki değişti. Yeniden giriş yapın.');return;}setError(e instanceof RequestError?(MESSAGES[e.code]||'İşlem reddedildi. Menüdeki değişiklikleri kontrol edin.'):'Yanıt doğrulanamadı. Bekleyen işlemi aynı kimlikle kontrol edin.');}
 async function refresh(){const n=++epoch.current;try{const d=await request();if(!mounted.current||epoch.current!==n)return;
  if(typeof d.scopeKey!=='string'||!/^([a-f0-9-]{36}:){2}[a-f0-9-]{36}$/.test(d.scopeKey)||!Array.isArray(d.jobs)||!Array.isArray(d.history))throw Error('INVALID_LIST');
  const k='menugo-photo-publication:'+d.scopeKey;
  if(key.current!==k){setPreview(null);setSelected('');setConfirmed(false);key.current=k;const stored=sessionStorage.getItem(k);pendingRef.current=null;setPending(null);if(stored){const c=JSON.parse(stored);const parsed=readPhotoCommand(c);if(parsed.action==='preview')throw Error('INVALID_JOURNAL');pendingRef.current=c;setPending(c);}}
  setList(d);
 }catch(e){if(mounted.current&&epoch.current===n)report(e);}}
 useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;epoch.current++;};},[]);
 async function compare(){if(lock.current||pendingRef.current||!selected)return;lock.current=true;setBusy(true);setError('');setNotice('');const n=++epoch.current;
  try{const p=await request({action:'preview',jobId:selected});if(!mounted.current||epoch.current!==n)return;
   readPhotoCommand({action:'apply',operationId:crypto.randomUUID(),confirmed:true,jobId:p.jobId,jobRevision:p.jobRevision,sourceHash:p.sourceHash,imageHash:p.imageHash,overlayVersion:p.overlayVersion});
   if(p.jobId!==selected||typeof p.ready!=='boolean'||p.sourceUrl!=='/api/studio/source?id='+selected||p.draftUrl!=='/api/studio/image?id='+selected)throw Error('INVALID_PREVIEW');
   if(p.beforeUrl!==null&&!publicPhotoPath(p.beforeUrl))throw Error('INVALID_IMAGE_PATH');
   setPreview(p);setPreviewKey(n);setConfirmed(false);setLoaded({source:false,draft:false});
  }catch(e){if(mounted.current&&epoch.current===n)report(e);}finally{lock.current=false;if(mounted.current)setBusy(false);}}
 async function send(c:PhotoCommand){if(lock.current||denied)return;lock.current=true;setBusy(true);setError('');setNotice('');const n=++epoch.current;
  try{setIntent(c);const r=await request(c);if(!mounted.current||epoch.current!==n)return;
   if(r.action!==c.action||r.operationId!==c.operationId||typeof r.publicationId!=='string'||r.cataloguePricesChanged!==false)throw Error('INVALID_RECEIPT');
   setIntent(null);setPreview(null);setSelected('');setConfirmed(false);setUndo(null);
   setNotice(c.action==='apply'?'İncelenen fotoğraf ürün kartına uygulandı. Fiyat ve ürün bilgileri değişmedi.':'Fotoğraf yayını geri alındı. Yeni değişikliklerin üzerine yazılmadı.');await refresh();
  }catch(e){if(!mounted.current)return;if(e instanceof RequestError&&[400,404,409,410,422].includes(e.status)){setIntent(null);setPreview(null);setConfirmed(false);setUndo(null);}report(e);}
  finally{lock.current=false;if(mounted.current)setBusy(false);}}
 const disabled=busy||!!pending||denied;
 return <section className="studio-photo-publication" aria-label="İncelenmiş fotoğrafları yayımla"><Card>
  <p className="eyebrow">FOTOĞRAF → KARŞILAŞTIR → ÜRÜNE UYGULA</p><h2>Ürün fotoğrafınızı menüye taşıyın</h2>
  <p>Yalnız incelenmiş görsel ürün kartında kullanılır. Eski fotoğraf korunur; fiyat, porsiyon, alerjen ve siparişler değiştirilmez.</p>
  {error&&<p className="notice" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
  {pending&&<div className="notice"><strong>Yayın işleminin sonucu belirsiz.</strong><p>Aynı işlemle doğrulayın; yeni bir üretim veya ikinci yayın başlatılmaz.</p><button className="btn" disabled={busy||denied} onClick={()=>void send(pending)}>Aynı fotoğraf işlemini kontrol et</button></div>}
  {!denied&&<><label htmlFor="studio-photo-draft">İncelenmiş ürün fotoğrafı</label><select id="studio-photo-draft" value={selected} disabled={disabled} onChange={e=>{epoch.current++;setSelected(e.target.value);setPreview(null);setConfirmed(false);}}><option value="">Fotoğraf taslağını seçin</option>{list?.jobs.map(j=><option key={j.id} value={j.id}>{j.sourceName}</option>)}</select>
   {!list?.jobs.length&&<p className="helper">Stüdyoda fotoğrafı kaynakla karşılaştırıp “İncelenmiş taslağı kaydet” adımını tamamlayın. AI altyapısını MenüGO şirketi yönetir.</p>}
   <div className="studio-publication-actions"><button className="btn" disabled={disabled} onClick={()=>void refresh()}>Fotoğraf listesini yenile</button><button className="btn" disabled={disabled||!selected} onClick={()=>void compare()}>Fotoğrafı karşılaştır</button></div>
   {preview&&<div key={previewKey} className="studio-photo-preview"><h3>{preview.productName}</h3><div className="studio-compare">
    <figure><h4>Yüklediğiniz kaynak fotoğraf</h4><img src={preview.sourceUrl} alt="Orijinal ürün fotoğrafı" onLoad={()=>setLoaded(v=>({...v,source:true}))} onError={()=>{setLoaded(v=>({...v,source:false}));setError('Kaynak fotoğraf yüklenemedi; yayımlama kapalı.');}}/></figure>
    <figure><h4>Menüye uygulanacak fotoğraf</h4><img src={preview.draftUrl} alt="İncelenecek ürün fotoğrafı" onLoad={()=>setLoaded(v=>({...v,draft:true}))} onError={()=>{setLoaded(v=>({...v,draft:false}));setError('Taslak fotoğraf yüklenemedi; yayımlama kapalı.');}}/></figure>
   </div>{preview.beforeUrl&&<details><summary>Şu anda menüdeki fotoğraf</summary><img className="studio-photo-current" src={preview.beforeUrl} alt="Mevcut ürün fotoğrafı"/></details>}
    {!preview.ready&&<p role="alert">{MESSAGES[preview.reason||'']||'Bu taslak güncel değil; uygulanamaz.'}</p>}
    <label className="studio-checkbox"><input type="checkbox" checked={confirmed} disabled={disabled||!loaded.source||!loaded.draft} onChange={e=>setConfirmed(e.target.checked)}/>Görseli kaynakla karşılaştırdım. Gerçek ürünün porsiyonu, malzemeleri ve sunumu doğru; bu fotoğrafı müşterilere göster.</label>
    <button className="btn primary" disabled={disabled||!confirmed||!preview.ready||!loaded.source||!loaded.draft} onClick={()=>void send(photoApplyCommand(preview,crypto.randomUUID()))}>Fotoğrafı ürün kartına uygula</button>
   </div>}
   <h3>Fotoğraf yayın geçmişi</h3>{list?.history.length?list.history.map(h=><article className="studio-photo-history" key={h.id}><strong>{h.action==='apply'?'Ürün fotoğrafı yayımlandı':'Fotoğraf yayını geri alındı'}</strong><p>{new Date(h.createdAt).toLocaleString('tr-TR')}</p>{h.canUndo&&<button className="btn" disabled={disabled} onClick={()=>setUndo(h.id)}>Bu fotoğrafı geri al</button>}{undo===h.id&&<div className="notice"><p>Önceki fotoğraf geri gelir. Daha yeni bir yayın varsa işlem reddedilir.</p><button className="btn" disabled={disabled} onClick={()=>void send({action:'undo',publicationId:h.id,operationId:crypto.randomUUID(),confirmed:true})}>Fotoğrafı geri almayı onayla</button><button className="btn" disabled={disabled} onClick={()=>setUndo(null)}>Vazgeç</button></div>}</article>):<p className="helper">Henüz yayımlanmış ürün fotoğrafı yok.</p>}
  </>}
 </Card></section>;
}
