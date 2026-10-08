import type { BreathEdit, Clip, ClipGainPoint, CrossfadeCurve } from '../types';
import { TrackType } from '../types';
import { envelopeDbAt, linToDb, sortGainPoints } from './clipGain';
import { handlesOf, makeCrossfade } from './fades';

/**
 * Assemblage de clips façon Pro Tools : logique pure.
 *
 * - Boucle de clip (Clip Looping) : chaque itération est un VRAI clip (même
 *   son, même offset), repéré par Clip.loop. Lecture, export, gel et
 *   collaboration n'ont rien de spécial à faire ; une ancienne version de
 *   NOVA joue la boucle telle quelle. Tirer le bord droit en mode boucle
 *   (Loop Trim) refait les itérations ; la dernière peut être partielle.
 * - Répéter n fois (Repeat, Alt+R) : copies collées les unes aux autres.
 * - Heal Separation (Ctrl+H) : recoller deux morceaux consécutifs d'un même
 *   fichier (même calage) ; le son redevient celui du clip d'avant la découpe.
 */

const EPS = 1e-6;
const endOf = (c: Pick<Clip, 'start' | 'duration'>) => c.start + c.duration;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ----------------------------------------------------------------------- boucle

export interface LoopOptions {
  /** Fondus aux jonctions (s), 0 = aucun. */
  xfade?: number;
  curve?: CrossfadeCurve;
  /** Durée du son (s) : un vrai crossfade quand il y a de l'audio au-delà des bords. */
  bufferDuration?: number;
  loopId?: string;
}

/** Plus petite itération gardée en fin de boucle (s). */
export const LOOP_MIN_TAIL = 0.005;

/** Clip d'origine d'une boucle (itération 0 remise à sa longueur et ses fondus). */
export function loopBase(c: Clip): Clip {
  if (!c.loop) return c;
  const { loop, ...rest } = c;
  return {
    ...rest,
    duration: loop.unit,
    fadeIn: loop.srcFadeIn ?? rest.fadeIn ?? 0,
    fadeOut: loop.srcFadeOut ?? rest.fadeOut ?? 0,
  };
}

/** Itérations d'une boucle, dans l'ordre. */
export const loopMembers = (clips: Clip[], loopId: string): Clip[] =>
  clips.filter(c => c.loop?.id === loopId).sort((a, b) => (a.loop!.index - b.loop!.index) || (a.start - b.start));

/**
 * Boucle `base` (clip non bouclé) jusqu'à `endTime` (temps de la timeline) :
 * renvoie les itérations (la première garde l'id du clip). Jusqu'à une seule
 * itération : le clip simplement rogné, sans boucle.
 */
export function buildLoop(base: Clip, endTime: number, opts: LoopOptions = {}): Clip[] {
  const unit = Math.max(0.01, base.duration);
  const total = endTime - base.start;
  if (total <= unit + EPS) {
    const d = Math.max(0.01, total);
    const { loop: _l, ...plain } = base;
    return [{ ...plain, duration: d, fadeOut: Math.min(base.fadeOut || 0, d) }];
  }
  const id = opts.loopId || `loop-${uid()}`;
  const xf = Math.max(0, opts.xfade || 0);
  const count = Math.ceil((total - LOOP_MIN_TAIL) / unit);
  const srcFadeIn = base.fadeIn || 0, srcFadeOut = base.fadeOut || 0;
  const out: Clip[] = [];
  for (let k = 0; k < count; k++) {
    const start = base.start + k * unit;
    const duration = Math.min(unit, endTime - start);
    if (duration < LOOP_MIN_TAIL) break;
    const last = k === count - 1;
    out.push({
      ...base,
      id: k === 0 ? base.id : `${id}~${k}`,
      start,
      duration,
      fadeIn: k === 0 ? Math.min(srcFadeIn, duration) : 0,
      fadeOut: last ? Math.min(srcFadeOut, duration) : 0,
      // Copies : pas de second point de synchro ni de second numéro de prise.
      ...(k > 0 ? { syncPoint: undefined, takeNumber: undefined } : {}),
      loop: { id, index: k, unit, ...(xf > 0 ? { xfade: xf } : {}), srcFadeIn, srcFadeOut },
    });
  }
  if (xf > 0) for (let k = 1; k < out.length; k++) junctionFade(out[k - 1], out[k], xf, opts);
  return out;
}

/**
 * Fondu à la jonction de deux itérations : un vrai crossfade centré si le son
 * a de la marge au-delà des bords (comme le « crossfade » de la fenêtre Loop
 * de Pro Tools), sinon deux fondus courts bout à bout (jamais de clic).
 */
