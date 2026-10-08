/**
 * Calage « réduction cible » (règle de mix de Romain) : NOVA écoute la voix
 * et règle le seuil (ou l'entrée, ou la « Peak Reduction ») pour que la
 * réduction de gain MAX lue sur un VU-mètre soit la cible : 5 dB pour les
 * compresseurs de voix et le FET de bus, 2 dB pour le Leveler de bus.
 *
 * - Effets NOVA : rendu hors ligne avec le cœur DSP lui-même (même code que
 *   l'AudioWorklet), réduction lue dans la cellule, balistique VU.
 * - VST réels (pont) : rendu hors ligne par le pont, réduction estimée en
 *   comparant sortie et entrée (gain court terme), même balistique VU ;
 *   voir aussi bridge-python/vst_host.calibrate_gr (même méthode).
 * Recherche dichotomique : la réduction croît (ou décroît) avec le réglage.
 */
import { createAnalogCompCore } from '../engine/analogCompCore';
import { buildAnalogInternal } from '../engine/analogCompMaps';
import { ANALOG_PROFILES } from '../engine/analogProfiles';
import { ANALOG_SPECS } from '../engine/analogCompParams';

export interface CalibrationResult {
  /** Valeur retenue du réglage. */
  value: number;
  /** Réduction max au VU obtenue (dB). */
  grDb: number;
  /** Cible atteinte à ±0,25 dB ? */
  reached: boolean;
  why?: string;
  steps: { value: number; grDb: number }[];
}

/** Balistique VU (2e ordre critique, 99 % en ~300 ms) appliquée à une trace de réduction (dB), puis maximum. */
export function vuMaxGr(trace: ArrayLike<number>, stepSeconds: number): number {
  const tau = 0.045;
  let v = 0, d = 0, max = 0;
  // pas interne ≤ 1 ms pour la stabilité
  const sub = Math.max(1, Math.ceil(stepSeconds / 0.001));
  const dt = stepSeconds / sub;
  for (let i = 0; i < trace.length; i++) {
    const g = Math.max(0, trace[i]);
    for (let k = 0; k < sub; k++) {
      const a = (g - v) / (tau * tau) - 2 * d / tau;
      d += a * dt; v += d * dt;
      if (v < 0) { v = 0; d = 0; }
    }
    if (v > max) max = v;
  }
  return max;
}

/** Réduction max au VU de l'effet NOVA `kind` réglé par `params` sur ce son. */
export function novaVuGr(kind: string, params: Record<string, number>, channels: Float32Array[], sampleRate: number): number {
  const core = createAnalogCompCore(sampleRate);
  core.setInternal(buildAnalogInternal(kind, params, ANALOG_PROFILES[kind], sampleRate));
  const B = 128;
  const n = channels[0].length;
  const L = channels[0], R = channels[1] || channels[0];
  const oL = new Float32Array(B), oR = new Float32Array(B);
  const trace = new Float32Array(Math.ceil(n / B));
  for (let i = 0, j = 0; i < n; i += B, j++) {
    const m = Math.min(B, n - i);
    core.process(L.subarray(i, i + m), R.subarray(i, i + m), oL.subarray(0, m), oR.subarray(0, m), m);
    trace[j] = core.takeMeters().grNowDb;
  }
  return vuMaxGr(trace, B / sampleRate);
}

/**
 * Réduction de gain estimée d'un traitement quelconque (VST) à partir de
 * l'entrée et de la sortie : gain court terme (fenêtres de 10 ms, passages
 * audibles seulement), référence = gain des passages les moins comprimés.
 */
