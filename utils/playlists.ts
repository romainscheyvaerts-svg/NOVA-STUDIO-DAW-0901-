import { Clip, TakeMeta, Track } from '../types';
import { fmtTime, takeNumberOf } from './takes';
import { CompOptions, compSwipe, compUsage, isCompClip, readComp, rebuildTakeClips, takeSpans, TakeSpan } from './comping';

/**
 * Couloirs de prises : les « Playlists » de Pro Tools, les « take lanes »
 * d'Ableton, le dossier de prises de Logic. Logique pure (tests/playlists.test.ts).
 *
 * Chaque prise (clips portant le même `takeNumber`) a son couloir sous la
 * piste. L'audio reste dans `track.clips` (rien à changer pour la sauvegarde,
 * le gel ou la collab) ; `track.takeMeta` décore les couloirs (nom, heure,
 * tour de boucle). Les anciens projets (« Prise N » mutées les unes sous les
 * autres) s'ouvrent tels quels : leurs couloirs se déduisent des clips.
 */

export interface TakeLane {
  n: number;
  /** « Prise 3 · 21:14 · 0:42 » (nom choisi, heure, durée). */
  label: string;
  /** Nom seul (« Prise 3 » ou le nom choisi). */
  name: string;
  /** Infobulle détaillée. */
  title: string;
  /** Morceaux d'audio du couloir. */
  spans: TakeSpan[];
  clipIds: string[];
  start: number;
  end: number;
  /** Durée d'audio de la prise (s). */
  duration: number;
  /** Durée entendue dans le comp (s). */
  used: number;
  meta?: TakeMeta;
}

const two = (v: number) => String(v).padStart(2, '0');
/** Heure locale « 21:14 ». */
export const clockOf = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

export const metaOf = (track: Pick<Track, 'takeMeta'>, n: number): TakeMeta | undefined =>
  (track.takeMeta || []).find(m => m && m.n === n);

/** Nom lisible d'une prise : « Prise 3 · 21:14 · 0:42 ». */
export function takeLabel(n: number, duration: number, meta?: TakeMeta): string {
  const parts = [meta?.name?.trim() || `Prise ${n}`];
  if (meta?.recordedAt) parts.push(clockOf(meta.recordedAt));
  parts.push(fmtTime(duration));
  return parts.join(' · ');
}

/** Couloirs de la piste, dans l'ordre des prises (Prise 1 en haut). */
export function listLanes(track: Pick<Track, 'clips' | 'takeMeta'>): TakeLane[] {
  const spans = takeSpans(track.clips || []);
  const usage = compUsage(track.clips || []);
  const byN = new Map<number, TakeLane>();
  for (const c of track.clips || []) {
    const n = takeNumberOf(c);
    if (n === null) continue;
    let lane = byN.get(n);
    if (!lane) {
      lane = { n, label: '', name: '', title: '', spans: [], clipIds: [], start: Infinity, end: -Infinity, duration: 0, used: 0, meta: metaOf(track, n) };
      byN.set(n, lane);
    }
    lane.clipIds.push(c.id);
    lane.start = Math.min(lane.start, c.start);
    lane.end = Math.max(lane.end, c.start + c.duration);
  }
  for (const lane of byN.values()) {
    lane.spans = spans.filter(s => s.n === lane.n);
    lane.duration = lane.spans.length ? lane.spans.reduce((a, s) => a + (s.end - s.start), 0) : lane.end - lane.start;
    lane.used = usage.get(lane.n) || 0;
    lane.name = lane.meta?.name?.trim() || `Prise ${lane.n}`;
    lane.label = takeLabel(lane.n, lane.duration, lane.meta);
    const bits = [`${lane.name} : ${fmtTime(lane.duration)} de voix, de ${fmtTime(lane.start)} à ${fmtTime(lane.end)} dans le morceau`];
    if (lane.meta?.recordedAt) bits.push(`enregistrée à ${clockOf(lane.meta.recordedAt)}`);
    if (lane.meta?.loopPass) bits.push(`tour de boucle n° ${lane.meta.loopPass}`);
    bits.push(lane.used > 0.05 ? `entendue ${fmtTime(lane.used)} dans ta voix finale` : 'pas utilisée dans ta voix finale');
    lane.title = bits.join(' · ');
  }
  return Array.from(byN.values()).sort((a, b) => a.n - b.n);
}

