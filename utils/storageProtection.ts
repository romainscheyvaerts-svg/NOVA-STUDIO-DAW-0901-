/**
 * Protection des sauvegardes de l'appareil contre l'effacement automatique du navigateur.
 *
 * La sauvegarde automatique et la récupération après plantage vivent dans IndexedDB.
 * Sans `navigator.storage.persist()`, ce stockage est « au mieux » : le navigateur peut
 * l'effacer quand le disque se remplit ou au nettoyage du site. Ici :
 *  - la persistance est demandée au premier projet sauvegardé (pas au chargement : le
 *    navigateur l'accorde plus volontiers à un site où l'on a déjà travaillé) ;
 *  - son état est lisible dans les réglages, avec un conseil clair si elle est refusée ;
 *  - le quota (`storage.estimate()`) est surveillé : alerte avant saturation ;
 *  - une marque hors du stockage effaçable (cookie) se souvient qu'il y avait des
 *    sauvegardes : si elles ont disparu, le studio le dit au lieu de se taire.
 */

export type PersistState = 'unsupported' | 'unknown' | 'granted' | 'denied';
export type QuotaLevel = 'ok' | 'warn' | 'full' | 'unknown';

export interface StorageStatus {
  persist: PersistState;
  usage: number | null;
  quota: number | null;
  level: QuotaLevel;
  checkedAt: number;
}

