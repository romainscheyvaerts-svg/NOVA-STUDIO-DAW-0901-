import type { AutomationCurveType, AutomationLane, AutomationPoint, Track } from '../types';

/**
 * Modes d'automation façon Pro Tools (Off, Read, Touch, Latch, Write, Trim) :
 * logique pure, sans React ni Web Audio.
 *
 * - Off   : l'automation n'est ni lue ni écrite.
 * - Read  : elle est rejouée ; bouger un fader ne l'écrit pas.
 * - Touch : écrit tant que le fader est tenu, puis revient à la courbe existante
 *           (rampe « AutoMatch »).
 * - Latch : écrit dès qu'on touche le fader et garde la dernière valeur jusqu'à
 *           l'arrêt de la lecture.
 * - Write : écrase tout le passage lu, du départ à l'arrêt.
 * - Trim  : décale la courbe existante (en dB pour un volume) tant qu'on tient.
 *
 * Le format des voies (`Track.automationLanes`) ne change pas : on n'y écrit
 * que des points ordinaires, simplifiés pour ne pas en garder des milliers.
 */

export type AutomationMode = NonNullable<Track['automationMode']>;

export interface AutomationModeInfo {
  id: AutomationMode;
  /** Libellé affiché dans le menu. */
  label: string;
  /** Libellé court du bouton de piste (comme la console Pro Tools). */
  short: string;
  /** Libellé français (mode simple : pas de sigle Pro Tools). */
  fr: string;
  /** Couleur Pro Tools : Read vert, Touch/Latch jaune, Write rouge. */
  color: string;
  /** Infobulle : ce que fait le mode, et son équivalent Pro Tools. */
  title: string;
}

export const AUTOMATION_MODES: AutomationModeInfo[] = [
  { id: 'off', label: 'Off', short: 'OFF', fr: 'Coupée', color: '#64748b',
    title: "Off : l'automation de la piste n'est ni lue ni écrite (Pro Tools : Off)." },
  { id: 'read', label: 'Read', short: 'READ', fr: 'Lecture', color: '#22c55e',
    title: "Read : la piste rejoue son automation ; bouger un fader ne l'écrit pas (Pro Tools : Read)." },
  { id: 'touch', label: 'Touch', short: 'TCH', fr: 'Au toucher', color: '#eab308',
    title: "Touch : pendant la lecture, écrit tant que tu tiens le fader ; au relâchement, il revient à la courbe (Pro Tools : Touch)." },
  { id: 'latch', label: 'Latch', short: 'LTCH', fr: 'Maintien', color: '#eab308',
    title: "Latch : écrit dès que tu touches le fader et garde la dernière valeur jusqu'à l'arrêt (Pro Tools : Latch)." },
  { id: 'write', label: 'Write', short: 'WRT', fr: 'Écriture', color: '#ef4444',
    title: "Write : écrase l'automation de tout le passage lu, du départ à l'arrêt ; la piste repasse ensuite en Touch (Pro Tools : Write)." },
  { id: 'trim', label: 'Trim', short: 'TRIM', fr: 'Ajustement', color: '#f97316',
    title: "Trim : décale la courbe existante (en dB pour le volume) tant que tu tiens le fader (Pro Tools : Trim)." },
];

export const DEFAULT_AUTOMATION_MODE: AutomationMode = 'read';
/** Rampe de retour à la courbe d'origine après Touch / Latch / Write (Pro Tools : AutoMatch). */
export const AUTOMATCH_SEC = 0.25;
/** Écart toléré à la simplification, en fraction de la course du fader. */
export const SIMPLIFY_TOLERANCE = 0.004;

const MODE_IDS = new Set<string>(AUTOMATION_MODES.map(m => m.id));

export const automationModeInfo = (mode: AutomationMode): AutomationModeInfo =>
  AUTOMATION_MODES.find(m => m.id === mode) || AUTOMATION_MODES[1];

/** Mode d'une piste (absent ou inconnu : Read, le comportement d'avant). */
export const automationModeOf = (track?: { automationMode?: string } | null): AutomationMode => {
  const m = String(track?.automationMode || '').toLowerCase();
  return (MODE_IDS.has(m) ? m : DEFAULT_AUTOMATION_MODE) as AutomationMode;
};

export const isAutomationPlayed = (mode: AutomationMode): boolean => mode !== 'off';
export const isWriteMode = (mode: AutomationMode): boolean =>
  mode === 'touch' || mode === 'latch' || mode === 'write' || mode === 'trim';

/** Voies réellement rejouées (lecture ET export) : aucune en mode Off. */
export const playedLanes = (track: Pick<Track, 'automationLanes'> & { automationMode?: string }): AutomationLane[] =>
  isAutomationPlayed(automationModeOf(track)) ? (track.automationLanes || []) : [];

