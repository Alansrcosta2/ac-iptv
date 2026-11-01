const CACHE='aciptv-v1';
const ASSETS=['./','./index.html','./css/app.css','./js/app.js','./js/i18n.js','./js/keys.js','./js/keyboard.js','./js/log.js','./js/m3u.js','./js/player.js','./js/store.js','./js/subs.js','./js/ui.js','./js/util.js','./manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).catch(()=>caches.match('./index.html'))));
});
