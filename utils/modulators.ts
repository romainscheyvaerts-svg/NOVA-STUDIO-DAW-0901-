import { TrackType, type AutomationLane, type AutomationPoint, type Clip, type Track } from '../types';
import { parsePluginParam, setLaneModulator, sortedPoints, valueAtPoints } from './automationWrite';
import { isMuteParam } from './muteAutomation';
import { PAN_L, PAN_R, stereoPanOf } from './panLaw';
import { quartersToTime, tempoMapStore, timeToQuarters, type TempoMap } from './tempoMap';
import { audioBufferRegistry } from './audioBufferRegistry';
import { blockPeaks, envSourcesOf, envUnitAt, followEnvelope } from './envelopeFollower';

/**
 * L3 · Modulateurs (écart 11) : un LFO calé sur le tempo pilote n'importe quel
 * réglage qui a une voie d'automation (volume, panoramique, envoi, réglage d'un
 * effet : coupure du filtre DJ, mix d'une réverbe…).
 *
 * Appliqué AU MÊME ENDROIT que l'automation : `playedLanes` (utils/automationWrite)
 * renvoie, pour une piste qui a des modulateurs actifs, des voies où la courbe
 * du LFO s'AJOUTE à l'automation dessinée (ou à la valeur fixe du réglage). Le
 * moteur les programme comme n'importe quelle automation : même courbe en
 * lecture et à l'export, rien de plus qui tourne pendant la lecture, rien du
 * tout à l'arrêt.
 *
 * Le LFO suit la position MUSICALE (piste tempo, rampes comprises) : une
 * période à la noire dure exactement un temps, même quand le tempo change.
 * Formes : sinus, triangle, carré, dent de scie, aléatoire (échantillonné-
 * bloqué, reproductible : même graine = même courbe). Points calculés une fois
 * par réglage (mémorisés par piste), 16 par période, au plus un toutes les 5 ms.
 *
 * Suiveur d'enveloppe (22/10/2026, utils/envelopeFollower) : le niveau d'une piste source
 * (attaque, relâchement, plage) remplace le LFO ; même chemin, même courbe en lecture et à l'export.
 *
 * Module pur : tests/modulators.test.ts.
 */

export type LfoShape = 'sine' | 'triangle' | 'square' | 'saw' | 'random';
export type LfoRate = '4/1' | '2/1' | '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/4T' | '1/8T' | '1/16T';
export type LfoPolarity = 'bi' | 'up' | 'down';
/** « lfo » : LFO calé sur le tempo ; « env » : suiveur d'enveloppe (niveau d'une piste source). */
export type ModulatorKind = 'lfo' | 'env';

export interface Modulator {
  id: string;
  on: boolean;
  /** Absent = LFO (projets d'avant le suiveur). */
  kind?: ModulatorKind;
  /** Suiveur : piste dont le niveau pilote le réglage. */
  source?: string;
  /** Suiveur : attaque (ms), temps de montée. */
  attack?: number;
  /** Suiveur : relâchement (ms), temps de retombée. */
  release?: number;
  /** Réglage piloté : nom d'une voie d'automation de la piste (« volume », « pan », « plugin::id::clé »…). */
  target: string;
  shape: LfoShape;
  rate: LfoRate;
  /** Amplitude : part de la plage du réglage (0 à 1 ; 1 = toute la plage). */
  depth: number;
  /** Décalage de phase (0 à 1 période). */
  phase: number;
  /** « bi » : autour de la valeur ; « up » : au-dessus ; « down » : en dessous. */
  polarity: LfoPolarity;
}

/** Noires par période. */
export const RATE_QUARTERS: Record<LfoRate, number> = {
  '4/1': 16, '2/1': 8, '1/1': 4, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/4T': 2 / 3, '1/8T': 1 / 3, '1/16T': 1 / 6,
};
export const RATE_LABEL: Record<LfoRate, string> = {
  '4/1': '4 mesures', '2/1': '2 mesures', '1/1': '1 mesure', '1/2': 'Blanche', '1/4': 'Noire', '1/8': 'Croche', '1/16': 'Double',
  '1/4T': 'Noire triolet', '1/8T': 'Croche triolet', '1/16T': 'Double triolet',
};
export const SHAPE_LABEL: Record<LfoShape, string> = { sine: 'Sinus', triangle: 'Triangle', square: 'Carré', saw: 'Dent de scie', random: 'Aléatoire' };

/** Réglages neutres par défaut (aucun préréglage inventé) : sinus à la mesure, amplitude 25 %. */
export const defaultModulator = (target: string, id = `mod-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`): Modulator => ({
  id, on: true, target, shape: 'sine', rate: '1/1', depth: 0.25, phase: 0, polarity: 'bi',
});

