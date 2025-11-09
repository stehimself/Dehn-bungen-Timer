// /sw.js
// Aktualisierungsfreundlicher Service Worker mit Offline-Fallback.
// Ziele:
// - Immer aktuelle Assets, solange online (network-first + no-cache Revalidation)
// - Offline: sinnvolles Fallback auf offline.html bzw. zuletzt bekannte Versionen

const VERSION = 'v2';
const OFFLINE_URL = './offline.html';
const RUNTIME_CACHE = `runtime-${VERSION}`;
const OFFLINE_CACHE = `offline-${VERSION}`;

// Install: Offline-Seite vorcachen und sofort aktiv werden
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
    })()
  );
  self.skipWaiting();
});

// Activate: alte Caches loeschen und Kontrolle uebernehmen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([RUNTIME_CACHE, OFFLINE_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (keep.has(k) ? Promise.resolve(false) : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

function isNavigationRequest(request) {
  return request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
}

// Fetch-Strategien
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // Nicht in Nicht-GET eingreifen

  const url = new URL(request.url);

  if (isNavigationRequest(request)) {
    // HTML/Navigations-Anfragen: Network-first mit Offline-Fallback
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        try {
          const fresh = await fetch(request, { cache: 'no-cache' });
          cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          const cached = await cache.match(request);
          return (
            cached ||
            (await caches.match(OFFLINE_URL)) ||
            new Response('Offline', { status: 503, statusText: 'Offline' })
          );
        }
      })()
    );
    return;
  }

  // Gleicher Ursprung: Assets (JS/CSS/Icons/Manifest) ebenfalls network-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        try {
          const fresh = await fetch(request, { cache: 'no-cache' });
          cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          const cached = await cache.match(request);
          if (cached) return cached;
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })()
    );
  }
  // Fremdurspruenge: Browser-Standardverhalten (keine Uebernahme)
});
