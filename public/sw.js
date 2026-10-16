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
 * - Notifications (Lot 7, services/PushNotify.ts) : « push » affiche la notification (commentaire,
 *   version, invitation, prise reçue) sauf si NOVA est déjà ouverte et au premier plan : la page la
 *   montre alors elle-même, sans bruit ; un clic ramène la fenêtre NOVA (ou en ouvre une) sur la
 *   séance, à l'instant du commentaire. Adresses de clic : toujours sur NOVA (chemin relatif).
 */
const CACHE = 'nova-static-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // Ne garder que la version courante… sauf le cache des kits (sons déjà écoutés, hors ligne)
    // et celui des modèles d'IA téléchargés à la demande (séparation de stems dans le navigateur,
    // ~250 Mo : ne jamais le faire retélécharger à chaque nouvelle version du site).
    await Promise.all(keys.filter(k => k !== CACHE && !k.startsWith('nova-kits-') && !k.startsWith('nova-models-')).map(k => caches.delete(k)));
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

// --- Notifications (Lot 7) ------------------------------------------------------------
/** Chemin relatif sur NOVA seulement (jamais une autre adresse, même dans un message reçu). */
const novaPath = (u) => (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && u.charAt(1) !== '\\' ? u : '/');

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'NOVA', body: e.data ? e.data.text() : '' }; }
  if (!d || typeof d !== 'object') d = {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // NOVA au premier plan : la page affiche la nouveauté elle-même (petite carte), pas de notification système.
    const front = wins.filter(w => w.visibilityState === 'visible' && w.focused);
    if (front.length && d.tag !== 'nova-test') {
      front.forEach(w => w.postMessage({ type: 'nova-push', data: d }));
      return;
    }
    await self.registration.showNotification(String(d.title || 'NOVA').slice(0, 120), {
      body: String(d.body || '').slice(0, 300),
      tag: typeof d.tag === 'string' ? d.tag.slice(0, 120) : undefined,
      renotify: typeof d.tag === 'string',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      lang: 'fr',
      data: { ...d, url: novaPath(d.url) },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const path = novaPath(d.url);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => { try { return new URL(c.url).origin === self.location.origin; } catch (_) { return false; } });
    if (w) {
      // Fenêtre déjà ouverte (peut-être en pleine prise) : on ne la recharge pas, la page décide.
      try { await w.focus(); } catch (_) { /* focus refusé */ }
      w.postMessage({ type: 'nova-notif-open', data: { ...d, url: path } });
      return;
    }
    await self.clients.openWindow(path);
  })());
});
