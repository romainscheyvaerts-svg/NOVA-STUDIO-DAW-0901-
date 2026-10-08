/**
 * Melodyne et VocAlign en INSERT sur une piste, comme dans Pro Tools (pont v12) : la logique
 * côté DAW, sans audio (testée par tests/araInsert.test.ts).
 *
 * Dans Pro Tools, un plugin ARA posé en insert reçoit TOUS les clips de la piste : son
 * éditeur s'ancre en bas de la fenêtre Édition et ses retouches s'entendent en direct,
 * sans rendu. Ici, l'insert est un effet VST3 de la piste (`params.ara`) ; à chaque édition
 * de NOVA (déplacer, couper, rogner, supprimer, dupliquer, Shuffle, groupes…), le document
 * ARA de la piste est recalculé (araDocumentFor) et envoyé au pont, qui ne transmet au
 * plugin que ce qui a changé. Tempo, mesures (piste tempo, R2) et accords (piste
 * d'accords, V20) suivent (araMusicFor).
 *
 * « Ouvrir dans Melodyne » sur un clip (rendu) reste : c'est le « Commit / Render »
 * optionnel. Chez un collaborateur sans le plugin, la piste joue son rendu (gel à l'envoi).
 */
import { TrackType } from '../types';
import type { AraPluginKey, Clip, PluginInstance, Track } from '../types';
import type { TempoMap } from './tempoMap';
import { QUALITY_INTERVALS } from './chordDetect';
import type { ChordEvent } from './chordDetect';
import { ARA_LABEL, araPluginKey } from './araEdit';

/** Effet de piste qui est un insert ARA (Melodyne / VocAlign du PC). */
export const isAraInsert = (p: PluginInstance | null | undefined): boolean =>
  !!p && p.type === 'VST3' && (p.params?.ara === 'melodyne' || p.params?.ara === 'vocalign');

/** Clé ARA d'un effet de piste (null : effet ordinaire). */
export const araInsertKind = (p: PluginInstance | null | undefined): AraPluginKey | null =>
  isAraInsert(p) ? (p!.params.ara as AraPluginKey) : null;

/** Le premier insert ARA actif de la piste (un seul, comme Pro Tools : il lit les clips eux-mêmes). */
export function araInsertOf(track: Pick<Track, 'plugins'> | null | undefined): PluginInstance | null {
  return (track?.plugins || []).find(p => isAraInsert(p) && !p.isInactive) || null;
}

/** Métadonnées d'un effet VST3 posé comme insert ARA (`vstMetadata` du navigateur VST + clé ARA). */
export function araInsertMetadata(p: { name: string; vendor?: string; uid?: string; path: string; pluginName?: string | null }): Record<string, any> | null {
  const ara = araPluginKey(p.path || p.name);
  if (!ara) return null;
  return { name: p.name, vendor: p.vendor || '', uid: p.uid || '', localPath: p.path, pluginName: p.pluginName || undefined, ara };
}

/**
 * Place de l'insert ARA dans la chaîne : TOUT EN HAUT. Le plugin lit les clips eux-mêmes
 * (pas le son qui lui arrive) : un effet placé avant lui ne s'entendrait pas.
 */
export function withAraInsertFirst(plugins: PluginInstance[], insert: PluginInstance): PluginInstance[] {
  return [insert, ...plugins.filter(p => p.id !== insert.id)];
}

/** Effets placés AVANT l'insert ARA (ignorés : le plugin lit les clips eux-mêmes). */
export function effectsBeforeAraInsert(track: Pick<Track, 'plugins'>): PluginInstance[] {
  const list = track.plugins || [];
  const i = list.findIndex(p => isAraInsert(p) && !p.isInactive);
  return i > 0 ? list.slice(0, i).filter(p => p.isEnabled && !p.isInactive) : [];
}

