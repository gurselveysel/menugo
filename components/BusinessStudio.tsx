'use client';
import {llmMessages} from '@/lib/llm/messages';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Card,Empty} from './Shell';
import {api} from './transport';
import {reconcileInvoice} from '@/src/studio/operations';
import {InvoicePurchasePosting,StudioCostLedger} from './StudioCostLedger';
import type {StudioKind} from '@/src/studio/contracts';
const TITLES:Record<StudioKind,string>={'photo-enhance':'Ürün fotoğrafı','product-copy':'Ürün açıklaması',translation:'Ürün çevirisi',campaign:'Kampanya metni',invoice:'Fatura okuma'};
const STATES:Record<string,string>={queued:'Sırada',running:'İşleniyor',review:'İnceleme bekliyor',approved:'İncelenmiş taslak',unknown:'Sonuç belirsiz',failed:'Tamamlanamadı',discarded:'Kaldırıldı'};
const ERRORS:Record<string,string>={AI_ACCESS_REQUIRED:'AI hizmeti henüz hazır değil. Altyapı MenüGO şirketi tarafından yönetilir.',AI_CREDIT_REQUIRED:'Ücretsiz hizmet kotası uygun değil. Ücretli kullanıma geçilmez.',AI_RESULT_UNKNOWN:'Yanıt kesinleşmedi. Aynı işi kontrol etmek yeni AI çağrısı yapmaz.',STUDIO_BUSY:'Başka bir stüdyo işi devam ediyor.',STUDIO_DAILY_LIMIT:'Günlük 10 işlem sınırına ulaşıldı.',STUDIO_IMAGE_LIMIT:'Günlük 3 görsel sınırına ulaşıldı.',STUDIO_RESULT_EXPIRED:'Yedi günlük saklama süresi doldu.',STUDIO_REVIEW_REQUIRED:'Kaynakla karşılaştırın ve güncel taslağı tekrar inceleyin.'};
const errorText=(e:unknown)=>ERRORS[e instanceof Error?e.message:'']||'İşlem tamamlanamadı. Kaynak verileriniz ve menünüz değiştirilmedi.';
type PendingCreate={operationId:string;payload:Record<string,unknown>};
export function BusinessStudio({demo=false}:{demo?:boolean}){
 const [data,setData]=useState<any>(null),[kind,setKind]=useState<StudioKind>('product-copy'),[product,setProduct]=useState(''),[file,setFile]=useState<File|null>(null),[selected,setSelected]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[compared,setCompared]=useState(false),[tab,setTab]=useState<'ai'|'cost'>('ai'),[pendingCreate,setPendingCreate]=useState<PendingCreate|null>(null);
 const listRequest=useRef(0),jobRequest=useRef(0);
 async function reload(){if(demo)return;const request=++listRequest.current;try{const next=await api('/api/studio/list');if(request!==listRequest.current)return;setData(next);setProduct(p=>p||next.catalogue[0]?.id||'');}catch(e){if(request===listRequest.current)setError(errorText(e));}}
 async function load(id:string){const request=++jobRequest.current;try{const next=await api('/api/studio/get?id='+encodeURIComponent(id));if(request!==jobRequest.current)return;setSelected(next);setCompared(false);}catch(e){if(request===jobRequest.current)setError(errorText(e));}}
 useEffect(()=>{void reload();},[demo]);
 useEffect(()=>()=>{listRequest.current++;jobRequest.current++;},[]);
 useEffect(()=>{if(!selected||!['queued','running'].includes(selected.state))return;const id=selected.id;const t=setInterval(()=>{if(document.visibilityState==='visible')void load(id);},2500);return()=>clearInterval(t);},[selected?.id,selected?.state]);
 async function finishCreate(pending:PendingCreate){const result=await api('/api/studio/create',pending.payload);setPendingCreate(current=>current?.operationId===pending.operationId?null:current);await load(result.id);await reload();}
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(pendingCreate)return;setBusy(true);setError('');try{
  const form=new FormData(e.currentTarget),operationId=crypto.randomUUID();const payload:Record<string,unknown>={operationId,kind,productId:product,language:form.get('language')||'tr',style:form.get('style')||'white'};
  if(kind==='invoice'||kind==='photo-enhance'){
   if(!file||file.size>2097152){setError('En fazla 2 MB boyutunda bir fotoğraf veya fatura PDF’si seçin.');return;}
   payload.data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.onerror=reject;reader.readAsDataURL(file);});
  }
  const pending={operationId,payload};setPendingCreate(pending);await finishCreate(pending);
 }catch(e){setError(errorText(e));}finally{setBusy(false);}}
 async function retryPending(){if(!pendingCreate)return;setBusy(true);setError('');try{await finishCreate(pendingCreate);}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 async function command(action:string){if(!selected)return;setBusy(true);setError('');try{await api('/api/studio/'+action,{id:selected.id,revision:selected.revision,comparedOriginal:compared});if(action==='discard'){jobRequest.current++;setSelected(null);}else await load(selected.id);await reload();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 const needsFile=kind==='invoice'||kind==='photo-enhance';
 return <section className="business-studio"><div className="studio-heading"><div><p className="eyebrow">İŞLETME ARAÇLARI</p><h2>Ürününüzden yeni içerikler.</h2><p>Gerçek fotoğraf, doğrulanmış ürün bilgisi ve kontrollü taslaklar.</p></div><span className="tag">Kaynak → Taslak → İnceleme</span></div>
 <div className="segmented"><button onClick={()=>setTab('ai')} className={tab==='ai'?'active':''}>İçerik & Görsel</button><button onClick={()=>setTab('cost')} className={tab==='cost'?'active':''}>Reçete maliyeti</button></div>
 {tab==='cost'?<StudioCostLedger demo={demo}/>:demo?<Card><Empty title="Gerçek işletme oturumu gerekli" description="AI çalıştırma, özel belgeler ve ürün kaynakları demo hesabında bulunmaz."/></Card>:<>
 {error&&<div className="notice" role="alert">{error}</div>}
 {pendingCreate&&<div className="notice" role="status"><strong>Önceki taslak isteğinin sonucu kesinleşmedi.</strong><p>Aynı işlem kimliğiyle yeniden kontrol edilir; sunucuda iş oluştuysa ikinci bir stüdyo işi oluşturulmaz. Dosya yalnız bu açık sayfanın belleğinde tutulur.</p><button type="button" className="btn" disabled={busy} onClick={()=>void retryPending()}>Bekleyen işlemi güvenle kontrol et</button></div>}
 {data&&!data.aiReady&&<div className="notice">{llmMessages[data.aiReason]||ERRORS[data.aiReason]||'AI hizmetiniz MenüGO tarafından hazırlanıyor; mevcut menü ve siparişler etkilenmez.'}</div>}
 <div className="studio-grid"><Card><h3>Yeni taslak</h3><form onSubmit={submit}>
 <label>Ne hazırlayalım?<select disabled={!!pendingCreate} value={kind} onChange={e=>{setKind(e.target.value as StudioKind);setFile(null);}}>{Object.entries(TITLES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 {kind!=='invoice'&&<label>Kaynak ürün<select disabled={!!pendingCreate} required value={product} onChange={e=>setProduct(e.target.value)}>{(data?.catalogue||[]).map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
 {kind==='photo-enhance'&&data?.imageReady===false&&<p className="notice">Görsel hizmetini MenüGO şirketi yönetir. Uygun ücretsiz bağlantı henüz hazır değil; ürünlerinize veya fiyatlarınıza dokunulmaz.</p>}
 {kind==='photo-enhance'?<label>Sunum stili<select name="style" disabled={!!pendingCreate}><option value="white">Beyaz katalog zemini</option><option value="cafe">Sıcak kafe ışığı</option><option value="dark-gold">Siyah–altın ambiyans</option></select></label>:<label>Dil<select name="language" disabled={!!pendingCreate} defaultValue={kind==='translation'?'en':'tr'}><option value="tr">Türkçe</option><option value="en">İngilizce</option></select></label>}
 {needsFile&&<label key={kind}>{kind==='invoice'?'Fatura fotoğrafı':'Gerçek ürün fotoğrafı'}<input disabled={!!pendingCreate} type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>setFile(e.target.files?.[0]||null)}/><small>En fazla 2 MB. PDF sayfalarını önce görüntüye dönüştürün; doğrudan PDF desteği henüz bağlı değil. Dosya özel tutulur ve 7 gün sonra kaldırılır.</small></label>}
 <p className="helper">{kind==='photo-enhance'?'Malzeme ve porsiyon gerçekliği için sonucu orijinal fotoğrafla karşılaştırın. Logo ve fiyat görsele AI ile yazılmaz.':kind==='invoice'?'Okunan tutarlar taslaktır. Bu işlem satın alma, muhasebe veya stok kaydı oluşturmaz.':'Kaynak ürünün içeriği dışında malzeme, alerjen veya indirim eklenmez. Sonucu yayımlamadan önce inceleyin.'}</p>
 <button className="btn primary full" disabled={busy||!!pendingCreate||!data?.aiReady||(kind==='photo-enhance'&&data?.imageReady===false)||needsFile&&!file||kind!=='invoice'&&!product}>{busy?'İşlem kaydediliyor…':'Taslak üret'}</button><p className="helper">Üretim yalnız izinli ücretsiz sağlayıcı rotalarını kullanır. Günde en fazla 10 işlem. Harici ücretli API’ye otomatik geçilmez.</p>
 </form></Card><Card><h3>Son çalışmalar</h3>{data?.jobs?.length?<div className="studio-job-list">{data.jobs.map((j:any)=><button key={j.id} className={selected?.id===j.id?'studio-job selected':'studio-job'} onClick={()=>void load(j.id)}><span><strong>{TITLES[j.kind as StudioKind]}</strong><small>{j.sourceName||'Özel belge'}</small></span><span>{STATES[j.state]||j.state}</span></button>)}</div>:<Empty title="Henüz çalışma yok" description="Taslaklar burada saklanır. Ürünleriniz ve fiyatlarınız kendiliğinden değişmez."/>}<button className="btn" onClick={()=>void reload()}>Listeyi yenile</button></Card></div>
 {selected&&<Card><div className="section-heading"><h3>{TITLES[selected.kind as StudioKind]}</h3><span className="tag">{STATES[selected.state]}</span></div>
 {selected.state==='unknown'&&<p className="notice">Sonuç belirsiz. Tekrar ücretli model çağrısı yapılmadı. Bu işi kontrol etmek yalnız kayıtlı durumu okur.</p>}
 {selected.error_code&&<p role="alert">{ERRORS[selected.error_code]||'Sağlayıcı işlemi tamamlayamadı.'}</p>}
 {selected.source_snapshot?.length>0&&<details><summary>Kullanılan ürün kaynağı</summary>{selected.source_snapshot.map((p:any)=><div key={p.id}><strong>{p.name}</strong><p>{p.description}</p><p>{p.ingredients||'Doğrulanmış ek içerik bilgisi yok'}</p><small>{p.serving} · {(p.options||[]).join(' / ')}</small></div>)}</details>}
 {selected.hasSource&&selected.kind==='invoice'&&<a className="btn" href={'/api/studio/source?id='+selected.id} target="_blank" rel="noopener noreferrer">Kaynak belgeyi aç</a>}
 {selected.result&&<DraftResult job={selected}/>} 
 {selected.kind==='invoice'&&selected.state==='approved'&&<InvoicePurchasePosting job={selected}/>} 
 <p className="helper">İncelenmiş taslağı kaydetmek, ürüne uygulamaz veya sosyal medyada paylaşmaz. Ürüne uygulama ve yayın bağlantıları ayrı kabul aşamasındadır.</p>
 {selected.state==='review'&&<><label className="studio-checkbox"><input type="checkbox" checked={compared} onChange={e=>setCompared(e.target.checked)}/>Kaynakla karşılaştırdım; içeriği incelenmiş taslak olarak sakla.</label><button className="btn primary" disabled={busy||!compared} onClick={()=>void command('approve')}>İncelenmiş taslağı kaydet</button></>}
 {selected.state==='queued'&&<button className="btn" disabled={busy||!data?.aiReady||(selected.kind==='photo-enhance'&&data?.imageReady===false)} onClick={()=>void command('process')}>Sıradaki işi çalıştır</button>}
 <button className="btn" disabled={busy} onClick={()=>void load(selected.id)}>Durumu kontrol et</button><button className="btn" disabled={busy} onClick={()=>void command('discard')}>Taslağı ve dosyayı kaldır</button>
 </Card>}
 </>}
 </section>;
}
function DraftResult({job}:{job:any}){
 const r=job.result;
 if(r.kind==='photo-enhance')return <div className="studio-compare"><figure><img src={'/api/studio/source?id='+job.id} alt="Orijinal ürün fotoğrafı"/><figcaption>Orijinal</figcaption></figure><figure><img src={r.imageUrl} alt="İncelenmesi gereken görsel taslağı"/><figcaption>Görsel taslağı · porsiyon ve malzemeyi kontrol edin</figcaption><a href={r.imageUrl} download="urun-taslak.webp" className="btn">Görseli kaydet</a></figure></div>;
 if(r.kind==='invoice'){
  let check;try{check=reconcileInvoice(r.lines,r.totalMinor);}catch{check={consistent:false,issues:['Tutarlar henüz doğrulanamadı.']};}
  return <><p className="notice">{check.consistent?'Satır tutarları belge toplamıyla tutarlı. İnsan incelemesi yine gereklidir.':'Belgede eksik veya uyuşmayan tutarlar var; muhasebeye aktarılmadı.'}</p><div className="studio-table"><table><thead><tr><th>Kalem / Kaynak</th><th>Miktar</th><th>Net kuruş</th><th>Vergi kuruş</th><th>Toplam kuruş</th></tr></thead><tbody>{r.lines.map((x:any,i:number)=><tr key={i}><td>{x.name}<small>Sayfa {x.page}: {x.sourceText}</small></td><td>{x.quantityText} {x.unitText}</td><td>{x.netMinor??'—'}</td><td>{x.taxMinor??'—'}</td><td>{x.grossMinor??'—'}</td></tr>)}</tbody></table></div><p>{r.warnings.join(' · ')}</p></>;
 }
 return <div className="studio-copy"><h4>{r.title}</h4><p>{r.body}</p>{r.options?.length>0&&<p>{r.options.join(' · ')}</p>}<p className="helper">{r.warnings?.join(' · ')}</p><button className="btn" onClick={()=>void navigator.clipboard.writeText(r.title+'\n\n'+r.body).catch(()=>{})}>Metni kopyala</button></div>;
}
