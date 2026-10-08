/**
 * R13 · Transposer, étirer et recaler un clip audio (Pro Tools Elastic Audio /
 * Clip Transpose / Trim TCE, Logic Flex Time et Flex Pitch, Ableton Warp,
 * FL « Stretch / Pitch » d'un clip audio).
 *
 * Non destructif, comme la justesse (utils/pitchEdit) et AudioSuite
 * (utils/clipProcess) : le clip joue un son rendu hors ligne une fois (lecture
 * = export, c'est le même son). Le son d'origine et les réglages restent dans
 * `Clip.elastic` : on rouvre le réglage, on retouche (toujours depuis
 * l'original, jamais un rendu de rendu), ou on revient à l'original. Une
 * ancienne version de NOVA ignore le champ et joue le son rendu.
 *
 * Temps : une fonction affine par morceaux relie le son d'origine (s) au temps
 * du clip (s depuis son début). Ancres : le début de la partie montrée (→ 0),
 * les marqueurs de warp, la fin (→ durée étirée). Au-delà des bords, la pente
 * du premier / dernier morceau continue (les marges rendues servent à
 * rallonger le clip).
 *
 * Moteurs (choix automatique selon le son, ou forcé) :
 *  - « voix » : PSOLA (celui de la justesse, utils/pitchRender) pour une voix
 *    seule — formants gardés, aucun effet chipmunk ;
 *  - « polyphonique » : vocodeur de phase verrouillé (engine/phaseVocoder)
 *    puis rééchantillonnage, pour un beat, un sample, des accords.
 * L'étirement passe toujours par le vocodeur de phase (attaques remises en
 * phase).
 */
import { TrackType } from '../types';
import type { BreathEdit, Clip, ClipGainPoint, ElasticInfo } from '../types';
import { pvStretch, resampleStep } from '../engine/phaseVocoder';
import { analyzePitch } from './pitchAnalysis';
import { renderPitch } from './pitchRender';
import { detectTransients } from './transients';

export type { ElasticInfo, ElasticMarker } from '../types';

/** Marge rendue de chaque côté de la partie montrée (s) : on peut rallonger le clip sans tout recalculer. */
export const ELASTIC_PAD = 0.5;
/** Bornes : ±12 demi-tons ; étirement de 25 % à 400 %. */
export const MAX_SEMITONES = 12;
export const MIN_STRETCH = 0.25;
export const MAX_STRETCH = 4;

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const clampSt = (v: number) => Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, Math.round(v * 100) / 100));

// ─── Fonction du temps ────────────────────────────────────────────────────────

/** Ancres triées : début de la partie montrée, marqueurs, fin. */
export function anchorsOf(info: Pick<ElasticInfo, 'sourceOffset' | 'sourceDuration' | 'duration' | 'markers'>): { src: number; dst: number }[] {
  const a = [{ src: info.sourceOffset, dst: 0 }];
  const end = info.sourceOffset + info.sourceDuration;
  for (const m of [...(info.markers || [])].sort((x, y) => x.src - y.src)) {
    if (m.src > a[a.length - 1].src + 1e-6 && m.src < end - 1e-6 && m.dst > a[a.length - 1].dst + 1e-6 && m.dst < info.duration - 1e-6) a.push({ src: m.src, dst: m.dst });
  }
  a.push({ src: end, dst: info.duration });
  return a;
}

/** Instant du clip (s depuis le début de la partie montrée) qui joue l'instant `s` du son d'origine. */
export function mapTime(info: Parameters<typeof anchorsOf>[0], s: number): number {
  const a = anchorsOf(info);
  let i = 0;
  while (i + 2 < a.length && s > a[i + 1].src) i++;
  const p = a[i], q = a[i + 1];
  const slope = q.src > p.src ? (q.dst - p.dst) / (q.src - p.src) : 1;
  return p.dst + (s - p.src) * slope;
}

/** Inverse de mapTime : instant du son d'origine joué à `d` s du début du clip. */
export function unmapTime(info: Parameters<typeof anchorsOf>[0], d: number): number {
  const a = anchorsOf(info);
  let i = 0;
  while (i + 2 < a.length && d > a[i + 1].dst) i++;
  const p = a[i], q = a[i + 1];
  const slope = q.dst > p.dst ? (q.src - p.src) / (q.dst - p.dst) : 1;
  return p.src + (d - p.dst) * slope;
}

