/**
 * R8 · Automation des effets historiques de NOVA (Compresseur, EQ, Reverb,
 * Délai, De-esser, Saturation, Doubleur, Nova Tune).
 *
 * Ces effets pilotent des nœuds Web Audio natifs (gains, filtres) ou un
 * AudioWorklet. Leurs réglages utiles sont exposés au moteur comme ceux des
 * effets V21 et du limiteur : `automationParam(clé)` renvoie un objet qui se
 * programme comme un AudioParam (setValueAtTime, linearRampToValueAtTime,
 * cancelScheduledValues, value). Le moteur y programme la voie d'automation
 * D'AVANCE, calée sur la latence (PDC), en lecture comme à l'export : au bloc
 * près, sans minuteur ni pause du rendu.
 *
 * `MappedParam` relaie chaque événement vers un ou plusieurs AudioParam
 * internes, à travers une loi (mix → cos / sin des gains sec / effet, dB →
 * gain…). Une rampe linéaire dans l'unité du réglage devient, si la loi n'est
 * pas affine, une suite de courtes rampes (≤ 5 ms) : l'écart à la vraie courbe
 * reste inaudible (< 0,01 dB sur un mix).
 *
 * Réglage statique (fenêtre de l'effet) : `setStatic` ne touche l'AudioParam
 * QUE si la valeur a changé. Régler le ratio pendant la lecture ne remet donc
 * plus le seuil automatisé à sa valeur fixe (et le moteur retire de toute
 * mise à jour les réglages tenus par une voie, voir AudioEngine).
 */

export interface ParamTarget {
  param: AudioParam;
  /** Loi réglage → valeur de l'AudioParam (identité si absente). */
  map?: (v: number) => number;
}

export interface MappedParamOptions {
  /** Bornes du réglage (unité de l'utilisateur). */
  min: number;
  max: number;
  /** Valeur de départ. */
  value: number;
  /** Lois affines (identité, a·v + b) : les rampes passent telles quelles. */
  affine?: boolean;
  /** Réciproque de la loi de la 1re cible (relecture de `value`). */
  inverse?: (y: number) => number;
}

/** Durée maximale d'une marche quand une rampe suit une loi non affine (s). */
export const RAMP_STEP_SEC = 0.005;

export class MappedParam {
  private targets: ParamTarget[];
  private opts: MappedParamOptions;
  private lastStatic: number;
  /** Dernier événement programmé (départ de la rampe suivante). */
  private last: { t: number; v: number };
  readonly minValue: number;
  readonly maxValue: number;
  readonly defaultValue: number;

  constructor(private ctx: BaseAudioContext, targets: ParamTarget[], opts: MappedParamOptions) {
    this.targets = targets;
    this.opts = opts;
    this.minValue = opts.min;
    this.maxValue = opts.max;
    this.defaultValue = opts.value;
    const v = this.clamp(opts.value);
    this.lastStatic = v;
    this.last = { t: 0, v };
    for (const tg of targets) {
      try { tg.param.cancelScheduledValues(0); tg.param.setValueAtTime(this.mapOf(tg, v), 0); } catch { tg.param.value = this.mapOf(tg, v); }
    }
  }

  private clamp(v: number) { return Math.max(this.opts.min, Math.min(this.opts.max, Number.isFinite(v) ? v : this.opts.value)); }
  private mapOf(tg: ParamTarget, v: number) { const y = tg.map ? tg.map(v) : v; return Number.isFinite(y) ? y : 0; }

  /** Valeur actuelle dans l'unité du réglage. */
  get value(): number {
    const tg = this.targets[0];
    if (!tg) return this.last.v;
    const y = tg.param.value;
    if (!tg.map) return y;
    return this.opts.inverse ? this.clamp(this.opts.inverse(y)) : this.last.v;
  }
  set value(v: number) { this.setValueAtTime(v, this.ctx.currentTime); }

  setValueAtTime(v: number, t: number): this {
    const c = this.clamp(v);
    for (const tg of this.targets) tg.param.setValueAtTime(this.mapOf(tg, c), t);
    this.last = { t, v: c };
    return this;
  }

  linearRampToValueAtTime(v: number, t: number): this {
    const c = this.clamp(v);
    const from = this.last;
    if (this.opts.affine || !(t > from.t)) {
      for (const tg of this.targets) tg.param.linearRampToValueAtTime(this.mapOf(tg, c), t);
    } else {
      const n = Math.max(1, Math.min(512, Math.ceil((t - from.t) / RAMP_STEP_SEC)));
      for (let k = 1; k <= n; k++) {
        const r = k / n;
        const vk = from.v + (c - from.v) * r;
        const tk = k === n ? t : from.t + (t - from.t) * r;
        for (const tg of this.targets) tg.param.linearRampToValueAtTime(this.mapOf(tg, vk), tk);
      }
    }
    this.last = { t, v: c };
    return this;
  }

