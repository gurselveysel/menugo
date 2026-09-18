'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {Card} from './Shell';
import {api,explain} from './transport';
export function Handover({go}:{go:(tab:'tables'|'staff'|'profile'|'menu'|'settings')=>void}){
 const[data,setData]=useState<any>(null),[error,setError]=useState('');
 useEffect(()=>{let alive=true;void api('/api/merchant/readiness').then(v=>{if(alive)setData(v);}).catch(e=>{if(alive)setError(explain(e));});return()=>{alive=false;};},[]);
 if(!data?.profile)return error?<Card><p>{error}</p></Card>:null;
 const steps=[{title:'Masa numaraları',done:data.tableCount>0,text:data.tableCount+' aktif masa',tab:'tables'},
 {title:'Personel görevleri',done:data.staffCount>1,text:data.staffCount+' yetkili hesap',tab:'staff'},
 {title:'Satış fiyatları',done:data.approvedProducts>0,text:data.approvedProducts+' onaylı ürün · '+data.unpricedProducts+' fiyat bekliyor',tab:'menu'},
 {title:'İşletme bilgileri',done:!!data.profile.address&&data.profile.hours.length===7,text:'Adres ve saatleri işletmenizin gerçek bilgileriyle tamamlayın.',tab:'profile'},
 {title:'Sipariş kabulü',done:data.orderingEnabled,text:data.orderingEnabled?'Masada sipariş açık':'Yeni masa siparişi kapalı',tab:'settings'}] as const;
 return <Card className="handover-card"><div className="section-heading"><div><h2>İlk servise hazırlık</h2><p>Servis düzeninizi birkaç adımda tamamlayın.</p></div><Link className="btn" href="/yardim#personel">Kullanım rehberi</Link></div><div className="handover-grid">{steps.map(s=><button key={s.title} onClick={()=>go(s.tab)}><span className={'tag '+(s.done?'green':'amber')}>{s.done?'✓':'→'}</span><strong>{s.title}</strong><small>{s.text}</small></button>)}</div><p className="helper">İlk masada sipariş → mutfak kabulü → servis → kasada gerçek ödeme kaydı akışını ekibinizle birlikte deneyin.</p></Card>;
}
