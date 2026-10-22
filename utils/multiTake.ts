import type { Clip, Marker, TakeMeta, Track } from '../types';
import { cutAroundPunch, trimTake } from './punch';
import { keptLoopPasses, nextTakeNumber, patchMeta, punchedPassages, splitLoopPasses } from './playlists';

/**
 * R14 · Ranger une prise sur SA piste (une par piste armée), module pur :
 * punch (zone ou QuickPunch, crossfades), Loop Record (un couloir par tour),
 * anciennes prises coupées, couloirs et groupe de prises. Les mêmes règles
 * qu'avant R14, appliquées à chaque piste du passage.
 */

export interface RecPlan {
  in: number | null;
  out: number | null;
  isPunch: boolean;
  loop?: { start: number; end: number };
  /** Heure (ms) du début de la prise. */
  wall?: number;
}

export interface PlaceOptions {
  rec: RecPlan | null;
  /** Crossfade du punch (s). */
  xfade: number;
  /** Gain automatique de la prise (1 = aucun). */
  takeGain?: number;
  /** Prise nettoyée (blancs retirés) : ses morceaux remplacent le clip entier. */
  cleaned?: Clip[] | null;
  /** Groupe de prises (passage multipiste). */
  group?: string;
  /** Heure de la prise (ms), si `rec.wall` manque. */
  wall: number;
  /** Suffixe unique des clips découpés. */
  stamp: string;
  /**
   * Section du morceau où tombe la prise (repère « Couplet 2 », voir takeSection) :
   * la prise s'appelle « Couplet 2 · Prise 3 » (3e prise de ce couplet sur la piste).
   */
  section?: string | null;
}

export interface PlacedTake {
  clips: Clip[];
  takeMeta?: TakeMeta[];
  /** Anciennes prises coupées (mutées) ou découpées par le punch. */
  mutedOld: number;
  firstTake: number;
  takeName: string;
  /** Tours de boucle rangés (0 hors Loop Record, ou un seul tour). */
  loopCount: number;
  /** Tour entendu (Loop Record). */
  activeTake?: number;
  /** Nom du tour entendu (« Couplet 1 · Prise 3 »). */
  activeName?: string;
  /** Loop Record : bout de tour commencé juste avant l'arrêt, jeté (n° du tour, durée en s). */
  droppedPass?: { pass: number; sec: number };
  newClipIds: string[];
}

/**
 * Coupe la prise à la fenêtre utile (punch, pré-roll) : null si rien n'a été capté
 * dans la zone. Le clip est modifié sur place (comme avant).
 */
export function trimToPlan(clip: Clip, rec: RecPlan | null, xfade: number): Clip | null {
  if (!rec) return clip;
  const t = trimTake(clip, rec.in, rec.out, rec.isPunch ? xfade : 0.01);
  if (!t) return null;
  Object.assign(clip, t);
  return clip;
}

/** Clip prêt à ranger : son audio est dans le registre sous l'id de la prise. */
function toStore(c: Clip, bufferId: string, gain: number): Clip {
  const x: Clip = { ...c, bufferId, gain: (c.gain ?? 1) * gain, originStart: c.originStart ?? Math.max(0, c.start - (c.offset || 0)) };
  delete x.buffer;
  return x;
}

/** Nom d'un repère posé sans être renommé (« Marqueur 3 ») : il ne nomme pas les prises. */
const DEFAULT_MARKER_NAME = /^\s*(marqueur|rep[eè]re|marker|r[ée]gion|s[ée]lection|memory location)\s*(n°\s*)?\d*\s*$/i;
const SECTION_MAX = 24;

/**
 * Section du morceau d'une prise : le repère (ou la région) qui couvre la plus grande
 * part de [from, to] — une prise lancée une mesure avant « Couplet 2 » pour l'élan
 * reste une prise du couplet 2. null : pas de repère nommé à cet endroit.
 * Les repères de sélection et ceux qui gardent leur nom par défaut sont ignorés.
 */
export function takeSection(markers: Pick<Marker, 'name' | 'time' | 'type' | 'endTime' | 'selection'>[] | undefined, from: number, to: number): string | null {
  const ms = (markers || []).filter(m => m && !m.selection && Number.isFinite(m.time)).sort((a, b) => a.time - b.time);
  if (!ms.length) return null;
  const a = Math.min(from, to), b = Math.max(from, to, a + 0.01);
  let best: { name: string; over: number } | null = null;
  ms.forEach((m, i) => {
    const next = ms.slice(i + 1).find(x => x.time > m.time + 1e-3);
    const end = m.type === 'REGION' && typeof m.endTime === 'number' && m.endTime > m.time ? m.endTime : (next ? next.time : Infinity);
    const over = Math.min(b, end) - Math.max(a, m.time);
    if (over <= 0) return;
    // Région plus précise qu'un repère simple à recouvrement égal.
    if (!best || over > best.over + 1e-6) best = { name: m.name, over };
  });
  const name = (best as { name: string } | null)?.name?.trim() || '';
  if (!name || DEFAULT_MARKER_NAME.test(name)) return null;
  return name.length > SECTION_MAX ? name.slice(0, SECTION_MAX).trim() : name;
}

/** Rang de la prochaine prise de la section sur la piste (« Couplet 2 · Prise 3 » → 4). */
export function nextSectionIndex(meta: TakeMeta[] | undefined, section: string): number {
  const head = `${section} · Prise `;
  let max = 0;
  for (const m of meta || []) {
    const name = m?.name || '';
    if (!name.startsWith(head)) continue;
    const rest = name.slice(head.length);
    if (/^[0-9]+$/.test(rest)) max = Math.max(max, parseInt(rest, 10));
  }
  return max + 1;
}