export interface AraDocSource { id: string; name: string; persistent_id: string }
export interface AraDocRegion { id: string; source: string; name: string; offset: number; start: number; duration: number }
export interface AraDocument {
  sources: AraDocSource[];
  regions: AraDocRegion[];
  track: { name: string };
  /** Clips joués tels quels par NOVA à côté du plugin (time-stretch, inversés…), pour l'affichage. */
  skipped: { id: string; reason: string }[];
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Document ARA d'une piste : un fichier son = une source (sa modification garde les
 * retouches : couper un clip les conserve), un clip = une région (début dans le fichier,
 * place sur la timeline, durée). Clips muets, MIDI ou sans son : absents.
 * `duration(bufferId)` : durée du fichier (s), pour borner la région ; inconnue = clip non envoyé.
 */
export function araDocumentFor(track: Pick<Track, 'id' | 'name' | 'clips'>, duration: (bufferId: string) => number | null): AraDocument {
  const sources = new Map<string, AraDocSource>();
  const regions: AraDocRegion[] = [];
  const skipped: AraDocument['skipped'] = [];
  for (const c of track.clips || []) {
    if (!c.bufferId || c.type === TrackType.MIDI || (c.notes && c.notes.length)) continue;
    if (c.isMuted) { skipped.push({ id: c.id, reason: 'muet' }); continue; }
    if (c.isReversed) { skipped.push({ id: c.id, reason: 'inversé' }); continue; }
    const len = duration(c.bufferId);
    if (len === null || !(len > 0)) { skipped.push({ id: c.id, reason: 'son pas encore chargé' }); continue; }
    const offset = Math.max(0, c.offset || 0);
    if (offset >= len) { skipped.push({ id: c.id, reason: 'hors du fichier' }); continue; }
    const dur = Math.min(c.duration, len - offset);
    if (!(dur > 1e-4)) continue;
    if (!sources.has(c.bufferId)) {
      sources.set(c.bufferId, { id: c.bufferId, name: (c.name || 'Son').replace(/\s*\((Melodyne|calé|justesse)\)$/, ''), persistent_id: `nova:${c.bufferId}` });
    }
    regions.push({ id: c.id, source: c.bufferId, name: c.name || 'Clip', offset: r6(offset), start: r6(c.start), duration: r6(dur) });
  }
  regions.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return { sources: Array.from(sources.values()), regions, track: { name: track.name || 'Piste' }, skipped };
}

/** Racine d'un accord (0 = Do) → cycle des quintes d'ARA (Do = 0, Sol = 1, Fa = −1…). */
export const circleOfFifths = (pc: number): number => {
  const v = (((Math.round(pc) % 12) + 12) % 12) * 7 % 12;
  return v > 6 ? v - 12 : v;
};

export interface AraMusic {
  bpm: number;
  tempo: { t: number; q: number }[];
  signatures: { q: number; num: number; den: number }[];
  chords: { q: number; root: number; bass: number; intervals: number[]; name: string }[];
}

/**
 * Tempo, mesures et accords pour le plugin (contexte musical ARA) : la piste tempo en points
 * (instant, noires) — au moins deux —, une signature par segment, la piste d'accords.
 */
export function araMusicFor(map: TempoMap, chords?: ChordEvent[] | null): AraMusic {
  const segs = map.segments.length ? map.segments : [{ bar: 0, time: 0, bpm: 120, num: 4, den: 4, beatSec: 0.5, barSec: 2 }];
  const tempo: AraMusic['tempo'] = [];
  const signatures: AraMusic['signatures'] = [];
  let q = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i > 0) q += (s.time - segs[i - 1].time) * segs[i - 1].bpm / 60;
    tempo.push({ t: r6(s.time), q: r6(q) });
    signatures.push({ q: r6(q), num: s.num, den: s.den });
  }
  const last = segs[segs.length - 1];
  // Point de fin du dernier segment (ARA veut au moins deux points ; la pente donne le tempo).
  tempo.push({ t: r6(last.time + 60), q: r6(q + last.bpm) });
  const quarterAt = (t: number) => {
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const end = i + 1 < segs.length ? segs[i + 1].time : Infinity;
      if (t <= s.time) break;
      acc += (Math.min(t, end) - s.time) * s.bpm / 60;
      if (t <= end) break;
    }
    return acc;
  };
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const out: AraMusic['chords'] = [];
  for (const c of [...(chords || [])].sort((a, b) => a.start - b.start)) {
    const iv = new Array(12).fill(0);
    (QUALITY_INTERVALS[c.quality] || QUALITY_INTERVALS.maj).forEach((x, k) => { iv[((x % 12) + 12) % 12] = k * 2 + 1; });
    const root = circleOfFifths(c.root);
    out.push({ q: r6(quarterAt(c.start)), root, bass: root, intervals: iv, name: `${names[((c.root % 12) + 12) % 12]}${c.quality === 'maj' ? '' : c.quality === 'min' ? 'm' : c.quality}` });
  }
  return { bpm: segs[0].bpm, tempo, signatures, chords: out };
}