/** Rapport d'étirement global (durée étirée / durée d'origine). */
export const stretchOf = (info: Pick<ElasticInfo, 'duration' | 'sourceDuration'>): number =>
  info.sourceDuration > 0 ? info.duration / info.sourceDuration : 1;

/** Réglage sans effet (on revient alors simplement à l'original). */
export const isNeutralElastic = (info: ElasticInfo): boolean =>
  Math.abs(info.semitones) < 0.005 && Math.abs(info.duration - info.sourceDuration) < 1e-6 && !(info.markers || []).some(m => Math.abs(m.dst - (m.src - info.sourceOffset)) > 1e-6);

// ─── Réglage de départ, retouches ─────────────────────────────────────────────

/**
 * Le réglage tel qu'on l'édite. Clip déjà rendu dont on a l'original : son
 * réglage, ramené à la partie montrée aujourd'hui (le clip a pu être rogné ou
 * coupé depuis). Sinon : réglage neutre sur le son actuel du clip (reçu en
 * collaboration : on repart du son rendu).
 */
export function editingElastic(clip: Clip, hasBuffer: (id: string) => boolean): { bufferId?: string; info: ElasticInfo; fromOriginal: boolean } {
  const e = clip.elastic;
  if (e?.sourceBufferId && hasBuffer(e.sourceBufferId)) {
    return { bufferId: e.sourceBufferId, info: rebaseVisible(e, (clip.offset || 0) - e.renderedOffset, clip.duration), fromOriginal: true };
  }
  const info: ElasticInfo = {
    version: 1,
    sourceBufferId: clip.bufferId,
    sourceOffset: clip.offset || 0,
    sourceDuration: clip.duration,
    regionStart: 0, regionEnd: 0, renderedOffset: 0,
    duration: clip.duration,
    semitones: 0,
    formants: true,
    algo: 'auto',
    ...(e ? { sourceName: e.sourceName } : {}),
  };
  return { bufferId: clip.bufferId, info, fromOriginal: false };
}

/** Le clip montre aujourd'hui [v0, v0 + dur] du son rendu (en temps du clip) : réglage ramené à cette partie. */
export function rebaseVisible(e: ElasticInfo, v0: number, dur: number): ElasticInfo {
  if (Math.abs(v0) < 1e-6 && Math.abs(dur - e.duration) < 1e-6) return { ...e, markers: e.markers ? e.markers.map(m => ({ ...m })) : undefined };
  const s0 = unmapTime(e, v0), s1 = unmapTime(e, v0 + dur);
  const markers = (e.markers || []).filter(m => m.dst > v0 + 1e-6 && m.dst < v0 + dur - 1e-6).map(m => ({ ...m, dst: r6(m.dst - v0) }));
  return { ...e, sourceOffset: r6(s0), sourceDuration: r6(Math.max(1e-3, s1 - s0)), duration: r6(dur), markers: markers.length ? markers : undefined };
}

/** Trim TCE : la partie montrée dure maintenant `newDuration` (s), contenu étiré d'autant (marqueurs compris). */
export function withDuration(info: ElasticInfo, newDuration: number): ElasticInfo {
  const minD = info.sourceDuration * MIN_STRETCH, maxD = info.sourceDuration * MAX_STRETCH;
  const d = Math.max(minD, Math.min(maxD, newDuration));
  const k = info.duration > 0 ? d / info.duration : 1;
  return { ...info, duration: r6(d), markers: info.markers?.map(m => ({ ...m, dst: r6(m.dst * k) })) };
}

export const withSemitones = (info: ElasticInfo, st: number): ElasticInfo => ({ ...info, semitones: clampSt(st) });

/** Calage au tempo (warp automatique) : un son à `sourceBpm` joué à `bpm`. */
export function withTempo(info: ElasticInfo, sourceBpm: number, bpm: number): ElasticInfo {
  if (!(sourceBpm > 0 && bpm > 0)) return info;
  const out = withDuration(info, info.sourceDuration * (sourceBpm / bpm));
  return { ...out, tempo: { sourceBpm, bpm } };
}

let markerSeq = 0;
const markerId = () => `wm-${Date.now().toString(36)}-${(markerSeq++).toString(36)}`;

