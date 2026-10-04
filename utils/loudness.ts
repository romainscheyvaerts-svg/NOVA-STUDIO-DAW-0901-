/**
 * Loudness intégrée (LUFS) selon ITU-R BS.1770-4 / EBU R128, et crête vraie
 * estimée (dBTP), pour l'export : les plateformes normalisent en LUFS
 * (Spotify / YouTube ≈ -14, Apple Music ≈ -16), pas en crête.
 *
 * Pondération K = filtre en plateau (+4 dB au-dessus de ~1,7 kHz) puis
 * passe-haut RLB (~38 Hz), recalculés pour la fréquence d'échantillonnage
 * (mêmes formules que pyloudnorm). Blocs de 400 ms recouverts à 75 %,
 * portillon absolu -70 LUFS puis relatif -10 LU.
 */

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function highShelf(fs: number): Biquad {
  const G = 3.999843853973347, Q = 0.7071752369554196, f0 = 1681.974450955533;
  const K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

function highPass(fs: number): Biquad {
  const Q = 0.5003270373238773, f0 = 38.13547087602444;
  const K = Math.tan(Math.PI * f0 / fs);
  const a0 = 1 + K / Q + K * K;
  return { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Loudness intégrée en LUFS (-Infinity si silence). */
export function integratedLufs(buffer: AudioBuffer): number {
  const fs = buffer.sampleRate;
  const sh = highShelf(fs), hp = highPass(fs);
  const chans = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => filter(filter(buffer.getChannelData(c), sh), hp));
  const block = Math.round(0.4 * fs), hop = Math.round(0.1 * fs);
  const powers: number[] = [];
  for (let s = 0; s + block <= buffer.length; s += hop) {
    let z = 0;
    for (const ch of chans) {
      let acc = 0;
      for (let i = s; i < s + block; i++) acc += ch[i] * ch[i];
      z += acc / block; // poids 1,0 pour G / D
    }
    powers.push(z);
  }
  if (!powers.length) return -Infinity;
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const abs = powers.filter(p => lufs(p) > -70);
  if (!abs.length) return -Infinity;
  const relGate = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter(p => lufs(p) > relGate);
  if (!gated.length) return -Infinity;
  return lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** Crête vraie estimée (dBTP) : suréchantillonnage ×4 par interpolation cubique. */
export function truePeakDb(buffer: AudioBuffer): number {
  let pk = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 1; i < d.length - 2; i++) {
      const p0 = d[i - 1], p1 = d[i], p2 = d[i + 1], p3 = d[i + 2];
      const a = Math.abs(p1); if (a > pk) pk = a;
      for (let k = 1; k < 4; k++) {
        const t = k / 4;
        const v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
        const av = v < 0 ? -v : v; if (av > pk) pk = av;
      }
    }
  }
  return 20 * Math.log10(Math.max(pk, 1e-9));
}

export interface LoudnessResult { before: number; after: number; truePeak: number; gainDb: number; limitedByPeak: boolean }

/**
 * Amène le mix à la loudness visée sans dépasser la crête vraie autorisée
 * (si la crête bloque, le gain est réduit et on le dit : pas de limiteur caché).
 */
export function normalizeToLufs(buffer: AudioBuffer, targetLufs: number, ceilingDbtp = -1): LoudnessResult {
  const before = integratedLufs(buffer);
  if (!Number.isFinite(before)) return { before, after: before, truePeak: truePeakDb(buffer), gainDb: 0, limitedByPeak: false };
  let gainDb = targetLufs - before;
  const tp = truePeakDb(buffer);
  let limitedByPeak = false;
  if (tp + gainDb > ceilingDbtp) { gainDb = ceilingDbtp - tp; limitedByPeak = true; }
  const g = Math.pow(10, gainDb / 20);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return { before, after: before + gainDb, truePeak: tp + gainDb, gainDb, limitedByPeak };
}

/**
 * Plafond de crête vraie visé avant l'encodage MP3. L'encodeur ajoute de la
 * crête (souvent 0,5 dB, parfois plus sur un beat très compressé) : on garde
 * de la marge pour que le fichier MP3 décodé reste vers -1 dBTP au plus.
 */
export const MP3_TRUE_PEAK_CEILING = -1.5;

/**
 * Baisse le volume (jamais ne le monte) pour que la crête vraie reste sous
 * `ceilingDbtp`. Modifie le buffer en place ; renvoie le gain appliqué (dB,
 * 0 si rien à faire). Évite l'écrêtage à la conversion MP3.
 */
export function capTruePeak(buffer: AudioBuffer, ceilingDbtp: number): number {
  const tp = truePeakDb(buffer);
  if (!(tp > ceilingDbtp)) return 0;
  const gainDb = ceilingDbtp - tp;
  const g = Math.pow(10, gainDb / 20);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return gainDb;
}
