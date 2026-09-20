'use client';
import {useState} from 'react';
import {publicPhotoPath} from '@/src/studio/photo-publication';
/** Invalid/stale photo URLs disappear without leaving a broken image or loading remote URLs. */
export function PublishedProductPhoto({url,name,className='merchant-published-photo'}:{url?:string|null;name:string;className?:string}){
 const path=publicPhotoPath(url);const[failed,setFailed]=useState<string|null>(null);
 if(!path||failed===path)return null;
 return <img className={className} src={path} alt={name+' · ürün fotoğrafı'} loading="lazy" decoding="async" onError={()=>setFailed(path)}/>;
}