/**
 * Pose (ou déplace) un marqueur : l'instant `src` du son d'origine joue à
 * `dst` s du début du clip. Le marqueur reste entre ses voisins (au moins
 * 5 ms d'écart, pas d'inversion du temps).
 */
export function placeMarker(info: ElasticInfo, src: number, dst: number, id?: string): ElasticInfo {
  const others = (info.markers || []).filter(m => m.id !== id && Math.abs(m.src - src) > 1e-4);
  const end = info.sourceOffset + info.sourceDuration;
  if (src <= info.sourceOffset + 0.005 || src >= end - 0.005) return info;
  const before = [{ src: info.sourceOffset, dst: 0 }, ...others.filter(m => m.src < src)].reduce((a, b) => (b.src > a.src ? b : a));
  const after = [{ src: end, dst: info.duration }, ...others.filter(m => m.src > src)].reduce((a, b) => (b.src < a.src ? b : a));
  // Pente bornée de chaque côté (25 % à 400 %).
  const lo = Math.max(before.dst + (src - before.src) * MIN_STRETCH, after.dst - (after.src - src) * MAX_STRETCH, before.dst + 0.005);
  const hi = Math.min(before.dst + (src - before.src) * MAX_STRETCH, after.dst - (after.src - src) * MIN_STRETCH, after.dst - 0.005);
  if (lo > hi) return info;
  const d = Math.max(lo, Math.min(hi, dst));
  const markers = [...others, { id: id || markerId(), src: r6(src), dst: r6(d) }].sort((a, b) => a.src - b.src);
  return { ...info, markers };
}

/** Retire un marqueur (le morceau redevient régulier entre ses voisins). */
export const removeMarker = (info: ElasticInfo, id: string): ElasticInfo => {
  const markers = (info.markers || []).filter(m => m.id !== id);
  return { ...info, markers: markers.length ? markers : undefined };
};

/**
 * « Quantifier l'audio » (Elastic Audio Quantize, Flex Time de Logic) : chaque
 * attaque du son d'origine (`onsets`, s) vient sur la ligne de grille la plus
 * proche, de `strength` (0-1). `clipStart` : position du clip sur la timeline ;
 * `grid` : pas de grille (s) ; `gridOrigin` : 0 en général. Les attaques
 * tombées entre deux autres trop proches sont laissées.
 */
export function quantizeOnsets(info: ElasticInfo, onsets: number[], clipStart: number, grid: number, strength = 1, gridOrigin = 0): ElasticInfo {
  if (!(grid > 0)) return info;
  let out: ElasticInfo = { ...info, markers: undefined };
  const end = info.sourceOffset + info.sourceDuration;
  const targets: { src: number; dst: number }[] = [];
  for (const s of [...onsets].sort((a, b) => a - b)) {
    if (s <= info.sourceOffset + 0.01 || s >= end - 0.01) continue;
    const t = clipStart + mapTime(info, s);
    const g = gridOrigin + Math.round((t - gridOrigin) / grid) * grid;
    const dst = mapTime(info, s) + (g - t) * Math.max(0, Math.min(1, strength));
    // Deux attaques vers la même ligne : on garde la plus proche.
    const prev = targets[targets.length - 1];
    if (prev && dst - prev.dst < 0.01) {
      const tp = clipStart + mapTime(info, prev.src);
      if (Math.abs(t - g) < Math.abs(tp - g)) targets[targets.length - 1] = { src: s, dst };
      continue;
    }
    targets.push({ src: s, dst });
  }
  for (const m of targets) out = placeMarker(out, m.src, m.dst);
  return out;
}

// ─── Plan de rendu ────────────────────────────────────────────────────────────

export interface ElasticSegment { s0: number; s1: number; d0: number; d1: number }

/**
 * Ce qu'il faut rendre (en échantillons du son d'origine / du son rendu) :
 * la région avec ses marges, découpée aux marqueurs. Le premier morceau
 * commence à 0 dans le son rendu.
 */