  setTargetAtTime(v: number, t: number, tau: number): this {
    const c = this.clamp(v);
    for (const tg of this.targets) tg.param.setTargetAtTime(this.mapOf(tg, c), t, tau);
    this.last = { t, v: c };
    return this;
  }

  cancelScheduledValues(t: number): this {
    const v = this.value;
    for (const tg of this.targets) tg.param.cancelScheduledValues(t);
    this.last = { t, v };
    return this;
  }

  /**
   * Réglage fixe (fenêtre de l'effet, projet chargé) : appliqué seulement s'il
   * a changé, ou toujours avec `force` (effet réactivé, retour à l'arrêt).
   */
  setStatic(v: number, opts: { force?: boolean; tau?: number; immediate?: boolean } = {}): void {
    const c = this.clamp(v);
    if (!opts.force && c === this.lastStatic) return;
    this.lastStatic = c;
    const now = this.ctx.currentTime;
    if (opts.immediate) {
      for (const tg of this.targets) { try { tg.param.cancelScheduledValues(now); tg.param.setValueAtTime(this.mapOf(tg, c), now); } catch { /* */ } }
      this.last = { t: now, v: c };
    } else this.setTargetAtTime(c, now, opts.tau ?? 0.01);
  }

  /** Revient au réglage fixe (lecture arrêtée : la voie ne joue plus). */
  restoreStatic() { this.setStatic(this.lastStatic, { force: true }); }
  get staticValue() { return this.lastStatic; }
}

/** Jeu de réglages automatisables d'un effet : clé → MappedParam. */
export class AutomationSet {
  private map = new Map<string, MappedParam>();
  add(key: string, p: MappedParam) { this.map.set(key, p); return p; }
  get(key: string): MappedParam | null { return this.map.get(key) || null; }
  has(key: string) { return this.map.has(key); }
  /** Applique les clés présentes dans une mise à jour (réglage fixe, seulement si changé). */
  setFrom(p: Record<string, any>, opts: { force?: boolean } = {}) {
    for (const [k, mp] of this.map) {
      const v = p?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) mp.setStatic(v, opts);
    }
  }
  restoreStatic() { this.map.forEach(mp => mp.restoreStatic()); }
  keys() { return [...this.map.keys()]; }
}

// ---------------------------------------------------------------------------
// Lois usuelles
// ---------------------------------------------------------------------------

export const dbToLin = (db: number) => Math.pow(10, db / 20);
/** Mix « puissance constante » des effets NOVA (Reverb, Délai). */
export const mixDry = (m: number) => Math.cos(Math.max(0, Math.min(1, m)) * Math.PI * 0.5);
export const mixWet = (m: number) => Math.sin(Math.max(0, Math.min(1, m)) * Math.PI * 0.5);
export const mixFromWet = (y: number) => Math.asin(Math.max(0, Math.min(1, y))) * 2 / Math.PI;

// ---------------------------------------------------------------------------
// Catalogue : ce qui apparaît dans « + voie » (noms français, bornes, unités)
// ---------------------------------------------------------------------------

export interface LegacyAutomatable { id: string; label: string; min: number; max: number; unit?: string }

const EQ_BANDS = 12;
/** EQ : fréquence, gain et largeur (Q) de chaque bande, puis gain de sortie. */
export const EQ_AUTOMATABLE: LegacyAutomatable[] = [
  ...Array.from({ length: EQ_BANDS }, (_, i) => [
    { id: `b${i + 1}Freq`, label: `Bande ${i + 1} : fréquence`, min: 20, max: 20000, unit: 'Hz' },
    { id: `b${i + 1}Gain`, label: `Bande ${i + 1} : gain`, min: -30, max: 30, unit: 'dB' },
    { id: `b${i + 1}Q`, label: `Bande ${i + 1} : largeur (Q)`, min: 0.1, max: 18, unit: '' },
  ]).flat(),
  { id: 'masterGain', label: 'Gain de sortie', min: 0, max: 2, unit: '×' },
];

