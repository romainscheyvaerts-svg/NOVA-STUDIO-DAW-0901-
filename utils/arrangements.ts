import type { AutomationLane, Clip, DAWState, Marker, Track } from '../types';
import type { ChordEvent } from './chordDetect';
import { extractRange, splitClipsAt, IdGen } from './timeSelection';
import { opIdGen, Section, sectionsOf, sliceLanePoints, songEnd } from './timeOps';

/**
 * R21 · Arrangements multiples (Logic : Arrangement Alternatives ; Pro Tools :
 * à la main, une copie de session par version). Un projet garde plusieurs
 * arrangements du même morceau : « Clean » / « Explicite », « Radio edit »,
 * « Version longue »…
 *
 * Un arrangement définit :
 *  - l'ORDRE des sections de la piste Arrangement (R12 : sections = repères) ;
 *    une section peut revenir plusieurs fois (refrain doublé en version longue)
 *    ou être retirée (radio edit) ;
 *  - des passages COUPÉS : plages sur une piste (le gros mot d'une version clean,
 *    avec un fondu de 5 ms de chaque côté) ou clips entiers.
 *
 * La timeline n'est jamais touchée : le rendu d'un arrangement est un projet
 * calculé (renderArrangement) que l'export joue, ou que « Poser sur la
 * timeline » applique (une seule annulation).
 *
 * Module pur : tests/arrangements.test.ts.
 */

export interface MutedRange { trackId: string; start: number; end: number }

export interface SongArrangement {
  id: string;
  name: string;
  /** Sections dans l'ordre de lecture (identifiant de leur repère ; START_SECTION = début avant le 1er repère). */
  sections: string[];
  /** Clips coupés dans cet arrangement. */
  mutedClipIds: string[];
  /** Passages coupés (temps de la timeline). */
  mutedRanges?: MutedRange[];
  color?: string;
  createdAt?: number;
}

export const START_SECTION = '__debut';
/** Fondu posé de chaque côté d'un passage coupé (évite le clic). */
export const MUTE_FADE = 0.005;
export const ARRANGEMENT_PRESETS = ['Explicite', 'Clean', 'Radio edit', 'Version longue', 'Instrumental'];
const COLORS = ['#22d3ee', '#a3e635', '#f59e0b', '#f472b6', '#a78bfa', '#34d399'];

const EPS = 1e-6;

/** Sections du morceau : celles de la piste Arrangement, plus le début s'il précède le 1er repère. */
export function arrangementSections(s: Pick<DAWState, 'tracks' | 'markers'>): Section[] {
  const secs = sectionsOf(s);
  const first = secs.length ? Math.min(...secs.map(x => x.start)) : songEnd(s);
  const out = [...secs];
  if (first > 1e-3) out.unshift({ id: START_SECTION, name: 'Début', start: 0, end: first, color: '#64748b', markerId: START_SECTION });
  return out.sort((a, b) => a.start - b.start);
}

