const CACHE='mining-translator-v041-ios';
const APP=['./','./index.html','./styles.css','./app.js?v=041','./manifest.webmanifest'];

self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(APP)));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  const same=url.origin===location.origin;
  const fresh=same && (url.pathname.endsWith('/')||url.pathname.endsWith('.html')||url.pathname.endsWith('.js'));
  if(fresh){
    event.respondWith(
      fetch(event.request)
        .then(resp=>{
          const copy=resp.clone();
          caches.open(CACHE).then(c=>c.put(event.request,copy));
          return resp;
        })
        .catch(()=>caches.match(event.request))
    );
  }else{
    event.respondWith(caches.match(event.request).then(r=>r||fetch(event.request)));
  }
});