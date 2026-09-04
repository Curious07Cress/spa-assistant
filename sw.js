const CACHE = 'spa-v5';
const ASSETS = ['/', '/index.html', '/manifest.json', '/chemistry.js'];

// Store responses stripped of the "redirected" flag (Safari rejects redirected
// responses served to navigations: "Response served by service worker has redirections")
async function cleanFetch(request) {
  const res = await fetch(request);
  if (res.redirected) {
    const body = await res.blob();
    return new Response(body, { status: 200, statusText: 'OK', headers: res.headers });
  }
  return res;
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async a => {
      try { await c.put(a, await cleanFetch(new Request(a, { cache: 'reload' }))); } catch (_) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;   // API is never cached or intercepted
  if (url.href.includes('api.anthropic.com')) return;
  if (url.pathname.startsWith('/guides') || url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') return;

  // Navigations: network-first (clean), cache fallback for offline
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await cleanFetch(e.request);
        const c = await caches.open(CACHE);
        c.put('/', res.clone());
        return res;
      } catch (_) {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Static assets: cache-first with clean store
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    const res = await cleanFetch(e.request);
    const c = await caches.open(CACHE);
    c.put(e.request, res.clone());
    return res;
  })());
});
