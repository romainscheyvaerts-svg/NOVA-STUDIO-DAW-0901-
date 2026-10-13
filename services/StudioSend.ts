import { catalogSupabase } from './supabase';
import { ProjectIO } from './ProjectIO';
import { runExport, renderRate, type ExportSettings } from './ExportPipeline';
import { prepareTracksForOffline } from './VstFreeze';
import type { DAWState } from '../types';
import { STUDIO_BUCKET } from '../supabase/functions/studio-inbox/rules.ts';
import { buildStudioNotes, studioNotesText, type BookingInput, type FileKind } from '../utils/studioPackage';

/**
 * « Envoyer au studio » (chantier 17 · B6) : construit le paquet (projet, stems,
 * notes) et le dépose au studio Make Music par la fonction studio-inbox
 * (supabase/functions/studio-inbox) : adresses d'envoi signées, envoi direct au
 * stockage privé, puis demande de réservation créée quand TOUT est arrivé.
 * Reprise : un envoi coupé repart du même paquet, seuls les fichiers manquants
 * repartent.
 */

export class StudioSendError extends Error {
  constructor(message: string, public code?: string, public status?: number, public extra?: Record<string, any>) { super(message); }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  let res: { data: any; error: any };
  try {
    res = await catalogSupabase.functions.invoke('studio-inbox', { body });
  } catch (e: any) {
    throw new StudioSendError(e?.message || 'Pas de connexion au serveur du studio', 'network');
  }
  const { data, error } = res;
  if (error) {
    let payload: any = null;
    try { payload = await (error as any).context?.json?.(); } catch { /* corps illisible */ }
    const status = (error as any).context?.status;
    if (status === 404 && !payload?.error) throw new StudioSendError("L'envoi au studio n'est pas encore activé sur le serveur : il arrive avec la prochaine mise en ligne.", 'not_deployed', 404);
    const net = typeof status !== 'number';
    throw new StudioSendError(payload?.error || (net ? 'Pas de connexion au serveur du studio : vérifie ton réseau, puis réessaie.' : error.message) || 'Erreur', payload?.code || (net ? 'network' : undefined), status, payload || undefined);
  }
  return data as T;
}

export interface StudioFile { kind: FileKind; name: string; blob: Blob }
export type StudioProgress = (pct: number, text: string) => void;

/** Fin du morceau (s) : dernier clip, guides exclus. */
const songEnd = (s: DAWState) => Math.max(0.05, ...s.tracks.filter(t => !t.isGuide).flatMap(t => t.clips.map(c => c.start + c.duration)));