export const LEGACY_AUTOMATABLE: Record<string, LegacyAutomatable[]> = {
  COMPRESSOR: [
    { id: 'threshold', label: 'Seuil', min: -60, max: 0, unit: 'dB' },
    { id: 'ratio', label: 'Ratio', min: 1, max: 20, unit: ':1' },
    { id: 'mix', label: 'Mix (parallèle)', min: 0, max: 1, unit: '%' },
    { id: 'makeupGain', label: 'Gain de compensation', min: 0, max: 8, unit: '×' },
  ],
  PROEQ12: EQ_AUTOMATABLE,
  REVERB: [
    { id: 'mix', label: 'Mix', min: 0, max: 1, unit: '%' },
    { id: 'preDelay', label: 'Pré-délai', min: 0, max: 0.25, unit: 's' },
  ],
  DELAY: [
    { id: 'mix', label: 'Mix', min: 0, max: 1, unit: '%' },
    { id: 'feedback', label: 'Réinjection', min: 0, max: 0.95, unit: '%' },
    { id: 'feedbackLP', label: 'Couleur (passe-bas des échos)', min: 500, max: 20000, unit: 'Hz' },
  ],
  DEESSER: [
    { id: 'threshold', label: 'Seuil', min: -60, max: 0, unit: 'dB' },
    { id: 'relThreshold', label: 'Seuil relatif', min: -30, max: 6, unit: 'dB' },
    { id: 'frequency', label: 'Fréquence', min: 2000, max: 12000, unit: 'Hz' },
  ],
  VOCALSATURATOR: [
    { id: 'mix', label: 'Mélange', min: 0, max: 1, unit: '%' },
    { id: 'tone', label: 'Couleur (tilt)', min: -1, max: 1, unit: '' },
    { id: 'outputGain', label: 'Gain de sortie', min: 0, max: 2, unit: '×' },
  ],
  DOUBLER: [
    { id: 'width', label: 'Largeur', min: 0, max: 1, unit: '%' },
    { id: 'gainL', label: 'Doublure gauche : niveau', min: 0, max: 1, unit: '%' },
    { id: 'gainR', label: 'Doublure droite : niveau', min: 0, max: 1, unit: '%' },
  ],
  AUTOTUNE: [
    { id: 'speed', label: 'Vitesse de correction', min: 0, max: 1, unit: '' },
    { id: 'mix', label: 'Intensité', min: 0, max: 1, unit: '%' },
    { id: 'humanize', label: 'Humanisation', min: 0, max: 1, unit: '%' },
  ],
};

/** Réglages automatisables d'un effet historique (vide si l'effet n'en a pas). */
export const legacyAutomatable = (type: string): LegacyAutomatable[] => LEGACY_AUTOMATABLE[type] || [];

/** Nom français d'un réglage automatisable d'un effet historique. */
export const legacyParamLabel = (type: string, key: string): string | null =>
  legacyAutomatable(type).find(a => a.id === key)?.label || null;

/** Clé d'EQ « b3Freq » → bande (0…11) et champ. */
export const parseEqKey = (key: string): { band: number; field: 'frequency' | 'gain' | 'q' } | null => {
  const m = /^b(\d{1,2})(Freq|Gain|Q)$/.exec(key);
  if (!m) return null;
  const band = +m[1] - 1;
  if (band < 0 || band >= EQ_BANDS) return null;
  return { band, field: m[2] === 'Freq' ? 'frequency' : m[2] === 'Gain' ? 'gain' : 'q' };
};

// ---------------------------------------------------------------------------
// Réglages fixes vs automation (moteur)
// ---------------------------------------------------------------------------

const PLUGIN_LANE = /^plugin::(.+?)::(.+)$/;

/**
 * Réglages fixes d'un effet à transmettre au nœud, SANS ceux qu'une voie
 * d'automation tient pendant la lecture : sinon la moindre mise à jour de la
 * piste (un autre réglage, un fader) reposait la valeur fixe au milieu de la
 * courbe programmée d'avance, jusqu'au point suivant.
 */
export function paramsWithoutAutomated(
  params: Record<string, any> | undefined,
  lanes: { parameterName: string; points: unknown[] }[],
  pluginId: string,
  playing: boolean,
): Record<string, any> {
  const p = params || {};
  if (!playing || !lanes.length) return p;
  let out: Record<string, any> | null = null;
  for (const l of lanes) {
    if (!l.points.length) continue;
    const m = PLUGIN_LANE.exec(l.parameterName);
    if (!m || m[1] !== pluginId || !(m[2] in p)) continue;
    if (!out) out = { ...p };
    delete out[m[2]];
  }
  return out || p;
}

/** Vrai si une voie (avec points) pilote un réglage de cet effet. */
export const hasPluginLane = (lanes: { parameterName: string; points: unknown[] }[], pluginId: string) =>
  lanes.some(l => l.points.length > 0 && l.parameterName.startsWith(`plugin::${pluginId}::`));

/** Valeur fixe d'un réglage automatisable (EQ : « b3Freq » lu dans la bande 3), ou undefined. */
export function pluginParamStaticValue(params: Record<string, any> | undefined, key: string): number | undefined {
  const p = params || {};
  const e = parseEqKey(key);
  const v = e ? p.bands?.[e.band]?.[e.field] : p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
