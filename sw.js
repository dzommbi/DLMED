const CACHE_PREFIX = 'dlmed-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v81`;
const APP_FILES = ['./', './index.html', './manifest.json', './manifest.webmanifest', './dlmed-icon.svg', './dlmed-icon-192.png', './dlmed-icon-512.png', './biochimie-homme-sain.js', './biochimie-etapes-analyse.js', './biochimie-marqueurs-cardiaques.js', './physio-choc-hypovolemique.js', './physio-mtev.js', './physio-ira.js', './psychologie-relation-medecin-malade.js', './semiologie-nouveaux-chapitres.js', './semiologie-examen-physique.js', './visitor-counter-config.js', './visitor-counter.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;

  if (requestUrl.pathname.endsWith('/visitor-counter-config.js')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (!response.ok) return response;
        const copy = response.clone();
        return caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).then(() => response);
      }).catch(() => caches.match(event.request).then(cached => cached || new Response("window.DLMED_VISITOR_COUNTER_URL = ''; ", {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
      })))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match('./index.html')))
  );
});