/** Suiveur d'enveloppe par défaut : attaque 10 ms, relâchement 150 ms, plage 50 %, au-dessus de la valeur. */
export const defaultEnvFollower = (target: string, source: string, id = `env-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`): Modulator => ({
  ...defaultModulator(target, id), kind: 'env', source, attack: 10, release: 150, depth: 0.5, polarity: 'up',
});
export const ENV_ATTACK_MAX_MS = 500;
export const ENV_RELEASE_MAX_MS = 3000;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const SHAPES = new Set<LfoShape>(['sine', 'triangle', 'square', 'saw', 'random']);

export function sanitizeModulators(raw: unknown): Modulator[] {
  if (!Array.isArray(raw)) return [];
  const out: Modulator[] = [];
  for (const r of raw.slice(0, 16)) {
    if (!r || typeof r !== 'object' || typeof (r as any).target !== 'string' || !(r as any).target) continue;
    const m = r as any;
    out.push({
      id: typeof m.id === 'string' ? m.id.slice(0, 64) : `mod-${out.length}`,
      on: m.on !== false,
      target: m.target.slice(0, 200),
      shape: SHAPES.has(m.shape) ? m.shape : 'sine',
      rate: m.rate in RATE_QUARTERS ? m.rate : '1/1',
      depth: clamp(Number.isFinite(Number(m.depth)) ? Number(m.depth) : 0.25, 0, 1),
      phase: clamp(Number.isFinite(Number(m.phase)) ? Number(m.phase) : 0, 0, 1),
      polarity: m.polarity === 'up' || m.polarity === 'down' ? m.polarity : 'bi',
      ...(m.kind === 'env' && typeof m.source === 'string' && m.source ? {
        kind: 'env' as const, source: m.source.slice(0, 200),
        attack: clamp(Number.isFinite(Number(m.attack)) ? Number(m.attack) : 10, 0, ENV_ATTACK_MAX_MS),
        release: clamp(Number.isFinite(Number(m.release)) ? Number(m.release) : 150, 1, ENV_RELEASE_MAX_MS),
      } : {}),
    });
  }
  return out;
}