export function renderPlan(info: ElasticInfo, sr: number, sourceLength: number): { regionStart: number; regionEnd: number; renderedOffset: number; segments: ElasticSegment[]; outLength: number } {
  const dur = sourceLength / sr;
  const regionStart = Math.max(0, info.sourceOffset - ELASTIC_PAD);
  const regionEnd = Math.min(dur, info.sourceOffset + info.sourceDuration + ELASTIC_PAD);
  const d0 = mapTime(info, regionStart);
  const pts = [regionStart, ...anchorsOf(info).slice(1, -1).map(a => a.src), regionEnd];
  const a0 = Math.round(regionStart * sr);
  const segments: ElasticSegment[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const s0 = Math.round(pts[i] * sr) - a0, s1 = Math.round(pts[i + 1] * sr) - a0;
    const e0 = Math.round((mapTime(info, pts[i]) - d0) * sr), e1 = Math.round((mapTime(info, pts[i + 1]) - d0) * sr);
    if (s1 > s0 && e1 > e0) segments.push({ s0, s1, d0: e0, d1: e1 });
  }
  return { regionStart: a0 / sr, regionEnd: Math.round(regionEnd * sr) / sr, renderedOffset: -d0, segments, outLength: segments.length ? segments[segments.length - 1].d1 : 0 };
}

// ─── Rendu (pur : worker et tests) ────────────────────────────────────────────

export interface ElasticJob {
  channels: Float32Array[];
  sr: number;
  segments: ElasticSegment[];
  semitones: number;
  formants: boolean;
  algo: 'auto' | 'voice' | 'poly';
}

export interface ElasticResult { channels: Float32Array[]; used: 'voice' | 'poly' }

export function monoMix(chs: Float32Array[]): Float32Array {
  if (chs.length === 1) return chs[0];
  const n = chs[0]?.length || 0;
  const m = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) m[i] += c[i] / chs.length;
  return m;
}

/**
 * Voix seule ou son polyphonique ? Une voix : la plupart de ses passages
 * forts ont UNE hauteur nette (YIN strict), avec peu d'attaques sèches. Un
 * beat : des attaques régulières (kick, caisse claire, charleston) et un
 * mélange sans hauteur unique.
 */
export function detectMaterial(x: Float32Array, sr: number): { kind: 'voice' | 'poly'; voiced: number; onsetsPerSec: number } {
  // 20 s au plus (le milieu) : assez pour décider, rapide.
  const maxN = Math.round(20 * sr);
  const from = x.length > maxN ? Math.floor((x.length - maxN) / 2) : 0;
  const y = x.length > maxN ? x.subarray(from, from + maxN) : x;
  const tr = analyzePitch(y, sr, { threshold: 0.15 });
  const db = Array.from(tr.rmsDb).sort((a, b) => a - b);
  const loud = db.length ? db[Math.floor(db.length * 0.95)] : -120;
  const floor = Math.max(-55, loud - 25);
  let n = 0, v = 0;
  for (let i = 0; i < tr.rmsDb.length; i++) {
    if (tr.rmsDb[i] < floor) continue;
    n++;
    if (!Number.isNaN(tr.midi[i])) v++;
  }
  const voiced = n ? v / n : 0;
  const onsets = detectTransients(y, sr, { jumpDb: 12 });
  const activeSec = Math.max(0.5, (n * tr.hop) / sr);
  const onsetsPerSec = onsets.length / activeSec;
  const kind = voiced >= 0.55 && onsetsPerSec < 3 ? 'voice' : 'poly';
  return { kind, voiced: Math.round(voiced * 1000) / 1000, onsetsPerSec: Math.round(onsetsPerSec * 100) / 100 };
}

/** Étire chaque morceau à sa longueur × `pitch` (la transposition suit par rééchantillonnage). */
function stretchSegments(chs: Float32Array[], segs: ElasticSegment[], pitch: number, sr: number, onsets: number[], formantPitch?: number): Float32Array[] {
  const total = Math.round(segs[segs.length - 1].d1 * pitch);
  const out = chs.map(() => new Float32Array(total));
  for (const g of segs) {
    const o0 = Math.round(g.d0 * pitch), o1 = Math.round(g.d1 * pitch);
    const len = o1 - o0;
    if (len <= 0) continue;
    const part = chs.map(c => c.subarray(g.s0, g.s1));
    let res: Float32Array[];
    if (len === g.s1 - g.s0 && !formantPitch) res = part; // morceau inchangé : copie exacte
    else res = pvStretch(part, len, { sampleRate: sr, onsets: onsets.filter(o => o >= g.s0 && o < g.s1).map(o => o - g.s0), formantPitch });
    res.forEach((c, i) => out[i].set(c.subarray(0, len), o0));
  }
  return out;
}

