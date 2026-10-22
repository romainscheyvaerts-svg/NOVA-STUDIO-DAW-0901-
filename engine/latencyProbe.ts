/**
 * Mesure RÉELLE de la latence aller-retour par une boucle (comme Engine::measureLatency du moteur
 * natif) : un court balayage (chirp) part dans la sortie du navigateur à un n° d'image CONNU de
 * l'horloge du contexte, et l'entrée est captée à partir de ce même n° d'image. L'écart trouvé par
 * corrélation est exactement le retard qu'a une prise : un son rendu à l'image F de la timeline
 * revient à l'enregistreur à l'image F + D. Le moteur retire alors D aux prises (au lieu de
 * l'estimation baseLatency + outputLatency + latence annoncée du micro, souvent fausse de
 * plusieurs dizaines de ms).
 *
 * Boucle : micro près de l'enceinte / du casque, ou câble de la sortie vers l'entrée de la carte.
 * Trois mesures, médiane ; refusée si le balayage n'est pas reconnu nettement ou si les trois
 * mesures ne concordent pas (±1 ms).
 *
 * Le worklet n'alloue rien dans process() : tampons de capture préalloués, un seul message à la fin.
 */

import { retireWorkletNode } from './workletGuard';

export const PROBE_LEN = 512;

/** Balayage 1 → 6 kHz, fenêtre de Hann, crête 0,5 (≈ −6 dBFS, 10 ms) : net, court, supportable. */
export function probePattern(sr: number, len = PROBE_LEN): Float32Array {
  const x = new Float32Array(len);
  const f0 = 1000, f1 = Math.min(6000, sr * 0.4), T = len / sr;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const ph = 2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * T));
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    x[i] = 0.5 * w * Math.sin(ph);
  }
  return x;
}

/**
 * Retard (images) du motif dans la capture : pic de corrélation croisée normalisée.
 * `clarity` = pic / moyenne des valeurs absolues de la corrélation (≥ 8 : reconnu).
 */
export function findDelay(cap: Float32Array, pat: Float32Array, maxLag = cap.length - pat.length): { lag: number; clarity: number } {
  const n = pat.length;
  let best = -1, bestV = 0, sum = 0, cnt = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    let v = 0;
    for (let i = 0; i < n; i++) v += cap[lag + i] * pat[i];
    const a = Math.abs(v);
    sum += a; cnt++;
    if (a > bestV) { bestV = a; best = lag; }
  }
  const mean = cnt ? sum / cnt : 0;
  return { lag: best, clarity: mean > 0 ? bestV / mean : 0 };
}

export const LATENCY_PROBE_WORKLET = `
class NovaLatencyProbe extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.pat = o.pattern;
    this.cap = new Float32Array(o.window);
    this.at = -1; this.n = 0; this.state = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'go') { this.at = e.data.at; this.n = 0; this.state = 1; } };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (out) out.fill(0);
    if (this.state !== 1) return true;
    const inp = inputs[0];
    const nIn = inp ? inp.length : 0;
    const len = out ? out.length : 128;
    for (let i = 0; i < len; i++) {
      const k = currentFrame + i - this.at;
      if (k < 0) continue;
      if (out && k < this.pat.length) out[i] = this.pat[k];
      if (this.n < this.cap.length) {
        let v = 0;
        for (let c = 0; c < nIn; c++) v += inp[c][i];
        this.cap[this.n++] = nIn > 1 ? v / nIn : v;
      }
    }
    if (this.n >= this.cap.length) { this.state = 2; this.port.postMessage({ type: 'cap', at: this.at, cap: this.cap }); }
    return true;
  }
}
registerProcessor('nova-latency-probe', NovaLatencyProbe);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
async function ensureModule(ctx: AudioContext) {
  let p = loaded.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([LATENCY_PROBE_WORKLET], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, p);
    p.catch(() => loaded.delete(ctx));
  }
  return p;
}

export interface RoundTrip { ok: boolean; frames: number; ms: number; seconds: number; tries: number[]; clarity: number; error?: string }

/**
 * Mesure la boucle `input` (source d'entrée) → `output` (sortie du navigateur). `window` : 0,6 s de
 * capture (une latence au-delà n'a pas de sens pour enregistrer).
 */
export async function measureRoundTrip(ctx: AudioContext, input: AudioNode, output: AudioNode, opts: { tries?: number; windowSec?: number } = {}): Promise<RoundTrip> {
  await ensureModule(ctx);
  const sr = ctx.sampleRate;
  const pat = probePattern(sr);
  const win = Math.round(sr * (opts.windowSec ?? 0.6));
  const node = new AudioWorkletNode(ctx, 'nova-latency-probe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { pattern: pat, window: win } });
  input.connect(node);
  node.connect(output);
  const tries: number[] = [];
  let clarity = Infinity;
  try {
    for (let k = 0; k < (opts.tries ?? 3); k++) {
      const at = Math.ceil((ctx.currentTime + 0.15) * sr / 128) * 128;
      const got = await new Promise<Float32Array | null>(resolve => {
        const t = setTimeout(() => resolve(null), 4000 + (win / sr) * 1000);
        node.port.onmessage = (e) => { if (e.data?.type === 'cap') { clearTimeout(t); resolve(e.data.cap); } };
        node.port.postMessage({ type: 'go', at });
      });
      if (!got) return { ok: false, frames: 0, ms: 0, seconds: 0, tries, clarity: 0, error: 'Pas de son capté (horloge audio arrêtée ?)' };
      const r = findDelay(got, pat);
      clarity = Math.min(clarity, r.clarity);
      if (r.clarity < 8) return { ok: false, frames: 0, ms: 0, seconds: 0, tries, clarity: r.clarity, error: 'Clic non reconnu : rapproche le micro de l\'enceinte (ou relie la sortie à l\'entrée), monte un peu le volume, puis recommence.' };
      tries.push(r.lag);
      await new Promise(r2 => setTimeout(r2, 120));
    }
  } finally {
    try { input.disconnect(node); } catch { /* */ }
    try { node.disconnect(); } catch { /* */ }
    retireWorkletNode(node);
  }
  const sorted = [...tries].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  if (sorted[sorted.length - 1] - sorted[0] > sr * 0.001) {
    return { ok: false, frames: med, ms: (med / sr) * 1000, seconds: med / sr, tries, clarity, error: 'Mesures instables (bruit, ou appli audio qui change la latence) : recommence au calme.' };
  }
  return { ok: true, frames: med, ms: Math.round((med / sr) * 10000) / 10, seconds: med / sr, tries, clarity };
}
