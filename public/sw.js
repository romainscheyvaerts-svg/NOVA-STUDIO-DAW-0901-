/*
 * Service worker de Nova Studio (application installable).
 * - Pages : toujours le réseau d'abord (jamais une ancienne version du DAW),
 *   la copie en cache ne sert que hors ligne.
 * - /assets/ (fichiers versionnés par Vite), polices, icônes, worklets :
 *   cache d'abord, ils ne changent jamais sous le même nom.
 * - Tout le reste (API, Supabase, audio des beats) : réseau direct, pas de cache.
 */
const CACHE = 'nova-static-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(CACHE);
        c.put('/', res.clone());
        return res;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  if (/^\/(assets|fonts|icons|worklets)\//.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
  }
});