// --- Courbes ------------------------------------------------------------------------

/** Interpolation entre deux points selon le type de courbe du premier. */
export const interpolateCurve = (
  v1: number,
  v2: number,
  t: number,
  curveType: AutomationCurveType = 'LINEAR'
): number => {
  switch (curveType) {
    case 'EXPONENTIAL': return v1 + (v2 - v1) * (1 - Math.pow(1 - t, 3));
    case 'LOGARITHMIC': return v1 + (v2 - v1) * Math.pow(t, 3);
    case 'S_CURVE': { const s = t * t * (3 - 2 * t); return v1 + (v2 - v1) * s; }
    case 'HOLD': return t < 1 ? v1 : v2;
    default: return v1 + (v2 - v1) * t;
  }
};

export const sortedPoints = (points: AutomationPoint[] | undefined): AutomationPoint[] =>
  [...(points || [])].sort((a, b) => a.time - b.time);

/** Valeur d'une enveloppe à un instant (points triés), `fallback` si elle est vide. */
export const valueAtPoints = (points: AutomationPoint[], time: number, fallback: number): number => {
  if (!points.length) return fallback;
  if (time <= points[0].time) return points[0].value;
  const last = points[points.length - 1];
  if (time >= last.time) return last.value;
  // Recherche dichotomique : les voies écrites peuvent compter des centaines de points.
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= time) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const d = b.time - a.time;
  return interpolateCurve(a.value, b.value, d > 0 ? (time - a.time) / d : 1, a.curveType || 'LINEAR');
};

// --- Paramètres automatisables --------------------------------------------------------

export const SEND_PREFIX = 'send::';
export const PLUGIN_PREFIX = 'plugin::';
/** Volume avant effets (voir utils/preFxEdits) : jamais écrit par un fader. */
const PRE_VOLUME = 'preVolume';

export const sendParamName = (sendId: string) => `${SEND_PREFIX}${sendId}`;
export const pluginParamName = (pluginId: string, key: string) => `${PLUGIN_PREFIX}${pluginId}::${key}`;
export const parsePluginParam = (name: string): { pluginId: string; key: string } | null => {
  if (!name.startsWith(PLUGIN_PREFIX)) return null;
  const rest = name.slice(PLUGIN_PREFIX.length);
  const i = rest.indexOf('::');
  if (i <= 0 || i >= rest.length - 2) return null;
  return { pluginId: rest.slice(0, i), key: rest.slice(i + 2) };
};

export type ParamKind = 'gain' | 'pan' | 'linear';
export interface ParamSpec { min: number; max: number; kind: ParamKind }

/** Paramètres d'effets courants : course connue d'après leur nom. */
const PLUGIN_RANGES: [RegExp, number, number][] = [
  [/threshold/i, -60, 0],
  [/ratio/i, 1, 20],
  [/(freq|cutoff|hz)/i, 20, 20000],
  [/(makeup|gain|output|input|trim|drive|db)/i, -24, 24],
  [/(mix|wet|dry|amount|depth|feedback|width|level|intensity|strength|speed|retune|humanize)/i, 0, 1],
];

/**
 * Course d'un paramètre automatisable. Pour un effet inconnu, la course part
 * de la valeur entendue (elle s'élargit ensuite si l'écriture la dépasse).
 */
export const paramSpec = (name: string, sample?: number): ParamSpec => {
  if (name === 'volume' || name === PRE_VOLUME) return { min: 0, max: 1.5, kind: 'gain' };
  if (name === 'pan') return { min: -1, max: 1, kind: 'pan' };
  if (name.startsWith(SEND_PREFIX)) return { min: 0, max: 1.5, kind: 'gain' };
  const p = parsePluginParam(name);
  const v = typeof sample === 'number' && Number.isFinite(sample) ? sample : 0;
  if (p) {
    for (const [re, lo, hi] of PLUGIN_RANGES) {
      if (re.test(p.key) && v >= lo && v <= hi) return { min: lo, max: hi, kind: 'linear' };
    }
  }
  const lo = Math.min(0, v * 2);
  const hi = Math.max(1, v * 2, v + 1);
  return { min: lo, max: hi, kind: 'linear' };
};

/** Élargit une course pour contenir des valeurs (paramètres d'effets inconnus). */
export const widenSpec = (spec: ParamSpec, values: number[]): ParamSpec => {
  let { min, max } = spec;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  return { ...spec, min, max };
};

export const clampToSpec = (spec: ParamSpec, v: number) => Math.max(spec.min, Math.min(spec.max, v));

/** Valeur → position 0…1 (fader en racine du gain, comme la console de NOVA). */
export const normalize = (spec: ParamSpec, v: number): number => {
  if (spec.kind === 'gain') return Math.sqrt(Math.max(0, v) / (spec.max || 1));
  return (v - spec.min) / ((spec.max - spec.min) || 1);
};

