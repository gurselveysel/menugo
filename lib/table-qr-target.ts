/** Parse only our table entry links. Never navigate to arbitrary QR contents. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ORIGINS = new Set([
  'https://menugo.app', 'https://www.menugo.app',
  'https://sariyerborekcisi.menugo.app', 'https://menugo-tau.vercel.app',
]);
export type TableTarget =
  | {kind:'table'; tableId:string; path:string}
  | {kind:'visit'; checkId:string; path:string};
export function tableQrTarget(raw:string, currentOrigin:string):TableTarget|null {
  if(typeof raw!=='string' || raw.length>2048) return null;
  const value=raw.trim();
  if(!value || /[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith('//')) return null;
  try {
    const current=new URL(currentOrigin);
    if(current.protocol!=='https:' && !(current.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(current.hostname)))return null;
    if(!value.startsWith('/') && !/^https?:\/\//i.test(value))return null;
    const url=new URL(value,current.origin);
    if(url.username||url.password||url.hash)return null;
    if(url.origin!==current.origin&&!PUBLIC_ORIGINS.has(url.origin))return null;
    const entries=[...url.searchParams];
    const unique=new Set(entries.map(([key])=>key));
    if(unique.size!==entries.length)return null;
    const path=url.pathname.replace(/\/$/,'');
    if(path==='/masaya-katil' && entries.length===1 && unique.has('masa')) {
      const id=url.searchParams.get('masa')!;
      if(!UUID.test(id))return null;
      return {kind:'table',tableId:id.toLowerCase(),path:'/masaya-katil?masa='+id.toLowerCase()};
    }
    if(path==='/siparis' && entries.length===2 && unique.has('check') && unique.has('token')) {
      const check=url.searchParams.get('check')!,token=url.searchParams.get('token')!;
      if(!UUID.test(check)||!/^[0-9a-f]{64}$/.test(token))return null;
      return {kind:'visit',checkId:check.toLowerCase(),path:'/siparis?check='+check.toLowerCase()+'&token='+token};
    }
  }catch{/* Invalid QR data is never an executable destination. */}
  return null;
}
export function cameraMessage(error:unknown):string {
  const name=error&&typeof error==='object'&&'name' in error?String(error.name):'';
  if(name==='NotAllowedError'||name==='SecurityError')return 'Kamera izni verilmedi. Tarayıcınızın site ayarlarından kameraya izin verin veya QR fotoğrafını seçin.';
  if(name==='NotFoundError'||name==='OverconstrainedError')return 'Uygun kamera bulunamadı. QR fotoğrafını seçebilir veya masa bağlantısını yapıştırabilirsiniz.';
  if(name==='NotReadableError'||name==='AbortError')return 'Kamera şu anda kullanılamıyor. Kamerayı kullanan diğer uygulamayı kapatıp yeniden deneyin.';
  return 'Kamera açılamadı. Yeniden deneyin veya QR fotoğrafından devam edin.';
}