export const takeCount = (track: Pick<Track, 'clips'>): number =>
  new Set((track.clips || []).map(c => takeNumberOf(c)).filter(n => n !== null)).size;

export const nextTakeNumber = (track: Pick<Track, 'clips'>): number =>
  1 + (track.clips || []).reduce((max, c) => Math.max(max, takeNumberOf(c) ?? 0), 0);

/**
 * Clips montrés sur la ligne principale : avec plusieurs prises, les passages
 * mutés recouverts par ce qu'on entend sont rangés dans les couloirs (au lieu
 * d'être empilés et coupés sous la nouvelle prise).
 */
export function mainRowClips(track: Pick<Track, 'clips'>): Clip[] {
  const clips = track.clips || [];
  if (takeCount(track) < 2) return clips;
  const audible = clips.filter(c => !c.isMuted);
  return clips.filter(c => {
    if (!c.isMuted || takeNumberOf(c) === null) return true;
    // Caché si entièrement recouvert par de l'audio entendu (à 25 ms près).
    const s = c.start + 0.025, e = c.start + c.duration - 0.025;
    if (e <= s) return !audible.some(o => o.start <= c.start && o.start + o.duration >= c.start + c.duration);
    const cover = audible.filter(o => o.start < e && o.start + o.duration > s).sort((a, b) => a.start - b.start);
    let cur = s;
    for (const o of cover) { if (o.start > cur + 1e-4) break; cur = Math.max(cur, o.start + o.duration); }
    return cur < e - 1e-4;
  });
}

/** Clip sous la souris sur la ligne principale : celui qu'on entend d'abord. */
export function clipAtTime(clips: Clip[], t: number): Clip | undefined {
  let best: Clip | undefined;
  for (const c of clips) {
    if (t < c.start || t > c.start + c.duration) continue;
    if (!best || (!!best.isMuted && !c.isMuted) || (!!best.isMuted === !!c.isMuted)) best = c;
  }
  return best;
}

/**
 * Écoute d'une prise en solo (comme le solo d'un couloir de Pro Tools) : la
 * prise n entière est audible, les autres prises se taisent, le reste de la
 * piste ne change pas. Rien n'est écrit dans le projet.
 */
export function auditionClips(clips: Clip[], n: number): Clip[] {
  const spans = takeSpans(clips);
  const mine = spans.filter(s => s.n === n);
  if (!mine.length) return clips;
  return rebuildTakeClips(clips, spans, mine.map(s => ({ start: s.start, end: s.end, n, span: s.key })), { newId: b => `${b}~solo${Math.random().toString(36).slice(2, 7)}` });
}

// ------------------------------------------------------------- gestion des couloirs

/** Met à jour (ou crée) les infos d'une prise. */
export function patchMeta(meta: TakeMeta[] | undefined, n: number, patch: Partial<TakeMeta>): TakeMeta[] {
  const list = (meta || []).filter(m => m && typeof m.n === 'number');
  const i = list.findIndex(m => m.n === n);
  const cur = i >= 0 ? list[i] : { n };
  const next: TakeMeta = { ...cur, ...patch, n };
  if (patch.name !== undefined && !String(patch.name).trim()) delete next.name;
  return i >= 0 ? list.map((m, k) => (k === i ? next : m)) : [...list, next].sort((a, b) => a.n - b.n);
}

export function renameTake(meta: TakeMeta[] | undefined, n: number, name: string): TakeMeta[] {
  return patchMeta(meta, n, { name: name.trim().slice(0, 40) });
}

/**
 * Supprime une prise et son couloir. Si elle était entendue dans le comp, la
 * prise la plus récente qui a de l'audio au même endroit la remplace (sinon
 * il resterait un trou dans la voix finale).
 */