/** Prépare les fichiers : projet complet (.zip), stems FLAC 24 bits (une piste par stem), notes (JSON + texte). */
export async function buildStudioFiles(state: DAWState, o: { stems: boolean; notes: boolean; owned: (string | number)[]; booking: BookingInput | null }, onP: StudioProgress): Promise<StudioFile[]> {
  const base = (state.name || 'Projet').trim() || 'Projet';
  const files: StudioFile[] = [];
  onP(2, 'Préparation du projet…');
  files.push({ kind: 'projet', name: `${base}.novaproj.zip`, blob: await ProjectIO.saveProject(state, o.owned) });
  if (o.notes) {
    const n = buildStudioNotes(state as any);
    files.push({ kind: 'notes', name: 'Notes.txt', blob: new Blob([studioNotesText(n, o.booking)], { type: 'text/plain;charset=utf-8' }) });
    files.push({ kind: 'notes', name: 'notes.json', blob: new Blob([JSON.stringify({ ...n, booking: o.booking }, null, 1)], { type: 'application/json' }) });
  }
  if (o.stems) {
    onP(8, 'Rendu des stems…');
    const settings: ExportSettings = {
      source: 'STEMS', stems: { grouping: 'tracks', returns: 'in-stems', withMasterFx: false },
      start: 0, end: songEnd(state), tail: { mode: 'auto', seconds: 2 },
      format: 'FLAC', bits: 24, mp3Kbps: 320, sampleRate: renderRate(), layout: 'stereo', dither: false, normalize: 'off',
      meta: { title: base, bpm: state.bpm, timeSignature: state.timeSignature },
      naming: { title: base, bpm: state.bpm, key: '' }, baseName: base.replace(/[\\/:*?"<>|]+/g, '_'),
    };
    const prep = await prepareTracksForOffline(state.tracks, msg => onP(8, msg));
    try {
      const r = await runExport(prep.tracks, settings, (state.markers || []).map(m => ({ name: m.name, time: m.time })), (pct, text) => onP(8 + Math.round(pct * 0.32), text));
      for (const f of r.files) files.push({ kind: 'stem', name: f.name, blob: f.blob });
    } finally { prep.cleanup(); }
  }
  onP(40, 'Paquet prêt');
  return files;
}

interface Upload { name: string; kind: string; path: string; token: string }

async function putFile(u: Upload, blob: Blob) {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { error } = await catalogSupabase.storage.from(STUDIO_BUCKET).uploadToSignedUrl(u.path, u.token, blob, { contentType: blob.type || 'application/octet-stream', upsert: true } as any);
      if (!error) return;
      last = error;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new StudioSendError(`« ${u.name} » n'est pas parti (${(last as any)?.message || 'réseau'}).`, 'upload');
}

export interface StudioSendState {
  packageId: string | null;
  /** Noms (côté serveur) déjà déposés. */
  done: Set<string>;
  /** Nom local → nom côté serveur (rendu sûr par le serveur). */
  names: Map<string, string>;
}
export const newSendState = (): StudioSendState => ({ packageId: null, done: new Set(), names: new Map() });

export interface StudioBooking { id: string; reference: string; status: string; service: string; date: string; slot: string; hours: number; name: string }

/**
 * Dépose le paquet et crée la demande de réservation. `st` garde la progression :
 * rappeler avec le même `st` après une coupure reprend l'envoi (fichiers déjà arrivés gardés).
 */
export async function sendStudioPackage(files: StudioFile[], meta: { title: string; bpm: number; key?: string | null; notesCount: number }, booking: BookingInput, st: StudioSendState, onP: StudioProgress): Promise<{ packageId: string; booking: StudioBooking; already?: boolean }> {
  const total = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  let uploads: Upload[];
  if (!st.packageId) {
    onP(42, 'Ouverture du dépôt au studio…');
    const r = await invoke<{ package_id: string; uploads: Upload[] }>({
      action: 'package_init', title: meta.title, bpm: meta.bpm, key: meta.key || undefined, notes_count: meta.notesCount,
      files: files.map(f => ({ kind: f.kind, name: f.name, size: f.blob.size })),
    });
    st.packageId = r.package_id;
    uploads = r.uploads;
    // Le serveur rend les noms sûrs, dans l'ordre annoncé.
    files.forEach((f, i) => { if (uploads[i]) st.names.set(f.name, uploads[i].name); });
  } else {
    const todo = files.map(f => st.names.get(f.name) || f.name).filter(n => !st.done.has(n));
    uploads = todo.length ? (await invoke<{ uploads: Upload[] }>({ action: 'package_resign', package_id: st.packageId, names: todo })).uploads : [];
  }
  const blobOf = (serverName: string) => files.find(f => (st.names.get(f.name) || f.name) === serverName);
  const sentBytes = () => files.filter(f => st.done.has(st.names.get(f.name) || f.name)).reduce((n, f) => n + f.blob.size, 0);
  const sendAll = async (list: Upload[]) => {
    for (const u of list) {
      const f = blobOf(u.name);
      if (!f || st.done.has(u.name)) continue;
      onP(45 + Math.round((sentBytes() / total) * 50), `Envoi de « ${f.name} »…`);
      await putFile(u, f.blob);
      st.done.add(u.name);
    }
  };
  await sendAll(uploads);
  onP(96, 'Le studio vérifie les fichiers…');
  for (let round = 0; ; round++) {
    try {
      return await invoke({ action: 'package_submit', package_id: st.packageId, booking });
    } catch (e) {
      const err = e as StudioSendError;
      if (err.code !== 'missing' || round >= 1) throw err;
      const missing: string[] = err.extra?.missing || [];
      missing.forEach(n => st.done.delete(n));
      const again = await invoke<{ uploads: Upload[] }>({ action: 'package_resign', package_id: st.packageId, names: missing });
      await sendAll(again.uploads);
    }
  }
}
