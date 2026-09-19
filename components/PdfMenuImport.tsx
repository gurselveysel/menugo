'use client';
import {useEffect,useRef,useState} from 'react';
import {Card} from './Shell';
import './pdf-menu.css';
import {api} from './transport';
import {importMessage} from '@/lib/ai-menu/contracts';
import {preparePdf,type PreparedPdf} from '@/src/documents/prepare-pdf';
import {pdfMessage} from '@/src/documents/pdf-policy';
type Receipt={id:string;duplicate:boolean};
type Status={operationId:string;receipt?:Receipt;unknown?:boolean};
export function PdfMenuImport({aiReady,remaining,onUploaded}:{aiReady:boolean;remaining:number;onUploaded:(id:string)=>void}){
 const [doc,setDoc]=useState<PreparedPdf|null>(null),[selected,setSelected]=useState<number[]>([]),[preparing,setPreparing]=useState(false),[sending,setSending]=useState(false),[progress,setProgress]=useState(''),[error,setError]=useState(''),[reviewed,setReviewed]=useState(false),[statuses,setStatuses]=useState<Record<number,Status>>({});
 const active=useRef<AbortController|null>(null),serial=useRef(0),busy=useRef(false),alive=useRef(true),stateRef=useRef<Record<number,Status>>({});
 const urls=useRef<string[]>([]);const [previews,setPreviews]=useState<string[]>([]);
 const clean=()=>{for(const u of urls.current)URL.revokeObjectURL(u);urls.current=[];};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;serial.current++;active.current?.abort();clean();};},[]);
 useEffect(()=>{if(!sending&&!Object.values(statuses).some(s=>s.unknown))return;const warn=(e:BeforeUnloadEvent)=>e.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[sending,statuses]);
 function put(page:number,value:Status){stateRef.current={...stateRef.current,[page]:value};if(alive.current)setStatuses(stateRef.current);}
 async function choose(file:File|null){
  if(!file||busy.current)return;
  if(Object.values(stateRef.current).some(s=>s.unknown)&&!window.confirm('Yanıtı belirsiz sayfa var. Aktarım geçmişini kontrol etmeden yeniden yükleme yapmayın. Başka belgeye geçilsin mi?'))return;
  active.current?.abort();const controller=new AbortController();active.current=controller;const run=++serial.current;
  clean();setPreviews([]);setDoc(null);setSelected([]);setReviewed(false);stateRef.current={};setStatuses({});setError('');setPreparing(true);setProgress('PDF cihazınızda hazırlanıyor…');
  try{const result=await preparePdf(file,controller.signal,(done,total)=>{if(run===serial.current)setProgress(`${done} / ${total} sayfa hazır`);});
   if(run!==serial.current||!alive.current)return;
   const created=result.pages.map(p=>URL.createObjectURL(p.file));urls.current=created;setPreviews(created);setDoc(result);setProgress(`${result.pages.length} sayfa hazır. Henüz hiçbir dosya gönderilmedi.`);
  }catch(e){if(run===serial.current&&alive.current){setError(pdfMessage(e));setProgress('');}}
  finally{if(run===serial.current&&alive.current)setPreparing(false);}
 }
 async function upload(){
  if(!doc||!aiReady||!reviewed||busy.current||!selected.length)return;
  const pending=selected.filter(n=>!stateRef.current[n]?.receipt);
  const unknown=pending.filter(n=>stateRef.current[n]?.unknown);
  if(pending.length>remaining&&!unknown.length){setError('Seçilen sayfa sayısı kalan günlük analiz hakkını aşıyor. Daha az sayfa seçin.');return;}
  busy.current=true;setSending(true);setError('');let lastId:string|undefined;
  try{for(const pageNo of pending){
   if(!alive.current)break;
   const item=doc.pages.find(p=>p.page===pageNo)!;
   const state=stateRef.current[pageNo]||{operationId:crypto.randomUUID()};put(pageNo,state);
   setProgress(`Sayfa ${pageNo} taslak olarak kaydediliyor…`);
   const data=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]!);r.onerror=()=>reject(Error('FILE_READ_FAILED'));r.readAsDataURL(item.file);});
   if(!alive.current)break;
   try{
    const value=await api<Receipt>('/api/ai-menu/upload',{operationId:state.operationId,fileName:item.file.name,data});
    if(!value||!value.id||typeof value.duplicate!=='boolean')throw Error('AI_RESULT_UNKNOWN');
    put(pageNo,{operationId:state.operationId,receipt:value});lastId=value.id;
   }catch(e){put(pageNo,{operationId:state.operationId,unknown:true});throw e;}
  }
  if(alive.current)setProgress('Seçilen sayfalar taslak olarak kaydedildi. Her taslağı ayrı ayrı inceleyin; menünüz değiştirilmedi.');
 }catch(e){if(alive.current){setError(importMessage(e)+' Kalan sayfalar gönderilmedi. Yeniden denemede aynı sayfa işlem kimliği korunur; aktarım geçmişini de kontrol edin.');setProgress('Aktarım durdu; daha önce kaydedilen sayfalar korunuyor.');}}
 finally{busy.current=false;if(alive.current){setSending(false);if(lastId)onUploaded(lastId);}}
 }
 const pending=selected.filter(n=>!statuses[n]?.receipt);const unknown=Object.values(statuses).some(s=>s.unknown);
 return <Card className="pdf-menu-preparation"><div className="section-heading"><div><p className="eyebrow">PDF’DEN MENÜYE</p><h2>PDF sayfalarını hazırla</h2></div><span className="tag">Cihazınızda · ücretsiz</span></div>
 <p>En fazla 10 MB ve 8 sayfa. Önce sayfa görüntülerini oluşturun, sonra okunurluğunu kontrol edip analiz edilecek sayfaları seçin. PDF’nin kendisi bu hazırlıkta sunucuya gönderilmez.</p>
 <label className="btn pdf-file-button">PDF seç<input aria-label="PDF menü belgesi seç" type="file" accept="application/pdf,.pdf" disabled={sending} onChange={e=>{void choose(e.target.files?.[0]||null);e.currentTarget.value='';}}/></label>
 {preparing&&<button className="btn" onClick={()=>active.current?.abort()}>Hazırlığı iptal et</button>}
 {progress&&<p role="status">{progress}</p>}{error&&<p role="alert" className="alert">{error}</p>}
 {doc&&<><h3 className="pdf-file-name">{doc.name}</h3><p className="helper">Her sayfa ayrı aktarım taslağıdır ve bir analiz hakkı kullanabilir. Dosya adındaki “sayfa N” özgün PDF sayfasını korur. Seçmediğiniz sayfalar gönderilmez. PDF içinde form alanları, katmanlar veya karmaşık yazılar varsa önizlemeyi kaynakla karşılaştırın.</p>
 <div className="pdf-page-grid">{doc.pages.map((page,index)=><figure key={page.page}>
 <label><input type="checkbox" aria-label={`Sayfa ${page.page} seç`} checked={selected.includes(page.page)} disabled={sending||!!statuses[page.page]?.receipt||!!statuses[page.page]?.unknown} onChange={e=>{setSelected(v=>e.target.checked?[...v,page.page].sort((a,b)=>a-b):v.filter(n=>n!==page.page));setReviewed(false);}}/>Sayfa {page.page}</label>
 <a href={previews[index]} target="_blank" rel="noopener noreferrer" aria-label={`Sayfa ${page.page} önizlemesini büyüt`}><img src={previews[index]} alt={`PDF sayfa ${page.page} önizlemesi`} width={page.width} height={page.height}/></a>
 <figcaption><a className="text-button" href={previews[index]} download={page.file.name}>Sayfa görüntüsünü kaydet</a>{statuses[page.page]?.receipt?<span>Kaydedildi <button type="button" className="text-button" disabled={sending} onClick={()=>onUploaded(statuses[page.page]!.receipt!.id)}>Taslağı aç</button></span>:statuses[page.page]?.unknown?<span>Yanıt belirsiz · aynı işlemle kontrol edin</span>:<span>Henüz gönderilmedi</span>}</figcaption></figure>)}</div>
 <label className="pdf-review-check"><input type="checkbox" checked={reviewed} disabled={sending} onChange={e=>setReviewed(e.target.checked)}/>Seçtiğim sayfaların okunurluğunu kontrol ettim. Bu görüntülerin MenüGO’nun yönettiği uygun ücretsiz AI hizmetine taslak analizi için gönderilmesini istiyorum.</label>
 <button className="btn primary" disabled={sending||!aiReady||!reviewed||pending.length===0||(!unknown&&pending.length>remaining)} onClick={()=>void upload()}>{sending?'Kaydediliyor…':unknown?'Aynı sayfa işlemini yeniden dene':`${pending.length} sayfayı taslak analize gönder`}</button>
 <p className="helper">Kalan günlük analiz hakkı: {remaining}. Fiyatlar, ürünler ve menü bu işlemle yayımlanmaz.</p>
 {!aiReady&&<p className="notice">AI analizi henüz etkin değil. Sayfaları ücretsiz hazırlayıp kaydedebilirsiniz; model bağlantısını yalnız MenüGO şirket yönetimi açabilir.</p>}
 </>}
 </Card>;
}
