/**
 * Mise à jour du PROGRAMME « Nova Studio pour Windows » (exe, ponts, hôtes VST / ARA), côté page.
 *
 * Deux cas :
 *  - appli 1.5.3 et plus (`__novaDesktop.features` contient 'app-update') : tout est natif
 *    (desktop/app_update.py : téléchargement vérifié, installation à la fermeture). La page
 *    reçoit l'état par des messages { type: 'nova-desktop-update', … } et envoie les choix de
 *    l'utilisateur (« nova-desktop:update:apply » / « later » / « check » / « auto:on|off » / « seen »).
 *  - appli plus ancienne (1.5.2 et avant) : pas de code natif, mais son INTERFACE se met à jour
 *    toute seule depuis le site. La page lit donc elle-même le manifeste publié par build.py
 *    (/downloads/nova-studio-latest.json, jamais embarqué dans l'appli : il vient du site) et
 *    propose de télécharger l'installateur quand la version de l'appli est plus ancienne.
 *
 * Sur le site (navigateur), rien de tout ça : `isNovaDesktop()` est faux.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { DESKTOP_APP_DOWNLOAD_URL, getNovaDesktop } from './desktopApp';

export const LATEST_MANIFEST_URL = '/downloads/nova-studio-latest.json';

// ---------------------------------------------------------------------------
// Versions et manifeste (fonctions pures, testées dans tests/appUpdate.test.ts)
// ---------------------------------------------------------------------------

/** « 1.5.3 » -> [1, 5, 3, 0] ; null si ce n'est pas une version simple. */
export function parseVersion(v: unknown): number[] | null {
  if (typeof v !== 'string' || !/^\d{1,4}(\.\d{1,6}){0,3}$/.test(v.trim())) return null;
  const p = v.trim().split('.').map(Number);
  while (p.length < 4) p.push(0);
  return p;
}

/** a > b ? (comparaison numérique : 1.5.10 > 1.5.9). Versions illisibles : false. */
export function isNewerVersion(a: unknown, b: unknown): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export interface LatestManifest {
  version: string;
  /** Chemin de l'installateur sur le site (« downloads/NovaStudioSetup-1.5.3.exe »). */
  url: string;
  sha256: string;
  size: number;
  date: string;
  notes: string[];
  minVersion?: string;
}

/** Manifeste vérifié (même règles que l'appli : installateur sous /downloads/ du site). */
export function parseLatestManifest(raw: unknown): LatestManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (!parseVersion(m.version)) return null;
  const url = typeof m.url === 'string' ? m.url.replace(/^\//, '') : '';
  if (!/^downloads\/NovaStudioSetup(-[0-9.]+)?\.exe$/.test(url)) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return null;
  if (typeof m.size !== 'number' || !(m.size > 100_000)) return null;
  const notes = Array.isArray(m.notes) ? m.notes.filter((n): n is string => typeof n === 'string' && !!n.trim()).map(n => n.trim()).slice(0, 6) : [];
  return {
    version: String(m.version).trim(), url, sha256: m.sha256.toLowerCase(), size: m.size,
    date: typeof m.date === 'string' ? m.date : '', notes,
    minVersion: parseVersion(m.minVersion) ? String(m.minVersion) : undefined,
  };
}

/** Appli Windows qui gère elle-même ses mises à jour (1.5.3 et plus). */
export function desktopHasNativeUpdate(info = getNovaDesktop()): boolean {
  const f = (info as { features?: unknown } | null)?.features;
  return Array.isArray(f) && f.includes('app-update');
}

/**
 * Carte « Une nouvelle version de Nova Studio est disponible » (appli ancienne seulement) :
 * dans l'appli Windows, sans mise à jour native, version de l'appli plus ancienne que le
 * manifeste, et pas déjà écartée (« Plus tard ») pour cette version.
 */
export function shouldShowLegacyCard(info: { version?: string; features?: unknown } | null, manifest: LatestManifest | null, dismissedVersion?: string | null): boolean {
  if (!info || !manifest || typeof info.version !== 'string') return false;
  if (desktopHasNativeUpdate(info as never)) return false;
  if (!isNewerVersion(manifest.version, info.version)) return false;
  return dismissedVersion !== manifest.version;
}