export function grTraceFromIO(input: Float32Array, output: Float32Array, sampleRate: number): { trace: Float32Array; step: number } {
  const w = Math.max(1, Math.round(0.01 * sampleRate));
  const nb = Math.floor(Math.min(input.length, output.length) / w);
  const g = new Float32Array(nb).fill(NaN);
  for (let b = 0; b < nb; b++) {
    let ei = 0, eo = 0;
    for (let i = b * w; i < (b + 1) * w; i++) { ei += input[i] * input[i]; eo += output[i] * output[i]; }
    if (ei / w < 1e-6) continue; // < −60 dBFS : silence, pas d'avis
    g[b] = 10 * Math.log10(Math.max(eo, 1e-20) / ei);
  }
  const valid = Array.from(g).filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return { trace: new Float32Array(0), step: 0.01 };
  const ref = valid[Math.floor(0.98 * (valid.length - 1))];
  const trace = new Float32Array(nb);
  for (let b = 0; b < nb; b++) trace[b] = Number.isFinite(g[b]) ? Math.max(0, ref - g[b]) : 0;
  return { trace, step: w / sampleRate };
}

/**
 * Recherche dichotomique : `measure(v)` = réduction max (dB) au réglage v.
 * `sense` = +1 si augmenter v comprime plus, −1 sinon.
 */
export async function bisectForTarget(measure: (v: number) => Promise<number> | number, lo: number, hi: number, sense: 1 | -1,
  target: number, opts: { iterations?: number; tolerance?: number; step?: number } = {}): Promise<CalibrationResult> {
  const steps: { value: number; grDb: number }[] = [];
  const meas = async (v: number) => { const g = await measure(v); steps.push({ value: v, grDb: g }); return g; };
  const iters = opts.iterations ?? 14, tol = opts.tolerance ?? 0.1;
  // « peu » = côté qui comprime le moins, « beaucoup » = celui qui comprime le plus
  let little = sense > 0 ? lo : hi, much = sense > 0 ? hi : lo;
  const gMuch = await meas(much);
  if (gMuch < target - tol) return { value: much, grDb: gMuch, reached: false, why: 'le son est trop faible : même au réglage maximal, la réduction reste sous la cible', steps };
  const gLittle = await meas(little);
  if (gLittle > target + tol) return { value: little, grDb: gLittle, reached: false, why: 'le son est trop fort : même au réglage minimal, la réduction dépasse la cible', steps };
  let best = Math.abs(gMuch - target) < Math.abs(gLittle - target) ? { v: much, g: gMuch } : { v: little, g: gLittle };
  for (let k = 0; k < iters; k++) {
    const mid = (little + much) / 2;
    const g = await meas(mid);
    if (Math.abs(g - target) < Math.abs(best.g - target)) best = { v: mid, g };
    if (Math.abs(g - target) <= tol) break;
    if (g > target) much = mid; else little = mid;
  }
  const st = opts.step || 0;
  const value = st > 0 ? Math.round(best.v / st) * st : best.v;
  return { value, grDb: best.g, reached: Math.abs(best.g - target) <= 0.25, steps };
}

/** Calage d'un effet NOVA sur un son donné. */
export async function calibrateNova(kind: string, params: Record<string, number>, channels: Float32Array[], sampleRate: number, target?: number): Promise<CalibrationResult> {
  const spec = ANALOG_SPECS[kind];
  if (!spec) throw new Error(`Effet inconnu : ${kind}`);
  const ps = spec.specs.find(s => s.id === spec.driveParam)!;
  const tgt = target ?? spec.targetGrDb;
  return bisectForTarget(v => novaVuGr(kind, { ...params, [spec.driveParam]: v }, channels, sampleRate), ps.min, ps.max, spec.driveSense, tgt, { step: ps.step });
}

/** Calage d'un effet NOVA sur l'audio d'une piste du projet (clips bout à bout, 90 s max). */
export async function calibrateNovaOnTrack(kind: string, params: Record<string, number>, trackId: string, target?: number): Promise<CalibrationResult | null> {
  const { audioEngine } = await import('../engine/AudioEngine');
  const src = audioEngine.getTrackSourceAudio(trackId, 90);
  if (!src) return null;
  return calibrateNova(kind, params, src.channels, src.sampleRate, target);
}