let seq = 0;
export const newArrangementId = () => `arr-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Nouvel arrangement : l'ordre de la timeline (ou une copie d'un autre). */
export function newArrangement(s: Pick<DAWState, 'tracks' | 'markers' | 'arrangements'>, name: string, from?: SongArrangement): SongArrangement {
  const n = (s.arrangements || []).length;
  return {
    id: newArrangementId(),
    name: name.trim().slice(0, 60) || `Arrangement ${n + 1}`,
    sections: from ? [...from.sections] : arrangementSections(s).map(x => x.id),
    mutedClipIds: from ? [...from.mutedClipIds] : [],
    mutedRanges: from?.mutedRanges ? from.mutedRanges.map(r => ({ ...r })) : [],
    color: COLORS[n % COLORS.length],
    createdAt: Date.now(),
  };
}

/** Sections jouées par un arrangement (dans l'ordre), et celles qui n'existent plus. */
export function resolveArrangement(s: Pick<DAWState, 'tracks' | 'markers'>, a: SongArrangement): { sections: Section[]; missing: string[]; length: number } {
  const all = arrangementSections(s);
  const byId = new Map(all.map(x => [x.id, x]));
  const sections: Section[] = [];
  const missing: string[] = [];
  for (const id of a.sections) {
    const x = byId.get(id);
    if (x) sections.push(x); else missing.push(id);
  }
  return { sections, missing, length: sections.reduce((t, x) => t + (x.end - x.start), 0) };
}

/** Passages coupés d'une piste, triés et fusionnés. */
function rangesOf(a: SongArrangement, trackId: string): [number, number][] {
  const rs = (a.mutedRanges || []).filter(r => r.trackId === trackId && r.end - r.start > 1e-4).map(r => [Math.min(r.start, r.end), Math.max(r.start, r.end)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of rs) { const last = out[out.length - 1]; if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]); else out.push([...r]); }
  return out;
}

/** Clips d'une piste avec les coupes de l'arrangement (clips mutés, passages coupés avec fondus). */
export function mutedClips(clips: Clip[], a: SongArrangement, trackId: string, gen: IdGen): Clip[] {
  const ids = new Set(a.mutedClipIds || []);
  let out = clips.map(c => (ids.has(c.id) && !c.isMuted ? { ...c, isMuted: true } : c));
  const ranges = rangesOf(a, trackId);
  if (!ranges.length) return out;
  out = splitClipsAt(out, ranges.flat(), gen);
  return out.map(c => {
    const s = c.start, e = c.start + c.duration;
    const inside = ranges.some(([r0, r1]) => s >= r0 - EPS && e <= r1 + EPS);
    if (inside) return c.isMuted ? c : { ...c, isMuted: true };
    // Fondus courts au bord d'un passage coupé (le son ne claque pas).
    let n = c;
    if (ranges.some(([r0]) => Math.abs(e - r0) < 1e-5)) n = { ...n, fadeOut: Math.max(n.fadeOut || 0, Math.min(MUTE_FADE, c.duration / 2)) };
    if (ranges.some(([, r1]) => Math.abs(s - r1) < 1e-5)) n = { ...n, fadeIn: Math.max(n.fadeIn || 0, Math.min(MUTE_FADE, c.duration / 2)) };
    return n;
  });
}

export interface ArrangementReport {
  length: number;
  /** Sections posées : nom, début et fin dans le rendu. */
  sections: { id: string; name: string; start: number; end: number }[];
  missing: number;
  /** Passages et clips coupés. */
  muted: number;
  /** Ce qui n'a pas pu suivre (piste gelée, piste tempo). */
  notes: string[];
}

/**
 * Projet joué par un arrangement : sections recopiées l'une après l'autre
 * (clips, automation, accords), repères des sections reposés, coupes
 * appliquées. La timeline d'origine n'est pas modifiée.
 */
export function renderArrangement<S extends DAWState>(s: S, a: SongArrangement, tag = `ar${a.id.slice(-5)}`): { state: S; report: ArrangementReport } {
  const gen = opIdGen(tag);
  const { sections, missing } = resolveArrangement(s, a);
  const notes: string[] = [];
  let muted = (a.mutedClipIds || []).length + (a.mutedRanges || []).length;
  const tracks: Track[] = s.tracks.map(t => {
    if (t.id === 'master') return t;
    const src = mutedClips(t.clips || [], a, t.id, gen);
    const clips: Clip[] = [];
    const lanes: AutomationLane[] = (t.automationLanes || []).map(l => ({ ...l, points: [] }));
    let cur = 0;
    for (const sec of sections) {
      const len = sec.end - sec.start;
      for (const c of extractRange(src, sec.start, sec.end, gen)) clips.push({ ...c, id: gen(c.id), start: c.start + cur });
      (t.automationLanes || []).forEach((l, i) => {
        if (!l.points?.length) return;
        for (const p of sliceLanePoints(l.points, sec.start, sec.end, gen)) lanes[i].points.push({ ...p, time: p.time + cur });
      });
      cur += len;
    }
    const nt: Track = { ...t, clips, automationLanes: lanes.map((l, i) => (t.automationLanes[i]?.points?.length ? l : t.automationLanes[i])) };
    if (t.frozenClip || t.isFrozen) {
      // Le rendu gelé suit la timeline d'origine : la piste joue ses clips et ses effets.
      delete nt.frozenClip; nt.isFrozen = false; delete nt.frozenClipIds;
      notes.push(`« ${t.name} » est jouée sans son rendu gelé`);
    }
    return nt;
  });
  const placed: ArrangementReport['sections'] = [];
  const markers: Marker[] = [];
  const chords: ChordEvent[] = [];
  let cur = 0;
  sections.forEach((sec, i) => {
    const len = sec.end - sec.start;
    placed.push({ id: sec.id, name: sec.name, start: cur, end: cur + len });
    const m0 = (s.markers || []).find(m => m.id === sec.markerId);
    markers.push({ id: gen(`m-${sec.id}`), name: sec.name, time: cur, type: 'MARKER', color: m0?.color || sec.color, number: i + 1 });
    for (const c of s.chords || []) {
      const cs = Math.max(c.start, sec.start), ce = Math.min(c.end, sec.end);
      if (ce - cs > 1e-3) chords.push({ ...c, id: gen(c.id), start: cs - sec.start + cur, end: ce - sec.start + cur });
    }
    cur += len;
  });
  if ((s.tempoEvents || []).length) notes.push('piste tempo : tempo de départ gardé');
  muted = Math.max(0, muted);
  const state: S = {
    ...s, tracks, markers, chords, tempoEvents: [],
    loopStart: 0, loopEnd: cur, isLoopActive: false,
  };
  return { state, report: { length: cur, sections: placed, missing: missing.length, muted, notes } };
}

/** Ajoute / retire une section (à la fin, ou à une position). */
export function withSections(a: SongArrangement, sections: string[]): SongArrangement {
  return { ...a, sections: sections.slice(0, 200) };
}

export function moveSection(a: SongArrangement, from: number, to: number): SongArrangement {
  const list = [...a.sections];
  if (from < 0 || from >= list.length) return a;
  const [x] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, x);
  return { ...a, sections: list };
}

/** Coupe / rétablit des clips dans l'arrangement. */
export function toggleMutedClips(a: SongArrangement, ids: string[]): SongArrangement {
  const set = new Set(a.mutedClipIds || []);
  const allIn = ids.every(id => set.has(id));
  ids.forEach(id => (allIn ? set.delete(id) : set.add(id)));
  return { ...a, mutedClipIds: [...set] };
}

/** Coupe un passage (sélection de plage) sur des pistes. */
export function addMutedRange(a: SongArrangement, start: number, end: number, trackIds: string[]): SongArrangement {
  const s = Math.max(0, Math.min(start, end)), e = Math.max(start, end);
  if (e - s < 1e-3 || !trackIds.length) return a;
  return { ...a, mutedRanges: [...(a.mutedRanges || []), ...trackIds.map(trackId => ({ trackId, start: s, end: e }))] };
}

export function removeMutedRange(a: SongArrangement, index: number): SongArrangement {
  const list = [...(a.mutedRanges || [])];
  list.splice(index, 1);
  return { ...a, mutedRanges: list };
}

/** Liste mise à jour (remplace l'arrangement de même id, ou l'ajoute). */
export function upsertArrangement(list: SongArrangement[] | undefined, a: SongArrangement): SongArrangement[] {
  const l = [...(list || [])];
  const i = l.findIndex(x => x.id === a.id);
  if (i >= 0) l[i] = a; else l.push(a);
  return l;
}

/** Arrangements relus d'un fichier (rien d'autre ne passe). */
export function sanitizeArrangements(raw: unknown): SongArrangement[] {
  if (!Array.isArray(raw)) return [];
  const out: SongArrangement[] = [];
  for (const r of raw.slice(0, 40)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (typeof x.id !== 'string' || !Array.isArray(x.sections)) continue;
    out.push({
      id: x.id.slice(0, 60),
      name: typeof x.name === 'string' ? x.name.slice(0, 60) : 'Arrangement',
      sections: (x.sections as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 200),
      mutedClipIds: Array.isArray(x.mutedClipIds) ? (x.mutedClipIds as unknown[]).filter((v): v is string => typeof v === 'string') : [],
      mutedRanges: Array.isArray(x.mutedRanges) ? (x.mutedRanges as any[]).filter(m => m && typeof m.trackId === 'string' && Number.isFinite(m.start) && Number.isFinite(m.end)).map(m => ({ trackId: m.trackId, start: +m.start, end: +m.end })) : [],
      ...(typeof x.color === 'string' ? { color: x.color } : {}),
      ...(Number.isFinite(x.createdAt) ? { createdAt: x.createdAt as number } : {}),
    });
  }
  return out;
}

const fmt = (sec: number) => {
  const m = Math.floor(sec / 60), r = sec - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0').replace('.', ',')}`;
};
/** Résumé d'un arrangement (« Intro → Couplet → Refrain · 1:12,0 · 2 coupes »). */
export function arrangementSummary(s: Pick<DAWState, 'tracks' | 'markers'>, a: SongArrangement): string {
  const r = resolveArrangement(s, a);
  const cuts = (a.mutedClipIds || []).length + (a.mutedRanges || []).length;
  return [r.sections.map(x => x.name).join(' → ') || 'aucune section', fmt(r.length), cuts ? `${cuts} coupe${cuts > 1 ? 's' : ''}` : null,
    r.missing.length ? `${r.missing.length} section${r.missing.length > 1 ? 's' : ''} disparue${r.missing.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
}
