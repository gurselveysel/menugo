import {OfflineShell} from '@/components/OfflineShell';
import type {Metadata,Viewport} from 'next';import './globals.css';import './merchant.css';import './guest.css';import './service-mobile.css';import './service-experience.css';
export const metadata:Metadata={title:{default:'MenüGO — İşletme Merkezi',template:'%s · MenüGO'},description:'Yeni Nesil Dijital Menü',robots:{index:false,follow:false},manifest:'/manifest.webmanifest'};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',interactiveWidget:'resizes-content'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="tr"><body>{children}<OfflineShell/></body></html>;}
