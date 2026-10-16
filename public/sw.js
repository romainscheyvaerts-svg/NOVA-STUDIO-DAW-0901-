/*
 * Service worker de Nova Studio (application installable).
 * - Pages : toujours le réseau d'abord (jamais une ancienne version du DAW),
 *   la copie en cache ne sert que hors ligne.
 * - /assets/ (fichiers versionnés par Vite), polices, icônes, worklets, sons
 *   de batterie (/drums/, noms = empreinte du fichier) :
 *   cache d'abord, ils ne changent jamais sous le même nom.
 * - Sons des kits NOVA (/drums/kits/, ~2 000 fichiers brouillés) et batterie du studio
 *   (/drums/lib/, brouillée de même depuis le 16/10/2026) : pas ici. La page les met
 *   elle-même en cache à la demande (Cache API « nova-kits-v1 », utils/drumKitLibrary.ts), aussi
 *   dans l'appli Windows qui n'a pas de service worker ; ce cache n'est jamais vidé ici.
 * - Tout le reste (API, Supabase, audio des beats) : réseau direct, pas de cache.
 */
const CACHE = 'nova-static-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // Ne garder que la version courante… sauf le cache des kits (sons déjà écoutés, hors ligne).
    await Promise.all(keys.filter(k => k !== CACHE && !k.startsWith('nova-kits-')).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/drums/kits/') || url.pathname.startsWith('/drums/lib/')) return; // cache géré par la page (voir plus haut)

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        // Seule la page du DAW sert de copie hors ligne : la page d'écoute d'un client
        // (/ecoute.html, lien d'écoute) ne doit pas la remplacer.
        const daw = !url.pathname.endsWith('/ecoute.html');
        if (daw && res.ok) (await caches.open(CACHE)).put('/', res.clone());
        return res;
      } catch {
        if (url.pathname.endsWith('/ecoute.html')) return Response.error();
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  if (/^\/(assets|fonts|icons|worklets|drums)\//.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
  }
});
