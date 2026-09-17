import Link from 'next/link';import type {ReactNode} from 'react';
export function Brand(){return <Link className="brand" href="/"><img src="/media/menugo.png" alt="menügo — Yeni Nesil Dijital Menü" width="560" height="147"/></Link>;}
export function PageHeader(){return <header className="top"><Brand/><nav><Link href="/bahcesehir">Menü</Link><Link href="/siparis">Masam</Link><Link href="/giris" className="btn quiet">İşletme girişi ↗</Link></nav></header>;}
export function Card({children,className=''}:{children:ReactNode;className?:string}){return <section className={'card '+className}>{children}</section>;}
export function Empty({title,description}:{title:string;description:string}){return <div className="empty"><span className="empty-icon">◎</span><h3>{title}</h3><p>{description}</p></div>;}
