const CACHE_PREFIX = 'dlmed-shell-';
// Bump this on each site release so open clients can detect the new worker.
const APP_VERSION = 'v111';
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;
const APP_FILES = [
  './', './index.html', './quiz.html', './exam.html',
  './exam.js', './exam-launcher.js', './pwa-update.js?v=111',
  './privacy/', './privacy/index.html', './terms/', './terms/index.html',
  './manifest.json', './manifest.webmanifest', './favicon.ico', './favicon.png',
  './apple-touch-icon.png', './dlmed-icon.svg', './dlmed-icon-192.png', './dlmed-icon-512.png',
  './supabase-config.js', './supabase-auth.js', './supabase-data.js',
  './supabase-runtime.js', './supabase-presence.js'
];
const SUPABASE_ORIGIN = 'https://alfziyssfhiabqgmzlsb.supabase.co';

function cacheKeyFor(url, includeQuery = true) {
  const normalized = new URL(url);
  normalized.hash = '';
  if (!includeQuery) normalized.search = '';
  return new Request(normalized.href);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_FILES.map(async path => {
      const url = new URL(path, self.registration.scope);
      const response = await fetch(new Request(url.href, { cache: 'reload' }));
      if (!response.ok) throw new Error(`Could not precache ${url.pathname}: ${response.status}`);
      await cache.put(url.href, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const upgradingExistingApp = names.some(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
    if (upgradingExistingApp) await refreshLegacyClients();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'DLMED_GET_SW_VERSION') {
    event.ports?.[0]?.postMessage({ version: APP_VERSION });
  } else if (event.data?.type === 'DLMED_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

async function refreshLegacyClients() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(pages.map(async client => {
    const url = new URL(client.url);
    if (url.origin !== self.location.origin
        || /\/exam\.html$/i.test(url.pathname)
        || url.searchParams.has('code')
        || url.searchParams.has('error')
        || /(?:^|[&#])(?:code|access_token|error)=/i.test(url.hash)) return;

    const helperAcknowledged = await new Promise(resolve => {
      const channel = new MessageChannel();
      let finished = false;
      const timeout = setTimeout(() => finish(false), 650);
      function finish(value) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        channel.port1.close();
        resolve(value);
      }
      channel.port1.onmessage = message => finish(message.data?.handled === true);
      channel.port1.start?.();
      try {
        client.postMessage({ type: 'DLMED_UPDATE_ACTIVATED', version: APP_VERSION }, [channel.port2]);
      } catch (_) {
        finish(false);
      }
    });

    if (!helperAcknowledged) {
      try { await client.navigate(client.url); } catch (_) {}
    }
  }));
}

async function networkFirst(request, cacheKey, offlineFallback = null) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(new Request(request, { cache: 'no-cache' }));
    if (fresh.ok || fresh.type === 'opaque') await cache.put(cacheKey, fresh.clone());
    return fresh;
  } catch (error) {
    return await cache.match(cacheKey)
      || (offlineFallback ? await cache.match(offlineFallback) : null)
      || new Response('DLMed est hors ligne. Reconnecte-toi puis réessaie.', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);

  // Supabase Auth, REST, Realtime and storage responses are never placed in CacheStorage.
  if (url.origin === SUPABASE_ORIGIN
      || /\/(?:rest|auth|realtime|storage)\/v1(?:\/|$)/i.test(url.pathname)) return;

  // Cache only the public Supabase JavaScript library, using network-first updates.
  if (url.origin === 'https://cdn.jsdelivr.net'
      && url.pathname.includes('/@supabase/supabase-js@2')) {
    event.respondWith(networkFirst(request, request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  const pageRequest = request.mode === 'navigate' || request.destination === 'document'
    || request.headers.get('accept')?.includes('text/html');
  if (pageRequest) {
    const key = cacheKeyFor(request.url, false);
    const appShell = new Request(new URL('index.html', self.registration.scope).href);
    event.respondWith(networkFirst(request, key, appShell));
    return;
  }

  const isScriptOrStyle = ['script', 'style'].includes(request.destination)
    || /\.(?:css|js|mjs)$/i.test(url.pathname);
  if (isScriptOrStyle) {
    event.respondWith(networkFirst(request, request));
    return;
  }

  // Images, icons and other static shell assets are useful offline and change less often.
  event.respondWith(cacheFirst(request));
});