/** Hachage FNV → 0…1 (aléatoire reproductible). */
function rnd(seed: string, k: number): number {
  let h = 0x811c9dc5;
  const s = `${seed}:${k}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 4294967296;
}

/** Valeur du LFO (−1…1) à la position `cycles` (périodes écoulées depuis le début du morceau). */
export function lfoAt(shape: LfoShape, cycles: number, seed = ''): number {
  const ph = cycles - Math.floor(cycles);
  switch (shape) {
    case 'sine': return Math.sin(2 * Math.PI * ph);
    case 'triangle': return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case 'square': return ph < 0.5 ? 1 : -1;
    case 'saw': return 2 * ph - 1;
    case 'random': return rnd(seed, Math.floor(cycles)) * 2 - 1;
  }
}

/** Valeur fixe d'un réglage (quand sa voie n'a pas de point). Null : inconnue (on ne module pas). */
export function staticValueOf(track: Track, param: string): number | null {
  if (param === 'volume') return track.volume;
  if (param === 'pan') return track.pan;
  // Double pan d'une piste stéréo : G / D écrits, ou ancien pan converti.
  if (param === PAN_L) return stereoPanOf(track).l;
  if (param === PAN_R) return stereoPanOf(track).r;
  if (param.startsWith('send::')) { const s = (track.sends || []).find(x => x.id === param.slice(6)); return s ? s.level : null; }
  const p = parsePluginParam(param);
  if (p) {
    const v = (track.plugins || []).find(x => x.id === p.pluginId)?.params?.[p.key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return null;
}

/** Fin des courbes calculées (s) : posée par App (fin du projet + marge). */
let span = 300;
export const modulationSpanStore = { get: () => span, set(s: number) { span = Math.max(30, Math.min(3600, s)); } };

const MAX_POINTS = 40000;

export const isEnvFollower = (m: Pick<Modulator, 'kind'>) => m.kind === 'env';

/**
 * Voie modulée : la courbe du LFO (ou du suiveur d'enveloppe) ajoutée à la voie (ou à la valeur
 * fixe), bornée à la plage. `envOf` : enveloppe calculée d'un suiveur (null : source sans son,
 * le suiveur ne fait rien).
 */
export function modulateLane(lane: Pick<AutomationLane, 'min' | 'max' | 'points'>, base: number | null, mods: Modulator[], map: TempoMap, end: number, envOf?: (m: Modulator) => Float32Array | null): AutomationPoint[] | null {
  const envs = new Map<Modulator, Float32Array>();
  for (const m of mods) if (isEnvFollower(m) && m.on && m.depth > 0) { const e = envOf?.(m); if (e && e.length) envs.set(m, e); }
  const live = mods.filter(m => m.on && m.depth > 0 && (!isEnvFollower(m) || envs.has(m)));
  if (!live.length) return null;
  const lfos = live.filter(m => !isEnvFollower(m));
  const pts = sortedPoints(lane.points);
  if (!pts.length && base === null) return null;
  const range = (lane.max ?? 1) - (lane.min ?? 0);
  const baseAt = (t: number) => (pts.length ? valueAtPoints(pts, t, base ?? 0) : (base as number));
  const qEnd = timeToQuarters(map, end);
  // Pas commun : 16 points par période du LFO le plus rapide, au moins 5 ms, au plus MAX_POINTS.
  const minQ = timeToQuarters(map, 0.005);
  let stepQ = lfos.length ? Math.min(...lfos.map(m => RATE_QUARTERS[m.rate])) / 16 : minQ;
  if (!(stepQ > 0)) stepQ = 1 / 64;
  if (minQ > 0 && stepQ < minQ) stepQ = minQ;
  if (qEnd / stepQ > MAX_POINTS) stepQ = qEnd / MAX_POINTS;
  const stepped = lfos.some(m => m.shape === 'square' || m.shape === 'random');
  // Instants : la grille, les sauts des formes en marches, et les points dessinés (coins gardés).
  const qs = new Set<number>();
  for (let q = 0; q <= qEnd + 1e-9; q += stepQ) qs.add(Math.round(q * 1e9) / 1e9);
  // Suiveur d'enveloppe : un point toutes les 5 ms de temps réel (au plus MAX_POINTS).
  if (envs.size && lfos.length) {
    const stepS = Math.max(0.005, end / MAX_POINTS);
    for (let t = 0; t <= end + 1e-9; t += stepS) qs.add(Math.round(timeToQuarters(map, t) * 1e9) / 1e9);
  }
  if (stepped) for (const m of lfos) {
    if (m.shape !== 'square' && m.shape !== 'random') continue;
    const per = RATE_QUARTERS[m.rate], half = m.shape === 'square' ? per / 2 : per;
    for (let k = Math.ceil((-m.phase * per) / half); (k * half + -m.phase * per) <= qEnd && qs.size < MAX_POINTS * 2; k++) {
      const q = k * half - m.phase * per;
      if (q > 0) qs.add(Math.round(q * 1e9) / 1e9);
    }
  }
  for (const p of pts) if (p.time >= 0 && p.time <= end) qs.add(Math.round(timeToQuarters(map, p.time) * 1e9) / 1e9);
  const sortedQ = [...qs].sort((a, b) => a - b);
  // Formes en marches : valeur lue juste APRÈS l'instant (un saut tombe pile, sans erreur d'arrondi).
  const valueAtQ = (q: number) => {
    const t = quartersToTime(map, q);
    const qe = stepped ? q + 1e-7 : q;
    let v = baseAt(t);
    for (const m of live) {
      const amp = m.depth * range;
      const env = envs.get(m);
      if (env) {
        // Suiveur : niveau 0…1 de la source ; « au-dessus » pousse, « en dessous » creuse, « autour » des deux côtés.
        const u = envUnitAt(env, t);
        v += m.polarity === 'bi' ? amp * (u - 0.5) : m.polarity === 'up' ? amp * u : -amp * u;
        continue;
      }
      const l = lfoAt(m.shape, qe / RATE_QUARTERS[m.rate] + m.phase, m.id);
      v += m.polarity === 'bi' ? (amp / 2) * l : m.polarity === 'up' ? (amp * (l + 1)) / 2 : (-amp * (l + 1)) / 2;
    }
    return { t, v: clamp(v, lane.min ?? -Infinity, lane.max ?? Infinity) };
  };
  const out: AutomationPoint[] = [];
  for (let i = 0; i < sortedQ.length; i++) {
    const q = sortedQ[i];
    const { t, v } = valueAtQ(q);
    // Formes en marches : la valeur tient jusqu'au saut suivant (HOLD), sinon rampe linéaire.
    const p: AutomationPoint = { id: `m${i}`, time: t, value: v, curveType: stepped ? 'HOLD' : 'LINEAR' };
    if (stepped) {
      // Valeur juste avant le prochain instant : un saut, pas une pente.
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.value - v) < 1e-12) continue;
    }
    out.push(p);
  }
  // Suiveur : les paliers plats (source silencieuse) gardent leurs deux bouts seulement (même courbe, moins de points).
  if (envs.size && !stepped && out.length > 2) {
    const kept: AutomationPoint[] = [out[0]];
    for (let i = 1; i < out.length - 1; i++) {
      const a = kept[kept.length - 1].value, b = out[i].value, c = out[i + 1].value;
      if (Math.abs(a - b) < 1e-9 && Math.abs(b - c) < 1e-9) continue;
      kept.push(out[i]);
    }
    kept.push(out[out.length - 1]);
    return kept;
  }
  return out;
}

/**
 * Pistes du projet où chercher la source d'un suiveur d'enveloppe (posé par le moteur audio : le
 * projet entier, même quand on n'exporte qu'une piste, un stem ou une sélection).
 */
let sourceResolver: ((id: string) => Track | undefined) | null = null;
export const setModulatorSourceResolver = (fn: ((id: string) => Track | undefined) | null) => { sourceResolver = fn; };

const bufferOfClip = (c: Clip): AudioBuffer | undefined => c.buffer || (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined);
const loadedClips = (t: Track | undefined) => (t?.clips || []).reduce((n, c) => n + (c.type !== TrackType.MIDI && !c.isMuted && bufferOfClip(c) ? 1 : 0), 0);

const objIds = new WeakMap<object, number>();
let nextObjId = 1;
const objId = (o: object) => { let k = objIds.get(o); if (!k) { k = nextObjId++; objIds.set(o, k); } return k; };

/** Crêtes par bloc des clips d'une source (une fois par version des clips et sons chargés). */
const peaksCache = new WeakMap<Clip[], { loaded: number; end: number; peaks: Float32Array }>();
const envCache = new WeakMap<Float32Array, Map<string, Float32Array>>();

/** Enveloppe d'un suiveur (null : source introuvable ou sans son chargé). */
export function envelopeOf(source: Track | undefined, m: Pick<Modulator, 'attack' | 'release'>, end: number): Float32Array | null {
  if (!source) return null;
  const loaded = loadedClips(source);
  if (!loaded) return null;
  const clips = source.clips || [];
  let pk = peaksCache.get(clips);
  if (!pk || pk.loaded !== loaded || pk.end !== end) {
    pk = { loaded, end, peaks: blockPeaks(envSourcesOf(source, bufferOfClip), end) };
    peaksCache.set(clips, pk);
  }
  const attack = m.attack ?? 10, release = m.release ?? 150;
  let byKey = envCache.get(pk.peaks);
  if (!byKey) { byKey = new Map(); envCache.set(pk.peaks, byKey); }
  const key = `${attack}|${release}`;
  let env = byKey.get(key);
  if (!env) { env = followEnvelope(pk.peaks, attack, release); byKey.set(key, env); }
  return env;
}

const cache = new WeakMap<Track, { lanes: AutomationLane[]; map: TempoMap; span: number; src: string; out: AutomationLane[] }>();

/**
 * Voies jouées d'une piste avec ses modulateurs (branché dans playedLanes).
 * `played` : les voies d'automation rejouées (vide en mode Off : le LFO joue
 * quand même, sur la valeur fixe). `resolve` : pistes sources des suiveurs d'enveloppe.
 */
export function modulatedLanes(track: Track, played: AutomationLane[], map: TempoMap = tempoMapStore.get(), end: number = span,
  resolve: ((id: string) => Track | undefined) | null = sourceResolver): AutomationLane[] {
  const mods = (track.modulators || []).filter(m => m.on && m.depth > 0 && !isMuteParam(m.target));
  if (!mods.length) return played;
  // Suiveurs : la courbe dépend aussi des clips de leur source (et des sons déjà chargés).
  const srcOf = (m: Modulator) => (m.source ? (m.source === track.id ? track : resolve?.(m.source)) : undefined);
  const src = mods.filter(isEnvFollower).map(m => { const t = srcOf(m); return t ? `${m.id}:${objId(t.clips || [])}:${loadedClips(t)}` : `${m.id}:-`; }).join(',');
  const hit = cache.get(track);
  if (hit && hit.lanes === played && hit.map === map && hit.span === end && hit.src === src) return hit.out;
  const envOf = (m: Modulator) => envelopeOf(srcOf(m), m, end);
  const byTarget = new Map<string, Modulator[]>();
  for (const m of mods) byTarget.set(m.target, [...(byTarget.get(m.target) || []), m]);
  const out = played.map(l => {
    const ms = byTarget.get(l.parameterName);
    if (!ms) return l;
    byTarget.delete(l.parameterName);
    const pts = modulateLane(l, staticValueOf(track, l.parameterName), ms, map, end, envOf);
    return pts ? { ...l, points: pts } : l;
  });
  // Cible sans voie jouée (mode Off, voie vide retirée) : sa voie de la piste, sur la valeur fixe.
  for (const [target, ms] of byTarget) {
    const lane = (track.automationLanes || []).find(l => l.parameterName === target);
    if (!lane) continue;
    const pts = modulateLane({ ...lane, points: [] }, staticValueOf(track, target), ms, map, end, envOf);
    if (pts) out.push({ ...lane, points: pts });
  }
  cache.set(track, { lanes: played, map, span: end, src, out });
  return out;
}

setLaneModulator((track, lanes) => modulatedLanes(track as Track, lanes));
