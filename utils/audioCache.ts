/**
 * Cache durable des fichiers audio du catalogue (beats, mélodies) dans le navigateur.
 *
 * Objectif : un même beat n'est JAMAIS retéléchargé (le quota d'egress du projet
 * Supabase du catalogue a été dépassé le 09/10/2026).
 *  - Fichier complet gardé (Cache API, 40 derniers) avec sa « version » (date de
 *    modification de la fiche du catalogue). Tant que la version ne change pas :
 *    zéro requête. Sans version connue, une vérification légère au plus tous les
 *    7 jours : If-None-Match / If-Modified-Since si le serveur a donné un ETag, sinon
 *    une plage d'un seul octet (taille totale comparée). Avant, chaque réouverture
 *    relançait en arrière-plan le téléchargement COMPLET du beat.
 *  - Écoute dans le catalogue : seulement le début du fichier (plage HTTP, ~1 Mo,
 *    ≈ 30 s), gardé lui aussi ; si le beat est choisi ensuite, seule la suite est
 *    demandée (plage « bytes=N- »). Un serveur qui ignore les plages (réponse 200) :
 *    la lecture s'arrête après ~1 Mo et la connexion est coupée.
 * Uniquement des adresses http(s) publiques (jamais les fichiers de l'utilisateur).
 */
import { CatalogHttpError, catalogStatus, isQuotaError } from './catalogStatus';

const FULL = 'nova-audio-v1';
const PREVIEWS = 'nova-audio-apercus-v1';
const MAX_FULL = 40;
const MAX_PREVIEWS = 80;
const FULL_INDEX = 'nova_audio_cache_index';
const PREVIEW_INDEX = 'nova_audio_apercu_index';
/** Début de fichier pour une écoute : ≈ 26 s à 320 kb/s, 44 s à 192 kb/s. */
export const PREVIEW_BYTES = 1_048_576;
/** Plafond d'un extrait (WAV : ≈ 24 s ; MP3 avec grosse pochette intégrée). */
const PREVIEW_MAX_BYTES = 4_194_304;
const PREVIEW_SECONDS = 30;
/** Âge au-delà duquel un fichier sans version connue est vérifié (requête légère). */
export const REVALIDATE_MS = 7 * 24 * 3600_000;

const H_SAVED = 'x-nova-saved';
const H_VERSION = 'x-nova-version';
const H_ETAG = 'x-nova-etag';
const H_LASTMOD = 'x-nova-lastmod';
const H_TOTAL = 'x-nova-total';
const H_RANGES = 'x-nova-ranges';

// ---------------------------------------------------------------- versions
const versions = new Map<string, string>();
/** Versions connues (date de modification de la fiche) : url → version. */
export function noteAudioVersion(url: string, version: string | null | undefined) {
  if (url && version) versions.set(url, String(version));
}

// ---------------------------------------------------------------- utilitaires
const readIndex = (key: string): string[] => {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
};
const writeIndex = (key: string, list: string[], max: number) => {
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, max))); } catch { /* */ }
};
const remember = async (cache: Cache, key: string, max: number, url: string) => {
  const list = [url, ...readIndex(key).filter(u => u !== url)];
  for (const old of list.slice(max)) { try { await cache.delete(old); } catch { /* */ } }
  writeIndex(key, list, max);
};
const forget = async (cache: Cache | null, key: string, url: string) => {
  try { await cache?.delete(url); } catch { /* */ }
  writeIndex(key, readIndex(key).filter(u => u !== url), 1000);
};

const cacheable = (url: string) => /^https?:\/\//.test(url) && typeof caches !== 'undefined';
const isCatalogUrl = (url: string) => /^https:\/\/[a-z0-9-]+\.supabase\.co\//i.test(url);
const open = async (name: string): Promise<Cache | null> => {
  try { return await caches.open(name); } catch { return null; }
};

const totalFromRange = (cr: string | null): number | null => {
  const m = /\/(\d+)\s*$/.exec(cr || '');
  return m ? Number(m[1]) : null;
};

/** Réponse HTTP en erreur → exception avec le code (et l'état du catalogue mis à jour). */
const fail = async (r: Response, url: string): Promise<never> => {
  let detail = '';
  try { detail = (await r.clone().text()).slice(0, 300); } catch { /* */ }
  const err = new CatalogHttpError(r.status, `HTTP Error: ${r.status}${isQuotaError(r.status, detail) ? ' (catalogue restreint)' : ''}`);
  if (isCatalogUrl(url) && (isQuotaError(r.status, detail) || r.status >= 500)) catalogStatus.fail(err, r.status);
  throw err;
};