function junctionFade(a: Clip, b: Clip, xf: number, opts: LoopOptions) {
  const curve = opts.curve || 'EQUAL_POWER';
  if (opts.bufferDuration !== undefined) {
    const x = makeCrossfade(a, b, xf, curve, handlesOf(a, b, () => opts.bufferDuration));
    if (x && Math.abs(x.end - x.start - xf) < 1e-4) { Object.assign(a, x.a); Object.assign(b, x.b); return; }
  }
  const h = Math.min(xf / 2, a.duration / 3, b.duration / 3);
  a.fadeOut = Math.max(a.fadeOut || 0, h); a.fadeOutCurve = curve;
  b.fadeIn = Math.max(b.fadeIn || 0, h); b.fadeInCurve = curve;
}

/** Boucler n fois (Pro Tools : Loop… « Number of Loops »). */
export const loopCount = (base: Clip, n: number, opts: LoopOptions = {}): Clip[] =>
  buildLoop(base, base.start + Math.max(1, Math.round(n)) * Math.max(0.01, base.duration), opts);

/**
 * Loop Trim : tirer le bord droit d'un clip (bouclé ou non) jusqu'à `endTime`.
 * Renvoie les clips à retirer et ceux à poser (une étape d'annulation).
 */
export function loopTrim(trackClips: Clip[], clipId: string, endTime: number, opts: LoopOptions = {}): { remove: string[]; add: Clip[] } | null {
  const c = trackClips.find(x => x.id === clipId);
  if (!c || c.type === TrackType.MIDI) return null;
  const members = c.loop ? loopMembers(trackClips, c.loop.id) : [c];
  const first = members[0];
  const base = loopBase(first);
  const add = buildLoop(base, Math.max(base.start + 0.01, endTime), {
    ...opts, loopId: c.loop?.id || opts.loopId, xfade: opts.xfade ?? c.loop?.xfade,
  });
  return { remove: members.map(m => m.id), add };
}

/** Défaire la boucle (Pro Tools : Unloop) : il ne reste que le clip d'origine. */
export function unloop(trackClips: Clip[], clipId: string): { remove: string[]; add: Clip[] } | null {
  const c = trackClips.find(x => x.id === clipId);
  if (!c?.loop) return null;
  const members = loopMembers(trackClips, c.loop.id);
  return { remove: members.map(m => m.id), add: [loopBase(members[0])] };
}

// ------------------------------------------------------------------ répéter

/**
 * Répéter n fois (Pro Tools : Repeat, Alt+R) : les clips donnés (d'une ou
 * plusieurs pistes) sont recopiés n fois à la suite, en gardant leurs écarts.
 */
export function repeatClips(clips: Clip[], n: number): Clip[] {
  if (!clips.length || n < 1) return [];
  const s = Math.min(...clips.map(c => c.start));
  const span = Math.max(...clips.map(endOf)) - s;
  if (span <= 0) return [];
  const out: Clip[] = [];
  const tag = uid();
  for (let k = 1; k <= Math.min(256, Math.round(n)); k++) {
    for (const c of clips) {
      const { loop: _l, ...plain } = c;
      out.push({ ...plain, id: `${c.id}-rep${k}-${tag}`, start: c.start + k * span, syncPoint: undefined, takeNumber: undefined });
    }
  }
  return out;
}

// --------------------------------------------------------------------- Heal

/** Tolérance de calage entre deux morceaux d'un même fichier (≈ 5 échantillons à 48 kHz). */
export const HEAL_TOL = 1e-4;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Pourquoi deux clips (a avant b) ne peuvent pas être recollés ; null s'ils le peuvent. */
export function healBlocker(a: Clip, b: Clip): string | null {
  if (a.type === TrackType.MIDI || b.type === TrackType.MIDI) return 'Heal ne recolle que des clips audio.';
  if (!a.bufferId || a.bufferId !== b.bufferId) return 'Ces deux clips ne viennent pas du même fichier.';
  if (!!a.isReversed !== !!b.isReversed) return 'L’un des deux clips est inversé.';
  if (!!a.isMuted !== !!b.isMuted) return 'L’un des deux clips est muet.';
  if (a.loop || b.loop) return 'Ce sont des itérations de boucle : défais la boucle d’abord.';
  if (!sameJson(a.warp, b.warp)) return 'Les deux clips n’ont pas le même étirement.';
  // Même calage : le son de b continue celui de a à la même place.
  if (Math.abs((a.start - (a.offset || 0)) - (b.start - (b.offset || 0))) > HEAL_TOL) return 'Les deux morceaux ont été déplacés l’un par rapport à l’autre.';
  if (b.start > endOf(a) + HEAL_TOL) return 'Il y a un trou entre les deux morceaux.';
  if (endOf(b) <= endOf(a) + EPS) return 'Un morceau en recouvre entièrement un autre.';
  return null;
}