/** Rend un clip : transposition (`semitones`) + étirement / warp (`segments`). */
export function renderElastic(job: ElasticJob): ElasticResult {
  const { channels, sr, segments } = job;
  const outLen = segments.length ? segments[segments.length - 1].d1 : 0;
  const mono = monoMix(channels);
  const used = job.algo === 'auto' ? detectMaterial(mono, sr).kind : job.algo;
  const st = clampSt(job.semitones);
  const p = Math.pow(2, st / 12);
  const onsets = detectTransients(mono, sr).map(t => Math.round(t * sr));

  if (used === 'voice' && job.formants && Math.abs(st) >= 0.005) {
    // Voix : étirement (s'il y en a) puis PSOLA à durée constante.
    const stretched = stretchSegments(channels, segments, 1, sr, onsets);
    const m = monoMix(stretched);
    const track = analyzePitch(m, sr);
    const curve = new Float32Array(track.midi.length).fill(st);
    return { channels: renderPitch(stretched, track, curve, m), used };
  }
  if (Math.abs(p - 1) < 1e-6) return { channels: stretchSegments(channels, segments, 1, sr, onsets), used };
  // Polyphonique (ou voix sans formants) : vocodeur de phase à la durée × p, puis lecture p fois plus vite.
  const pv = stretchSegments(channels, segments, p, sr, onsets, job.formants ? p : undefined);
  return { channels: pv.map(c => resampleStep(c, p, outLen)), used };
}

// ─── Clip ─────────────────────────────────────────────────────────────────────

const SUFFIX_RE = /\s*\((?:transposé|étiré|warp)[^)]*\)$/;

/** Transposition lisible : « +3 demi-tons », « −5 demi-tons −20 ct », « +30 cents ». */
export function semitoneText(semitones: number): string {
  const v = Math.round(semitones * 100) / 100;
  if (Math.abs(v) < 0.005) return '0 demi-ton';
  const whole = Math.trunc(v), ct = Math.round((v - whole) * 100);
  const sg = (x: number) => (x > 0 ? '+' : '−');
  if (!whole) return `${sg(ct)}${Math.abs(ct)} cents`;
  return `${sg(whole)}${Math.abs(whole)} demi-ton${Math.abs(whole) > 1 ? 's' : ''}${ct ? ` ${sg(ct)}${Math.abs(ct)} ct` : ''}`;
}

/** Libellé court du réglage (« +3 demi-tons · 110 % · 4 marqueurs »). */
export function elasticLabel(info: ElasticInfo): string {
  const parts: string[] = [];
  if (Math.abs(info.semitones) >= 0.005) parts.push(semitoneText(info.semitones));
  const s = stretchOf(info);
  if (Math.abs(s - 1) > 1e-4) parts.push(`${Math.round(s * 1000) / 10} %`);
  const n = info.markers?.length || 0;
  if (n) parts.push(`${n} marqueur${n > 1 ? 's' : ''}`);
  return parts.join(' · ') || 'original';
}

/** Transforme un instant du son d'origine en instant du son rendu. */
const toRendered = (info: ElasticInfo, t: number) => mapTime(info, t) + info.renderedOffset;
/** Et l'inverse. */
const toSource = (info: ElasticInfo, t: number) => unmapTime(info, t - info.renderedOffset);

const mapGain = (pts: ClipGainPoint[] | undefined, f: (t: number) => number) => pts?.map(p => ({ ...p, t: r6(f(p.t)) }));
const mapBreaths = (b: BreathEdit[] | undefined, f: (t: number) => number) => {
  const out = b?.map(e => ({ ...e, start: r6(Math.max(0, f(e.start))), end: r6(f(e.end)) })).filter(e => e.end > e.start);
  return out?.length ? out : undefined;
};

/**
 * Changements du clip une fois le son rendu enregistré sous `newBufferId`.
 * `info` : réglage complet (avec regionStart/regionEnd/renderedOffset du plan).
 * `base` : le réglage d'avant (clip déjà rendu), pour ramener la ligne de gain
 * et les respirations dans le repère de l'original.
 */