const succeeded = (url: string) => { if (isCatalogUrl(url)) catalogStatus.ok(); };

/** Le réseau a échoué (pas une réponse HTTP) : noté pour le délai d'attente. */
const networkFailed = (e: unknown, url: string) => {
  if (isCatalogUrl(url) && !(e instanceof CatalogHttpError) && (e as any)?.name !== 'AbortError') catalogStatus.fail(e);
};

/** Pas d'essai réseau vers le catalogue pendant le délai d'attente (aucune rafale). */
const guardCatalog = (url: string) => {
  if (isCatalogUrl(url) && !catalogStatus.canTry()) {
    const o = catalogStatus.get();
    throw new CatalogHttpError(o?.kind === 'quota' ? 402 : 503, 'Catalogue momentanément indisponible');
  }
};

const concat = (a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
};

const metaHeaders = (r: Response | null, extra: Record<string, string>) => {
  const h: Record<string, string> = { [H_SAVED]: String(Date.now()), ...extra };
  const ct = r?.headers.get('content-type');
  if (ct) h['content-type'] = ct;
  const etag = r?.headers.get('etag');
  if (etag) h[H_ETAG] = etag;
  const lm = r?.headers.get('last-modified');
  if (lm) h[H_LASTMOD] = lm;
  return h;
};

const putFull = async (cache: Cache | null, url: string, data: ArrayBuffer, r: Response | null, total?: number | null) => {
  if (!cache) return;
  const v = versions.get(url);
  try {
    await cache.put(url, new Response(data.slice(0), {
      headers: metaHeaders(r, { [H_TOTAL]: String(total ?? data.byteLength), ...(v ? { [H_VERSION]: v } : {}) }),
    }));
    void remember(cache, FULL_INDEX, MAX_FULL, url);
  } catch { /* quota du navigateur plein : tant pis */ }
};

// ------------------------------------------------------- vérification légère
const inFlight = new Set<string>();

async function revalidate(cache: Cache, url: string, hit: Response) {
  const saved = Number(hit.headers.get(H_SAVED) || 0);
  if (Date.now() - saved < REVALIDATE_MS || inFlight.has(url) || !catalogStatus.canTry()) return;
  inFlight.add(url);
  const ctrl = new AbortController();
  try {
    const etag = hit.headers.get(H_ETAG);
    const lastmod = hit.headers.get(H_LASTMOD);
    const known = Number(hit.headers.get(H_TOTAL) || 0) || (await hit.clone().arrayBuffer()).byteLength;
    const headers: Record<string, string> = etag ? { 'If-None-Match': etag } : lastmod ? { 'If-Modified-Since': lastmod } : { Range: 'bytes=0-0' };
    const r = await fetch(url, { headers, cache: 'no-store', signal: ctrl.signal });
    const restamp = async () => {
      const body = await hit.clone().arrayBuffer();
      const h: Record<string, string> = {};
      hit.headers.forEach((v, k) => { h[k] = v; });
      h[H_SAVED] = String(Date.now());
      const v = versions.get(url);
      if (v) h[H_VERSION] = v;
      await cache.put(url, new Response(body, { headers: h }));
    };
    if (r.status === 304) { ctrl.abort(); await restamp(); return; }
    if (headers.Range) {
      const total = r.status === 206 ? totalFromRange(r.headers.get('content-range')) : Number(r.headers.get('content-length') || 0) || null;
      ctrl.abort(); // jamais le corps : un serveur qui ignore la plage enverrait tout le fichier
      if (total && known && total === known) { await restamp(); return; }
      if (!total) { await restamp(); return; } // rien pour comparer : on garde
      await forget(cache, FULL_INDEX, url);     // taille différente : fichier remplacé, rechargé au prochain usage
      return;
    }
    if (r.ok) {
      const data = await r.arrayBuffer();
      await putFull(cache, url, data, r);
      return;
    }
    ctrl.abort();
  } catch { /* hors ligne : on garde l'ancien */ } finally { inFlight.delete(url); }
}