export function deleteTake(track: Pick<Track, 'clips' | 'takeMeta'>, n: number, opts: CompOptions = {}):
  { clips: Clip[]; takeMeta: TakeMeta[]; replacedBy: number[]; removedClipIds: string[] } {
  const clips = track.clips || [];
  const holes = readComp(clips).filter(s => s.n === n);
  const removedClipIds = clips.filter(c => takeNumberOf(c) === n).map(c => c.id);
  let next = clips.filter(c => takeNumberOf(c) !== n);
  const replacedBy = new Set<number>();
  for (const h of holes) {
    const others = takeSpans(next).filter(s => s.start < h.end && s.end > h.start).map(s => s.n);
    const best = others.length ? Math.max(...others) : null;
    if (best === null) continue;
    const r = compSwipe(next, best, h.start, h.end, opts);
    if (r.changed) { next = r.clips; replacedBy.add(best); }
  }
  return { clips: next, takeMeta: (track.takeMeta || []).filter(m => m && m.n !== n), replacedBy: Array.from(replacedBy), removedClipIds };
}

/**
 * Duplique une prise dans un nouveau couloir (prise muette, même audio) :
 * comme « Dupliquer la playlist » de Pro Tools, pour essayer des retouches
 * sans risquer l'originale.
 */
export function duplicateTake(track: Pick<Track, 'clips' | 'takeMeta'>, n: number, stamp = Date.now().toString(36)):
  { clips: Clip[]; takeMeta: TakeMeta[]; newN: number } | null {
  const spans = takeSpans(track.clips || []).filter(s => s.n === n);
  if (!spans.length) return null;
  const newN = nextTakeNumber(track);
  const copies: Clip[] = spans.map((s, i) => {
    const c: Clip = {
      ...s.base, id: `${s.key}-dup${stamp}${i}`, takeNumber: newN, start: s.start, duration: s.end - s.start,
      offset: s.start - s.anchor, fadeIn: s.fadeIn, fadeOut: s.fadeOut, isMuted: true,
      name: spans.length > 1 ? `Prise ${newN} (partie ${i + 1})` : `Prise ${newN}`,
    };
    if (s.fadeInCurve) c.fadeInCurve = s.fadeInCurve; else delete c.fadeInCurve;
    if (s.fadeOutCurve) c.fadeOutCurve = s.fadeOutCurve; else delete c.fadeOutCurve;
    return c;
  });
  const src = metaOf(track, n);
  const takeMeta = patchMeta(track.takeMeta, newN, {
    name: `${src?.name?.trim() || `Prise ${n}`} (copie)`.slice(0, 40),
    ...(src?.recordedAt ? { recordedAt: src.recordedAt } : {}),
  });
  return { clips: [...(track.clips || []), ...copies], takeMeta, newN };
}

/** Garde la prise n sur toute sa longueur (bouton « Garder »). */
export function keepTake(clips: Clip[], n: number, opts: CompOptions = {}): Clip[] {
  const spans = takeSpans(clips).filter(s => s.n === n);
  if (!spans.length) return clips;
  return compSwipe(clips, n, Math.min(...spans.map(s => s.start)), Math.max(...spans.map(s => s.end)), opts).clips;
}

// ---------------------------------------------------------------------- Loop Record

/** Tour de boucle le plus court gardé comme prise (s). */
export const MIN_LOOP_PASS_SEC = 1;

export interface LoopPass {
  /** 1, 2, 3… */
  pass: number;
  start: number;
  duration: number;
  /** Offset dans l'audio enregistré. */
  offset: number;
  /** Le tour est allé jusqu'au bout de la boucle. */
  complete: boolean;
}

/**
 * Loop Record (comme Pro Tools / Logic) : l'enregistreur tourne sans s'arrêter
 * pendant que la lecture reboucle. La prise est « déroulée » sur le temps (son
 * début est déjà recalé de la latence) : chaque passage de la fin de boucle
 * commence un nouveau tour, replacé au début de la boucle.
 */
