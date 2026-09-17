import type {Metadata} from 'next';import './globals.css';import './merchant.css';import './guest.css';
export const metadata:Metadata={title:{default:'MenüGO — İşletme Merkezi',template:'%s · MenüGO'},description:'Yeni Nesil Dijital Menü',robots:{index:false,follow:false},manifest:'/manifest.webmanifest'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="tr"><body>{children}</body></html>;}
