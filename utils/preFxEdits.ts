import { AutomationLane, AutomationPoint, Clip, FreezeBase, FreezeBaseClip, PreFxJournal, PreFxOp, Track, TrackType } from '../types';

/**
 * Éditions PRÉ-EFFET d'une piste gelée.
 *
 * Au studio, la piste est gelée (rendu de ses effets VST) avec une PHOTO de ses
 * clips (FreezeBase). Ailleurs (tablette, chez l'artiste), on édite les clips
 * d'origine : couper, enlever un passage, déplacer, supprimer, fondus, gain,
 * mute, volume avant effets. Ces éditions se lisent comme des OPÉRATIONS sur
 * l'audio SEC d'origine (positions dans la source, gains, fondus) : jamais
 * « cuites » dans le rendu. De retour sur le PC, la vraie chaîne d'effets est
 * rejouée sur l'audio sec édité : les éditions passent AVANT les effets.
 *
 * Ce module est pur (aucun audio) : photo, plan d'édition, rejeu, résumé,
 * journal avec auteurs, fusion à trois voies et conflits.
 */

/** Automation « volume avant effets » (gain en tête de chaîne, avant les plugins). */
export const PRE_VOLUME = 'preVolume';

/** Version du format de session qui porte photo, journal et rendus d'envois. */
export const SESSION_SCHEMA_VERSION = 2;

// Auteur des éditions (nom du compte, de la collaboration) : posé par l'interface.
let editAuthor = '';
export const setEditAuthor = (name: string | null | undefined) => { editAuthor = (name || '').trim().slice(0, 60); };
export const getEditAuthor = () => editAuthor;

const EPS = 1e-3;
const near = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps;

/** Clips qui peuvent être photographiés (audio, non inversés, avec un son). */
export const isBaseable = (c: Clip): boolean => !!c.bufferId && !c.isReversed && !c.notes && !c.isFreezeSlice;

export const baseClipOf = (c: Clip): FreezeBaseClip & { bufferId?: string; color?: string; fadeInCurve?: Clip['fadeInCurve']; fadeOutCurve?: Clip['fadeOutCurve'] } => ({
  id: c.id,
  name: c.name,
  start: c.start,
  offset: c.offset || 0,
  duration: c.duration,
  gain: c.gain ?? 1,
  fadeIn: c.fadeIn || 0,
  fadeOut: c.fadeOut || 0,
  ...(c.isMuted ? { isMuted: true } : {}),
  ...(c.bufferId ? { bufferId: c.bufferId } : {}),
  ...(c.color ? { color: c.color } : {}),
  ...(c.fadeInCurve ? { fadeInCurve: c.fadeInCurve } : {}),
  ...(c.fadeOutCurve ? { fadeOutCurve: c.fadeOutCurve } : {}),
});

type BaseClipFull = ReturnType<typeof baseClipOf>;

export const preVolumeLane = (t: Pick<Track, 'automationLanes'>): AutomationLane | undefined =>
  (t.automationLanes || []).find(l => l.parameterName === PRE_VOLUME);

const lanePoints = (l?: AutomationLane): AutomationPoint[] =>
  (l?.points || []).map(p => ({ id: p.id, time: p.time, value: p.value, ...(p.curveType ? { curveType: p.curveType } : {}) }));

/** Photo de la piste au moment du gel (clips rendus, volume avant effets). */
export function makeFreezeBase(t: Track, renderId: string, by?: string, at = Date.now()): FreezeBase {
  const clips = (t.clips || [])
    .filter(c => isBaseable(c) && (!c.freezeRef || c.freezeRef.renderId === renderId))
    .map(baseClipOf);
  const pv = preVolumeLane(t);
  return { renderId, at, ...(by ? { by } : {}), clips, ...(pv && pv.points.length ? { preVolume: lanePoints(pv) } : {}) };
}

// --- Plan d'édition ------------------------------------------------------------

/** Morceau d'audio sec d'un clip photographié, tel qu'il est joué maintenant. */
export interface PreFxPiece {
  id: string;
  /** Partie de l'audio source jouée (offsets source, s). */
  from: number;
  to: number;
  /** Position sur la ligne de temps (s). */
  start: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  isMuted: boolean;
}

/** Pour chaque clip photographié : les morceaux joués (vide = supprimé). */
export type PreFxPlan = Record<string, PreFxPiece[]>;