export function splitLoopPasses(take: Pick<Clip, 'start' | 'duration' | 'offset'>, loopStart: number, loopEnd: number): LoopPass[] {
  const len = loopEnd - loopStart;
  const s0 = take.start;
  const end = take.start + take.duration;
  const off0 = take.offset || 0;
  if (!(len > 0.05) || end <= loopEnd + 1e-3) {
    return [{ pass: 1, start: s0, duration: take.duration, offset: off0, complete: end >= loopEnd - 0.05 }];
  }
  const out: LoopPass[] = [];
  // Tour 1 : du début de la prise à la fin de boucle.
  out.push({ pass: 1, start: s0, duration: loopEnd - s0, offset: off0, complete: true });
  for (let k = 1; ; k++) {
    const b = loopEnd + (k - 1) * len;
    if (b >= end - 1e-6) break;
    const d = Math.min(len, end - b);
    out.push({ pass: k + 1, start: loopStart, duration: d, offset: off0 + (b - s0), complete: d >= len - 0.05 });
  }
  return out;
}

/**
 * Les tours gardés : les tours complets, plus le dernier tour inachevé s'il
 * dure au moins MIN_LOOP_PASS_SEC. Le dernier tour complet est celui qu'on
 * entend (comme dans Pro Tools : la dernière prise est active).
 */
export function keptLoopPasses(passes: LoopPass[]): { kept: LoopPass[]; active: number } {
  const kept = passes.filter((p, i) => p.complete || (i === passes.length - 1 && p.duration >= MIN_LOOP_PASS_SEC) || passes.length === 1);
  const complete = kept.filter(p => p.complete);
  const active = (complete.length ? complete[complete.length - 1] : kept[kept.length - 1])?.pass ?? 1;
  return { kept, active };
}

// ---------------------------------------------------------------------- Punch

/**
 * Punch sur une piste à prises : `cutAroundPunch` (utils/punch) retire de
 * l'ancienne prise le passage remplacé. Pour qu'elle reste entière dans son
 * couloir, on remet ce passage, muté. (Pour les clips qui ne sont pas des
 * prises, rien ne change.)
 */
export function punchedPassages(oldClips: Clip[], punchIn: number, punchOut: number, stamp: string): Clip[] {
  const out: Clip[] = [];
  oldClips.forEach((c, i) => {
    const cEnd = c.start + c.duration;
    if (c.isMuted || !isCompClip(c) || cEnd <= punchIn || c.start >= punchOut) return;
    const a = Math.max(c.start, punchIn), b = Math.min(cEnd, punchOut);
    if (b - a <= 1e-6) return;
    out.push({
      ...c, id: `${c.id}-p${stamp}${i}`, start: a, duration: b - a, offset: (c.offset || 0) + (a - c.start),
      fadeIn: 0.005, fadeOut: 0.005, isMuted: true,
    });
  });
  return out.map(c => { const x = { ...c }; delete x.fadeInCurve; delete x.fadeOutCurve; return x; });
}

// ---------------------------------------------------------------------- collaboration

/**
 * Op « content » de la collab : `takeMeta` est un champ ajouté. Une ancienne
 * version l'ignore (elle lit seulement les champs qu'elle connaît et joue le
 * comp, déjà dans les clips). Une version récente qui reçoit un contenu sans
 * `takeMeta` (envoyé par une ancienne version) garde ses noms de couloirs.
 */
export function mergeIncomingTakeMeta(local: TakeMeta[] | undefined, incoming: unknown): TakeMeta[] | undefined {
  if (!Array.isArray(incoming)) return local;
  return incoming.filter((m: any) => m && typeof m.n === 'number' && Number.isFinite(m.n)).map((m: any) => {
    const x: TakeMeta = { n: m.n };
    if (typeof m.name === 'string' && m.name.trim()) x.name = m.name.slice(0, 40);
    if (typeof m.recordedAt === 'number') x.recordedAt = m.recordedAt;
    if (typeof m.loopPass === 'number') x.loopPass = m.loopPass;
    if (m.score && typeof m.score.total === 'number') x.score = m.score;
    return x;
  });
}