/** Empreinte d'un document (rien n'est renvoyé au pont si elle n'a pas bougé). */
export const araDocSignature = (doc: Pick<AraDocument, 'sources' | 'regions' | 'track'>, music?: AraMusic | null): string =>
  JSON.stringify([doc.sources.map(s => s.id), doc.regions.map(r => [r.id, r.source, r.offset, r.start, r.duration, r.name]), doc.track.name, music || null]);

/** Clips de la piste sélectionnés → régions montrées dans l'éditeur (aucun : toute la piste). */
export function araSelectionFor(track: Pick<Track, 'clips'>, selectedClipIds: Iterable<string>, doc?: Pick<AraDocument, 'regions'>): string[] {
  const ids = new Set(selectedClipIds);
  const regionIds = new Set((doc?.regions || []).map(r => r.id));
  return (track.clips || []).filter(c => ids.has(c.id) && (!doc || regionIds.has(c.id))).map(c => c.id);
}

/** Message affiché chez un collaborateur ou sur un poste sans le plugin. */
export function araMissingMessage(kind: AraPluginKey, ctx: { bridgeConnected: boolean; pluginInstalled: boolean; frozen: boolean }): string | null {
  const label = ARA_LABEL[kind];
  if (ctx.bridgeConnected && ctx.pluginInstalled) return null;
  const where = ctx.bridgeConnected ? `${label} absent sur ce PC` : `${label} n'est utilisable que dans Nova Studio sur PC`;
  return ctx.frozen
    ? `${where} : le son retouché est joué tel quel.`
    : `${where} : la piste joue ses clips sans les retouches (rendu à faire sur le PC qui a ${label}).`;
}

/** Libellé court de l'insert (barre de l'effet, liste des inserts). */
export const araInsertLabel = (kind: AraPluginKey) => `${ARA_LABEL[kind]} (ARA)`;

/** Clips dont la position a changé entre deux documents (pour le journal / l'affichage). */
export function araChangedRegions(a: AraDocument | null, b: AraDocument): { added: string[]; removed: string[]; moved: string[] } {
  const prev = new Map((a?.regions || []).map(r => [r.id, r] as const));
  const next = new Map(b.regions.map(r => [r.id, r] as const));
  const added = b.regions.filter(r => !prev.has(r.id)).map(r => r.id);
  const removed = (a?.regions || []).filter(r => !next.has(r.id)).map(r => r.id);
  const moved = b.regions.filter(r => {
    const p = prev.get(r.id);
    return p && (p.start !== r.start || p.offset !== r.offset || p.duration !== r.duration || p.source !== r.source);
  }).map(r => r.id);
  return { added, removed, moved };
}

/**
 * Archive ARA (retouches) contenue dans l'état d'un insert (« NARA1. » + JSON base64 : archive
 * ARA + état VST3, voir bridge-python/ara_insert.py). Une ancienne valeur nue = l'archive.
 */
export function araArchiveOfState(state: string | null | undefined): string | undefined {
  if (!state) return undefined;
  if (!state.startsWith('NARA1.')) return state;
  try {
    const d = JSON.parse(typeof atob === 'function' ? atob(state.slice(6)) : '');
    return typeof d?.ara === 'string' && d.ara ? d.ara : undefined;
  } catch { return undefined; }
}

export type { Clip };