/**
 * Recolle a (avant) et b (après). Le son redevient celui d'un clip unique :
 * les fondus de la jonction disparaissent, ceux des bords extérieurs restent.
 * `exact` = false quand les deux gains différaient (petite rampe de 5 ms).
 */
export function healPair(a: Clip, b: Clip): { clip: Clip; exact: boolean } {
  const anchor = a.start - (a.offset || 0);
  const J = b.start;                       // jonction (timeline)
  const Jsrc = J - anchor;                 // jonction (audio source)
  const ga = linToDb(a.gain ?? 1), gb = linToDb(b.gain ?? 1);
  const pa = sortGainPoints(a.gainPoints), pb = sortGainPoints(b.gainPoints);
  let gainPoints: ClipGainPoint[] | undefined;
  let gain = a.gain ?? 1;
  let exact = true;
  if (sameJson(pa, pb) && Math.abs(ga - gb) < 1e-4) {
    gainPoints = pa.length ? pa : undefined;
  } else {
    // Lignes ou gains différents : chaque côté garde sa ligne, gain global ramené dans la ligne.
    const da = (t: number) => envelopeDbAt(pa, t) + (Number.isFinite(ga) ? ga : -60);
    const db = (t: number) => envelopeDbAt(pb, t) + (Number.isFinite(gb) ? gb : -60);
    gain = 1;
    const left = pa.filter(p => p.t < Jsrc - 1e-6).map(p => ({ ...p, db: p.db + (Number.isFinite(ga) ? ga : -60) }));
    const right = pb.filter(p => p.t > Jsrc + 1e-6).map(p => ({ ...p, db: p.db + (Number.isFinite(gb) ? gb : -60) }));
    const vA = da(Jsrc), vB = db(Jsrc);
    const R = 0.0025;
    const pts: ClipGainPoint[] = [...left];
    if (Math.abs(vA - vB) < 1e-4) pts.push({ t: Jsrc, db: vA });
    else { exact = false; pts.push({ t: Jsrc - R, db: da(Jsrc - R) }, { t: Jsrc + R, db: db(Jsrc + R) }); }
    pts.push(...right);
    // Le premier point de a tient avant lui-même, comme avant le recollage.
    if (!left.length && pa.length) pts.unshift({ t: Math.min(a.offset || 0, Jsrc - 0.01), db: da(a.offset || 0) });
    gainPoints = pts.sort((x, y) => x.t - y.t);
  }
  const breaths = mergeBreaths(a.breaths, b.breaths);
  const end = endOf(b);
  const duration = end - a.start;
  const { loop: _l, ...rest } = a;
  const clip: Clip = {
    ...rest,
    duration,
    gain,
    gainPoints,
    fadeIn: Math.min(a.fadeIn || 0, duration),
    fadeInCurve: a.fadeInCurve,
    fadeOut: Math.min(b.fadeOut || 0, Math.max(0, duration - (a.fadeIn || 0))),
    fadeOutCurve: b.fadeOutCurve,
    ...(breaths ? { breaths } : { breaths: undefined }),
    syncPoint: a.syncPoint ?? b.syncPoint,
  };
  return { clip, exact };
}

function mergeBreaths(x?: BreathEdit[], y?: BreathEdit[]): BreathEdit[] | undefined {
  const all = [...(x || []), ...(y || [])];
  if (!all.length) return undefined;
  const seen = new Set<string>();
  return all.filter(e => { const k = `${e.start.toFixed(5)}:${e.end.toFixed(5)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((p, q) => p.start - q.start);
}

/**
 * Heal sur une piste : recolle toutes les paires consécutives recollables
 * parmi `candidates` (ids ; absent = tous les clips). Renvoie les clips de la
 * piste après coup, le nombre de recollages et la première raison d'échec.
 */
export function healTrack(trackClips: Clip[], candidates?: Set<string>): { clips: Clip[]; healed: number; exact: boolean; reason: string | null; removed: string[] } {
  let list = trackClips.slice();
  let healed = 0, exact = true;
  let reason: string | null = null;
  const removed: string[] = [];
  let again = true;
  while (again) {
    again = false;
    const cand = list.filter(c => !candidates || candidates.has(c.id)).sort((p, q) => p.start - q.start);
    outer: for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const a = cand[i], b = cand[j];
        if (b.start > endOf(a) + HEAL_TOL) break;
        const why = healBlocker(a, b);
        if (why) { if (!reason) reason = why; continue; }
        const r = healPair(a, b);
        if (!r.exact) exact = false;
        list = list.filter(c => c.id !== b.id).map(c => (c.id === a.id ? r.clip : c));
        removed.push(b.id);
        if (candidates) candidates.add(a.id);
        healed++;
        again = true;
        break outer;
      }
    }
  }
  return { clips: list, healed, exact, reason: healed ? null : reason, removed };
}