export interface StorageApi {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

/** Au-delà : alerte (« presque plein »). */
export const WARN_RATIO = 0.8;
/** Au-delà : les prochaines sauvegardes risquent d'échouer. */
export const FULL_RATIO = 0.95;
/** Moins de 300 Mo libres : alerte même si le pourcentage reste bas. */
export const WARN_FREE_BYTES = 300 * 1024 * 1024;

const api = (): StorageApi | null => {
  try { return (typeof navigator !== 'undefined' && (navigator as any).storage) || null; } catch { return null; }
};

export function quotaLevel(usage: number | null | undefined, quota: number | null | undefined): QuotaLevel {
  if (usage == null || !quota) return 'unknown';
  const r = usage / quota;
  if (r >= FULL_RATIO) return 'full';
  if (r >= WARN_RATIO || quota - usage < WARN_FREE_BYTES) return 'warn';
  return 'ok';
}

let status: StorageStatus = { persist: 'unknown', usage: null, quota: null, level: 'unknown', checkedAt: 0 };
const listeners = new Set<(s: StorageStatus) => void>();
const set = (patch: Partial<StorageStatus>) => {
  status = { ...status, ...patch, checkedAt: Date.now() };
  listeners.forEach(cb => { try { cb(status); } catch { /* écouteur fautif */ } });
};
export const storageStatus = () => status;
export function onStorageStatus(cb: (s: StorageStatus) => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

/** Relit l'état (persistance déjà accordée ? place utilisée ?) sans rien demander. */
export async function refreshStorageStatus(s: StorageApi | null = api()): Promise<StorageStatus> {
  if (!s) { set({ persist: 'unsupported', level: 'unknown' }); return status; }
  let granted: boolean | null = null;
  if (typeof s.persisted === 'function') {
    try { granted = await s.persisted(); } catch { /* */ }
  }
  let usage: number | null = null, quota: number | null = null;
  if (typeof s.estimate === 'function') {
    try { const e = await s.estimate(); usage = e.usage ?? null; quota = e.quota ?? null; } catch { /* */ }
  }
  // Décidé au moment d'écrire : une demande (requestPersistence) a pu aboutir entre-temps,
  // un refus déjà connu n'est jamais ramené à « inconnu ».
  const persist: PersistState = typeof s.persisted !== 'function' ? 'unsupported'
    : granted ? 'granted'
      : (askResult === 'denied' || status.persist === 'denied') ? 'denied' : 'unknown';
  set({ persist, usage, quota, level: quotaLevel(usage, quota) });
  return status;
}

let asked: Promise<PersistState> | null = null;
let askResult: PersistState | null = null;
/**
 * Demande la persistance (une fois par chargement de page). À appeler au premier
 * projet sauvegardé. Chrome accorde ou refuse sans fenêtre ; Firefox peut demander.
 */
export function requestPersistence(s: StorageApi | null = api()): Promise<PersistState> {
  if (asked) return asked;
  asked = (async (): Promise<PersistState> => {
    if (!s || typeof s.persist !== 'function') return 'unsupported';
    try {
      if (typeof s.persisted === 'function' && await s.persisted()) return 'granted';
      return (await s.persist()) ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  })().then(r => { askResult = r; set({ persist: r }); return r; });
  return asked;
}
export function resetStorageProtectionForTests() { asked = null; askResult = null; status = { persist: 'unknown', usage: null, quota: null, level: 'unknown', checkedAt: 0 }; listeners.clear(); }

/** Erreur « stockage plein » (IndexedDB, Cache, localStorage), quel que soit le navigateur. */
export function isQuotaError(e: unknown): boolean {
  const x = e as { name?: string; code?: number; message?: string; inner?: unknown } | null;
  if (!x) return false;
  if (x.name === 'QuotaExceededError' || x.code === 22 || x.code === 1014 || x.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  return /quota|storage.*full|disk.*full/i.test(String(x.message || ''));
}

const fmt = (b: number | null) => (b == null ? '?' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} Go` : `${Math.round(b / 1024 ** 2)} Mo`);

export interface StorageAdvice { tone: 'ok' | 'info' | 'warn' | 'danger'; title: string; text: string }

/** Ce que les réglages affichent (et quoi faire), selon l'état et l'appli. */
export function storageAdvice(s: StorageStatus, desktop: boolean, diskOk = false): StorageAdvice[] {
  const out: StorageAdvice[] = [];
  if (desktop && diskOk) {
    out.push({ tone: 'ok', title: 'Tes projets sont aussi sauvegardés sur le disque',
      text: 'Chaque sauvegarde automatique est copiée dans Documents › Nova Studio › Projets (20 dernières versions + une par jour). Même si le stockage de l’appli est vidé, « Récupérer » les retrouve.' });
  } else if (desktop) {
    out.push({ tone: 'warn', title: 'Copie sur le disque en attente',
      text: 'Le pont de Nova Studio n’est pas encore connecté : les sauvegardes restent dans l’appli en attendant. Elles partiront sur le disque dès qu’il sera là.' });
  }
  if (s.persist === 'granted') {
    out.push({ tone: 'ok', title: 'Tes projets sont protégés contre l’effacement automatique du navigateur',
      text: 'Le navigateur ne videra pas tes sauvegardes de lui-même, même si le disque se remplit. Seul un « Effacer les données du site » fait à la main les supprime.' });
  } else if (s.persist === 'denied' || s.persist === 'unsupported') {
    out.push({ tone: desktop ? 'info' : 'warn', title: 'Le navigateur peut effacer tes sauvegardes',
      text: desktop
        ? 'Pas grave ici : la copie sur le disque reste.'
        : 'Ce navigateur n’a pas accepté de protéger le stockage de NOVA. S’il manque de place, il peut effacer les sauvegardes automatiques. Pour ne rien perdre : exporte ton projet en .zip (Sauvegarder › Fichier sur cet appareil (.zip)) à la fin de chaque séance, ou travaille dans Nova Studio pour Windows, qui sauvegarde aussi sur le disque.' });
  } else {
    out.push({ tone: 'info', title: 'Protection demandée au premier projet sauvegardé',
      text: 'Dès ta première sauvegarde, NOVA demande au navigateur de ne jamais effacer tes projets de lui-même.' });
  }
  if (s.level === 'full' || s.level === 'warn') {
    out.push({ tone: s.level === 'full' ? 'danger' : 'warn',
      title: s.level === 'full' ? 'Stockage plein : les prochaines sauvegardes vont échouer' : 'Stockage presque plein',
      text: `${fmt(s.usage)} utilisés sur ${fmt(s.quota)}. Exporte tes projets terminés en .zip (Sauvegarder › Fichier sur cet appareil (.zip)), puis libère de la place sur le disque de l’ordinateur : le navigateur donne à NOVA une part de l’espace libre.` });
  } else if (s.usage != null && s.quota) {
    out.push({ tone: 'ok', title: 'Place disponible', text: `${fmt(s.usage)} utilisés sur ${fmt(s.quota)} autorisés pour NOVA.` });
  }
  return out;
}

/** Message quand une sauvegarde échoue faute de place. */
export const QUOTA_FULL_MESSAGE =
  '⚠️ Plus de place pour sauvegarder sur cet appareil : ta dernière modification n’est PAS sauvegardée. '
  + 'Exporte le projet en .zip tout de suite (Sauvegarder › Fichier sur cet appareil (.zip)), puis libère de la place sur le disque de l’ordinateur.';

// --------------------------------------------------------------------------- effacement détecté

const MARK = 'nova_saves_here';

/**
 * Note qu'il y a des sauvegardes sur cet appareil : dans un cookie (que le navigateur
 * ne vide pas avec le stockage du site quand il manque de place) et dans localStorage.
 */
export function markLocalSaves(): void {
  try { document.cookie = `${MARK}=1; max-age=${400 * 86400}; path=/; SameSite=Lax`; } catch { /* */ }
  try { localStorage.setItem(MARK, '1'); } catch { /* */ }
}
export function clearLocalSavesMark(): void {
  try { document.cookie = `${MARK}=; max-age=0; path=/; SameSite=Lax`; } catch { /* */ }
  try { localStorage.removeItem(MARK); } catch { /* */ }
}
export function localSavesMarked(): boolean {
  try { if (new RegExp(`(?:^|; )${MARK}=1`).test(document.cookie)) return true; } catch { /* */ }
  try { return localStorage.getItem(MARK) === '1'; } catch { return false; }
}

/** Il y avait des sauvegardes ici, il n'y en a plus : le navigateur les a effacées. */
export const evictionSuspected = (hasVersions: boolean) => !hasVersions && localSavesMarked();

export const EVICTED_WEB_MESSAGE =
  'Les sauvegardes automatiques de cet appareil ont été effacées par le navigateur (manque de place ou nettoyage du site). '
  + 'Tes projets enregistrés dans ton compte ou exportés en .zip ne sont pas touchés. Pour que ça n’arrive plus : exporte tes projets en .zip, '
  + 'ou travaille dans Nova Studio pour Windows, qui sauvegarde aussi sur le disque.';

export const EVICTED_DESKTOP_MESSAGE =
  'Le stockage interne de Nova Studio a été vidé, mais ta session est retrouvée sur le disque (Documents › Nova Studio › Projets) : clique « Reprendre ma session ».';
