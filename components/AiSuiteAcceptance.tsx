import Link from 'next/link';
import MenuGoLogo from './MenuGoLogo';

type ModuleEvidence={
 id:string;label:string;automaticEvidenceReady:boolean;externalAcceptanceRequired:boolean;reason?:string;
 [key:string]:unknown;
};
type Snapshot={
 generatedAt:string;role:string;
 policy:{companyOnly:boolean;freeOnly:boolean;paidFallback:boolean;autoCompletion:boolean};
 providerEvidence:{enabledRoutes:string;successfulAttempts:string;configured:boolean;realSuccessSeen:boolean};
 modules:ModuleEvidence[];
 completion:{complete:boolean;reason:string};
};
const hidden=new Set(['id','label','automaticEvidenceReady','externalAcceptanceRequired','reason']);
const labels:Record<string,string>={providerRuns:'Gerçek sağlayıcı çalışması',reviewedApplications:'İncelenip uygulanan aktarım',providerJobs:'Gerçek sağlayıcı işi',publications:'Yayımlanan fotoğraf',applies:'Uygulanan metin',externalDispatches:'Dış sosyal yayın kanıtı',confirmedCommands:'Onaylı komut',postedPurchases:'Onaylı satın alma kaydı',recipeVersions:'Reçete sürümü',serviceDays:'Gerçek servis günü',completedOrders:'Tamamlanmış sipariş',wasteEvents:'Gerçek fire kaydı',demandReady:'Talep verisi yeterli',wasteReady:'Fire verisi yeterli',branches:'Gerçek şube',masterItems:'Ana menü ürünü',bindings:'Şube bağlaması',localPriceOverrides:'Yerel fiyat farkı'};
function value(v:unknown){if(typeof v==='boolean')return v?'Evet':'Hayır';return String(v??'—');}
export function AiSuiteAcceptance({data}:{data:Snapshot}){
 const autoReady=data.modules.filter(m=>m.automaticEvidenceReady).length;
 return <main className="pc-root">
  <header className="pc-header"><Link href="/platform"><MenuGoLogo alt="MenüGO" width="280" height="74"/></Link><div><span className="pc-badge">ŞİRKET · KABUL KONTROLÜ</span><p>Yetki: {data.role}</p></div></header>
  <div className="pc-layout"><nav className="pc-nav" aria-label="Şirket kabul menüsü"><Link href="/platform">Şirket merkezi</Link><Link href="/platform/yapay-zeka">AI sağlayıcıları</Link></nav>
  <section className="pc-content"><h1>AI tam kapsam kabul durumu</h1>
   <p className="pc-lead">Bu ekran yalnız üretim kayıtlarından türetilen kanıtı gösterir. Derleme, mock yanıt, ekranın açılması veya yerel test gerçek AI kabulü sayılmaz; burada hiçbir modül elle “tamamlandı” olarak işaretlenemez.</p>
   <div className="pc-grid">
    <div className="pc-metric"><span>Otomatik kanıtı hazır dilim</span><strong>{autoReady}/{data.modules.length}</strong></div>
    <div className="pc-metric"><span>Etkin ücretsiz rota</span><strong>{data.providerEvidence.enabledRoutes}</strong></div>
    <div className="pc-metric"><span>Başarılı gerçek ücretsiz çağrı</span><strong>{data.providerEvidence.successfulAttempts}</strong></div>
   </div>
   <section className="pc-banner"><h2>Tam kapsam tamamlandı mı?</h2><p><strong>Hayır.</strong> {data.completion.reason}</p><p className="pc-small">Politika: şirket yönetimi · yalnız ücretsiz sağlayıcılar · ücretli fallback kapalı · otomatik tamamlama kapalı.</p></section>
   {data.modules.map(m=><article className="pc-card" key={m.id}><div className="pc-row"><div><h2>{m.label}</h2><small>{m.automaticEvidenceReady?'Üretim kayıtlarında otomatik kanıt mevcut':'Kabul kanıtı henüz yeterli değil'}</small></div><span className="pc-badge">{m.automaticEvidenceReady?'KANIT VAR':'BEKLİYOR'}</span></div>
    {m.reason&&<p>{m.reason}</p>}
    <div className="pc-columns">{Object.entries(m).filter(([k])=>!hidden.has(k)).map(([k,v])=><div className="pc-row" key={k}><span>{labels[k]??k}</span><strong>{value(v)}</strong></div>)}</div>
    {m.externalAcceptanceRequired&&<p className="pc-small">Son kabul ayrıca gerçek alan adı/cihaz/işletme senaryosuyla doğrulanmalıdır.</p>}
   </article>)}
   <p className="pc-small">Son üretim kanıtı okuması: {new Date(data.generatedAt).toLocaleString('tr-TR')}</p>
  </section></div>
 </main>;
}
