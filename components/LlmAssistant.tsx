'use client';
import {useEffect,useRef,useState} from 'react';
import {Card} from './Shell';
import {FreeAiSettings} from './FreeAiSettings';
import {llmApi as api} from '@/lib/llm/browser';
import {llmMessage,type LlmStatus} from '@/lib/llm/messages';
type Status=LlmStatus&{products:{id:string;name:string}[]};
type Pending={operationId:string;task:string;question:string;productId:string|null;day:string};
type Answer={answer:string;warnings:string[];sources:{id:string;title:string;data:Record<string,unknown>}[];capturedAt:string;draftOnly:true};
const tasks=[['menu','Menüyü değerlendir','Açıklaması ve porsiyonu eksik ürünleri, kategori tutarlılığını değerlendir.'],['description','Ürün açıklaması','Bu ürün için yalnızca kayıtlı içerikten kısa, iştah açıcı bir açıklama taslağı yaz.'],['translation','İngilizce çeviri','Ürün adını, mevcut açıklamayı, porsiyonu ve seçenekleri İngilizceye çevir.'],['campaign','Paylaşım metni','Bu ürün için Instagram gönderi açıklaması yaz. İndirim veya içerik uydurma.'],['daily','Günü özetle','Seçilen günün sipariş ve kasa raporunu özetle; tahsilat ile sipariş tutarını ayır.']];
export function LlmAssistant(){
 const[status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
 const[task,setTask]=useState('menu'),[question,setQuestion]=useState(tasks[0][2]),[product,setProduct]=useState(''),[day,setDay]=useState(''),[answer,setAnswer]=useState<Answer|null>(null),[answerModel,setAnswerModel]=useState(''),[pending,setPending]=useState<Pending|null>(null);
 const mounted=useRef(true),testOp=useRef<string|null>(null);
 const loadEpoch=useRef(0);
 async function load(){const epoch=++loadEpoch.current;try{const s=await api<Status>('/api/llm/status');if(mounted.current&&epoch===loadEpoch.current)setStatus(s);}catch(e){if(mounted.current&&epoch===loadEpoch.current)setError(llmMessage(e));}}
 useEffect(()=>{mounted.current=true;setDay(new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Istanbul'}));void load();return()=>{mounted.current=false;};},[]);
 async function probe(){if(busy)return;setBusy(true);setError('');setNote('');testOp.current??=crypto.randomUUID();try{const r=await api<any>('/api/llm/test',{operationId:testOp.current});if(r.result?.verified){setNote('Gerçek model yanıtı alındı. LLM bağlantısı doğrulandı.');testOp.current=null;}await load();}catch(e){setError(llmMessage(e));if(!(e instanceof Error)||!['LLM_RESULT_UNKNOWN','LLM_SAVE_UNKNOWN','LLM_IN_PROGRESS'].includes(e.message))testOp.current=null;}finally{setBusy(false);}}
 async function send(existing?:Pending){if(busy)return;const p=existing||{operationId:crypto.randomUUID(),task,question,productId:product||null,day};setPending(p);setBusy(true);setError('');setNote('');setAnswer(null);try{const r=await api<any>('/api/llm/ask',p);if(mounted.current){setAnswer(r.result);setAnswerModel(r.model);setPending(null);await load();}}catch(e){if(mounted.current){setError(llmMessage(e));if(e instanceof Error&&!['LLM_RESULT_UNKNOWN','LLM_SAVE_UNKNOWN','LLM_IN_PROGRESS','LLM_CONNECTION_UNAVAILABLE'].includes(e.message))setPending(null);}}finally{if(mounted.current)setBusy(false);}}
 const ready=!!status&&status.provider==='free_router'&&!!status.enabled&&!!status.verified;
 return <section className="llm-studio" aria-label="LLM Asistanı">
 <Card className="llm-hero"><div><p className="eyebrow">MENÜGO · İŞLETME ASİSTANI</p><h2>Menünüzü bilen<br/>bir çalışma arkadaşı.</h2><p>Menüyü değerlendirin, ürün metni hazırlayın, çevirin ve günlük raporu yorumlayın. Son karar ve yayın kontrolü sizde.</p></div><div className="llm-status"><span className={'tag '+(ready?'':'muted')}>{ready?'Bağlantı doğrulandı':status?.configured?'Bağlantı testi gerekli':'LLM bağlantısı bekleniyor'}</span><strong>{status?.provider==='free_router'?'Ücretsiz görev yönlendiricisi':'Ücretsiz API bağlantısı'}</strong><small>Menüye, siparişe ve ödemeye otomatik yazma yok.</small></div></Card>
 {error&&<p className="alert" role="alert">{error}</p>}{note&&<p className="notice" role="status">{note}</p>}
 <div className="llm-grid"><Card>
 <FreeAiSettings onSaved={()=>void load()}/>
 <div className="llm-actions"><button className="btn" disabled={busy||!status?.configured||!status.enabled} onClick={()=>void probe()}>Bağlantıyı test et</button><button className="text-button" disabled={busy} onClick={()=>void load()}>Durumu yenile</button></div>
 <p className="helper">Test yalnız küçük bir gerçek istek yapar. En az bir rotanın yanıtı doğrulanır; bu diğer tüm modellerin test edildiği anlamına gelmez. Ücretli servis çağrısı yapılmaz.</p>
 </Card><Card>
 <h2>Nasıl yardımcı olayım?</h2><div className="llm-task-grid">{tasks.map(t=><button key={t[0]} className={'llm-task '+(task===t[0]?'active':'')} disabled={busy||!!pending} onClick={()=>{setTask(t[0]);setQuestion(t[2]);setAnswer(null);}}>{t[1]}</button>)}</div>
 <div className="llm-form">{['description','translation','campaign'].includes(task)&&<label>İlgili ürün<select value={product} disabled={busy||!!pending} onChange={e=>setProduct(e.target.value)}><option value="">Ürün seçin</option>{status?.products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
 {task==='daily'&&<label>Rapor günü<input type="date" value={day} disabled={busy||!!pending} onChange={e=>setDay(e.target.value)}/></label>}
 <label>İsteğiniz<textarea maxLength={1500} rows={5} value={question} disabled={busy||!!pending} onChange={e=>setQuestion(e.target.value)} placeholder="Menünüz veya günlük raporunuz hakkında sorun…"/></label>
 <p className="helper">Müşteri telefonu, adresi veya kişisel veri yazmayın. Model yalnız kayıtlı menü ve seçili günlük raporla çalışır; CRM kişileri gönderilmez.</p>
 {!pending?<button className="btn primary" disabled={busy||!ready||!question.trim()||(['description','translation','campaign'].includes(task)&&!product)} onClick={()=>void send()}>Taslak yanıt oluştur</button>:<div className="llm-actions"><button className="btn" disabled={busy} onClick={()=>void send(pending)}>{busy?'Model yanıtı bekleniyor…':'Aynı işlemin sonucunu kontrol et'}</button><button className="text-button" disabled={busy} onClick={()=>{if(window.confirm('Önceki çağrı sonuçlanmış olabilir. Yeni deneme ayrı kullanım oluşturabilir. Yeni istek hazırlansın mı?'))setPending(null);}}>Yeni istek hazırla</button></div>}
 </div>
 {answer&&<article className="llm-answer" aria-label="LLM yanıtı"><div className="section-heading"><strong>AI taslağı · {answerModel}</strong><button className="text-button" onClick={()=>void navigator.clipboard.writeText(answer.answer).then(()=>setNote('Taslak metin kopyalandı. Menüye uygulanmadı.')).catch(()=>setError('Metni seçerek kopyalayın.'))}>Metni kopyala</button></div><p className="llm-answer-text">{answer.answer}</p>{answer.warnings.map((w,i)=><p className="notice" key={i}>{w}</p>)}<p className="helper">AI yanılabilir. Bu yanıt hiçbir ürün, fiyat, sipariş veya kampanyayı değiştirmedi.</p><details><summary>Kullanılan kayıtlar ({answer.sources.length})</summary>{answer.sources.map(s=><div className="llm-source" key={s.id}><strong>{s.title}</strong><pre>{JSON.stringify(s.data,null,2)}</pre></div>)}</details></article>}
 {!answer&&!busy&&<div className="llm-empty"><span aria-hidden>✦</span><h3>Önce kaynak, sonra yorum.</h3><p>Yanıtın altında hangi ürünlerin veya raporun kullanıldığını görebilirsiniz. Fiyat hesabı, ödeme ve sadakat kuralları LLM’ye bırakılmaz.</p></div>}
 </Card></div></section>;
}