/** Paramètre piloté par un fader, un potard ou un effet (pas le volume avant effets). */
export const isFaderParam = (name: string): boolean =>
  name === 'volume' || name === 'pan' || name.startsWith(SEND_PREFIX) || !!parsePluginParam(name);

/** Valeur « statique » (réglage de la piste, hors automation). */
export const staticParamValue = (track: Track, name: string): number | null => {
  if (name === 'volume') return track.volume;
  if (name === 'pan') return track.pan;
  if (name.startsWith(SEND_PREFIX)) {
    const id = name.slice(SEND_PREFIX.length);
    return (track.sends || []).find(s => s.id === id)?.level ?? null;
  }
  const p = parsePluginParam(name);
  if (p) {
    const v = (track.plugins || []).find(pl => pl.id === p.pluginId)?.params?.[p.key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return null;
};

/** Piste avec une nouvelle valeur statique (le fader reste là où on l'entend). */
export const withStaticParamValue = (track: Track, name: string, value: number): Track => {
  if (name === 'volume') return { ...track, volume: value };
  if (name === 'pan') return { ...track, pan: value };
  if (name.startsWith(SEND_PREFIX)) {
    const id = name.slice(SEND_PREFIX.length);
    return { ...track, sends: (track.sends || []).map(s => s.id === id ? { ...s, level: value } : s) };
  }
  const p = parsePluginParam(name);
  if (p) {
    return { ...track, plugins: (track.plugins || []).map(pl => pl.id === p.pluginId ? { ...pl, params: { ...pl.params, [p.key]: value } } : pl) };
  }
  return track;
};

/** Nom lisible d'une voie (« Volume », « Envoi delay », « COMPRESSOR · threshold »). */
export const laneDisplayName = (name: string, track?: Pick<Track, 'plugins'>): string => {
  if (name === 'volume') return 'Volume';
  if (name === 'pan') return 'Panoramique';
  if (name === PRE_VOLUME) return 'Volume avant effets';
  if (name.startsWith(SEND_PREFIX)) return `Envoi ${name.slice(SEND_PREFIX.length).replace(/^send-/, '')}`;
  const p = parsePluginParam(name);
  if (p) {
    const pl = track?.plugins?.find(x => x.id === p.pluginId);
    return `${pl?.name || pl?.type || 'Effet'} · ${p.key}`;
  }
  return name;
};

// --- Simplification ---------------------------------------------------------------

export interface Sample { time: number; value: number }

/**
 * Réduit une suite d'échantillons (Ramer-Douglas-Peucker) en gardant la forme
 * à `tolerance` près, mesurée sur la course du fader (0…1). Pro Tools appelle
 * ça « Thin Automation ».
 */
export const simplifySamples = (samples: Sample[], spec: ParamSpec, tolerance = SIMPLIFY_TOLERANCE): Sample[] => {
  const pts = samples.filter(s => Number.isFinite(s.time) && Number.isFinite(s.value));
  if (pts.length <= 2) return pts.map(s => ({ ...s }));
  const n = pts.map(s => normalize(spec, s.value));
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ta = pts[a].time, tb = pts[b].time, va = n[a], vb = n[b];
    let worst = -1, worstErr = tolerance;
    for (let i = a + 1; i < b; i++) {
      const r = tb > ta ? (pts[i].time - ta) / (tb - ta) : 0;
      const err = Math.abs(n[i] - (va + (vb - va) * r));
      if (err > worstErr) { worstErr = err; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  // Paliers : un point qui répète le précédent et le suivant ne sert à rien.
  const out: Sample[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push({ ...pts[i] });
  return out;
};

// --- Écriture d'un passage -------------------------------------------------------------

export type WriteKind = 'touch' | 'latch' | 'write' | 'trim';

export interface WriteSegment {
  kind: WriteKind;
  /** Début et fin du passage écrit (temps du projet, s). */
  start: number;
  end: number;
  /**
   * Valeurs entendues pendant le passage. En Trim : valeurs du fader (le
   * décalage est calculé par rapport à `trimRef`).
   */
  samples: Sample[];
  /** Trim : position du fader au moment où on l'a touché. */
  trimRef?: number;
}

export interface CommitOptions {
  spec: ParamSpec;
  /** Valeur de la piste quand la voie est vide (réglage statique d'avant le passage). */
  baseline: number;
  autoMatchSec?: number;
  tolerance?: number;
  /** Préfixe des identifiants de points créés. */
  idPrefix?: string;
}

/** Trim : valeur d'origine décalée (rapport en gain, soit des dB ; écart pour le reste). */
export const trimValue = (spec: ParamSpec, original: number, control: number, ref: number): number => {
  if (spec.kind === 'gain' && ref > 1e-4) return clampToSpec(spec, original * (control / ref));
  return clampToSpec(spec, original + (control - ref));
};

const controlAt = (samples: Sample[], t: number): number => {
  if (!samples.length) return 0;
  if (t <= samples[0].time) return samples[0].value;
  for (let i = samples.length - 1; i >= 0; i--) if (samples[i].time <= t) return samples[i].value;
  return samples[0].value;
};

const EPS = 0.005;

/**
 * Fusionne un passage écrit dans une enveloppe existante et renvoie la
 * nouvelle liste de points (triée).
 *
 * - la courbe avant le passage est gardée (point d'ancrage juste avant) ;
 * - les points d'origine du passage sont remplacés par les valeurs écrites,
 *   simplifiées ;
 * - après le passage, une rampe AutoMatch ramène à la courbe d'origine.
 */
export const commitSegment = (existing: AutomationPoint[], seg: WriteSegment, opts: CommitOptions): AutomationPoint[] => {
  const spec = opts.spec;
  const autoMatch = Math.max(0, opts.autoMatchSec ?? AUTOMATCH_SEC);
  const orig = sortedPoints(existing);
  const origAt = (t: number) => valueAtPoints(orig, t, opts.baseline);
  const start = Math.max(0, Math.min(seg.start, seg.end));
  const end = Math.max(seg.start, seg.end);
  let samples = [...seg.samples].filter(s => s.time >= start - 1e-6 && s.time <= end + 1e-6).sort((a, b) => a.time - b.time);
  if (!samples.length) return orig;

  if (seg.kind === 'trim') {
    const ref = seg.trimRef ?? samples[0].value;
    const times = new Set<number>(samples.map(s => s.time));
    orig.forEach(p => { if (p.time > start && p.time < end) times.add(p.time); });
    times.add(start); times.add(end);
    samples = [...times].sort((a, b) => a - b)
      .map(t => ({ time: t, value: trimValue(spec, origAt(t), controlAt(seg.samples, t), ref) }));
  } else {
    // Le passage commence et finit pile à ses bornes.
    if (samples[0].time > start + 1e-6) samples.unshift({ time: start, value: samples[0].value });
    const last = samples[samples.length - 1];
    if (last.time < end - 1e-6) samples.push({ time: end, value: last.value });
  }
  samples = samples.map(s => ({ time: s.time, value: clampToSpec(spec, s.value) }));
  const written = simplifySamples(samples, spec, opts.tolerance ?? SIMPLIFY_TOLERANCE);

  const prefix = opts.idPrefix || `aw${Date.now().toString(36)}`;
  let n = 0;
  const pt = (time: number, value: number): AutomationPoint => ({ id: `${prefix}-${n++}`, time, value });

  const tailAt = end + autoMatch;
  const before = orig.filter(p => p.time < start - EPS);
  const after = orig.filter(p => p.time > tailAt + 1e-9);
  const out: AutomationPoint[] = [...before];
  // Ancrage : la courbe d'avant reste celle d'avant jusqu'au début du passage.
  if (start >= EPS) out.push(pt(start - EPS, origAt(start - EPS)));
  written.forEach(s => out.push(pt(s.time, s.value)));
  // AutoMatch : retour à la courbe d'origine (Trim aussi : le décalage s'arrête au relâchement).
  if (autoMatch > 0) out.push(pt(tailAt, origAt(tailAt)));
  out.push(...after);
  out.sort((a, b) => a.time - b.time);

  // Points en double à la même date : on garde le dernier écrit.
  const dedup: AutomationPoint[] = [];
  for (const p of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.time - p.time) < 1e-6) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup;
};

/** Voie d'automation d'un paramètre (créée au besoin, sans modifier la piste). */
export const findLane = (track: Pick<Track, 'automationLanes'>, name: string): AutomationLane | undefined =>
  (track.automationLanes || []).find(l => l.parameterName === name);

export const newLane = (name: string, color: string, spec: ParamSpec): AutomationLane => ({
  id: `lane-${name.replace(/[^a-z0-9]+/gi, '-')}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  parameterName: name,
  points: [],
  color,
  isExpanded: true,
  min: spec.min,
  max: spec.max,
});

/**
 * « Effacer l'automation » : vide les voies (toutes, ou un paramètre). Les
 * voies restent à leur place, sans points, comme dans Pro Tools.
 */
export const clearTrackAutomation = (track: Track, param?: string): Track => ({
  ...track,
  automationLanes: (track.automationLanes || []).map(l =>
    (!param || l.parameterName === param) ? { ...l, points: [] } : l),
});

export const hasAutomation = (track: Pick<Track, 'automationLanes'>): boolean =>
  (track.automationLanes || []).some(l => (l.points || []).length > 0);
