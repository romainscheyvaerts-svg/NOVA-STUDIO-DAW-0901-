import JSZip from 'jszip';
import { catalogSupabase } from './supabase';
import { ProjectIO } from './ProjectIO';
import { DAWState } from '../types';

/**
 * Session « à emporter » : enregistrée au studio, continuée chez soi (iPad,
 * ordinateur, navigateur), rouverte au studio.
 *
 * Stockage : Supabase du site Make Music (fonction daw-session). Le projet
 * (.novaproj : JSON + WAV) est découpé : le JSON va dans le manifeste, chaque
 * fichier audio en morceaux de 40 Mo nommés par leur SHA-1. Une
 * synchronisation n'envoie donc que l'audio nouveau (les prises déjà en ligne
 * ne repartent pas). Accès : la clé du lien, ou le compte Make Music du
 * propriétaire. Écriture optimiste : conflit si un autre appareil a
 * synchronisé entre-temps.
 */

const CHUNK = 40 * 1024 * 1024;
const SITE_DAW_URL = 'https://www.studiomakemusic.com/daw';

export interface CloudLink { id: string; secret?: string }

export interface CloudSessionInfo {
  id: string;
  link: string | null;
  name: string;
  version: number;
  updated_at: string;
  updated_from: string | null;
  owned?: boolean;
  has_owner?: boolean;
  total_bytes?: number;
}

export class CloudConflictError extends Error {
  constructor(public version: number, public updatedAt: string, public updatedFrom: string | null) {
    super('La session a été modifiée sur un autre appareil');
  }
}

export const parseLink = (s: string | null | undefined): CloudLink | null => {
  const m = /^([a-z0-9]{12})(?:\.([A-Za-z0-9]{24,64}))?$/.exec((s || '').trim());
  return m ? { id: m[1], secret: m[2] } : null;
};
export const linkToString = (l: CloudLink): string => (l.secret ? `${l.id}.${l.secret}` : l.id);
/** Lien à donner au client : le site Make Music ouvre le studio avec la session. */
export const sessionUrl = (l: CloudLink): string => `${SITE_DAW_URL}?session=${encodeURIComponent(linkToString(l))}`;

/** « iPad », « Windows (Nova Studio) »… : affiché dans « modifiée sur … ». */
export const deviceLabel = (): string => {
  const ua = navigator.userAgent;
  const desktop = (window as any).__novaDesktop ? ' (Nova Studio)' : '';
  if (/iPad|Macintosh/.test(ua) && 'ontouchend' in document) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return `PC Windows${desktop}`;
  if (/Mac OS X/.test(ua)) return 'Mac';
  return 'Navigateur';
};

async function call<T = any>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await catalogSupabase.functions.invoke('daw-session', { body: { action, ...body } });
  if (error) {
    let payload: any = null;
    try { payload = await (error as any).context?.json?.(); } catch { /* corps illisible */ }
    const status = (error as any).context?.status;
    if (status === 409 && payload) throw new CloudConflictError(payload.version, payload.updated_at, payload.updated_from);
    throw new Error(payload?.error || error.message || 'Erreur réseau');
  }
  return data as T;
}

const sha1 = async (bytes: Uint8Array): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
};

type Manifest = { format: 1; project: any; files: Record<string, { parts: string[]; size: number }> };

export interface PushResult { link: CloudLink; version: number; uploadedBytes: number }

/**
 * Envoie la session. Sans lien : en crée une (rattachée au compte connecté
 * s'il y en a un). Lève CloudConflictError si un autre appareil a synchronisé
 * depuis baseVersion (sauf force).
 */
