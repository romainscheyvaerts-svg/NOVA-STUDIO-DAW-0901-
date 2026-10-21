/**
 * Branchement de l'échange DAWproject dans l'appli (navigateur et appli Windows) :
 *  - ouvrir un .dawproject (ZIP), décoder ses sons, les enregistrer dans le registre
 *    et ajouter ses pistes au projet (une seule étape d'annulation) ;
 *  - fabriquer le .dawproject du projet (project.xml, metadata.xml, audio/*.wav, nova/).
 * La logique du format est dans les modules purs (xml, dawProjectRead, dawProjectToNova,
 * novaToDawProject).
 */
import JSZip from 'jszip';
import type { DAWState, Track } from '../../types';
import { audioBufferRegistry } from '../audioBufferRegistry';
import { resampleBuffer } from '../hqAudio';
import { projectRateOf } from '../projectRate';
import { applyImport } from '../sessionImport';
import { decodeAudioFile } from '../aaf/aafMedia';
import { registryAudio } from '../aaf/aafApp';
import { DawSession, readDawProject } from './dawProjectRead';
import { dawProjectToNova, DawImportReport, MediaAudio } from './dawProjectToNova';
import { buildDawProject, DawExportOptions, DawExportResult } from './novaToDawProject';

export const isDawProjectFile = (f: { name: string }) => /\.dawproject$/i.test(f.name);

export interface OpenedDawProject { session: DawSession; files: Map<string, Uint8Array>; fileName: string }

/** Lit le ZIP et project.xml (sans décoder les sons). */
export async function openDawProject(file: Blob & { name?: string }): Promise<OpenedDawProject> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new Error("Ce fichier n'est pas un projet DAWproject (archive ZIP illisible)."); }
  const files = new Map<string, Uint8Array>();
  const entries = Object.values(zip.files).filter(e => !e.dir);
  for (const e of entries) files.set(e.name.replace(/^\/+/, ''), await e.async('uint8array'));
  return { session: readDawProject(files), files, fileName: file.name || 'projet.dawproject' };
}

/** Chemins des sons utilisés par la séance. */
export const audioPaths = (s: DawSession): string[] => [...new Set([...s.tracks, ...(s.master ? [s.master] : [])].flatMap(t => t.clips.map(c => c.audio?.path).filter((p): p is string => !!p)))];

/** Décode un son du ZIP : WAV / AIFF par NOVA, le reste (FLAC, MP3, OGG) par le navigateur. */
async function decodeEntry(bytes: Uint8Array): Promise<MediaAudio | null> {
  const pcm = decodeAudioFile(bytes);
  if (pcm) return { channels: pcm.channels, sampleRate: pcm.sampleRate };
  try {
    const Ctx = (globalThis as any).OfflineAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx(2, 1, 48000);
    const buf: AudioBuffer = await ctx.decodeAudioData(bytes.slice().buffer);
    return { channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), sampleRate: buf.sampleRate };
  } catch { return null; }
}

const findEntry = (files: Map<string, Uint8Array>, path: string): Uint8Array | null => {
  const clean = path.replace(/^\.?\/+/, '').replace(/\\/g, '/');
  if (files.has(clean)) return files.get(clean)!;
  const low = clean.toLowerCase();
  for (const [k, v] of files) if (k.toLowerCase() === low) return v;
  // Son « externe » (chemin absolu du disque de l'autre logiciel) : par son nom seul.
  const name = low.split('/').pop();
  for (const [k, v] of files) if (k.toLowerCase().split('/').pop() === name) return v;
  return null;
};

export interface DawImportOptions {
  /** Reprendre tempo, mesure, repères et réglages du master du fichier. */
  takeProjectSettings: boolean;
}

export interface DawImportOutcome { state: DAWState; report: DawImportReport; trackIds: string[] }

