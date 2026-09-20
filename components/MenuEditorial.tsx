import {PublishedProductPhoto} from './PublishedProductPhoto';
import {publicPhotoPath} from '@/src/studio/photo-publication';
import MenuGoLogo from './MenuGoLogo';
import {CATEGORY_ART,EDITORIAL_MEDIA,editorialPicks,type EditorialProduct} from '@/lib/merchant-visuals';
import {money} from '@/lib/public-format';
export function EditorialHero(){return <div className="editorial-hero" data-surface="dark">
 <p className="editorial-kicker">BAHÇEŞEHİR'DE BİR MOLA</p><h2>Lezzetin<br/><em>en güzel hâli.</em></h2>
 <p>Sandviçten waffle'a, kahvaltıdan kahveye.</p>
 <a className="editorial-hero-link" href="#menu-content">Menüyü keşfet <span aria-hidden="true">↘</span></a>
 <img className="editorial-hero-food" src={EDITORIAL_MEDIA+'food-banner.webp'} srcSet={EDITORIAL_MEDIA+'food-banner-480.webp 480w, '+EDITORIAL_MEDIA+'food-banner-800.webp 800w, '+EDITORIAL_MEDIA+'food-banner.webp 1154w'} sizes="(min-width: 901px) 40vw, 100vw" width={1154} height={244} alt="" loading="lazy" decoding="async"/>
 </div>;}
export function EditorialProducts<T extends EditorialProduct & {photoUrl?:string}>({items,onSelect,english,name}: {items:readonly T[];onSelect:(item:T)=>void;english:boolean;name:(item:T)=>string}) {
 const chosen=editorialPicks(items);if(!chosen.length)return null;
 return <section className="editorial-picks" aria-labelledby="editorial-picks-title">
  <div className="editorial-section-heading"><div><p className="editorial-kicker">{english?'EXPLORE THE MENU':'MENÜDEN BİR SEÇKİ'}</p><h2 id="editorial-picks-title">{english?'A taste of the menu':'Bir sonraki lezzet molanız'}</h2></div><span>{english?'Selected for discovery':'Keşfetmeniz için seçtik'}</span></div>
  <div className="editorial-pick-grid">{chosen.map(item=>{const art=CATEGORY_ART[item.category];return <button className="editorial-pick" key={item.id} onClick={()=>onSelect(item)} aria-label={name(item)+' · '+(english?'View product':'Ürünü incele')} data-product-id={item.id}>
   {publicPhotoPath(item.photoUrl)?<PublishedProductPhoto url={item.photoUrl} name={name(item)} className="editorial-reviewed-photo"/>:<img src={EDITORIAL_MEDIA+art.file} width={art.width} height={art.height} alt="" loading="lazy" decoding="async"/>}
   <div><h3>{name(item)}</h3><strong data-price-minor={item.priceMinor}>{money(item.priceMinor)}</strong><span className="editorial-pick-arrow" aria-hidden="true">↗</span></div>
  </button>;})}</div>
  <p className="editorial-art-note">{english?'Cards without an approved product photo use illustrative artwork. See each item for ingredients and price.':'Ürün fotoğrafı bulunmayan kartlarda temsili sunum kullanılır. İçerik ve güncel fiyat için ürünü inceleyin.'}</p>
 </section>;
}
export function EditorialCallout({onBrowse,english}:{onBrowse:()=>void;english:boolean}){return <section className="editorial-callout" data-surface="dark">
 <div><p className="editorial-kicker">SANDVİÇ · WAFFLE · CAFE</p><h2>{english?'Your next delicious break.':'Lezzetli bir molaya davetlisiniz.'}</h2><button onClick={onBrowse}>{english?'Explore the menu':'Menüyü keşfet'} <span aria-hidden="true">↗</span></button></div>
 <a href="https://www.menugo.app/" className="editorial-partner" aria-label="MenüGO ana sitesi"><span>{english?'Digital menu experience':'Dijital menü deneyimi'}</span><MenuGoLogo tone="dark" width={560} height={147}/></a>
 </section>;}