// ------------------------------------------------------------ fichier entier
/** Télécharge un fichier audio, en passant par le cache quand c'est possible. */
export async function fetchAudio(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!cacheable(url)) {
    const r = await fetch(url, { signal });
    if (!r.ok) await fail(r, url);
    return r.arrayBuffer();
  }
  const cache = await open(FULL);
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit) {
    const v = versions.get(url);
    const stored = hit.headers.get(H_VERSION);
    if (!(v && stored && v !== stored)) {
      // Déjà là : rendu tout de suite, sans réseau (vérification légère si la version est inconnue).
      void remember(cache!, FULL_INDEX, MAX_FULL, url);
      if (!(v && stored === v)) void revalidate(cache!, url, hit.clone());
      return hit.arrayBuffer();
    }
    // La fiche du catalogue a changé depuis : nouvelle version à télécharger.
  }
  guardCatalog(url);
  // Le début du fichier est peut-être déjà là (écouté dans le catalogue) : seulement la suite.
  const pcache = await open(PREVIEWS);
  const head = pcache ? await pcache.match(url).catch(() => undefined) : undefined;
  let data: ArrayBuffer;
  let r: Response;
  try {
    if (head && head.headers.get(H_RANGES) === '1' && (!versions.get(url) || head.headers.get(H_VERSION) === versions.get(url))) {
      const first = await head.arrayBuffer();
      const total = Number(head.headers.get(H_TOTAL) || 0);
      if (total && first.byteLength >= total) {
        await putFull(cache, url, first, head, total);
        await forget(pcache, PREVIEW_INDEX, url);
        return first;
      }
      r = await fetch(url, { headers: { Range: `bytes=${first.byteLength}-` }, signal });
      if (!r.ok) await fail(r, url);
      const rest = await r.arrayBuffer();
      data = r.status === 206 ? concat(first, rest) : rest;
    } else {
      r = await fetch(url, { signal });
      if (!r.ok) await fail(r, url);
      data = await r.arrayBuffer();
    }
  } catch (e) {
    networkFailed(e, url);
    throw e;
  }
  succeeded(url);
  await putFull(cache, url, data, r, data.byteLength);
  if (head) await forget(pcache, PREVIEW_INDEX, url);
  return data;
}

// ------------------------------------------------------------------- extrait
export interface AudioPreview {
  /** Audio prêt à décoder / lire (WAV tronqué : en-tête corrigé). */
  data: ArrayBuffer;
  /** Vrai si c'est le fichier entier (petit fichier, ou déjà en cache). */
  complete: boolean;
  mime: string;
}

const ascii = (u8: Uint8Array, at: number, n: number) => String.fromCharCode(...u8.subarray(at, at + n));

/** Octets à avoir pour ≈ 30 s d'écoute (étiquette ID3 incluse, ou WAV non compressé). */
export function previewBytesNeeded(buf: ArrayBuffer): number {
  const u8 = new Uint8Array(buf);
  if (u8.length >= 10 && ascii(u8, 0, 3) === 'ID3') {
    const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    const footer = (u8[5] & 0x10) ? 10 : 0;
    const tag = 10 + size + footer;
    // Petite étiquette : pas de 2e requête pour quelques octets.
    return tag < 65_536 ? PREVIEW_BYTES : Math.min(PREVIEW_MAX_BYTES, tag + PREVIEW_BYTES);
  }
  const wav = wavLayout(u8);
  if (wav) return Math.min(PREVIEW_MAX_BYTES, wav.dataAt + wav.byteRate * PREVIEW_SECONDS);
  return PREVIEW_BYTES;
}

function wavLayout(u8: Uint8Array): { byteRate: number; blockAlign: number; dataAt: number; dataSizeAt: number } | null {
  if (u8.length < 44 || ascii(u8, 0, 4) !== 'RIFF' || ascii(u8, 8, 4) !== 'WAVE') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 12, byteRate = 0, blockAlign = 1;
  while (p + 8 <= u8.length) {
    const id = ascii(u8, p, 4);
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ' && p + 24 <= u8.length) { byteRate = dv.getUint32(p + 16, true); blockAlign = dv.getUint16(p + 20, true) || 1; }
    if (id === 'data') return byteRate ? { byteRate, blockAlign, dataAt: p + 8, dataSizeAt: p + 4 } : null;
    p += 8 + size + (size & 1);
  }
  return null;
}

/** Début d'un WAV : tailles RIFF / data ramenées à ce qui est là (sinon le décodeur refuse). */
export function trimmedWav(buf: ArrayBuffer): ArrayBuffer {
  const u8 = new Uint8Array(buf);
  const w = wavLayout(u8);
  if (!w) return buf;
  let dataLen = Math.max(0, u8.length - w.dataAt);
  dataLen -= dataLen % w.blockAlign;
  const out = u8.slice(0, w.dataAt + dataLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, out.length - 8, true);
  dv.setUint32(w.dataSizeAt, dataLen, true);
  return out.buffer;
}

