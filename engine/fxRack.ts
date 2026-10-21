/**
 * Rack d'effets parallèles NOVA (écart 13 du comparatif du 21/10/2026) : règles pures, testées.
 *
 * Le rack est UN effet de la chaîne (type « FXRACK », engine/pluginRegistry.ts) : il héberge
 * lui-même ses branches (engine/FxRackNode.ts), la construction des pistes du moteur ne change pas.
 *
 *   entrée ─┬─ (retard = latence du rack) ─ sec × (1 − mélange) ───────────────┐
 *           └─ division ─ branche k : effets en série → réalignement → niveau ─┴─ humide × mélange → sortie
 *
 * Division :
 *  - « parallele » : 2 à 4 branches reçoivent le même son ;
 *  - « bandes »    : 2 ou 3 bandes de fréquence (filtres Linkwitz-Riley 24 dB/oct, somme à
 *                    module plat : la bande grave passe aussi par le passe-tout de la 2e coupure) ;
 *  - « ms »        : branche 1 = centre (Mid), branche 2 = côtés (Side), recombinées G = M + S, D = M − S.
 * Réalignement : chaque branche est retardée de (latence max − sa latence) ; le son sec aussi,
 * de la latence du rack, annoncée au moteur (PDC).
 * Valeurs par défaut : 2 branches vides à −6,02 dB (×0,5) : le son passe inchangé AU BIT PRÈS.
 */
import type { PluginInstance } from '../types';

export type RackMode = 'parallele' | 'bandes' | 'ms';

export interface RackBranch {
  id: string;
  name?: string;
  /** Effets de la branche, en série (effets NOVA). */
  plugins: PluginInstance[];
  /** Niveau de la branche (dB) ; ≤ −80 = coupé. */
  level: number;
  mute?: boolean;
  solo?: boolean;
}

export interface RackParams {
  mode: RackMode;
  branches: RackBranch[];
  /** Nombre de bandes en mode « bandes » (2 ou 3). */
  bandCount: number;
  /** Coupures (Hz) en mode « bandes ». */
  x1: number;
  x2: number;
  /** Mélange sec / humide global (%) : 0 = son d'origine seul, 100 = branches seules. */
  mix: number;
  /** Volume de sortie (dB). */
  outGain: number;
}

export const RACK_MAX_BRANCHES = 4;
export const RACK_MIN_BRANCHES = 2;
/** −6,02 dB : ×0,5 exactement (deux branches vides = le son d'origine, au bit près). */
export const HALF_DB = 20 * Math.log10(0.5);
export const LEVEL_OFF_DB = -80;

/**
 * Effets NOVA qu'une branche peut accueillir. Pas de VST du PC (pont), ni d'Auto-Tune (route
 * hybride vers le pont), ni de rack dans un rack.
 */
export const RACK_BUILTIN_FX: { type: string; name: string }[] = [
  { type: 'PROEQ12', name: 'Égaliseur 12 bandes' },
  { type: 'COMPRESSOR', name: 'Compresseur' },
  { type: 'REVERB', name: 'Réverbe' },
  { type: 'DELAY', name: 'Écho (délai)' },
  { type: 'VOCALSATURATOR', name: 'Saturation' },
  { type: 'DEESSER', name: 'De-esser' },
  { type: 'CHORUS', name: 'Chorus' },
  { type: 'FLANGER', name: 'Flanger' },
  { type: 'DOUBLER', name: 'Doubleur' },
  { type: 'STEREOSPREADER', name: 'Stéréo' },
];
export const RACK_EXCLUDED = new Set(['FXRACK', 'VST3', 'AUTOTUNE', 'MASTERSYNC', 'DENOISER', 'SAMPLER', 'DRUM_SAMPLER', 'MELODIC_SAMPLER', 'DRUM_RACK_UI']);

let seq = 0;
export const newRackId = (prefix = 'rb') => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const rackBranch = (level = HALF_DB, id?: string): RackBranch => ({ id: id || newRackId(), plugins: [], level });

export const rackDefaults = (): RackParams => ({
  mode: 'parallele',
  branches: [rackBranch(HALF_DB, 'rb-1'), rackBranch(HALF_DB, 'rb-2')],
  bandCount: 3,
  x1: 200,
  x2: 3000,
  mix: 100,
  outGain: 0,
});

const num = (v: any, d: number, lo: number, hi: number) => { const x = +v; return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };

/** Nombre de branches imposé par la division (bandes : 2 ou 3 ; M/S : 2 ; parallèle : 2 à 4). */
export function branchCountFor(mode: RackMode, bandCount: number, current: number): number {
  if (mode === 'ms') return 2;
  if (mode === 'bandes') return bandCount >= 3 ? 3 : 2;
  return Math.max(RACK_MIN_BRANCHES, Math.min(RACK_MAX_BRANCHES, current));
}

