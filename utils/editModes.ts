import { useSyncExternalStore } from 'react';
import { GRID_OPTIONS, gridStepSeconds, snapToGrid } from './grid';

/**
 * Modes d'édition de Pro Tools : Shuffle, Slip, Spot et Grid (absolu ou
 * relatif). Ils décident où atterrit un clip qu'on déplace, un bord qu'on
 * rogne, une sélection de plage et le curseur.
 *
 * - SLIP : libre, à l'échantillon près.
 * - GRID absolu : le début du clip (ou son point de synchro), les bords, la
 *   plage et le curseur se calent sur la grille.
 * - GRID relatif : le clip avance par pas de grille en gardant son décalage
 *   d'origine (une prise un peu en avance reste un peu en avance).
 * - SHUFFLE : les clips se collent les uns aux autres (utils/shuffle).
 * - SPOT : un clic sur un clip ouvre « Position exacte » (components/SpotDialog).
 *
 * Inversion temporaire (Pro Tools : Ctrl pendant le glissement) : Ctrl ou
 * Maj maintenus PENDANT le glissement passent de Grid à Slip, et de Slip ou
 * Spot à Grid. Maj était déjà « libre » dans NOVA, Ctrl est la touche de
 * Pro Tools sous Windows : les deux marchent.
 *
 * Le réglage est une préférence (localStorage) ET il est sauvé avec le projet
 * (DAWState.editMode, hooks/useEditModes) ; il ne voyage pas en collaboration
 * (chacun garde son mode, seules les positions des clips voyagent).
 */

export type EditMode = 'SHUFFLE' | 'SLIP' | 'SPOT' | 'GRID';
export type GridKind = 'ABSOLUTE' | 'RELATIVE';

export interface EditModeSettings {
  mode: EditMode;
  gridKind: GridKind;
  /** Valeur de grille (utils/grid : '1/1' … '1/32', triolets). */
  gridSize: string;
  /** Shuffle Lock (Pro Tools) : interdit d'entrer en Shuffle par erreur. */
  shuffleLock: boolean;
  /** Tab to Transient (Pro Tools) : Tab va à l'attaque suivante (sinon au bord de clip suivant). */
  tabToTransient: boolean;
}

export const EDIT_MODES: EditMode[] = ['SHUFFLE', 'SLIP', 'SPOT', 'GRID'];

/** Réglage par défaut : la grille relative est le comportement historique de NOVA. */
export const DEFAULT_EDIT_MODE: EditModeSettings = { mode: 'GRID', gridKind: 'RELATIVE', gridSize: '1/4', shuffleLock: false, tabToTransient: true };

/** Infos d'affichage. Couleurs : celles des boutons de Pro Tools, adaptées au thème sombre. */
export const EDIT_MODE_INFO: Record<EditMode, { short: string; label: string; color: string; keys: string; hint: string }> = {
  SHUFFLE: {
    short: 'SHUF', label: 'Shuffle', color: '#f97316', keys: 'F1 ou Alt+1',
    hint: 'Shuffle (Pro Tools, F1) : les clips se collent les uns aux autres. Déplacer un clip pousse les suivants ; supprimer, couper ou rogner recolle la suite ; coller insère et pousse le reste. Clic droit ou Ctrl+clic : Shuffle Lock (verrou).',
  },
  SLIP: {
    short: 'SLIP', label: 'Slip', color: '#22c55e', keys: 'F2 ou Alt+2',
    hint: 'Slip (Pro Tools, F2) : déplacement et rognage libres, à l’échantillon près. Ctrl ou Maj pendant le glissement : calé sur la grille.',
  },
  SPOT: {
    short: 'SPOT', label: 'Spot', color: '#eab308', keys: 'F3 ou Alt+3',
    hint: 'Spot (Pro Tools, F3) : un clic sur un clip (appui long au doigt) ouvre « Position exacte » — mesures|temps|ticks, min:s.ms ou échantillons, pour le début, la fin ou le point de synchro.',
  },
  GRID: {
    short: 'GRID', label: 'Grid', color: '#3b82f6', keys: 'F4 ou Alt+4 (2e appui : relatif)',
    hint: 'Grid (Pro Tools, F4) : clips, bords, sélection et curseur se calent sur la grille. Absolu : le début du clip (ou son point de synchro) tombe sur la grille. Relatif (2e appui sur F4) : le clip avance par pas de grille et garde son décalage. Ctrl ou Maj pendant le glissement : libre.',
  },
};

export const GRID_KIND_LABEL: Record<GridKind, string> = { ABSOLUTE: 'absolue', RELATIVE: 'relative' };

const KEY = 'nova_edit_mode';
const isMode = (m: unknown): m is EditMode => typeof m === 'string' && (EDIT_MODES as string[]).includes(m);
const isGrid = (g: unknown): g is string => typeof g === 'string' && GRID_OPTIONS.some(o => o.value === g);

