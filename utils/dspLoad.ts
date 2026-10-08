import { PluginInstance, Track, TrackType } from '../types';
import { canBakeTrack, isTrackFrozen, postFreezePlugins } from './freeze';

/**
 * Charge processeur estimée des pistes (module pur, sans audio).
 *
 * Coûts mesurés le 08/10/2026 : 20 instances de chaque effet rendues hors ligne
 * (Chromium 153), en millisecondes de calcul par seconde de son et par instance.
 * Le rendu audio du navigateur tourne sur UN seul fil : au-delà d'environ
 * DSP_BUDGET_MS par seconde, il ne suit plus (sous-régimes = craquements).
 */
export const FX_COST_MS: Record<string, number> = {
  REVERB: 127,
  DELAY: 43,
  AUTOTUNE: 39,
  CHORUS: 35,
  LOFI: 21,
  DOUBLER: 18.5,
  COMPRESSOR: 16,
  STEREOSPREADER: 15,
  VOCALSATURATOR: 12,
  GATEFX: 12,
  PROEQ12: 12,
  DJFILTER: 8,
  DEESSER: 7,
  FLANGER: 6,
  DENOISER: 10,
  LIMITER: 10,
  HARMONIZER: 30,
  VOICESHIFT: 25,
  TIMEFX: 15,
  MASTERSYNC: 20,
  // Effet du PC via le pont : le calcul est fait par le pont, mais le flux
  // (worklet + messages) coûte aussi au navigateur.
  VST3: 20,
};
/** Effet inconnu : coût moyen. */
export const FX_COST_DEFAULT_MS = 15;
/** Piste nue (fader, pan, mesure, compensation). */
export const TRACK_BASE_MS = 0.3;
/** Lecture d'un clip audio / du rendu gelé. */
export const CLIP_COST_MS = 0.3;
/** Instruments MIDI (synthé NOVA, 808, batterie, échantillonneurs). */
export const INSTRUMENT_COST_MS = { synth: 25, bass808: 10, drums: 12, sampler: 10 };
/** Budget réaliste d'un fil audio (ms de calcul par seconde de son). */
export const DSP_BUDGET_MS = 700;

export const pluginCostMs = (p: PluginInstance): number => {
  if (!p || p.isInactive || p.isEnabled === false) return 0;
  return FX_COST_MS[p.type] ?? FX_COST_DEFAULT_MS;
};

const isReturnOrBus = (t: Track) => t.type === TrackType.BUS || t.type === TrackType.SEND || t.id === 'master';

/** Coût estimé d'une piste (ms de calcul par seconde de son). */
export function trackCostMs(t: Track): number {
  if (!t || t.isInactive) return 0;
  let cost = TRACK_BASE_MS;
  const frozen = isTrackFrozen(t);
  // Piste gelée : le rendu remplace la source et les effets qu'il contient.
  const plugins = frozen ? postFreezePlugins(t) : (t.plugins || []);
  for (const p of plugins) cost += pluginCostMs(p);
  if (frozen) return cost + CLIP_COST_MS;
  if (t.type === TrackType.MIDI && !t.vstInstrument) cost += t.bass808 ? INSTRUMENT_COST_MS.bass808 : INSTRUMENT_COST_MS.synth;
  if (t.type === TrackType.DRUM_RACK || t.drumMachine) cost += INSTRUMENT_COST_MS.drums;
  if (t.type === TrackType.SAMPLER || t.type === TrackType.DRUM_SAMPLER || t.type === TrackType.MELODIC_SAMPLER) cost += INSTRUMENT_COST_MS.sampler;
  if (t.type === TrackType.AUDIO || t.vstInstrument) cost += Math.min(8, (t.clips || []).length) * CLIP_COST_MS;
  return Math.round(cost * 10) / 10;
}

export const totalCostMs = (tracks: Track[]): number =>
  Math.round(tracks.reduce((s, t) => s + trackCostMs(t), 0) * 10) / 10;

/** Charge estimée (0–100 %, peut dépasser 100 quand la session est trop lourde). */
export const estimatedLoadPct = (tracks: Track[], budgetMs = DSP_BUDGET_MS): number =>
  Math.round((totalCostMs(tracks) / budgetMs) * 100);

export interface HeavyTrack { id: string; name: string; costMs: number; frozen: boolean }

/** Pistes les plus lourdes (pistes de son seulement : bus et retours à part). */
export function rankHeavyTracks(tracks: Track[], n = 3, opts: { includeFrozen?: boolean } = {}): HeavyTrack[] {
  return tracks
    .filter(t => !isReturnOrBus(t) && !t.isInactive && (opts.includeFrozen || !isTrackFrozen(t)))
    .map(t => ({ id: t.id, name: t.name, costMs: trackCostMs(t), frozen: isTrackFrozen(t) }))
    .filter(t => t.costMs > TRACK_BASE_MS + CLIP_COST_MS * 2)
    .sort((a, b) => b.costMs - a.costMs)
    .slice(0, n);
}

export interface SafetyContext {
  /** Une prise est en cours (jamais de gel automatique). */
  isRecording: boolean;
  /** Pont VST connecté (sans lui, une piste avec des VST3 ne peut pas être gelée). */
  bridgeConnected: boolean;
  /** Pistes qu'un collaborateur est en train de modifier / verrouillées (collaboration). */
  busyTrackIds?: Set<string> | string[];
}

export type SafetyVerdict = { ok: true } | { ok: false; reason: string };

/** Gel automatique (mode sécurité) sans risque pour CETTE piste ? */
export function safeToAutoFreeze(t: Track | undefined, ctx: SafetyContext): SafetyVerdict {
  if (!t) return { ok: false, reason: 'piste introuvable' };
  if (ctx.isRecording) return { ok: false, reason: 'prise en cours' };
  if (t.isTrackArmed) return { ok: false, reason: 'piste armée' };
  if (t.isFrozen || isTrackFrozen(t)) return { ok: false, reason: 'déjà gelée' };
  if (t.isInactive) return { ok: false, reason: 'piste inactive' };
  if (isReturnOrBus(t)) return { ok: false, reason: 'bus, retour d\'effet ou master' };
  if (!canBakeTrack(t)) return { ok: false, reason: 'beat sous licence' };
  if (!(t.clips || []).length) return { ok: false, reason: 'rien à geler' };
  if (t.vstInstrument) return { ok: false, reason: 'instrument VST (rendu déjà automatique)' };
  if ((t.plugins || []).some(p => p.type === 'VST3' && !p.isInactive) && !ctx.bridgeConnected) return { ok: false, reason: 'effets VST sans pont' };
  if (t.remote) return { ok: false, reason: 'piste de l\'ingé à distance' };
  if (t.livePreview) return { ok: false, reason: 'aperçu de collaboration en cours' };
  const busy = ctx.busyTrackIds ? new Set(ctx.busyTrackIds) : null;
  if (busy?.has(t.id)) return { ok: false, reason: 'un collaborateur travaille sur cette piste' };
  if (!(t.plugins || []).some(p => pluginCostMs(p) > 0)) return { ok: false, reason: 'aucun effet à soulager' };
  return { ok: true };
}

/** Piste la plus lourde qu'on peut geler sans risque (mode sécurité), sinon null. */
export function pickAutoFreeze(tracks: Track[], ctx: SafetyContext): HeavyTrack | null {
  for (const h of rankHeavyTracks(tracks, tracks.length)) {
    if (safeToAutoFreeze(tracks.find(t => t.id === h.id), ctx).ok) return h;
  }
  return null;
}
