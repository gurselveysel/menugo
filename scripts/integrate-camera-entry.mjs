// One-time, guarded source integration. Run in the review branch, never at production runtime.
import fs from 'node:fs';import{createHash}from'node:crypto';
const release='menugo-camera-entry-20260918-r14';
const hashes={
 'components/GuestTable.tsx':'865c9c9e50ed9b84b11c6d6977709c6318698c4f0d23ee84251c08db1e788050',
 'components/TableEntry.tsx':'b4a4a498dfad4f443f76d691af723fd12a35c6656a0ddb573b37457331f87bca',
 'app/yardim/page.tsx':'bb2545559cdbadfcc927fbc6948d6afa1efc3998d023f0065460cef198d78842',
 'lib/config.ts':'3d9f95b6919c5c4b433c96bcc0ede74a6e4ba416374db5745958909996201354',
 'public/release.json':'caa447665b477ec52213404851e186a554183dac92b46b8ada4dbd4d062da5b7',
 'next.config.mjs':'b6fbb502e83862b1a37528a8a62f2917853b33b0c394b78a2930920e3a20d508',
};
if(JSON.parse(fs.readFileSync('public/release.json')).version===release){console.log('Camera source already integrated.');process.exit(0);}
for(const[p,hash]of Object.entries(hashes))if(createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==hash)throw Error('Concurrent source edit: '+p);
function edit(path,changes){let s=fs.readFileSync(path,'utf8');for(const[old,value]of changes){if(s.split(old).length!==2)throw Error('Unexpected match count: '+path);s=s.replace(old,value);}fs.writeFileSync(path,s);}
edit('components/GuestTable.tsx',[
 ["import {ServiceAvailability,VisitFeedback}","import {TableScanner} from './TableScanner';\nimport {ServiceAvailability,VisitFeedback}"],
 ['Masanızdaki QR’yi okutun; ürünlerinizi seçip siparişinizi doğrudan gönderin. Üyelik gerekmez. İşletme siparişinizi kabul ettikten sonra hazırlık başlar.','Masanızın QR kodunu kameranızla tarayın; ürünlerinizi seçip siparişinizi gönderin. Üyelik gerekmez.'],
 ['<div className="guest-welcome-actions"><Link','{!loading&&<TableScanner/>}<div className="guest-welcome-actions"><Link'],
 ['className="btn primary" href="/bahcesehir">Menüyü incele','className="btn" href="/bahcesehir">Menüyü incele'],
]);
edit('components/TableEntry.tsx',[
 ["import {ApprovedTableEntry}","import {TableScanner} from './TableScanner';\nimport {ApprovedTableEntry}"],
 ['<div className="guest-welcome-actions"><Link','{!busy&&!id&&<TableScanner/>}<div className="guest-welcome-actions"><Link'],
]);
edit('app/yardim/page.tsx',[
 ['<h3>Masadaki sabit QR kodu</h3>','<h3>Site içinde kamerayla QR okutma</h3><p>Masada sipariş sayfasındaki “Kamerayı aç ve masa QR’sini tara” düğmesine dokunun. Tarayıcı izin isterse kameraya izin verin. QR bulunduğunda masanın ekranına geçersiniz. Kamera kullanılamıyorsa QR fotoğrafı seçebilir veya masa bağlantısını yapıştırabilirsiniz. Fotoğraf cihazınızda okunur; sunucuya gönderilmez. Masa QR’sinden zaten geldiyseniz tekrar tarama istenmez.</p><h3>Masadaki sabit QR kodu</h3>'],
]);
edit('next.config.mjs',[["{key:'X-Content-Type-Options',value:'nosniff'}","{key:'Permissions-Policy',value:'camera=(self), microphone=()'},{key:'X-Content-Type-Options',value:'nosniff'}"]]);
edit('lib/config.ts',[["menugo-service-experience-20260918-r13",release]]);
const manifest=JSON.parse(fs.readFileSync('public/release.json','utf8'));
fs.writeFileSync('public/release.json',JSON.stringify({...manifest,version:release,previous:'menugo-service-experience-20260918-r13',cameraEntry:true,localQrDecoder:true,photoFallback:true,menuUnchanged:true},null,2)+'\n');
console.log('Camera integrated in empty-state pages only; table join, orders, prices and DB unchanged.');
