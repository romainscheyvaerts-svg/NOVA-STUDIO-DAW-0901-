/**
 * Cache des fichiers audio du catalogue (beats, mélodies) dans le navigateur.
 * Un beat déjà écouté se rouvre tout de suite, même avec une connexion faible
 * ou sans connexion (application Windows hors ligne, métro…). Les 20 derniers
 * sont gardés ; on vérifie en arrière-plan qu'ils n'ont pas changé.
 * Uniquement des adresses http(s) publiques (jamais les fichiers de l'utilisateur).
 */
const CACHE = 'nova-audio-v1';
const MAX_ENTRIES = 20;
const INDEX_KEY = 'nova_audio_cache_index';

const readIndex = (): string[] => {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch { return []; }
};
const writeIndex = (list: string[]) => {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES))); } catch { /* */ }
};

const remember = async (cache: Cache, url: string) => {
  const list = [url, ...readIndex().filter(u => u !== url)];
  for (const old of list.slice(MAX_ENTRIES)) { try { await cache.delete(old); } catch { /* */ } }
  writeIndex(list);
};

const cacheable = (url: string) => /^https?:\/\//.test(url) && typeof caches !== 'undefined';

/** Télécharge un fichier audio, en passant par le cache quand c'est possible. */
export async function fetchAudio(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!cacheable(url)) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`HTTP Error: ${r.status}`);
    return r.arrayBuffer();
  }
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); } catch { cache = null; }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit) {
    // Déjà là : on rend tout de suite, et on rafraîchit discrètement.
    void (async () => {
      try {
        const fresh = await fetch(url, { cache: 'no-cache' });
        if (fresh.ok && fresh.type !== 'opaque') await cache!.put(url, fresh);
      } catch { /* hors ligne : on garde l'ancien */ }
    })();
    void remember(cache!, url);
    return hit.arrayBuffer();
  }
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP Error: ${r.status}`);
  if (cache && r.type !== 'opaque') {
    try { await cache.put(url, r.clone()); void remember(cache, url); } catch { /* quota plein : tant pis */ }
  }
  return r.arrayBuffer();
}