/** Clip photographié dont un clip actuel est issu (null : nouvelle prise). */
export const sourceOf = (c: Clip, base: FreezeBase): string | null => {
  const ids = new Set(base.clips.map(b => b.id));
  const ref = c.freezeRef;
  if (ref && ref.renderId === base.renderId) {
    if (ref.srcClipId && ids.has(ref.srcClipId)) return ref.srcClipId;
    // Ancrage sans origine (rendu d'avant le journal) : même place dans la source.
    const b = base.clips.find(x => near(x.start - x.offset, ref.anchor) && near(x.offset, ref.from) && near(x.offset + x.duration, ref.to));
    if (b) return b.id;
  }
  // Clip jamais ancré mais présent dans la photo (même id).
  if (!ref && ids.has(c.id) && isBaseable(c)) return c.id;
  return null;
};

const pieceOf = (c: Clip): PreFxPiece => ({
  id: c.id, from: c.offset || 0, to: (c.offset || 0) + c.duration, start: c.start,
  gain: c.gain ?? 1, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, isMuted: !!c.isMuted,
});

/** Lecture des clips actuels comme un plan d'édition de la photo, plus les ajouts. */
export function planOf(base: FreezeBase, clips: Clip[]): { plan: PreFxPlan; extras: Clip[] } {
  const plan: PreFxPlan = {};
  base.clips.forEach(b => { plan[b.id] = []; });
  const extras: Clip[] = [];
  for (const c of clips) {
    if (c.isFreezeSlice) continue;
    const src = sourceOf(c, base);
    if (src) plan[src].push(pieceOf(c));
    else extras.push(c);
  }
  Object.values(plan).forEach(ps => ps.sort((a, b) => a.from - b.from || a.start - b.start));
  return { plan, extras };
}

/** Plan « rien n'a bougé » d'un clip photographié. */
const identityPieces = (b: FreezeBaseClip): PreFxPiece[] => [{
  id: b.id, from: b.offset, to: b.offset + b.duration, start: b.start,
  gain: b.gain, fadeIn: b.fadeIn, fadeOut: b.fadeOut, isMuted: !!b.isMuted,
}];

const samePieces = (a: PreFxPiece[], b: PreFxPiece[]): boolean =>
  a.length === b.length && a.every((p, i) => {
    const q = b[i];
    return near(p.from, q.from) && near(p.to, q.to) && near(p.start, q.start) && near(p.gain, q.gain)
      && near(p.fadeIn, q.fadeIn) && near(p.fadeOut, q.fadeOut) && p.isMuted === q.isMuted;
  });

/** Ce clip photographié a-t-il été édité ? */
export const isPieceEdited = (b: FreezeBaseClip, pieces: PreFxPiece[]): boolean => !samePieces(pieces, identityPieces(b));

/**
 * REJEU : reconstruit les clips à partir de la photo et d'un plan d'édition.
 * Chaque morceau rejoue l'audio SEC d'origine (même son, offset = début du
 * morceau dans la source) ; la vraie chaîne d'effets passe ensuite dessus.
 * Idempotent : rejouer le plan des clips rejoués redonne les mêmes clips.
 */
export function replayPreFx(base: FreezeBase, plan: PreFxPlan, extras: Clip[] = []): Clip[] {
  const out: Clip[] = [];
  for (const raw of base.clips) {
    const b = raw as BaseClipFull;
    for (const p of plan[b.id] || []) {
      out.push({
        id: p.id,
        name: b.name || 'Clip',
        color: b.color || '#888888',
        type: TrackType.AUDIO,
        ...(b.bufferId ? { bufferId: b.bufferId } : {}),
        start: p.start,
        offset: p.from,
        duration: Math.max(0, p.to - p.from),
        gain: p.gain,
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
        ...(b.fadeInCurve ? { fadeInCurve: b.fadeInCurve } : {}),
        ...(b.fadeOutCurve ? { fadeOutCurve: b.fadeOutCurve } : {}),
        ...(p.isMuted ? { isMuted: true } : {}),
        freezeRef: {
          renderId: base.renderId, srcClipId: b.id, anchor: b.start - b.offset,
          from: b.offset, to: b.offset + b.duration, fadeIn: b.fadeIn, fadeOut: b.fadeOut, gain: b.gain,
        },
      });
    }
  }
  return [...out, ...extras].sort((a, b) => a.start - b.start);
}

