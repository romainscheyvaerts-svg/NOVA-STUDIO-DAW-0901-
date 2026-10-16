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

/** Un canal passé dans la pondération K (BS.1770), pour une loudness à court terme (utils/voiceClean). */
export function kWeighted(x: Float32Array, fs: number): Float32Array {
  return filter(filter(x, highShelf(fs)), highPass(fs));
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

/**
 * Crête vraie en dBTP. Par défaut ×8 avec 64 coefficients par phase
 * (plus exigeant que les 4 phases × 12 coefficients de la norme BS.1770) :
 * c'est l'arbitre des preuves du limiteur.
 */
export function truePeakChannels(ch: Float32Array[], oversample = 8, taps = 64): number {
  const half = taps / 2;
  const phases: Float64Array[] = [];
  const i0 = (x: number) => { let s = 1, t = 1; for (let k = 1; k < 200; k++) { const h = x / (2 * k); t *= h * h; s += t; if (t < 1e-14 * s) break; } return s; };
  const beta = 9, ib = i0(beta);
  for (let k = 1; k < oversample; k++) {
    const frac = k / oversample, h = new Float64Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const t = (j - half + 1) - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / (half + 0.5);
      h[j] = Math.abs(r) >= 1 ? 0 : sinc * i0(beta * Math.sqrt(1 - r * r)) / ib;
      sum += h[j];
    }
    for (let j = 0; j < taps; j++) h[j] /= sum;
    phases.push(h);
  }
  let pk = 0;
  for (const x of ch) {
    const n = x.length;
    for (let m = 0; m < n; m++) {
      const a = Math.abs(x[m]); if (a > pk) pk = a;
      if (m < half - 1 || m + half >= n) continue;
      // Fenêtre rapide : inutile d'interpoler loin sous la crête courante.
      if (Math.abs(x[m]) < pk * 0.5 && Math.abs(x[m + 1]) < pk * 0.5) continue;
      for (const h of phases) {
        let v = 0;
        for (let j = 0; j < taps; j++) v += h[j] * x[m + j - half + 1];
        const av = Math.abs(v); if (av > pk) pk = av;
      }
    }
  }
  return 20 * Math.log10(Math.max(pk, 1e-12));
}

/**
 * Crête vraie (dBTP) d'un AudioBuffer : polyphase ×4, 16 coefficients (norme BS.1770).
 * Avant : interpolation cubique, qui lisait −1,07 dBTP une crête réelle de 0 dBTP placée entre deux
 * échantillons (un export « −1 dBTP » pouvait sortir vers 0 dBTP).
 */
export function truePeakDb(buffer: AudioBuffer): number {
  const ch: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) ch.push(buffer.getChannelData(c));
  return truePeakChannels(ch, 4, 16);
}

export interface LoudnessResult { before: number; after: number; truePeak: number; gainDb: number; limitedByPeak: boolean }

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