/** Lit au plus `limit` octets d'une réponse, puis coupe la connexion. */
async function readAtMost(r: Response, limit: number): Promise<{ data: ArrayBuffer; done: boolean }> {
  if (!r.body) { const d = await r.arrayBuffer(); return { data: d, done: true }; }
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0, done = false;
  while (n < limit) {
    const step = await reader.read();
    if (step.done) { done = true; break; }
    parts.push(step.value);
    n += step.value.byteLength;
  }
  if (!done) { try { await reader.cancel(); } catch { /* */ } }
  const out = new Uint8Array(done ? n : Math.min(n, limit));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    const take = p.subarray(0, out.length - at);
    out.set(take, at); at += take.byteLength;
  }
  return { data: out.buffer, done };
}

/**
 * Écoute d'un beat dans le catalogue : le début du fichier seulement (plage HTTP),
 * ou le fichier entier s'il est déjà en cache. Rien n'est retéléchargé deux fois.
 */
export async function fetchAudioPreview(url: string, signal?: AbortSignal): Promise<AudioPreview> {
  if (!cacheable(url)) {
    const r = await fetch(url, { signal });
    if (!r.ok) await fail(r, url);
    return { data: await r.arrayBuffer(), complete: true, mime: r.headers.get('content-type') || 'audio/mpeg' };
  }
  const full = await open(FULL);
  const hit = full ? await full.match(url).catch(() => undefined) : undefined;
  if (hit) {
    void remember(full!, FULL_INDEX, MAX_FULL, url);
    return { data: await hit.arrayBuffer(), complete: true, mime: hit.headers.get('content-type') || 'audio/mpeg' };
  }
  const pcache = await open(PREVIEWS);
  const phit = pcache ? await pcache.match(url).catch(() => undefined) : undefined;
  const v = versions.get(url);
  if (phit && !(v && phit.headers.get(H_VERSION) && phit.headers.get(H_VERSION) !== v)) {
    void remember(pcache!, PREVIEW_INDEX, MAX_PREVIEWS, url);
    return { data: trimmedWav(await phit.arrayBuffer()), complete: false, mime: phit.headers.get('content-type') || 'audio/mpeg' };
  }
  guardCatalog(url);
  let data: ArrayBuffer, complete: boolean, total: number | null, ranges: boolean;
  let r: Response;
  try {
    r = await fetch(url, { headers: { Range: `bytes=0-${PREVIEW_BYTES - 1}` }, signal });
    if (!r.ok) await fail(r, url);
    if (r.status === 206) {
      ranges = true;
      total = totalFromRange(r.headers.get('content-range'));
      data = await r.arrayBuffer();
      const need = Math.min(previewBytesNeeded(data), total ?? Infinity);
      if (need > data.byteLength) {
        const r2 = await fetch(url, { headers: { Range: `bytes=${data.byteLength}-${need - 1}` }, signal });
        if (!r2.ok) await fail(r2, url);
        const more = await r2.arrayBuffer();
        data = r2.status === 206 ? concat(data, more) : more;
      }
      complete = total != null && data.byteLength >= total;
    } else {
      // Le serveur ignore la plage : on ne lit que le début, puis on coupe.
      ranges = false;
      const got = await readAtMost(r, PREVIEW_BYTES);
      data = got.data; complete = got.done;
      total = complete ? data.byteLength : (Number(r.headers.get('content-length') || 0) || null);
    }
  } catch (e) {
    networkFailed(e, url);
    throw e;
  }
  succeeded(url);
  const mime = r.headers.get('content-type') || 'audio/mpeg';
  if (complete) {
    await putFull(full, url, data, r, data.byteLength);
    return { data, complete: true, mime };
  }
  if (pcache) {
    try {
      await pcache.put(url, new Response(data.slice(0), {
        headers: metaHeaders(r, { [H_TOTAL]: String(total ?? ''), [H_RANGES]: ranges ? '1' : '0', ...(v ? { [H_VERSION]: v } : {}) }),
      }));
      void remember(pcache, PREVIEW_INDEX, MAX_PREVIEWS, url);
    } catch { /* quota du navigateur plein */ }
  }
  return { data: trimmedWav(data), complete: false, mime };
}