/** Retour à la photo (version de l'ingé au moment du gel), en gardant les ajouts. */
export function revertToBase(base: FreezeBase, clips: Clip[]): Clip[] {
  const { extras } = planOf(base, clips);
  const plan: PreFxPlan = {};
  base.clips.forEach(b => { plan[b.id] = identityPieces(b); });
  // Son d'origine absent de la photo : celui d'un morceau encore présent.
  const bufOf = new Map<string, string>();
  clips.forEach(c => { const src = sourceOf(c, base); if (src && c.bufferId && !bufOf.has(src)) bufOf.set(src, c.bufferId); });
  const filled: FreezeBase = { ...base, clips: base.clips.map(b => ((b as BaseClipFull).bufferId || !bufOf.has(b.id) ? b : { ...b, bufferId: bufOf.get(b.id) } as FreezeBaseClip)) };
  return replayPreFx(filled, plan, extras);
}

/** Tous les sons d'origine de la photo sont-ils disponibles (retour possible) ? */
export const canRevert = (base: FreezeBase, clips: Clip[]): boolean => {
  const have = new Set<string>();
  clips.forEach(c => { const src = sourceOf(c, base); if (src && c.bufferId) have.add(src); });
  return base.clips.every(b => !!(b as BaseClipFull).bufferId || have.has(b.id));
};

// --- Opérations lisibles -------------------------------------------------------

const fmtS = (s: number) => `${(Math.round(s * 100) / 100).toLocaleString('fr-FR')} s`;
const db = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
const fmtDb = (d: number) => (Number.isFinite(d) ? `${d > 0 ? '+' : ''}${(Math.round(d * 10) / 10).toLocaleString('fr-FR')} dB` : 'coupé');

/** Zones de la source [from, to] non couvertes par les morceaux. */
const gapsOf = (from: number, to: number, pieces: PreFxPiece[]): [number, number][] => {
  const gaps: [number, number][] = [];
  let cur = from;
  for (const p of [...pieces].sort((a, b) => a.from - b.from)) {
    if (p.from > cur + 0.01) gaps.push([cur, Math.min(p.from, to)]);
    cur = Math.max(cur, p.to);
  }
  if (cur < to - 0.01) gaps.push([cur, to]);
  return gaps.filter(([a, b]) => b - a > 0.01);
};

const sameVolume = (a: AutomationPoint[] = [], b: AutomationPoint[] = []): boolean =>
  a.length === b.length && a.every((p, i) => near(p.time, b[i].time) && near(p.value, b[i].value, 1e-4));

/** Opérations d'un clip photographié. */
function opsOfClip(b: FreezeBaseClip, pieces: PreFxPiece[]): PreFxOp[] {
  const ops: PreFxOp[] = [];
  const timeOf = (srcPos: number) => b.start + (srcPos - b.offset);
  if (pieces.length === 0) {
    ops.push({ kind: 'delete', baseClipId: b.id, at: b.start, end: b.start + b.duration, detail: b.name || undefined });
    return ops;
  }
  const to = b.offset + b.duration;
  // Coupes : frontières entre morceaux qui se suivent dans la source.
  const sorted = [...pieces].sort((x, y) => x.from - y.from);
  for (let i = 1; i < sorted.length; i++) {
    if (near(sorted[i].from, sorted[i - 1].to, 0.01)) ops.push({ kind: 'split', baseClipId: b.id, at: timeOf(sorted[i].from) });
  }
  // Passages enlevés (début, milieu ou fin raccourcis).
  for (const [g0, g1] of gapsOf(b.offset, to, sorted)) {
    ops.push({ kind: 'remove', baseClipId: b.id, at: timeOf(g0), end: timeOf(g1), detail: fmtS(g1 - g0) });
  }
  for (const p of sorted) {
    const homeStart = timeOf(p.from);
    if (!near(p.start, homeStart)) ops.push({ kind: 'move', baseClipId: b.id, at: p.start, end: p.start + (p.to - p.from), detail: `${p.start > homeStart ? '+' : '−'}${fmtS(Math.abs(p.start - homeStart))}` });
    if (!near(p.gain, b.gain)) ops.push({ kind: 'gain', baseClipId: b.id, at: p.start, end: p.start + (p.to - p.from), detail: fmtDb(db(p.gain) - db(b.gain)) });
    const inAtEdge = near(p.from, b.offset, 0.01);
    const outAtEdge = near(p.to, to, 0.01);
    const fiWas = inAtEdge ? b.fadeIn : 0;
    const foWas = outAtEdge ? b.fadeOut : 0;
    // Les découpes posent de très courts fondus anti-clic : seuls les vrais fondus comptent.
    if (!near(p.fadeIn, fiWas, 0.02) && Math.max(p.fadeIn, fiWas) > 0.02) ops.push({ kind: 'fade', baseClipId: b.id, at: p.start, end: p.start + p.fadeIn, detail: `fondu d'entrée ${fmtS(p.fadeIn)}` });
    if (!near(p.fadeOut, foWas, 0.02) && Math.max(p.fadeOut, foWas) > 0.02) ops.push({ kind: 'fade', baseClipId: b.id, at: p.start + (p.to - p.from) - p.fadeOut, end: p.start + (p.to - p.from), detail: `fondu de sortie ${fmtS(p.fadeOut)}` });
    if (p.isMuted !== !!b.isMuted) ops.push({ kind: p.isMuted ? 'mute' : 'unmute', baseClipId: b.id, at: p.start, end: p.start + (p.to - p.from) });
  }
  return ops;
}

