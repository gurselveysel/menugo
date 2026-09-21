'use client';
import {useEffect,useRef,useState} from 'react';
import {llmApi as api} from '@/lib/llm/browser';
import {llmMessage} from '@/lib/llm/messages';
const options={
 groq_free:{name:'Groq Free · OpenAI gpt-oss',models:['openai/gpt-oss-20b','openai/gpt-oss-120b'],note:'Metin, çeviri ve şemalı çıktı. OpenAI’nin ücretli API’si kullanılmaz. Özel raporlar için Groq Data Controls bölümünde ZDR açılmalı.',url:'https://console.groq.com/keys'},
 gemini_free:{name:'Google Gemini · Free proje',models:['gemini-2.5-flash','gemini-2.5-flash-lite'],note:'Faturalandırma bağlanmamış Google projesi gerektirir. Yalnız paylaşımı onaylanmış menü belgeleri ve ürün metinleri; faturalar, günlük raporlar ve serbest sorular bu rotaya gönderilmez.',url:'https://aistudio.google.com/api-keys'},
 openrouter_free:{name:'OpenRouter · Yalnız ücretsiz',models:['openrouter/free'],note:'Sıfır fiyat üst sınırı, ZDR ve veri toplamama şartı zorunlu. Uygun görüntü veya JSON modeli yoksa işlem bekler. Ücretli auto router kullanılmaz.',url:'https://openrouter.ai/settings/keys'},
 cloudflare_free:{name:'Cloudflare Workers Free · Görsel + metin yedeği',models:['@cf/black-forest-labs/flux-2-klein-4b'],note:'Workers Free hesabında ürün fotoğrafı için FLUX.2 Klein 4B, ek ücretsiz metin yedeği olarak Cloudflare-hosted Gemma 4 26B A4B kullanılır. MenüGO üçüncü taraf ücretli AI Gateway modellerini çağırmaz. Free kota aşılırsa istek hata verir; ücretli plana otomatik geçiş yoktur.',url:'https://dash.cloudflare.com/profile/api-tokens'}
} as const;
type Provider=keyof typeof options;
type Route={provider:Provider;model:string;priority:number;enabled:boolean;hasKey:boolean;accountId:string|null;publicContentAllowed:boolean;privateContentAllowed:boolean;attestedUntil:string;dailyLimit:number;lastSuccessAt:string|null};
type Status={version:string;canManage:boolean;paidFallback:false;routes:Route[]};
export function FreeAiSettings({onSaved,businessId,branchId}:{onSaved:()=>void;businessId:string;branchId:string}){
 const endpoint=(action:string)=>'/api/platform/ai/'+action+'?businessId='+encodeURIComponent(businessId)+'&branchId='+encodeURIComponent(branchId);
 const [s,setS]=useState<Status|null>(null),[error,setError]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),alive=useRef(true);
 async function load(){const g=++generation.current;try{const v=await api<Status>(endpoint('free-status'));if(alive.current&&g===generation.current)setS(v);}catch(e){if(alive.current&&g===generation.current)setError(llmMessage(e));}}
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;generation.current++;};},[]);
 async function save(provider:Provider,form:HTMLFormElement){if(busy||!s)return;const f=new FormData(form);setBusy(true);setError('');setNote('');
  try{await api(endpoint('free-save'),{version:s.version,provider,model:f.get('model'),apiKey:String(f.get('key')||''),priority:Number(f.get('priority')),dailyLimit:Number(f.get('limit')),accountId:String(f.get('accountId')||''),enabled:f.get('enabled')==='on',publicContentAllowed:f.get('public')==='on',privateContentAllowed:f.get('private')==='on',freePlanConfirmed:f.get('free')==='on',consent:f.get('consent')==='on'});setNote('Bağlantı kaydedildi. Aşağıdaki bağlantı testi gerçek sağlayıcı yanıtını doğrular; henüz denenmeyen rotalar ayrıca belirtilir.');await load();onSaved();}
  catch(e){setError(llmMessage(e));await load();}finally{const key=form.elements.namedItem('key') as HTMLInputElement|null;if(key)key.value='';setBusy(false);}}
 async function remove(provider:Provider){if(!s||busy||!confirm('Bu sağlayıcının kayıtlı anahtarı silinsin mi?'))return;setBusy(true);setError('');try{await api(endpoint('free-remove'),{version:s.version,provider});await load();onSaved();}catch(e){setError(llmMessage(e));await load();}finally{setBusy(false);}}
 return <div className="free-ai-settings"><h2>Ücretsiz AI bağlantıları</h2><p>Ücretli modele geçiş ve otomatik kredi alımı kapalı. Öncelik sırasındaki uygun bağlantılar denenir. Kota bittiğinde iş bekler; restoran siparişleri etkilenmez.</p>
 <p className="notice"><strong>Yalnız API kotası ücretsizdir.</strong> Anahtar, hesabınızın Free planda kaldığını kanıtlamaz. Faturalandırmayı sağlayıcı panelinden kapalı tutun. Bu beyan 30 gün sonra yenilenir; planı ücretliye değiştirirseniz önce buradaki bağlantıyı kapatın.</p>
 {error&&<p className="alert" role="alert">{error}</p>}{note&&<p className="notice" role="status">{note}</p>}
 {!s?<p>Bağlantılar yükleniyor…</p>:(Object.keys(options) as Provider[]).map((provider,i)=>{const o=options[provider],r=s.routes.find(x=>x.provider===provider);return <details key={provider+':'+s.version} className="card" open={!r&&i===0}><summary><strong>{o.name}</strong> · {r?.hasKey?(r.enabled?'Anahtar kayıtlı':'Durduruldu'):'Bağlanmadı'}</summary><p>{o.note}</p><p className="helper">{r?.lastSuccessAt?'Son gerçek yanıt: '+new Date(r.lastSuccessAt).toLocaleString('tr-TR'):'Bu rotadan doğrulanmış gerçek yanıt henüz yok.'}</p>
 {s.canManage?<form className="llm-form" onSubmit={event=>{event.preventDefault();void save(provider,event.currentTarget);}}>
 <label>Model<select name="model" defaultValue={r?.model||o.models[0]}>{o.models.map(m=><option key={m}>{m}</option>)}</select></label>
 <label>API anahtarı<input name="key" type="password" autoComplete="new-password" maxLength={512} spellCheck={false} placeholder={r?'Değişmeyecekse boş bırakın':'Sağlayıcı anahtarını güvenli alana girin'}/></label>
 {provider==='cloudflare_free'&&<label>Cloudflare Account ID<input name="accountId" pattern="[a-fA-F0-9]{32}" required defaultValue={r?.accountId||''}/></label>}
 <div className="llm-task-grid"><label>Öncelik<input name="priority" type="number" min={1} max={100} required defaultValue={r?.priority||(i+1)*10}/></label><label>24 saatlik üst sınır<input name="limit" type="number" min={1} max={provider==='cloudflare_free'?3:50} required defaultValue={r?.dailyLimit||(provider==='cloudflare_free'?3:20)}/></label></div>
 <label className="llm-check"><input name="enabled" type="checkbox" defaultChecked={r?.enabled??true}/>Bağlantıyı kullan</label>
 <label className="llm-check"><input name="public" type="checkbox" defaultChecked={r?.publicContentAllowed??false}/>Yayımlanabilir menü fotoğrafları ve ürün metinlerinin bu sağlayıcıya gönderilmesini onaylıyorum. Ücretsiz Gemini bu içerikleri hizmet geliştirmede kullanabilir.</label>
 {provider!=='gemini_free'&&<label className="llm-check"><input name="private" type="checkbox" defaultChecked={r?.privateContentAllowed??false}/>Özel belge, fotoğraf ve sorular için bu sağlayıcıya veri aktarımını onaylıyorum. Groq için ZDR, OpenRouter için ZDR/veri toplamama filtresi zorunludur; Cloudflare Workers AI müşteri içeriğini açık izin olmadan model eğitimi veya hizmet geliştirmede kullanmadığını belirtir.</label>}
 <label className="llm-check"><input name="free" type="checkbox" required/>Sağlayıcı hesabı Free planda; ücretli kullanım, kredi alımı ve otomatik yükleme kapalı.</label>
 <label className="llm-check"><input name="consent" type="checkbox" required/>Veri kullanım koşullarını kontrol ettim; anahtarı yalnızca burada şifreli olarak saklamayı onaylıyorum.</label>
 <div className="llm-actions"><button className="btn primary" disabled={busy}>{busy?'Kaydediliyor…':'Ücretsiz bağlantıyı kaydet'}</button><a className="text-button" href={o.url} target="_blank" rel="noopener noreferrer">Sağlayıcı paneli</a>{r&&<button type="button" className="text-button" disabled={busy} onClick={()=>void remove(provider)}>Anahtarı sil</button>}</div>
 </form>:<p>Ayarları yalnız MenüGO şirket yönetimi değiştirebilir.</p>}</details>;})}
 <p className="helper">NVIDIA NIM deneme, Cohere değerlendirme, Mistral Free prototip ve ücretli OpenAI/DeepSeek/Claude uçları otomatik üretim rotasına alınmaz. Kota artırmak için hesap veya anahtar çoğaltılmaz.</p></div>;
}
