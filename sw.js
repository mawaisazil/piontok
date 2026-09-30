/* SnapClip Service Worker — Cache-first strategy for core assets */
const CACHE_NAME = 'snapclip-v1-0-0';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  // External CDN assets (best-effort cache)
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Open+Sans:wght@300;600&display=swap',
  'https://cdn.tailwindcss.com'
];

// Install: pre-cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Cache core assets, but don't fail install if CDN fetch fails
      Promise.allSettled(CORE_ASSETS.map(url => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for static, network-first for API
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Skip non-GET
  if (req.method !== 'GET') return;
  // Skip chrome-extension and cross-origin API calls (tikwm.com)
  const url = new URL(req.url);
  if (url.origin !== location.origin && url.hostname === 'www.tikwm.com') {
    // Network-only for API
    return;
  }
  // Cache-first for everything else
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        // Cache successful same-origin responses
        if (resp && resp.status === 200 && (url.origin === location.origin || url.hostname.includes('fonts.googleapis') || url.hostname.includes('cdn.tailwindcss'))) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return resp;
      }).catch(() => cached || new Response('Offline', { status: 503, statusText: 'Offline' }));
    })
  );
});

// Allow page to trigger skipWaiting via postMessage
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