/** Remet d'aplomb un réglage lu (projet ancien, préférence abîmée). */
export function sanitizeEditMode(raw: unknown, base: EditModeSettings = DEFAULT_EDIT_MODE): EditModeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<EditModeSettings>;
  const out: EditModeSettings = {
    mode: isMode(r.mode) ? r.mode : base.mode,
    gridKind: r.gridKind === 'ABSOLUTE' || r.gridKind === 'RELATIVE' ? r.gridKind : base.gridKind,
    gridSize: isGrid(r.gridSize) ? r.gridSize : base.gridSize,
    shuffleLock: typeof r.shuffleLock === 'boolean' ? r.shuffleLock : base.shuffleLock,
    tabToTransient: typeof r.tabToTransient === 'boolean' ? r.tabToTransient : base.tabToTransient,
  };
  if (out.shuffleLock && out.mode === 'SHUFFLE') out.mode = 'SLIP';
  return out;
}

const read = (): EditModeSettings => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return raw ? sanitizeEditMode(JSON.parse(raw)) : DEFAULT_EDIT_MODE;
  } catch { return DEFAULT_EDIT_MODE; }
};

type Listener = () => void;
let current: EditModeSettings = read();
const listeners = new Set<Listener>();

const publishGlobals = () => {
  if (typeof window === 'undefined') return;
  // Lus par le nudge et les raccourcis (pas de grille), comme avant.
  (window as any).gridSize = current.gridSize;
  (window as any).isSnapEnabled = current.mode === 'GRID';
};
publishGlobals();

export const editModeStore = {
  get: (): EditModeSettings => current,
  set(patch: Partial<EditModeSettings>) {
    const next = sanitizeEditMode({ ...current, ...patch }, current);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* stockage indisponible */ }
    publishGlobals();
    listeners.forEach(l => l());
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  /** Tests : repart des valeurs par défaut, sans toucher au stockage. */
  reset() { current = DEFAULT_EDIT_MODE; publishGlobals(); listeners.forEach(l => l()); },
};

export function useEditMode(): EditModeSettings {
  return useSyncExternalStore(editModeStore.subscribe, editModeStore.get, editModeStore.get);
}

/** Message d'état après un changement de mode (affiché en notification). */
export function editModeMessage(s: EditModeSettings = current): string {
  if (s.mode === 'GRID') return `Mode Grid ${GRID_KIND_LABEL[s.gridKind]} (grille ${GRID_OPTIONS.find(o => o.value === s.gridSize)?.label || s.gridSize}) — Ctrl ou Maj pendant un glissement : libre.`;
  if (s.mode === 'SLIP') return 'Mode Slip : libre, à l’échantillon près — Ctrl ou Maj pendant un glissement : calé sur la grille.';
  if (s.mode === 'SPOT') return 'Mode Spot : clique sur un clip pour lui donner une position exacte.';
  return 'Mode Shuffle : les clips se collent, supprimer recolle la suite, coller pousse le reste.';
}

/**
 * Choisit un mode (bouton, F1–F4, Alt+1–4). Grid déjà actif : bascule absolu /
 * relatif (comme un 2e appui sur F4 dans Pro Tools). Shuffle verrouillé : refusé.
 */
export function chooseEditMode(mode: EditMode): { ok: boolean; message: string } {
  const s = current;
  if (mode === 'SHUFFLE' && s.shuffleLock) {
    return { ok: false, message: 'Shuffle est verrouillé (Shuffle Lock) : clic droit ou Ctrl+clic sur SHUF pour le déverrouiller.' };
  }
  if (mode === 'GRID' && s.mode === 'GRID') editModeStore.set({ gridKind: s.gridKind === 'ABSOLUTE' ? 'RELATIVE' : 'ABSOLUTE' });
  else editModeStore.set({ mode });
  return { ok: true, message: editModeMessage() };
}

/** Shuffle Lock on / off ; verrouiller pendant le Shuffle repasse en Slip. */
export function toggleShuffleLock(): { locked: boolean; message: string } {
  const locked = !current.shuffleLock;
  editModeStore.set({ shuffleLock: locked, ...(locked && current.mode === 'SHUFFLE' ? { mode: 'SLIP' as EditMode } : {}) });
  return { locked, message: locked ? '🔒 Shuffle Lock : impossible d’entrer en Shuffle par erreur (clic droit sur SHUF pour l’enlever).' : '🔓 Shuffle déverrouillé.' };
}

// ------------------------------------------------------------- positions