export async function importDawProjectIntoProject(o: OpenedDawProject, target: DAWState, opts: DawImportOptions, onProgress?: (t: string) => void): Promise<DawImportOutcome> {
  const projectRate = projectRateOf(target);
  const stamp = Date.now().toString(36);
  const decoded = new Map<string, MediaAudio | null>();
  const paths = [...audioPaths(o.session), ...(o.session.sidecar?.samples || []).map(s => `nova/samples/${s}.wav`)];
  let k = 0;
  for (const p of paths) {
    onProgress?.(`Lecture des sons… ${++k} / ${paths.length}`);
    const bytes = findEntry(o.files, p);
    decoded.set(p, bytes ? await decodeEntry(bytes) : null);
  }
  const conv = dawProjectToNova(o.session, p => decoded.get(p) || null, { idPrefix: `daw${stamp}` });
  const all = [...conv.buffers, ...conv.samples];
  let i = 0;
  for (const b of all) {
    onProgress?.(`Préparation des sons… ${++i} / ${all.length}`);
    let buf = new AudioBuffer({ length: Math.max(1, b.channels[0].length), numberOfChannels: b.channels.length, sampleRate: b.sampleRate });
    b.channels.forEach((ch, c) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, c));
    if (b.sampleRate !== projectRate) buf = await resampleBuffer(buf, projectRate);
    audioBufferRegistry.register(buf, b.id);
  }
  return { ...mergeDawImport(target, conv, opts, stamp), report: conv.report };
}

/** Pistes converties posées dans le projet (pur : testé). */
export function mergeDawImport(target: DAWState, conv: ReturnType<typeof dawProjectToNova>, opts: DawImportOptions, stamp: string): { state: DAWState; trackIds: string[] } {
  let n = 0;
  const r = applyImport(target, { tracks: conv.tracks, bpm: target.bpm },
    conv.tracks.map(t => ({ sourceId: t.id, parts: ['clips', 'plugins', 'sends', 'automation', 'color'] })),
    { sameName: 'add', matchTempo: false }, base => `${base}-${stamp}${(n++).toString(36)}`);
  // applyImport ne reprend ni le mute ni les dossiers : posés ici (même ordre que les pistes).
  const idOf = new Map(conv.tracks.map((t, i) => [t.id, r.trackIds[i]]));
  const tracks: Track[] = r.state.tracks.map(t => {
    const i = r.trackIds.indexOf(t.id);
    if (i < 0) return t;
    const src = conv.tracks[i];
    const out: Track = { ...t };
    if (src.isMuted) out.isMuted = true;
    if (src.folder) out.folder = { ...src.folder };
    if (src.parentFolderId && idOf.get(src.parentFolderId)) out.parentFolderId = idOf.get(src.parentFolderId);
    return out;
  });
  let state: DAWState = { ...r.state, tracks };
  if (opts.takeProjectSettings) {
    state = { ...state, bpm: conv.bpm, timeSignature: { ...conv.timeSignature }, tempoEvents: conv.tempoEvents.length ? conv.tempoEvents : undefined,
      markers: [...(state.markers || []), ...conv.markers] };
    if (conv.master) {
      state.tracks = state.tracks.map(t => (t.id === 'master' ? { ...t, volume: conv.master!.volume, pan: conv.master!.pan, plugins: conv.master!.plugins, automationLanes: conv.master!.automationLanes } : t));
    }
  }
  return { state, trackIds: r.trackIds };
}

// ── Export ───────────────────────────────────────────────────────────────────────────────
const safeName = (s: string) => (s || 'Projet').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Projet';

export function planDawProject(state: DAWState, opts: DawExportOptions): DawExportResult {
  return buildDawProject({ ...state, sampleRate: projectRateOf(state) }, registryAudio, opts);
}

export interface DawProjectZip { blob: Blob; fileName: string; result: DawExportResult }

/** .dawproject : project.xml, metadata.xml, audio/*.wav, nova/nova.json. */
export async function buildDawProjectZip(state: DAWState, opts: DawExportOptions): Promise<DawProjectZip> {
  const result = planDawProject(state, opts);
  const zip = new JSZip();
  zip.file('project.xml', result.projectXml);
  zip.file('metadata.xml', result.metadataXml);
  for (const f of result.files) zip.file(f.path, f.bytes, /\.wav$/i.test(f.path) ? { compression: 'STORE' } : {});
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' });
  return { blob, fileName: `${safeName(state.name)}.dawproject`, result };
}