export async function pushSession(
  state: DAWState,
  ownedInstrumentIds: (string | number)[],
  link: CloudLink | null,
  baseVersion: number,
  onProgress?: (pct: number, msg: string) => void,
  opts: { force?: boolean; name?: string } = {},
): Promise<PushResult> {
  onProgress?.(3, 'Préparation de la session…');
  const blob = await ProjectIO.saveProject(state, ownedInstrumentIds);
  const zip = await JSZip.loadAsync(blob);
  const projectText = await zip.file('project.json')!.async('string');
  const manifest: Manifest = { format: 1, project: JSON.parse(projectText), files: {} };
  const chunks = new Map<string, Uint8Array>();
  const entries = Object.values(zip.files).filter(f => !f.dir && f.name !== 'project.json');
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i];
    const bytes = await f.async('uint8array');
    const parts: string[] = [];
    for (let off = 0; off < bytes.length || (off === 0 && bytes.length === 0); off += CHUNK) {
      const part = bytes.subarray(off, Math.min(bytes.length, off + CHUNK));
      const h = await sha1(part);
      parts.push(h);
      chunks.set(h, part);
      if (bytes.length === 0) break;
    }
    manifest.files[f.name] = { parts, size: bytes.length };
    onProgress?.(5 + Math.round(15 * (i + 1) / Math.max(1, entries.length)), 'Préparation de l\'audio…');
  }

  const name = opts.name || state.name || 'Session';
  let l = link;
  if (!l?.id) {
    const c = await call<{ id: string; secret: string; version: number }>('create', { name, device: deviceLabel() });
    l = { id: c.id, secret: c.secret };
    baseVersion = 0;
  }

  // Envoi des morceaux qui manquent en ligne (par paquets de 150).
  const all = Array.from(chunks.keys());
  const missing: { hash: string; path: string; token: string }[] = [];
  for (let i = 0; i < all.length; i += 150) {
    const r = await call<{ uploads: Record<string, { path: string; token: string }> }>('sign_upload', { id: l.id, secret: l.secret, parts: all.slice(i, i + 150) });
    for (const [hash, u] of Object.entries(r.uploads || {})) missing.push({ hash, ...u });
  }
  const totalBytes = missing.reduce((s, m) => s + chunks.get(m.hash)!.length, 0);
  let sent = 0;
  for (const m of missing) {
    const data = chunks.get(m.hash)!;
    const { error } = await catalogSupabase.storage.from('daw-sessions')
      .uploadToSignedUrl(m.path.replace(/^daw-sessions\//, ''), m.token, new Blob([data], { type: 'application/octet-stream' }));
    if (error) throw new Error(`Envoi de l'audio impossible : ${error.message}`);
    sent += data.length;
    onProgress?.(20 + Math.round(75 * sent / Math.max(1, totalBytes)), `Envoi de l'audio… ${Math.round(sent / 1048576)} / ${Math.max(1, Math.round(totalBytes / 1048576))} Mo`);
  }

  onProgress?.(97, 'Enregistrement…');
  const r = await call<{ version: number }>('commit', {
    id: l.id, secret: l.secret, baseVersion, manifest, name, device: deviceLabel(), force: !!opts.force,
  });
  onProgress?.(100, 'Session en ligne');
  return { link: l, version: r.version, uploadedBytes: totalBytes };
}

/** Télécharge la session et la reconstruit en projet. */
export async function pullSession(link: CloudLink, onProgress?: (pct: number, msg: string) => void): Promise<{ state: DAWState; info: CloudSessionInfo }> {
  onProgress?.(3, 'Ouverture de la session…');
  const r = await call<CloudSessionInfo & { manifest: Manifest; urls: Record<string, string> }>('get', { id: link.id, secret: link.secret });
  if (!r.manifest?.project) throw new Error('Cette session est encore vide (rien n\'a été envoyé).');
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(r.manifest.project));
  const files = Object.entries(r.manifest.files || {});
  const total = files.reduce((s, [, f]) => s + (f.size || 0), 0);
  let got = 0;
  for (const [name, f] of files) {
    const buf = new Uint8Array(f.size);
    let off = 0;
    for (const p of f.parts) {
      const url = r.urls[p];
      if (!url) throw new Error('Un fichier audio de la session est introuvable.');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Téléchargement impossible (${res.status})`);
      const b = new Uint8Array(await res.arrayBuffer());
      buf.set(b.subarray(0, Math.max(0, f.size - off)), off);
      off += b.length;
      got += b.length;
      onProgress?.(5 + Math.round(85 * got / Math.max(1, total)), `Téléchargement de l'audio… ${Math.round(got / 1048576)} / ${Math.max(1, Math.round(total / 1048576))} Mo`);
    }
    zip.file(name, buf);
  }
  onProgress?.(93, 'Reconstruction du projet…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const state = await ProjectIO.loadProject(new File([blob], 'session.novaproj.zip'));
  onProgress?.(100, 'Session ouverte');
  const { manifest: _m, urls: _u, ...info } = r;
  return { state, info };
}

export const sessionInfo = (link: CloudLink) => call<CloudSessionInfo>('info', { id: link.id, secret: link.secret });
export const listMySessions = () => call<{ sessions: CloudSessionInfo[] }>('list_mine').then(r => r.sessions);
export const claimSession = (link: CloudLink) => call<{ ok: boolean; link: string | null }>('claim', { id: link.id, secret: link.secret });
export const assignSession = (link: CloudLink, email: string) => call<{ ok: boolean }>('assign', { id: link.id, secret: link.secret, email });

// --- Compte Make Music dans le studio ---------------------------------------------

export async function currentAccount(): Promise<{ email: string; isAdmin: boolean } | null> {
  const { data } = await catalogSupabase.auth.getUser();
  const u = data?.user;
  if (!u) return null;
  let isAdmin = false;
  try {
    const { data: ok } = await catalogSupabase.rpc('mm_is_admin');
    isAdmin = !!ok;
  } catch { /* pas admin */ }
  return { email: u.email || '', isAdmin };
}

export async function signInAccount(email: string, password: string): Promise<void> {
  const { error } = await catalogSupabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'E-mail ou mot de passe incorrect' : error.message);
}

export const signOutAccount = () => catalogSupabase.auth.signOut();

/** Le site (page /daw) transmet la connexion du client au studio intégré. */
export async function adoptSiteSession(accessToken: string, refreshToken: string): Promise<void> {
  const { data } = await catalogSupabase.auth.getSession();
  if (data?.session?.access_token === accessToken) return;
  await catalogSupabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
}

// --- Session liée à cet appareil ---------------------------------------------------

const LS_KEY = 'nova_cloud_session';
export interface LocalCloudSession { id: string; secret?: string; version: number; name: string; syncedAt: number }

export const getLocalCloudSession = (): LocalCloudSession | null => {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return v && parseLink(v.id) ? v : null; } catch { return null; }
};
export const setLocalCloudSession = (s: LocalCloudSession | null) => {
  try { if (s) localStorage.setItem(LS_KEY, JSON.stringify(s)); else localStorage.removeItem(LS_KEY); } catch { /* stockage indisponible */ }
};

/** Crée une session vide (rattachée au compte connecté s'il y en a un). */
export const createCloudSession = (name: string) =>
  call<{ id: string; secret: string; version: number; owned?: boolean }>('create', { name, device: deviceLabel() });

/** Identifiant du projet lié à une session en ligne (garde-fou : jamais un autre projet). */
export const cloudProjectId = (sessionId: string) => `cloud-${sessionId}`;
