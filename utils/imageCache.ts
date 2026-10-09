/**
 * Cache durable des pochettes du catalogue (Cache API).
 *
 * Avant : l'accueil affichait les ~40 pochettes d'un coup (jusqu'à plusieurs Mo
 * chacune), retéléchargées dès que le cache HTTP du navigateur expirait (1 h).
 * Maintenant : une pochette n'est demandée que quand sa carte approche de l'écran
 * (voir CachedImage), puis gardée 30 jours ; au-delà, une vérification
 * conditionnelle (If-None-Match → 304, quelques octets) suffit tant qu'elle n'a
 * pas changé. Les noms de fichiers des pochettes sont horodatés : un changement
 * de pochette = une nouvelle adresse.
 */
import { catalogStatus, isQuotaError } from './catalogStatus';

const CACHE = 'nova-images-v1';
const INDEX_KEY = 'nova_images_cache_index';
const MAX_ENTRIES = 200;
export const IMAGE_TTL_MS = 30 * 24 * 3600_000;

const memo = new Map<string, Promise<string | null>>();

const readIndex = (): string[] => {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch { return []; }
};
const remember = async (cache: Cache, url: string) => {
  const list = [url, ...readIndex().filter(u => u !== url)];
  for (const old of list.slice(MAX_ENTRIES)) { try { await cache.delete(old); } catch { /* */ } }
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES))); } catch { /* */ }
};

const isCatalogUrl = (url: string) => /^https:\/\/[a-z0-9-]+\.supabase\.co\//i.test(url);

async function load(url: string): Promise<string | null> {
  let cache: Cache | null = null;
  try { cache = typeof caches !== 'undefined' ? await caches.open(CACHE) : null; } catch { cache = null; }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  const saved = Number(hit?.headers.get('x-nova-saved') || 0);
  if (hit && Date.now() - saved < IMAGE_TTL_MS) {
    void remember(cache!, url);
    return URL.createObjectURL(await hit.blob());
  }
  if (isCatalogUrl(url) && !catalogStatus.canTry()) return hit ? URL.createObjectURL(await hit.blob()) : null;
  try {
    const etag = hit?.headers.get('etag');
    const r = await fetch(url, { mode: 'cors', headers: etag ? { 'If-None-Match': etag } : undefined, cache: etag ? 'no-store' : 'default' });
    if (r.status === 304 && hit) {
      const blob = await hit.blob();
      const h: Record<string, string> = {};
      hit.headers.forEach((v, k) => { h[k] = v; });
      h['x-nova-saved'] = String(Date.now());
      try { await cache!.put(url, new Response(blob, { headers: h })); } catch { /* */ }
      return URL.createObjectURL(blob);
    }
    if (!r.ok) {
      if (isCatalogUrl(url) && isQuotaError(r.status)) catalogStatus.fail(new Error(`HTTP ${r.status}`), r.status);
      return hit ? URL.createObjectURL(await hit.blob()) : null;
    }
    const blob = await r.blob();
    if (cache) {
      const h: Record<string, string> = { 'x-nova-saved': String(Date.now()), 'content-type': r.headers.get('content-type') || blob.type || 'image/jpeg' };
      const et = r.headers.get('etag');
      if (et) h.etag = et;
      try { await cache.put(url, new Response(blob, { headers: h })); void remember(cache, url); } catch { /* quota plein */ }
    }
    return URL.createObjectURL(blob);
  } catch {
    // CORS refusé, hors ligne… : l'<img> essaiera l'adresse directe (cache HTTP du navigateur).
    return hit ? URL.createObjectURL(await hit.blob()) : url;
  }
}

/**
 * Adresse affichable pour une pochette : blob: depuis le cache, ou null si elle
 * est indisponible (le composant garde alors son visuel par défaut).
 * Les adresses non http(s) (data:, blob:, fichiers locaux) sont rendues telles quelles.
 */
export function cachedImageUrl(url: string): Promise<string | null> {
  if (!/^https?:\/\//.test(url)) return Promise.resolve(url);
  let p = memo.get(url);
  if (!p) {
    p = load(url).then(u => { if (!u) memo.delete(url); return u; });
    memo.set(url, p);
  }
  return p;
}

/** Déjà prête (affichage immédiat, sans clignotement) ? */
export const peekCachedImage = (url: string) => memo.get(url);
