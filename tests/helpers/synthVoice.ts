/**
 * Voix synthétique « source-filtre » pour les tests de justesse (V19) :
 * des harmoniques de la hauteur chantée, dont l'amplitude suit l'enveloppe
 * d'une voyelle (formants fixes). La hauteur peut glisser et vibrer.
 */
export interface SynthNote {
  /** Hauteur MIDI fractionnaire (57.4 = La2 + 40 cents). */
  midi: number;
  at: number;
  len: number;
  /** Glissade d'attaque depuis la note précédente (s). */
  glide?: number;
  vibratoCents?: number;
  vibratoHz?: number;
  /** Dérive lente sur la note (cents, de 0 à cette valeur à la fin). */
  driftCents?: number;
}

/** Formants de la voyelle « a » (Hz, largeur de bande). */
export const VOWEL_A: [number, number, number][] = [[730, 90, 1], [1090, 110, 0.5], [2440, 170, 0.25]];

export const envelope = (f: number, formants = VOWEL_A): number => {
  let a = 0;
  for (const [F, B, g] of formants) a += g / Math.sqrt(1 + ((f - F) / B) ** 2);
  return a * (1 / (1 + f / 4000));
};

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Hauteur (MIDI) de la voix synthétique à l'instant t, ou NaN. */
export function synthPitchAt(notes: SynthNote[], t: number): number {
  for (let k = 0; k < notes.length; k++) {
    const n = notes[k];
    if (t < n.at || t >= n.at + n.len) continue;
    const u = t - n.at;
    let m = n.midi + ((n.driftCents || 0) / 100) * (u / n.len);
    if (n.vibratoCents) m += (n.vibratoCents / 100) * Math.sin(2 * Math.PI * (n.vibratoHz || 5.5) * u);
    const prev = notes[k - 1];
    if (n.glide && prev && Math.abs(prev.at + prev.len - n.at) < 1e-6 && u < n.glide) {
      const g = 0.5 - 0.5 * Math.cos(Math.PI * (u / n.glide));
      m = prev.midi + (m - prev.midi) * g;
    }
    return m;
  }
  return NaN;
}

export function synthVoice(sr: number, dur: number, notes: SynthNote[], opts: { amp?: number; noise?: number; formants?: [number, number, number][] } = {}): Float32Array {
  const x = new Float32Array(Math.round(dur * sr));
  const amp = opts.amp ?? 0.25;
  let phase = 0;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const fs = opts.formants || VOWEL_A;
  // Amplitudes des harmoniques recalculées toutes les 64 échantillons.
  let amps: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const m = synthPitchAt(notes, t);
    if (Number.isNaN(m)) { phase = 0; x[i] = (opts.noise ?? 0) * rnd(); continue; }
    const f0 = hz(m);
    if (i % 64 === 0 || !amps.length) {
      amps = [];
      for (let h = 1; h * f0 < Math.min(sr / 2 - 500, 5000); h++) amps.push(envelope(h * f0, fs));
    }
    phase += f0 / sr;
    if (phase > 1e6) phase -= 1e6;
    // Enveloppe d'amplitude : attaque 10 ms, relâche 20 ms à chaque note.
    const n = notes.find(q => t >= q.at && t < q.at + q.len)!;
    const prev = notes[notes.indexOf(n) - 1], next = notes[notes.indexOf(n) + 1];
    const tiedIn = prev && Math.abs(prev.at + prev.len - n.at) < 1e-6, tiedOut = next && Math.abs(n.at + n.len - next.at) < 1e-6;
    const env = Math.min(tiedIn ? 1 : Math.min(1, (t - n.at) / 0.01), tiedOut ? 1 : Math.min(1, (n.at + n.len - t) / 0.02));
    let s = 0;
    for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin(2 * Math.PI * (h + 1) * phase);
    x[i] = amp * env * s / 2 + (opts.noise ?? 0) * rnd();
  }
  return x;
}
