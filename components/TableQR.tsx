'use client';

import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export type TableQRProps = {
  url: string;
  tableName: string;
  kind: 'permanent' | 'visit';
  expiresAt?: number;
  open: boolean;
  onClose: () => void;
};

/** Native top-layer dialog: the waiter can hand the screen to the guest.
 * Rendering/printing a permanent QR never opens a check or grants access.
 * Visit credentials are never sent to an image generation/QR service.
 */
export function TableQR({url,tableName,kind,expiresAt,open,onClose}:TableQRProps) {
  const ref=useRef<HTMLDialogElement>(null);
  const linkRef=useRef<HTMLInputElement>(null);
  const [mounted,setMounted]=useState(false);
  const [image,setImage]=useState('');
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [presentation,setPresentation]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const [now,setNow]=useState(0);
  const titleId=useId();
  const descriptionId=useId();
  const permanent=kind==='permanent';
  const expired=!permanent&&!!expiresAt&&now>=expiresAt;
  const seconds=expiresAt?Math.max(0,Math.floor((expiresAt-now)/1000)):null;

  useEffect(()=>setMounted(true),[]);
  useEffect(()=>{
    if(!mounted||!open)return;
    const dialog=ref.current;
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const previousOverflow=document.body.style.overflow;
    if(dialog&&!dialog.open)dialog.showModal();
    document.body.style.overflow='hidden';
    return()=>{
      if(dialog?.open)dialog.close();
      document.body.style.overflow=previousOverflow;
      if(trigger?.isConnected)trigger.focus({preventScroll:true});
    };
  },[mounted,open]);
  useEffect(()=>{
    if(!open)return;
    let alive=true;
    setImage('');setError('');setMessage('');setPresentation(false);
    // The payload is encoded locally; no logo overlay compromises the QR.
    void import('qrcode').then(q=>q.toDataURL(url,{
      width:1024,margin:4,errorCorrectionLevel:'M',
      color:{dark:'#000000',light:'#ffffff'},
    })).then(value=>{if(alive)setImage(value);}).catch(()=>{
      if(alive)setError('QR hazırlanamadı. Yeniden deneyin veya bağlantıyı kopyalayın.');
    });
    return()=>{alive=false;};
  },[open,url,attempt]);
  useEffect(()=>{
    if(!open)return;
    setNow(Date.now());
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>clearInterval(timer);
  },[open]);
  async function copy() {
    if(expired)return;
    try{await navigator.clipboard.writeText(url);setMessage('Bağlantı kopyalandı.');}
    catch{linkRef.current?.focus();linkRef.current?.select();setMessage('Bağlantıyı seçip kopyalayabilirsiniz.');}
  }
  async function share() {
    if(expired)return;
    try{
      if(navigator.share)await navigator.share({title:tableName+' · Sarıyer Börekçisi',url});
      else await copy();
    }catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))setMessage('Paylaşım açılamadı. Bağlantıyı kopyalayabilirsiniz.');}
  }
  if(!mounted||!open)return null;
  return createPortal(
    <dialog ref={ref} className={'table-qr-dialog'+(presentation?' is-presenting':'')} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{
        if(e.target!==e.currentTarget)return;
        const r=e.currentTarget.getBoundingClientRect();
        if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();
      }}>
      <header className="table-qr-heading">
        <div><p>{permanent?'MASA QR KODU':'BU ZİYARETE ÖZEL'}</p><h2 id={titleId}>{tableName}</h2></div>
        <button type="button" className="table-qr-close" autoFocus onClick={onClose} aria-label="QR penceresini kapat">×</button>
      </header>
      <div className="table-qr-stage">
        {expired?<p className="notice" role="status">Bu ziyaret QR’sinin süresi doldu. Pencereyi kapatıp yeni ziyaret bağlantısı oluşturun.</p>
          :image?<img className="table-qr-image" src={image} width={1024} height={1024} alt={permanent?tableName+' kalıcı masa QR kodu':'Masa katılım QR kodu'}/>
          :<p role="status">QR hazırlanıyor…</p>}
      </div>
      <p id={descriptionId} className="table-qr-instruction">{permanent?'Telefonunuzun kamerasıyla okutun. Ürünlerinizi seçin ve siparişinizi gönderin; üyelik gerekmez.':'Telefonunuzun kamerasıyla okutun; bu ziyaretin sipariş ekranına doğrudan katılın.'}</p>
      {!permanent&&seconds!==null&&!expired&&<p className="table-qr-expiry">Geçerlilik: {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')} · Yalnızca masadaki müşteriye gösterin.</p>}
      {error&&<div role="alert"><p>{error}</p><button className="btn" onClick={()=>setAttempt(v=>v+1)}>Yeniden dene</button></div>}
      <button type="button" className="btn primary qr-present-button" disabled={!image||expired} onClick={()=>setPresentation(v=>!v)}>{presentation?'Garson ekranına dön':'Müşteriye göster · Tam ekran'}</button>
      <div className="table-qr-tools">
        <label>Masa katılım bağlantısı<input ref={linkRef} readOnly value={url} autoComplete="off" spellCheck={false} onFocus={e=>e.target.select()}/></label>
        <div className="table-qr-actions">
          <button type="button" className="btn" disabled={expired} onClick={()=>void copy()}>Bağlantıyı kopyala</button>
          <button type="button" className="btn" disabled={expired} onClick={()=>void share()}>Paylaş</button>
          {permanent&&image&&<><a className="btn" href={image} download={'Sariyer-'+tableName.replace(/[^a-zA-Z0-9ığüşöçİĞÜŞÖÇ-]/g,'-')+'-QR.png'}>QR’yi kaydet</a><button type="button" className="btn" onClick={()=>window.print()}>Masa kartını yazdır</button></>}
        </div>
        <p className="helper">{permanent?'Bu QR masada basılı kalabilir. Standart akışta ilk müşteri masanın sipariş ekranını açar; katılım onayı gerekmez. Personel yalnızca gelen siparişi kabul eder. QR’yi göstermek tek başına sipariş oluşturmaz.':'Kısa süreli ziyaret QR’si basılmaz. Bağlantıyı yalnızca fiziksel olarak bu masada bulunan müşterilerle paylaşın. Yeni bağlantı öncekinin geçerliliğini sonlandırabilir.'}</p>
      </div>
      <p className="table-qr-message" role="status">{message}</p>
      <p className="table-qr-print-brand">Meşhur Sarıyer Börekçisi Sandviç · Bahçeşehir</p>
    </dialog>,document.body,
  );
}