/** Fréquence d'échantillonnage par défaut (avant que le moteur audio ne soit lancé). */
export const SAMPLE_RATE = 48000;
let rateProvider: (() => number | undefined | null) | null = null;
/** Le studio donne la vraie fréquence de la session (contexte audio du moteur). */
export const setSampleRateProvider = (fn: (() => number | undefined | null) | null) => { rateProvider = fn; };
/** Fréquence de la session : « à l'échantillon près » et format Échantillons du Spot. */
export const sessionSampleRate = (): number => {
  const r = rateProvider?.();
  return r && r > 0 ? r : SAMPLE_RATE;
};
export const toSample = (t: number, sr = sessionSampleRate()): number => Math.round(t * sr) / sr;

/** Mode réellement appliqué pendant un geste (avec la touche d'inversion). */
export type EffectiveMode = 'SLIP' | 'GRID_ABS' | 'GRID_REL' | 'SHUFFLE' | 'SPOT';

export function effectiveMode(s: Pick<EditModeSettings, 'mode' | 'gridKind'>, invert = false): EffectiveMode {
  switch (s.mode) {
    case 'GRID': return invert ? 'SLIP' : (s.gridKind === 'RELATIVE' ? 'GRID_REL' : 'GRID_ABS');
    case 'SLIP': return invert ? 'GRID_ABS' : 'SLIP';
    case 'SPOT': return invert ? 'GRID_ABS' : 'SPOT';
    default: return 'SHUFFLE';
  }
}

export const snapsToGrid = (e: EffectiveMode): boolean => e === 'GRID_ABS' || e === 'GRID_REL';

/**
 * Point posé à la souris (curseur, sélection de plage, bord rogné, boucle,
 * repère) : sur la grille en Grid (absolu comme relatif), sinon à l'échantillon.
 */
export function snapPoint(t: number, s: Pick<EditModeSettings, 'mode' | 'gridKind' | 'gridSize'>, bpm: number, invert = false, sr = sessionSampleRate()): number {
  return snapsToGrid(effectiveMode(s, invert)) ? snapToGrid(t, bpm, s.gridSize, true) : toSample(t, sr);
}

/** Clip réduit à ce qu'il faut pour le point de synchro. */
export interface SyncClip { start: number; duration: number; offset?: number; syncPoint?: number }

/**
 * Point de synchro (Pro Tools : Sync Point) en secondes depuis le début du clip,
 * ou null s'il n'y en a pas (ou s'il est sorti du clip après un rognage). Il est
 * stocké en temps du fichier audio (Clip.syncPoint) : il reste collé à
 * l'attaque quand on déplace ou qu'on rogne le clip.
 */
export function syncOffsetOf(c: SyncClip): number | null {
  if (typeof c.syncPoint !== 'number' || !Number.isFinite(c.syncPoint)) return null;
  const rel = c.syncPoint - (c.offset || 0);
  return rel >= -1e-9 && rel <= c.duration + 1e-9 ? Math.max(0, Math.min(c.duration, rel)) : null;
}

/** Valeur de Clip.syncPoint pour un point de synchro posé à l'instant `t` de la timeline. */
export function syncPointAt(c: SyncClip, t: number, sr = sessionSampleRate()): number | null {
  if (t < c.start - 1e-9 || t > c.start + c.duration + 1e-9) return null;
  return toSample((c.offset || 0) + (t - c.start), sr);
}

export interface MoveArgs {
  settings: Pick<EditModeSettings, 'mode' | 'gridKind' | 'gridSize'>;
  invert?: boolean;
  bpm: number;
  /** Début du clip au début du glissement. */
  origStart: number;
  /** Début brut sous la souris (origStart + déplacement). */
  rawStart: number;
  /** Point de synchro (s depuis le début du clip) : c'est lui qui se cale en Grid absolu. */
  syncOffset?: number | null;
  sr?: number;
}

/** Nouveau début d'un clip déplacé (hors Shuffle, qui a sa propre logique). */
export function moveClipStart(a: MoveArgs): number {
  const eff = effectiveMode(a.settings, a.invert);
  const step = gridStepSeconds(a.settings.gridSize, a.bpm);
  if (eff === 'GRID_ABS') {
    const sync = a.syncOffset || 0;
    let res = snapToGrid(a.rawStart + sync, a.bpm, a.settings.gridSize, true) - sync;
    if (res < -1e-9) res += step * Math.ceil((-res - 1e-9) / step);
    return Math.max(0, res);
  }
  if (eff === 'GRID_REL') {
    const k = Math.round((a.rawStart - a.origStart) / step);
    let res = a.origStart + k * step;
    while (res < -1e-9) res += step;
    return Math.max(0, res);
  }
  return Math.max(0, toSample(a.rawStart, a.sr));
}

/** Pas de la grille courante en secondes. */
export const currentGridStep = (bpm: number): number => gridStepSeconds(current.gridSize, bpm);