/** Taille lisible (« 51 Mo »). */
export const formatSize = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} Mo`;

// ---------------------------------------------------------------------------
// État envoyé par l'appli (mise à jour native)
// ---------------------------------------------------------------------------

export type NativePhase = 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error' | 'installing';
export type BusyReason = 'recording' | 'playing' | 'collab' | 'unknown' | 'failed';

export interface NativeUpdateState {
  installed: string;
  auto: boolean;
  phase: NativePhase;
  progress: number;
  available: { version: string; notes: string[]; size: number; date: string } | null;
  error: string;
  busy: BusyReason | null;
  busyText: string;
  dismissed: boolean;
  justUpdated: { version: string; notes: string[] } | null;
  lastCheck: number;
}

/** Message { type: 'nova-desktop-update', … } venu de l'appli (chaîne JSON ou objet), sinon null. */
export function parseNativeUpdateMessage(data: unknown): NativeUpdateState | null {
  let v: unknown = data;
  if (typeof v === 'string') {
    if (!v.startsWith('{') || v.length > 65536) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || (v as any).type !== 'nova-desktop-update') return null;
  const m = v as any;
  const avail = m.available && typeof m.available === 'object' && parseVersion(m.available.version)
    ? { version: String(m.available.version), notes: Array.isArray(m.available.notes) ? m.available.notes.filter((n: unknown) => typeof n === 'string').slice(0, 6) : [], size: Number(m.available.size) || 0, date: String(m.available.date || '') }
    : null;
  const just = m.justUpdated && typeof m.justUpdated === 'object' && parseVersion(m.justUpdated.version)
    ? { version: String(m.justUpdated.version), notes: Array.isArray(m.justUpdated.notes) ? m.justUpdated.notes.filter((n: unknown) => typeof n === 'string').slice(0, 6) : [] }
    : null;
  const busy = ['recording', 'playing', 'collab', 'unknown', 'failed'].includes(m.busy) ? m.busy as BusyReason : null;
  return {
    installed: typeof m.installed === 'string' ? m.installed : '',
    auto: m.auto !== false,
    phase: (['off', 'idle', 'checking', 'downloading', 'ready', 'uptodate', 'error', 'installing'].includes(m.phase) ? m.phase : 'idle') as NativePhase,
    progress: Math.max(0, Math.min(1, Number(m.progress) || 0)),
    available: avail,
    error: typeof m.error === 'string' ? m.error.slice(0, 300) : '',
    busy,
    busyText: typeof m.busyText === 'string' ? m.busyText.slice(0, 300) : '',
    dismissed: !!m.dismissed,
    justUpdated: just,
    lastCheck: Number(m.lastCheck) || 0,
  };
}

type Listener = () => void;
let nativeState: NativeUpdateState | null = null;
const listeners = new Set<Listener>();
let wired = false;

function webview(): { postMessage: (m: string) => void; addEventListener: (t: string, h: (e: any) => void) => void } | null {
  if (typeof window === 'undefined') return null;
  const wv = (window as any).chrome?.webview;
  return wv && typeof wv.postMessage === 'function' && typeof wv.addEventListener === 'function' ? wv : null;
}

/** Envoie un choix de l'utilisateur à l'appli (« apply », « later », « check », « auto:on »…). */
export function sendUpdateCommand(cmd: 'hello' | 'apply' | 'later' | 'check' | 'seen' | 'auto:on' | 'auto:off'): boolean {
  const wv = webview();
  if (!wv || !desktopHasNativeUpdate()) return false;
  try { wv.postMessage(`nova-desktop:update:${cmd}`); return true; } catch { return false; }
}

/** Branche l'écoute des messages de l'appli (une fois) et demande l'état (« hello »). */
export function connectNativeUpdate(): void {
  if (wired || !desktopHasNativeUpdate()) return;
  const wv = webview();
  if (!wv) return;
  wired = true;
  wv.addEventListener('message', (e: any) => {
    const st = parseNativeUpdateMessage(e?.data);
    if (!st) return;
    nativeState = st;
    listeners.forEach(l => l());
  });
  sendUpdateCommand('hello');
}

export const nativeUpdateStore = {
  get: () => nativeState,
  subscribe: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Tests. */
  _reset: () => { nativeState = null; wired = false; listeners.clear(); },
  _set: (s: NativeUpdateState | null) => { nativeState = s; listeners.forEach(l => l()); },
};

export function useNativeUpdate(): NativeUpdateState | null {
  useEffect(() => { connectNativeUpdate(); }, []);
  return useSyncExternalStore(nativeUpdateStore.subscribe, nativeUpdateStore.get, nativeUpdateStore.get);
}

/** « Rechercher maintenant » (palette, chat, réglages) : natif, sinon relecture du manifeste. */
export function requestDesktopUpdateCheck(): void {
  if (!getNovaDesktop()) return; // site : toujours à jour, rien à lire
  if (sendUpdateCommand('check')) return;
  void refreshLegacyManifest(true);
}

// ---------------------------------------------------------------------------
// Appli ancienne : lecture du manifeste par la page
// ---------------------------------------------------------------------------

export type LegacyStatus = 'idle' | 'checking' | 'ok' | 'error';
let legacy: { status: LegacyStatus; manifest: LatestManifest | null; checkedAt: number } = { status: 'idle', manifest: null, checkedAt: 0 };
const legacyListeners = new Set<Listener>();
const setLegacy = (v: typeof legacy) => { legacy = v; legacyListeners.forEach(l => l()); };

export async function refreshLegacyManifest(force = false, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<LatestManifest | null> {
  if (!force && legacy.checkedAt && Date.now() - legacy.checkedAt < 6 * 3600_000) return legacy.manifest;
  if (legacy.status === 'checking') return legacy.manifest;
  setLegacy({ ...legacy, status: 'checking' });
  try {
    const r = await fetcher(`${LATEST_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    const m = r.ok ? parseLatestManifest(await r.json().catch(() => null)) : null;
    setLegacy({ status: m ? 'ok' : 'error', manifest: m, checkedAt: Date.now() });
    return m;
  } catch {
    setLegacy({ status: 'error', manifest: legacy.manifest, checkedAt: Date.now() });
    return legacy.manifest;
  }
}

