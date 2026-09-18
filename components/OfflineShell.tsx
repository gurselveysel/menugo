'use client';
import {useEffect} from 'react';
/** Cache only static branding/offline shell. Never queue orders or cache account APIs. */
export function OfflineShell(){useEffect(()=>{if('serviceWorker' in navigator&&location.protocol==='https:'){void navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});}},[]);return null;}