/** Réglages propres, quoi qu'on reçoive (projet ancien, collaboration, IA). */
export function sanitizeRack(p: any): RackParams {
  const d = rackDefaults();
  const mode: RackMode = p?.mode === 'bandes' || p?.mode === 'ms' ? p.mode : 'parallele';
  const bandCount = +p?.bandCount === 2 ? 2 : 3;
  const src: any[] = Array.isArray(p?.branches) ? p.branches : d.branches;
  const want = branchCountFor(mode, bandCount, src.length || 2);
  const branches: RackBranch[] = [];
  for (let i = 0; i < want; i++) {
    const b = src[i] || {};
    branches.push({
      id: typeof b.id === 'string' && b.id ? b.id : `rb-${i + 1}`,
      ...(typeof b.name === 'string' && b.name.trim() ? { name: b.name.trim().slice(0, 40) } : {}),
      plugins: (Array.isArray(b.plugins) ? b.plugins : []).filter((x: any) => x && typeof x.type === 'string' && !RACK_EXCLUDED.has(x.type) && typeof x.id === 'string')
        .map((x: any) => ({ id: x.id, name: x.name || x.type, type: x.type, isEnabled: x.isEnabled !== false, params: x.params && typeof x.params === 'object' ? x.params : {}, latency: 0 })),
      level: num(b.level, mode === 'parallele' ? HALF_DB : 0, LEVEL_OFF_DB, 12),
      ...(b.mute ? { mute: true } : {}),
      ...(b.solo ? { solo: true } : {}),
    });
  }
  let x1 = num(p?.x1, d.x1, 40, 16000), x2 = num(p?.x2, d.x2, 60, 18000);
  if (bandCount >= 3 && x2 < x1 * 1.25) x2 = Math.min(18000, x1 * 1.25);
  return { mode, branches, bandCount, x1, x2, mix: num(p?.mix, 100, 0, 100), outGain: num(p?.outGain, 0, -24, 12) };
}

/** Noms des branches selon la division. */
export function branchLabel(p: Pick<RackParams, 'mode' | 'bandCount'>, i: number, b?: RackBranch): string {
  if (b?.name) return b.name;
  if (p.mode === 'ms') return i === 0 ? 'Centre' : 'Côtés';
  if (p.mode === 'bandes') return (p.bandCount >= 3 ? ['Grave', 'Médium', 'Aigu'] : ['Grave', 'Aigu'])[i] || `Bande ${i + 1}`;
  return `Branche ${i + 1}`;
}

/** Gain linéaire effectif d'une branche (niveau, coupure, solo d'une autre branche). */
export function branchGain(p: RackParams, i: number): number {
  const b = p.branches[i];
  if (!b) return 0;
  const anySolo = p.branches.some(x => x.solo);
  if (b.mute || (anySolo && !b.solo)) return 0;
  return levelToGain(b.level);
}

/** Gain linéaire d'un niveau en dB (−80 = coupé). La valeur −6,02 dB donne 0,5 EXACTEMENT. */
export const levelToGain = (db: number) => (db <= LEVEL_OFF_DB + 1e-9 ? 0 : Math.abs(db - HALF_DB) < 1e-9 ? 0.5 : Math.pow(10, db / 20));

/**
 * Réalignement : latences des branches (échantillons) → latence du rack et retard de chaque
 * branche, en échantillons entiers.
 */
export function rackAlignment(branchLatencies: number[]): { latency: number; delays: number[] } {
  const lat = branchLatencies.map(l => (Number.isFinite(l) && l > 0 ? Math.round(l) : 0));
  const latency = lat.length ? Math.max(...lat) : 0;
  return { latency, delays: lat.map(l => latency - l) };
}

/** Effets actifs (non contournés) d'une branche. */
export const activePlugins = (b: RackBranch) => b.plugins.filter(p => p.isEnabled !== false && !p.isInactive);

/**
 * Clé de structure : ce qui impose de recâbler le rack (division, branches, effets présents ou
 * contournés). Niveaux, mélange, coupures et réglages des effets n'en font pas partie.
 */
export function rackStructureKey(p: RackParams): string {
  return JSON.stringify([p.mode, p.mode === 'bandes' ? p.bandCount : 0, p.branches.map(b => b.plugins.map(x => `${x.id}:${x.type}:${x.isEnabled !== false && !x.isInactive ? 1 : 0}`))]);
}

/** Réglages automatisables du rack (éditeur d'automation). */
export const RACK_AUTOMATABLE = [
  { id: 'mix', label: 'Mélange sec / humide', min: 0, max: 100, unit: '%' },
  { id: 'outGain', label: 'Volume de sortie', min: -24, max: 12, unit: 'dB' },
  ...[1, 2, 3, 4].map(k => ({ id: `br${k}Level`, label: `Niveau de la branche ${k}`, min: LEVEL_OFF_DB, max: 12, unit: 'dB' })),
];

/** Remplace les réglages d'un effet d'une branche (fenêtre de l'effet, dans le rack). */
export function withChildParams(p: RackParams, branchId: string, pluginId: string, params: Record<string, any>): RackParams {
  return { ...p, branches: p.branches.map(b => (b.id !== branchId ? b : { ...b, plugins: b.plugins.map(x => (x.id === pluginId ? { ...x, params: { ...x.params, ...params } } : x)) })) };
}

/** Change la division : le nombre de branches suit (branches gardées dans l'ordre, effets compris). */
export function withMode(p: RackParams, mode: RackMode, bandCount = p.bandCount): RackParams {
  const n = branchCountFor(mode, bandCount, p.branches.length);
  const branches = p.branches.slice(0, n).map(b => ({ ...b }));
  while (branches.length < n) branches.push(rackBranch(mode === 'parallele' ? HALF_DB : 0));
  // En bandes et en M/S, chaque branche est une part du son : 0 dB rend le son d'origine.
  if (mode !== p.mode) branches.forEach(b => { if (mode !== 'parallele' && Math.abs(b.level - HALF_DB) < 1e-9) b.level = 0; if (mode === 'parallele' && b.level === 0 && !b.plugins.length) b.level = HALF_DB; });
  return { ...p, mode, bandCount, branches };
}
