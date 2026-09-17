import fs from 'node:fs';
// One-time r5 preservation import; subsequent repository builds use committed assets.
const file='public/menu.js';let js=fs.readFileSync(file,'utf8');
if(!js.includes('MENUGO_LIVE_CATALOGUE_R6')){
 const archive=JSON.parse(fs.readFileSync('public/catalog.json','utf8'));
 const groups=Object.fromEntries(archive.map(x=>[x[0],x[3]]));
 js=js.replace(/const price=p=>[^\n]+;/,`const price=p=>p===null?'Fiyat için sorunuz':(BigInt(p)/100n).toLocaleString('tr-TR')+','+(BigInt(p)%100n).toString().padStart(2,'0')+' ₺';`);
 const pos=js.lastIndexOf("fetch('/catalog.json'");if(pos<0)throw Error('Legacy catalog fetch not found');
 js=js.slice(0,pos)+`// MENUGO_LIVE_CATALOGUE_R6\nconst legacyGroups=${JSON.stringify(groups)};\nfetch('/api/catalogue',{cache:'no-store',credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error('Menu unavailable');return r.json();}).then(data=>{if(!Array.isArray(data.items))throw Error('Invalid catalog');items=data.items.map(p=>[p.sourceId,p.name,p.category,legacyGroups[p.sourceId]||p.category,p.priceMinor,p.description,Array.isArray(p.options)?p.options:[],p.quantityLabel]);render();}).catch(()=>{$('result-count').textContent='Bağlantı sorunu';$('products').innerHTML='<div class="empty"><h4>Menü yüklenemedi.</h4><p>Lütfen sayfayı yenileyin.</p><button class="button primary" type="button" id="retry">Tekrar dene</button></div>';$('retry').addEventListener('click',()=>location.reload());});\n`;
 fs.writeFileSync(file,js);
}
for(const path of ['public/legacy/platform.html','public/legacy/branch.html']){let html=fs.readFileSync(path,'utf8');html=html.replace(/src="\/menu\.js[^\"]*"/g,'src="/menu.js?v=r6"');fs.writeFileSync(path,html);}
fs.writeFileSync('public/release.json',JSON.stringify({version:'menugo-counter-pilot-20260917-r6',dataMode:'supabase',orderMode:'staff-controlled-dine-in',counterReceipt:'staff-declared-cash-or-external-pos',payments:false,daas:false,sms:false,sourceRepository:'gurselveysel/menugo'}));
