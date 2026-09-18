// Never cache requests, financial snapshots, auth or POSTs. Static shell only.
const CACHE='menugo-shell-r10';const FILES=['/media/menugo-transparent-r8.png','/offline.html'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('menugo-shell-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin)return;if(FILES.includes(u.pathname)){e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));return;}if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match('/offline.html')));});
