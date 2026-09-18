'use client';

import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {cameraMessage,tableQrTarget} from '@/lib/table-qr-target';
import styles from './TableScanner.module.css';

type Phase='idle'|'requesting'|'scanning'|'reading'|'verifying'|'paused'|'error';
type Decoder=typeof import('jsqr')['default'];
let decoderPromise:Promise<Decoder>|undefined;
function decoder(){return decoderPromise??=(import('jsqr').then(m=>m.default).catch(e=>{decoderPromise=undefined;throw e;}));}
const SIZE_LIMIT=12*1024*1024;

/** Camera/file pixels stay in this browser. No video upload, account or order writes. */
export function TableScanner(){
 const [mounted,setMounted]=useState(false),[open,setOpen]=useState(false),[phase,setPhase]=useState<Phase>('idle');
 const [message,setMessage]=useState(''),[manual,setManual]=useState('');
 const dialog=useRef<HTMLDialogElement>(null),video=useRef<HTMLVideoElement>(null),file=useRef<HTMLInputElement>(null);
 const stream=useRef<MediaStream|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),deadline=useRef<ReturnType<typeof setTimeout>|null>(null);
 const epoch=useRef(0),visible=useRef(false),navigating=useRef(false),request=useRef<AbortController|null>(null),objectUrl=useRef<string|null>(null);
 const label=useId(),description=useId();
 function release(){
  epoch.current++;
  if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}
  if(deadline.current!==null){clearTimeout(deadline.current);deadline.current=null;}
  request.current?.abort();request.current=null;
  stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;
  if(video.current){video.current.pause();video.current.srcObject=null;}
  if(objectUrl.current){URL.revokeObjectURL(objectUrl.current);objectUrl.current=null;}
 }
 function close(){visible.current=false;release();dialog.current?.close();setOpen(false);setPhase('idle');setManual('');setMessage('');}
 useEffect(()=>{
  setMounted(true);
  const pause=()=>{if(!visible.current||navigating.current)return;release();setPhase('paused');setMessage('Kamera duraklatıldı. Devam etmek için kamerayı yeniden açın.');};
  const hidden=()=>{if(document.visibilityState==='hidden')pause();};
  window.addEventListener('pagehide',pause);document.addEventListener('visibilitychange',hidden);
  return()=>{visible.current=false;release();window.removeEventListener('pagehide',pause);document.removeEventListener('visibilitychange',hidden);};
 },[]);
 useEffect(()=>{
  if(!open)return;
  const previous=document.body.style.overflow;
  document.body.style.overflow='hidden';
  return()=>{document.body.style.overflow=previous;};
 },[open]);
 function launch(){
  if(!dialog.current||visible.current)return;
  visible.current=true;navigating.current=false;setOpen(true);setManual('');setMessage('');
  dialog.current.showModal();void startCamera();
 }
 async function navigate(raw:string):Promise<boolean>{
  const target=tableQrTarget(raw,location.origin);
  if(!target){setMessage('Bu QR, MenüGO masa siparişi bağlantısı değil. Masanızdaki QR’yi tarayın.');return false;}
  release();const current=epoch.current;setPhase('verifying');setMessage('Masa bağlantısı doğrulanıyor…');
  try{
   if(!navigator.onLine)throw Error('İnternet bağlantısı yok. Bağlantınız geldikten sonra tekrar deneyin.');
   if(target.kind==='table'){
    const ctrl=new AbortController();request.current=ctrl;
    deadline.current=setTimeout(()=>ctrl.abort(),12000);
    const res=await fetch('/api/table/'+target.tableId,{cache:'no-store',credentials:'same-origin',signal:ctrl.signal});
    if(!res.ok)throw Error(res.status===404?'Bu masa bağlantısı bulunamadı. Personelimizden güncel QR’yi isteyin.':'Masa doğrulanamadı. Lütfen yeniden deneyin.');
    const data=await res.json();
    if(data?.table?.tableId!==target.tableId||typeof data.table.tableName!=='string')throw Error('Masa bağlantısı doğrulanamadı.');
   }
   if(!visible.current||current!==epoch.current)return true;
   if(deadline.current!==null){clearTimeout(deadline.current);deadline.current=null;}
   navigating.current=true;setMessage('Masanız açılıyor…');location.assign(target.path);return true;
  }catch(e){
   if(!visible.current||current!==epoch.current)return true;
   release();setPhase('error');setMessage(e instanceof Error&&e.name!=='AbortError'?e.message:'Masa doğrulaması zaman aşımına uğradı. Yeniden deneyin.');return true;
  }
 }
 async function startCamera(){
  if(!visible.current)return;
  release();const current=epoch.current;setMessage('');setPhase('requesting');
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){setPhase('error');setMessage('Bu tarayıcı kamerayı açamıyor. Sayfayı Chrome veya Safari’de açın; QR fotoğrafıyla da devam edebilirsiniz.');return;}
  deadline.current=setTimeout(()=>{if(current!==epoch.current)return;release();setPhase('error');setMessage('Kamera izni bekleniyor. İzin penceresini kontrol edip yeniden deneyin.');},25000);
  let acquired:MediaStream|null=null;
  try{
   acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
   if(current!==epoch.current||!visible.current){acquired.getTracks().forEach(t=>t.stop());return;}
   stream.current=acquired;
   if(!video.current)throw Error('VIDEO_NOT_READY');
   video.current.srcObject=acquired;await video.current.play();
   const decode=await decoder();
   if(current!==epoch.current||!visible.current){acquired.getTracks().forEach(t=>t.stop());return;}
   if(deadline.current!==null){clearTimeout(deadline.current);deadline.current=null;}
   setPhase('scanning');setMessage('Masanızdaki QR kodunu kameraya gösterin.');
   const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
   if(!ctx)throw Error('CANVAS_UNAVAILABLE');
   const ended=()=>{if(current!==epoch.current||!visible.current)return;release();setPhase('error');setMessage('Kamera bağlantısı kesildi. Yeniden açabilirsiniz.');};
   acquired.getVideoTracks().forEach(t=>t.addEventListener('ended',ended,{once:true}));
   const scan=()=>{
    if(current!==epoch.current||!visible.current)return;
    try{
     const v=video.current;
     if(v&&v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0){
      const scale=Math.min(1,960/Math.max(v.videoWidth,v.videoHeight));
      canvas.width=Math.max(1,Math.round(v.videoWidth*scale));canvas.height=Math.max(1,Math.round(v.videoHeight*scale));
      ctx.drawImage(v,0,0,canvas.width,canvas.height);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
      const result=decode(pixels.data,canvas.width,canvas.height,{inversionAttempts:'attemptBoth'});
      if(result){
       if(tableQrTarget(result.data,location.origin)){void navigate(result.data);return;}
       setMessage('Bu QR masa siparişi için değil. Masanızdaki MenüGO QR’sini gösterin.');
      }
     }
     timer.current=setTimeout(scan,220);
    }catch{release();setPhase('error');setMessage('Kamera görüntüsü okunamadı. QR fotoğrafından devam edebilirsiniz.');}
   };scan();
  }catch(e){
   acquired?.getTracks().forEach(t=>t.stop());
   if(current!==epoch.current||!visible.current)return;
   release();setPhase('error');setMessage(cameraMessage(e));
  }
 }
 async function readPhoto(selected:File){
  release();const current=epoch.current;setPhase('reading');setMessage('QR fotoğrafı cihazınızda okunuyor…');
  if(!['image/jpeg','image/png','image/webp','image/gif','image/bmp'].includes(selected.type)||selected.size>SIZE_LIMIT||selected.size===0){setPhase('error');setMessage('En fazla 12 MB boyutunda JPG, PNG veya WebP fotoğrafı seçin.');return;}
  const url=URL.createObjectURL(selected);objectUrl.current=url;
  try{
   const img=new Image();
   await new Promise<void>((resolve,reject)=>{
    deadline.current=setTimeout(()=>reject(Error('PHOTO_TIMEOUT')),15000);
    img.onload=()=>resolve();img.onerror=()=>reject(Error('INVALID_IMAGE'));img.src=url;
   });
   if(current!==epoch.current||!visible.current)return;
   if(deadline.current!==null){clearTimeout(deadline.current);deadline.current=null;}
   if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>36000000)throw Error('IMAGE_LIMIT');
   const decode=await decoder();if(current!==epoch.current||!visible.current)return;
   const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('CANVAS');
   let found:string|null=null;
   for(const max of [1600,2400]){
    const scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
    found=decode(pixels.data,canvas.width,canvas.height,{inversionAttempts:'attemptBoth'})?.data??null;
    if(found)break;
   }
   if(current!==epoch.current||!visible.current)return;
   if(!found){setPhase('error');setMessage('Fotoğrafta QR bulunamadı. QR’nin tamamının net göründüğü bir fotoğraf seçin.');return;}
   if(!await navigate(found))setPhase('error');
  }catch{if(current===epoch.current&&visible.current){setPhase('error');setMessage('Fotoğraf okunamadı. Net bir JPG veya PNG fotoğrafıyla tekrar deneyin.');}}
  finally{URL.revokeObjectURL(url);if(objectUrl.current===url)objectUrl.current=null;if(current===epoch.current&&deadline.current!==null){clearTimeout(deadline.current);deadline.current=null;}}
 }
 const working=['requesting','reading','verifying'].includes(phase);
 return <>
  <button type="button" className={'btn '+styles.launch} onClick={launch} disabled={!mounted}>
   <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 6h3l2-3h6l2 3h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/></svg>
   Kamerayı aç ve masa QR’sini tara
  </button>
  {mounted&&createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={label} aria-describedby={description}
   onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}}}>
   <header className={styles.heading}><div><span>SARIYER BÖREKÇİSİ · BAHÇEŞEHİR</span><h2 id={label}>Masanızın QR’sini tarayın</h2></div><button autoFocus type="button" onClick={close} aria-label="QR tarayıcıyı kapat">×</button></header>
   <p id={description} className={styles.description}>QR kodunu çerçeveye alın. Masa bulunduğunda sipariş ekranınız açılır.</p>
   <div className={styles.stage} data-phase={phase}><video ref={video} autoPlay muted playsInline aria-label="Masa QR kamera görüntüsü"/><div className={styles.frame} aria-hidden="true"/>{phase!=='scanning'&&<span>{phase==='requesting'?'Kamera izni bekleniyor…':phase==='reading'?'Fotoğraf okunuyor…':phase==='verifying'?'Masa doğrulanıyor…':'Kamera kapalı'}</span>}</div>
   <p className={styles.status} role={phase==='error'?'alert':'status'} aria-live="polite">{message}</p>
   <div className={styles.actions}>
    {phase==='scanning'?<button type="button" className="btn" onClick={()=>{release();setPhase('paused');setMessage('Kamera kapatıldı.');}}>Kamerayı durdur</button>:<button type="button" className="btn" disabled={working} onClick={()=>void startCamera()}>Kamerayı yeniden aç</button>}
    <button type="button" className="btn" disabled={phase==='verifying'||phase==='reading'} onClick={()=>{release();setPhase('paused');setMessage('QR fotoğrafını seçin.');file.current?.click();}}>QR fotoğrafı seç</button>
   </div>
   <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden aria-label="QR fotoğrafı" onChange={e=>{const selected=e.currentTarget.files?.[0];e.currentTarget.value='';if(selected)void readPhoto(selected);}}/>
   <details className={styles.manual}><summary>Masa bağlantısını yapıştır</summary><form onSubmit={e=>{e.preventDefault();if(!working)void navigate(manual);}}><label>Masa QR bağlantısı<input value={manual} onChange={e=>setManual(e.target.value)} type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} placeholder="https://…/masaya-katil?masa=…"/></label><button type="submit" className="btn" disabled={!manual.trim()||working}>Masaya geç</button></form></details>
   <p className={styles.privacy}>Kamera ve fotoğraf yalnızca cihazınızda işlenir; görüntüler gönderilmez. Siparişiniz siz onaylamadan gönderilmez.</p>
   <details className={styles.help}><summary>Kamera açılmıyorsa</summary><p>Tarayıcının site ayarlarından kamera iznini kontrol edin. Uygulama içi tarayıcı kullanıyorsanız sayfayı telefonunuzun Chrome veya Safari tarayıcısında açın. QR fotoğrafı seçebilir ya da personelimizden masa bağlantısını isteyebilirsiniz.</p></details>
  </dialog>,document.body)}
 </>;
}
