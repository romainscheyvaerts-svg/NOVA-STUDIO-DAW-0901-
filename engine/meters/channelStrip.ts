/**
 * Tête de tranche (R11) : trim d'entrée, inversion de polarité (Ø), mono
 * (somme) et largeur stéréo, AVANT les inserts (comme le trim et le Ø d'une
 * console ou du plugin Trim de Pro Tools).
 *
 * Nœuds natifs uniquement (aucun AudioWorklet) : même câblage en lecture et à
 * l'export (OfflineAudioContext), sans latence, et rien n'est inséré tant que
 * la piste garde ses réglages neutres (aucun coût sur 40 pistes neutres).
 *
 * Matrice milieu / côtés, p = ±1 (polarité), w = largeur (0 = mono, 1 = normal, 2 = très large) :
 *   M = p·(L + R) / 2     S = p·(L − R) / 2
 *   L' = M + w·S          R' = M − w·S
 * Le gain du nœud « côtés » EST la largeur : un seul AudioParam, automatisable.
 */
import type { AutomationLane } from '../../types';

export interface StripSettings {
  /** Trim d'entrée (dB, −24 à +24). */
  trimDb: number;
  /** Inversion de polarité des deux canaux (Ø). */
  phase: boolean;
  /** Somme mono. */
  mono: boolean;
  /** Largeur stéréo (0 à 2 ; 1 = inchangée). */
  width: number;
}

export const TRIM_PARAM = 'trim';
export const WIDTH_PARAM = 'width';
export const TRIM_MIN_DB = -24, TRIM_MAX_DB = 24;

export interface StripFields {
  inputTrimDb?: number;
  phaseInvert?: boolean;
  monoSum?: boolean;
  stereoWidth?: number;
  automationLanes?: AutomationLane[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function stripOf(t: StripFields): StripSettings {
  const trim = Number.isFinite(t.inputTrimDb) ? clamp(t.inputTrimDb!, TRIM_MIN_DB, TRIM_MAX_DB) : 0;
  const width = Number.isFinite(t.stereoWidth) ? clamp(t.stereoWidth!, 0, 2) : 1;
  return { trimDb: trim, phase: !!t.phaseInvert, mono: !!t.monoSum, width };
}

const hasLane = (t: StripFields, name: string) => (t.automationLanes || []).some(l => l.parameterName === name && l.points.length > 0);

/** Ce que la tranche doit câbler : trim seul, et / ou la matrice (polarité, mono, largeur). */
export function stripNeeds(t: StripFields): { trim: boolean; matrix: boolean } {
  const s = stripOf(t);
  return {
    trim: Math.abs(s.trimDb) > 1e-6 || hasLane(t, TRIM_PARAM),
    matrix: s.phase || s.mono || Math.abs(s.width - 1) > 1e-6 || hasLane(t, WIDTH_PARAM),
  };
}

/** Empreinte de câblage (graphe de la piste reconstruit si elle change). */
export function stripSignature(t: StripFields): string {
  const n = stripNeeds(t);
  return n.trim || n.matrix ? `|strip:${n.trim ? 't' : ''}${n.matrix ? 'm' : ''}` : '';
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);

export interface StripNodes {
  input: AudioNode;
  output: AudioNode;
  trim?: GainNode;
  /** Gain des côtés = largeur (AudioParam automatisable). */
  side?: GainNode;
  coef?: GainNode[];
  /** Mono enclenché : la largeur (et son automation) est ignorée. */
  monoOn?: boolean;
  all: AudioNode[];
  sig: string;
}

/** Construit la tête de tranche (null si neutre : la piste reste câblée en direct). */
export function buildStrip(ctx: BaseAudioContext, t: StripFields): StripNodes | null {
  const need = stripNeeds(t);
  if (!need.trim && !need.matrix) return null;
  const all: AudioNode[] = [];
  let input: AudioNode | null = null, output: AudioNode | null = null;
  let trim: GainNode | undefined, side: GainNode | undefined, coef: GainNode[] | undefined;
  if (need.trim) {
    trim = ctx.createGain();
    trim.channelCount = 2; trim.channelCountMode = 'explicit'; trim.channelInterpretation = 'speakers';
    all.push(trim);
    input = output = trim;
  }
  if (need.matrix) {
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const mid = ctx.createGain();
    side = ctx.createGain();
    const sideNeg = ctx.createGain();
    sideNeg.gain.value = -1;
    mid.channelCount = 1; mid.channelCountMode = 'explicit';
    side.channelCount = 1; side.channelCountMode = 'explicit';
    sideNeg.channelCount = 1; sideNeg.channelCountMode = 'explicit';
    // L→M, R→M, L→S, R→S
    coef = [0, 1, 2, 3].map(() => { const g = ctx.createGain(); g.channelCount = 1; g.channelCountMode = 'explicit'; return g; });
    split.connect(coef[0], 0); split.connect(coef[1], 1);
    split.connect(coef[2], 0); split.connect(coef[3], 1);
    coef[0].connect(mid); coef[1].connect(mid);
    coef[2].connect(side); coef[3].connect(side);
    mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
    side.connect(merge, 0, 0);
    side.connect(sideNeg); sideNeg.connect(merge, 0, 1);
    all.push(split, merge, mid, side, sideNeg, ...coef);
    if (output) output.connect(split); else input = split;
    output = merge;
  }
  const s: StripNodes = { input: input!, output: output!, trim, side, coef, all, sig: stripSignature(t) };
  setStrip(s, t, ctx.currentTime, true);
  return s;
}

/**
 * Pose les réglages (valeurs immédiates à l'arrêt / à l'export, lissées sur
 * 10 ms en lecture). `automated` : le paramètre suit une courbe, on n'y touche pas.
 */
export function setStrip(s: StripNodes, t: StripFields, when: number, immediate: boolean, automated?: { trim?: boolean; width?: boolean }) {
  const v = stripOf(t);
  const set = (p: AudioParam, x: number) => {
    if (immediate) { try { p.cancelScheduledValues(when); } catch { /* */ } p.setValueAtTime(x, when); }
    else p.setTargetAtTime(x, when, 0.01);
  };
  if (s.trim && !automated?.trim) set(s.trim.gain, dbToGain(v.trimDb));
  if (s.coef && s.side) {
    const p = v.phase ? -0.5 : 0.5;
    set(s.coef[0].gain, p); set(s.coef[1].gain, p);
    set(s.coef[2].gain, p); set(s.coef[3].gain, -p);
    // Mono prime sur la largeur (et sur son automation).
    s.monoOn = v.mono;
    if (v.mono) set(s.side.gain, 0);
    else if (!automated?.width) set(s.side.gain, v.width);
  }
}

export function disposeStrip(s: StripNodes | null | undefined) {
  s?.all.forEach(n => { try { n.disconnect(); } catch { /* */ } });
}

/** AudioParam d'automation de la tranche ('trim' en gain linéaire, 'width' de 0 à 2). */
export function stripParam(s: StripNodes | null | undefined, name: string): AudioParam | null {
  if (!s) return null;
  if (name === TRIM_PARAM) return s.trim?.gain || null;
  if (name === WIDTH_PARAM) return s.monoOn ? null : s.side?.gain || null;
  return null;
}
