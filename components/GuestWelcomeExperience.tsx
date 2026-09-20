import {PublishedProductPhoto} from './PublishedProductPhoto';
import {publicPhotoPath} from '@/src/studio/photo-publication';
import type {ReactNode} from 'react';
import Link from 'next/link';
import MenuGoLogo from './MenuGoLogo';
import {CATEGORY_ART,EDITORIAL_MEDIA,productArtwork,type EditorialProduct} from '@/lib/merchant-visuals';
import styles from './GuestWelcomeExperience.module.css';

/** Presentation only. No session, order, price, provider or catalogue mutations. */
export function GuestWelcomeExperience({children}:{children:ReactNode}) {
 const categories=[['sandvic','Sandviç'],['tatli','Waffle'],['kahvalti','Kahvaltı']] as const;
 return <main className={'guest-welcome '+styles.welcome}>
  <div className={styles.copy}>{children}</div>
  <aside className={styles.preview} aria-labelledby="welcome-menu-preview-title" data-surface="dark">
   <div className={styles.intro}><p className={styles.eyebrow}>SANDVİÇ · WAFFLE · CAFE</p>
    <h2 id="welcome-menu-preview-title">Lezzetli bir<br/><em>molaya hoş geldiniz.</em></h2>
    <p>Menüyü keşfedin. Masanızın QR’sini tarayıp seçimlerinize devam edin.</p>
   </div>
   <div className={styles.images}>{categories.map(([key,title])=>{
    const art=CATEGORY_ART[key];
    return <figure key={key}><img src={EDITORIAL_MEDIA+art.file} width={art.width} height={art.height} alt="" loading="lazy" decoding="async"/><figcaption>{title}</figcaption></figure>;
   })}</div>
   <Link className={styles.menuLink} href="/bahcesehir">Lezzetleri keşfet <span aria-hidden="true">↗</span></Link>
   <p className={styles.disclaimer}>Sunum görselleri temsilidir. İçerik ve güncel fiyatlar menüde yer alır.</p>
   <a className={styles.partner} href="https://www.menugo.app/" aria-label="MenüGO ana sitesi"><span>Dijital menü deneyimi</span><MenuGoLogo tone="dark" width={560} height={147}/></a>
  </aside>
 </main>;
}

/** Use only reviewed name/category matches. Never attach invented product photos. */
export function MenuSelectionVisual({item}:{item:EditorialProduct & {photoUrl?:string}}) {
 if(publicPhotoPath(item.photoUrl))return <figure className={styles.productVisual} data-reviewed-product-photo="true"><PublishedProductPhoto url={item.photoUrl} name={item.name}/></figure>;
 const art=productArtwork(item);
 if(!art)return null;
 return <figure className={styles.productVisual} data-menu-illustration="true">
  <img src={EDITORIAL_MEDIA+art.file} width={art.width} height={art.height} alt="" loading="lazy" decoding="async"/>
  <figcaption>Temsili sunum</figcaption>
 </figure>;
}