/** Range une prise (déjà coupée à la fenêtre utile) sur sa piste. */
export function placeTake(track: Pick<Track, 'clips' | 'takeMeta'>, clip: Clip, o: PlaceOptions): PlacedTake {
  const bufferId = clip.id;
  const gain = o.takeGain ?? 1;
  const takeNumber = nextTakeNumber(track);
  // Nommage automatique : « Couplet 2 · Prise 3 » dans une section nommée, sinon « Prise N ».
  const sec = o.section?.trim() || '';
  const k0 = sec ? nextSectionIndex(track.takeMeta, sec) : 0;
  const nameOf = (i: number) => (sec ? `${sec} · Prise ${k0 + i}` : `Prise ${takeNumber + i}`);
  const secName = (i: number): Partial<TakeMeta> => (sec ? { name: nameOf(i) } : {});
  const named: Clip = { ...clip, name: nameOf(0), takeNumber };
  const rec = o.rec;
  const wall = rec?.wall || o.wall;

  // Loop Record : un clip par tour gardé (même audio, offsets différents).
  let loopTakes: { clip: Clip; pass: number; active: boolean; wall: number }[] = [];
  let takeName = named.name!;
  let droppedPass: { pass: number; sec: number } | undefined;
  if (rec?.loop) {
    const { kept, active, dropped } = keptLoopPasses(splitLoopPasses(named, rec.loop.start, rec.loop.end), rec.loop.end - rec.loop.start);
    if (dropped) droppedPass = { pass: dropped.pass, sec: dropped.duration };
    // Un seul tour gardé (le bout suivant jeté) : la prise s'arrête à la fin de la boucle.
    if (kept.length === 1 && dropped) named.duration = kept[0].duration;
    if (kept.length > 1) {
      const off0 = named.offset || 0;
      loopTakes = kept.map((ps, i) => ({
        pass: ps.pass,
        active: ps.pass === active,
        wall: wall + Math.max(0, ps.offset - off0) * 1000,
        clip: {
          ...named, id: `${named.id}-l${ps.pass}`, start: ps.start, duration: ps.duration, offset: ps.offset,
          takeNumber: takeNumber + i, name: nameOf(i), fadeIn: 0.01, fadeOut: 0.01,
          ...(ps.pass === active ? {} : { isMuted: true }),
        },
      }));
      takeName = sec ? `${sec} · Prises ${k0} à ${k0 + kept.length - 1}` : `Prises ${takeNumber} à ${takeNumber + kept.length - 1}`;
    }
  }

  const before = track.clips as Clip[];
  let clips: Clip[];
  let mutedOld = 0;
  const takeStart = loopTakes.length ? Math.min(...loopTakes.map(l => l.clip.start)) : named.start;
  const takeEnd = loopTakes.length ? Math.max(...loopTakes.map(l => l.clip.start + l.clip.duration)) : named.start + named.duration;
  const punch = rec?.isPunch ? rec : null;
  const punchIn = punch ? (punch.in ?? named.start) : 0;
  const punchOut = punch ? (punch.out ?? named.start + named.duration) : 0;
  if (punch && punchOut > punchIn) {
    // Punch : l'ancienne prise est découpée autour de la zone (avant / après gardés),
    // crossfade à puissance égale sur chaque point ; le passage remplacé reste dans le
    // couloir de l'ancienne prise (muté) : on peut y revenir par le comp.
    const cut = cutAroundPunch(before, punchIn, punchOut, o.xfade, o.stamp);
    mutedOld += cut.replaced;
    clips = [...cut.clips, ...punchedPassages(before, punchIn, punchOut, o.stamp)];
  } else {
    clips = before.map(c => {
      if (!c.isMuted && c.start < takeEnd && c.start + c.duration > takeStart) { mutedOld++; return { ...c, isMuted: true }; }
      return c;
    });
  }

  let meta = track.takeMeta as TakeMeta[] | undefined;
  const grp = o.group ? { group: o.group } : {};
  let newClipIds: string[];
  if (loopTakes.length) {
    clips = [...clips, ...loopTakes.map(l => toStore(l.clip, bufferId, gain))];
    // Un groupe par tour : le tour 2 de la batterie va avec le tour 2 des overheads.
    loopTakes.forEach((l, i) => { meta = patchMeta(meta, l.clip.takeNumber!, { recordedAt: Math.round(l.wall), loopPass: l.pass, ...secName(i), ...(o.group ? { group: `${o.group}-t${l.pass}` } : {}) }); });
    newClipIds = loopTakes.map(l => l.clip.id);
  } else if (o.cleaned?.length) {
    const parts = o.cleaned.map(c => toStore({ ...c, takeNumber, name: named.name }, bufferId, gain));
    clips = [...clips, ...parts];
    meta = patchMeta(meta, takeNumber, { recordedAt: wall, ...secName(0), ...grp });
    newClipIds = parts.map(c => c.id);
  } else {
    clips = [...clips, toStore(named, bufferId, gain)];
    meta = patchMeta(meta, takeNumber, { recordedAt: wall, ...secName(0), ...grp });
    newClipIds = [named.id];
  }
  const act = loopTakes.find(l => l.active);
  return {
    clips, takeMeta: meta, mutedOld, firstTake: takeNumber, takeName,
    loopCount: loopTakes.length, ...(act ? { activeTake: act.clip.takeNumber, activeName: act.clip.name } : {}), newClipIds,
    ...(droppedPass ? { droppedPass } : {}),
  };
}
