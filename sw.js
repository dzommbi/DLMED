const CACHE_PREFIX = 'dlmed-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v109`;
const APP_FILES = ['./', './index.html', './quiz.html', './exam.html', './exam.js', './exam-launcher.js', './manifest.json', './manifest.webmanifest', './favicon.ico', './favicon.png', './apple-touch-icon.png', './dlmed-icon.svg', './dlmed-icon-192.png', './dlmed-icon-512.png', './supabase-config.js', './supabase-auth.js', './supabase-data.js', './supabase-runtime.js', './supabase-presence.js'];

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
  if (event.request.method !== 'GET') return;

  // Cache the public Supabase SDK so the app shell can still open offline after
  // its first successful online load. Supabase data grading still needs network.
  if (requestUrl.origin === 'https://cdn.jsdelivr.net' && requestUrl.pathname.includes('/@supabase/supabase-js@2')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => cache.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok || response.type === 'opaque') cache.put(event.request, response.clone());
          return response;
        }).catch(() => cached || new Response('', { status: 503, statusText: 'Offline' }));
      }))
    );
    return;
  }
  if (requestUrl.origin !== self.location.origin) return;

  const cacheRequest = requestUrl.pathname.endsWith('/quiz.html') || requestUrl.pathname.endsWith('/exam.html')
    ? new Request(requestUrl.origin + requestUrl.pathname)
    : event.request;
  event.respondWith(
    caches.match(cacheRequest).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(cacheRequest).then(shell => shell || caches.match('./index.html'))))
  );
});