export function elasticPatch(clip: Clip, o: { newBufferId: string; info: ElasticInfo; sourceBufferId?: string }): Partial<Clip> {
  const prev = clip.elastic;
  const fromOriginal = !!prev && !!o.sourceBufferId && o.sourceBufferId === prev.sourceBufferId;
  // Repère d'origine des points du clip (gain, respirations, point de synchro).
  const toOrig = (t: number) => (fromOriginal ? toSource(prev!, t) : t);
  const toNew = (t: number) => toRendered(o.info, toOrig(t));
  const baseName = prev?.sourceName ?? clip.name.replace(SUFFIX_RE, '');
  const info: ElasticInfo = {
    ...o.info,
    sourceBufferId: o.sourceBufferId,
    sourceName: baseName,
    ...(fromOriginal ? (prev!.sourceWarp ? { sourceWarp: prev!.sourceWarp } : {}) : (clip.warp ? { sourceWarp: clip.warp } : {})),
  };
  delete info.sourceRef;
  const kind = Math.abs(info.semitones) >= 0.005 ? 'transposé' : info.markers?.length ? 'warp' : 'étiré';
  const patch: Partial<Clip> = {
    bufferId: o.newBufferId,
    offset: r6(info.renderedOffset),
    duration: r6(info.duration),
    fadeIn: Math.min(clip.fadeIn || 0, info.duration),
    fadeOut: Math.min(clip.fadeOut || 0, info.duration),
    name: `${baseName} (${kind} ${elasticLabel(info)})`.slice(0, 80),
    elastic: info,
    gainPoints: mapGain(clip.gainPoints, toNew),
    breaths: mapBreaths(clip.breaths, toNew),
    syncPoint: clip.syncPoint !== undefined ? r6(toNew(clip.syncPoint)) : undefined,
  };
  // Calage au tempo de l'ancien système (warp) : le rendu le remplace.
  if (clip.warp?.enabled) patch.warp = { ...clip.warp, enabled: false };
  return patch;
}

/** « Revenir à l'original » : le son d'origine, même début (null si on ne l'a plus : reçu en collaboration). */
export function elasticRevertPatch(clip: Clip, hasBuffer: (id: string) => boolean): Partial<Clip> | null {
  const e = clip.elastic;
  if (!e?.sourceBufferId || !hasBuffer(e.sourceBufferId)) return null;
  const v0 = (clip.offset || 0) - e.renderedOffset;
  const s0 = unmapTime(e, v0), s1 = unmapTime(e, v0 + clip.duration);
  const back = (t: number) => toSource(e, t);
  return {
    bufferId: e.sourceBufferId,
    offset: r6(Math.max(0, s0)),
    duration: r6(Math.max(0.01, s1 - Math.max(0, s0))),
    name: e.sourceName ?? clip.name.replace(SUFFIX_RE, ''),
    elastic: undefined,
    gainPoints: mapGain(clip.gainPoints, back),
    breaths: mapBreaths(clip.breaths, back),
    syncPoint: clip.syncPoint !== undefined ? r6(back(clip.syncPoint)) : undefined,
    ...(e.sourceWarp ? { warp: e.sourceWarp } : {}),
  };
}

/** Ce clip peut-il être transposé / étiré ? (sinon : la raison, à afficher) */
export function elasticBlock(c: Clip): string | null {
  if (c.notes || c.type === TrackType.MIDI) return 'Transposer un clip MIDI : utilise le piano roll (sélectionne les notes, flèches haut / bas).';
  if (!c.bufferId && !c.buffer) return 'Le son de ce clip n’est pas encore chargé.';
  if (c.isReversed) return 'Clip inversé : consolide-le d’abord (Alt+Maj+3).';
  if (c.isOffline) return 'Son introuvable : relie d’abord le fichier.';
  return null;
}

/**
 * Rendu dans un worker (repli : sur place). Les canaux sont transférés au
 * worker : l'appelant ne doit plus s'en servir.
 */
export async function renderElasticAsync(job: ElasticJob): Promise<ElasticResult> {
  if (typeof Worker === 'undefined') return renderElastic(job);
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./clipTranspose.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return renderElastic(job);
  }
  try {
    return await new Promise<ElasticResult>((resolve, reject) => {
      worker!.onmessage = (e: MessageEvent<ElasticResult & { error?: string }>) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
      worker!.onerror = ev => reject(new Error(ev.message || 'Calcul impossible'));
      worker!.postMessage(job, job.channels.map(c => c.buffer as ArrayBuffer));
    });
  } finally { worker.terminate(); }
}