/** Toutes les éditions faites depuis le gel, dans l'ordre du morceau. */
export function preFxOps(t: Track): PreFxOp[] {
  const base = t.freezeBase;
  if (!base) return [];
  const { plan, extras } = planOf(base, t.clips || []);
  const ops: PreFxOp[] = [];
  for (const b of base.clips) ops.push(...opsOfClip(b, plan[b.id] || []));
  for (const c of extras) {
    if (c.notes || c.isFreezeSlice) continue;
    ops.push({ kind: 'add', at: c.start, end: c.start + c.duration, detail: c.name || undefined });
  }
  const pv = lanePoints(preVolumeLane(t));
  if (!sameVolume(pv, base.preVolume || [])) {
    const first = pv.find((p, i) => { const q = (base.preVolume || [])[i]; return !q || !near(p.time, q.time) || !near(p.value, q.value, 1e-4); });
    ops.push({ kind: 'volume', at: first?.time ?? pv[0]?.time ?? 0, detail: `${pv.length} point${pv.length > 1 ? 's' : ''} de volume` });
  }
  return ops.sort((a, b) => a.at - b.at);
}

/** Éditions qui passent AVANT les effets au dégel (les nouvelles prises n'en sont pas). */
export const countPreFxEdits = (ops: PreFxOp[]): number => ops.filter(o => o.kind !== 'add').length;

const opKey = (o: PreFxOp) => `${o.kind}|${o.baseClipId || ''}|${Math.round(o.at * 100)}|${o.detail || ''}`;

/**
 * Journal avec auteurs : une opération déjà connue garde son auteur et sa
 * date, une nouvelle prend l'auteur actuel. Vide : pas de journal.
 */
export function stampJournal(t: Track, by: string, now = Date.now()): PreFxJournal | undefined {
  const base = t.freezeBase;
  if (!base) return undefined;
  const ops = preFxOps(t);
  if (ops.length === 0) return undefined;
  const prev = t.preFxJournal && t.preFxJournal.renderId === base.renderId ? t.preFxJournal.ops : [];
  const known = new Map(prev.map(o => [opKey(o), o]));
  return {
    v: 1, renderId: base.renderId,
    ops: ops.map(o => {
      const k = known.get(opKey(o));
      return k ? { ...o, by: k.by, ts: k.ts } : { ...o, by, ts: now };
    }),
  };
}

const KIND_LABEL: Record<PreFxOp['kind'], [string, string]> = {
  split: ['coupe', 'coupes'],
  remove: ['passage enlevé', 'passages enlevés'],
  delete: ['clip supprimé', 'clips supprimés'],
  move: ['déplacement', 'déplacements'],
  gain: ['volume de clip', 'volumes de clip'],
  fade: ['fondu', 'fondus'],
  mute: ['clip coupé (mute)', 'clips coupés (mute)'],
  unmute: ['clip réactivé', 'clips réactivés'],
  volume: ['automation de volume', 'automations de volume'],
  add: ['nouvelle prise', 'nouvelles prises'],
};

/** « 3 coupes, 1 passage enlevé, 2 fondus » */
export function describeOps(ops: PreFxOp[]): string {
  const counts = new Map<PreFxOp['kind'], number>();
  ops.forEach(o => counts.set(o.kind, (counts.get(o.kind) || 0) + 1));
  return Array.from(counts.entries()).map(([k, n]) => `${n} ${KIND_LABEL[k][n > 1 ? 1 : 0]}`).join(', ');
}