export const legacyManifestStore = {
  get: () => legacy,
  subscribe: (l: Listener) => { legacyListeners.add(l); return () => { legacyListeners.delete(l); }; },
  _reset: () => { legacy = { status: 'idle', manifest: null, checkedAt: 0 }; legacyListeners.clear(); },
};

export function useLegacyManifest(enabled: boolean) {
  useEffect(() => { if (enabled) void refreshLegacyManifest(); }, [enabled]);
  return useSyncExternalStore(legacyManifestStore.subscribe, legacyManifestStore.get, legacyManifestStore.get);
}

const DISMISS_KEY = 'nova_app_update_later';
export function dismissedLegacyVersion(): string | null {
  try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}
export function dismissLegacyVersion(v: string): void {
  try { localStorage.setItem(DISMISS_KEY, v); } catch { /* */ }
}

/** Lien de l'installateur : le nom fixe du site (toujours la dernière version). */
export const LEGACY_DOWNLOAD_URL = DESKTOP_APP_DOWNLOAD_URL;

// ---------------------------------------------------------------------------
// « Pas pendant un enregistrement » : état lu par l'appli avant de redémarrer
// ---------------------------------------------------------------------------

export interface BusyState { recording: boolean; playing: boolean; collab: boolean }

/**
 * Expose window.__novaBusy() (lu par desktop/app_update.py BUSY_PROBE_JS) : l'appli ne
 * redémarre jamais pour une mise à jour pendant un enregistrement, une lecture ou une
 * collaboration.
 */
export function useDesktopBusyProbe(get: () => BusyState): void {
  useEffect(() => {
    const w = window as any;
    const f = () => { try { const b = get(); return { recording: !!b.recording, playing: !!b.playing, collab: !!b.collab }; } catch { return { recording: false, playing: false, collab: false }; } };
    w.__novaBusy = f;
    return () => { if (w.__novaBusy === f) delete w.__novaBusy; };
  // `get` lit des refs : il n'a pas besoin d'être à jour à chaque rendu.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Texte du refus côté page (même sens que l'appli). */
export const BUSY_TEXT: Record<BusyReason, string> = {
  recording: 'Un enregistrement est en cours : arrête-le, puis relance la mise à jour.',
  playing: 'La lecture est en cours : mets-la en pause, puis relance la mise à jour.',
  collab: 'Une séance de collaboration est ouverte : quitte-la, puis relance la mise à jour.',
  unknown: 'Nova Studio ne répond pas pour l’instant : réessaie dans un moment.',
  failed: 'L’installation n’a pas abouti aujourd’hui : ta version actuelle reste utilisable. Nouvel essai demain (ou télécharge l’installateur sur le site).',
};
