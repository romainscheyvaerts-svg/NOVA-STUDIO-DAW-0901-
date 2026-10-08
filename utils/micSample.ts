/**
 * R18 · Enregistrer au micro directement dans le sampler (FL : Edison →
 * sampler, Logic : Quick Sampler « Record », Live : enregistrement dans
 * Simpler). Capture mono brute (sans traitement du navigateur), arrêt à la
 * main ou au bout de `maxSec`, silence de début retiré (5 ms gardées).
 */

export interface MicTake {
  /** Niveau crête récent (0-1), pour le vu-mètre. */
  level(): number;
  /** Durée enregistrée (s). */
  seconds(): number;
  /** Arrête et renvoie le son (null si rien d'audible). */
  stop(): AudioBuffer | null;
  /** Abandonne. */
  cancel(): void;
}

/** Retire le silence de début et de fin (sous `floorDb` sous la crête), garde une marge. */
export function trimSilence(x: Float32Array, sampleRate: number, floorDb = -45, padMs = 5): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  if (peak < 1e-4) return new Float32Array(0);
  const th = peak * Math.pow(10, floorDb / 20);
  let a = 0; while (a < x.length && Math.abs(x[a]) < th) a++;
  let b = x.length - 1; while (b > a && Math.abs(x[b]) < th) b--;
  const pad = Math.round((padMs / 1000) * sampleRate);
  return x.slice(Math.max(0, a - pad), Math.min(x.length, b + 1 + pad * 20));
}

export async function startMicSample(ctx: AudioContext, opts: { deviceId?: string; maxSec?: number } = {}): Promise<MicTake> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    },
  });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  const chunks: Float32Array[] = [];
  let total = 0;
  let peak = 0;
  const max = Math.round((opts.maxSec ?? 20) * ctx.sampleRate);
  let done = false;
  proc.onaudioprocess = e => {
    if (done) return;
    const d = e.inputBuffer.getChannelData(0);
    let p = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
    peak = Math.max(p, peak * 0.85);
    if (total < max) { chunks.push(new Float32Array(d)); total += d.length; }
  };
  src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  const close = () => {
    done = true;
    try { src.disconnect(); proc.disconnect(); sink.disconnect(); } catch { /* déjà débranché */ }
    stream.getTracks().forEach(t => t.stop());
  };
  return {
    level: () => peak,
    seconds: () => total / ctx.sampleRate,
    cancel: close,
    stop: () => {
      close();
      const all = new Float32Array(total);
      let o = 0;
      chunks.forEach(c => { all.set(c.subarray(0, Math.min(c.length, total - o)), o); o += c.length; });
      const x = trimSilence(all, ctx.sampleRate);
      if (x.length < ctx.sampleRate * 0.03) return null;
      const b = ctx.createBuffer(1, x.length, ctx.sampleRate);
      b.getChannelData(0).set(x);
      return b;
    },
  };
}