/** Auteurs des éditions, du plus actif au moins actif. */
export function authorsOf(ops: PreFxOp[]): string[] {
  const n = new Map<string, number>();
  ops.forEach(o => { if (o.by) n.set(o.by, (n.get(o.by) || 0) + 1); });
  return Array.from(n.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** Ops de la piste, auteurs repris du journal enregistré. */
export function opsWithAuthors(t: Track): PreFxOp[] {
  const ops = preFxOps(t);
  const j = t.preFxJournal && t.freezeBase && t.preFxJournal.renderId === t.freezeBase.renderId ? t.preFxJournal.ops : [];
  const known = new Map(j.map(o => [opKey(o), o]));
  return ops.map(o => { const k = known.get(opKey(o)); return k ? { ...o, by: k.by, ts: k.ts } : o; });
}

/** « 12 éditions de L'AMG réappliquées avant les effets » */
export function summaryLine(n: number, authors: string[]): string {
  const who = authors.length === 0 ? '' : authors.length === 1 ? ` de ${authors[0]}` : ` de ${authors.slice(0, -1).join(', ')} et ${authors[authors.length - 1]}`;
  return `${n} édition${n > 1 ? 's' : ''}${who} réappliquée${n > 1 ? 's' : ''} avant les effets`;
}

export const fmtTime = (s: number): string => {
  const m = Math.floor(Math.max(0, s) / 60);
  const r = Math.max(0, s) - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1).replace('.', ',')}`;
};

// --- Fusion à trois voies et conflits -------------------------------------------

export interface PreFxConflict {
  baseClipId: string;
  name: string;
  at: number;
  end: number;
  /** Ce que chacun a fait sur ce passage. */
  mine: string;
  theirs: string;
}

export interface PreFxMerge {
  clips: Clip[];
  conflicts: PreFxConflict[];
  /** Clips photographiés pris chez l'autre (ses éditions gardées). */
  takenTheirs: number;
}

/**
 * Fusion des éditions de deux versions d'une même piste gelée (même photo) :
 * chaque clip photographié modifié d'un seul côté prend cette modification ;
 * modifié des deux côtés (différemment) = conflit, « mine » est gardé et le
 * conflit est expliqué. Les nouvelles prises des deux côtés sont gardées.
 */
export function mergePreFx(base: FreezeBase, mine: Clip[], theirs: Clip[]): PreFxMerge {
  const m = planOf(base, mine);
  const th = planOf(base, theirs);
  const pickFrom = new Map<string, 'mine' | 'theirs'>();
  const conflicts: PreFxConflict[] = [];
  let takenTheirs = 0;
  for (const b of base.clips) {
    const pm = m.plan[b.id] || [];
    const pt = th.plan[b.id] || [];
    const em = isPieceEdited(b, pm);
    const et = isPieceEdited(b, pt);
    if (et && !em) { pickFrom.set(b.id, 'theirs'); takenTheirs++; continue; }
    pickFrom.set(b.id, 'mine');
    if (em && et && !samePieces(pm, pt)) {
      const om = opsOfClip(b, pm);
      const ot = opsOfClip(b, pt);
      const zone = [...om, ...ot];
      conflicts.push({
        baseClipId: b.id, name: b.name || 'Clip',
        at: Math.min(b.start, ...zone.map(o => o.at)),
        end: Math.max(b.start + b.duration, ...zone.map(o => o.end ?? o.at)),
        mine: describeOps(om) || 'modifié', theirs: describeOps(ot) || 'modifié',
      });
    }
  }
  const out: Clip[] = [];
  const used = new Set<string>();
  const push = (c: Clip) => {
    let id = c.id;
    for (let k = 2; used.has(id); k++) id = `${c.id}-${k}`;
    used.add(id);
    out.push(id === c.id ? c : { ...c, id });
  };
  for (const c of mine) {
    const src = sourceOf(c, base);
    if (!src) push(c);
    else if (pickFrom.get(src) !== 'theirs') push(c);
  }
  const mineIds = new Set(mine.map(c => c.id));
  for (const c of theirs) {
    const src = sourceOf(c, base);
    if (!src) { if (!mineIds.has(c.id)) push(c); }
    else if (pickFrom.get(src) === 'theirs') push(c);
  }
  return { clips: out.sort((a, b) => a.start - b.start), conflicts, takenTheirs };
}
