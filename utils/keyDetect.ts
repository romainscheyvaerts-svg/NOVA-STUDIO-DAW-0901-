/**
 * Détection de la tonalité d'un beat à l'écoute, pour régler l'Auto-Tune
 * quand le catalogue ne l'indique pas.
 *
 * Chromagramme par Goertzel (60 notes, Do2 → Si6) sur l'audio sous-échantillonné
 * à ~11 kHz, puis corrélation avec les profils de Krumhansl. Le calcul est
 * découpé en tranches pour ne pas figer l'interface (~100 ms pour une minute).
 *
 * Pour l'Auto-Tune, confondre majeur et mineur relatif est sans effet (mêmes
 * notes) ; en cas de quasi-égalité on garde donc le mineur, de loin le plus
 * fréquent dans le catalogue.
 */

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Poids de la tonique jouée à la basse dans le score (0 = profils seuls). */
const BASS_WEIGHT = 0.2;

const correlate = (a: number[], b: number[]) => {
  const ma = a.reduce((s, x) => s + x, 0) / 12;
  const mb = b.reduce((s, x) => s + x, 0) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};
const rotate = (p: number[], root: number) => p.map((_, i) => p[(i - root + 12) % 12]);

export interface DetectedKey { rootKey: number; scale: 'MAJOR' | 'MINOR'; confidence: number }

export async function detectKey(buffer: AudioBuffer): Promise<DetectedKey | null> {
  if (buffer.duration < 4) return null;
  const sr = buffer.sampleRate;
  const factor = Math.max(1, Math.round(sr / 11025));
  const fs = sr / factor;
  // Partie centrale (jusqu'à 60 s) : l'intro est souvent filtrée ou sans basse.
  const from = Math.floor(Math.max(0, buffer.duration / 2 - 30) * sr);
  const to = Math.min(buffer.length, from + Math.floor(60 * sr));
  const chans = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));

  // Sous-échantillonnage (moyenne = filtre passe-bas grossier, suffisant sous 2 kHz)
  const n = Math.floor((to - from) / factor);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    const base = from + i * factor;
    for (let k = 0; k < factor; k++) for (const ch of chans) v += ch[base + k] || 0;
    x[i] = v / (factor * chans.length);
  }

  // Fréquences des 60 notes et coefficients de Goertzel
  const N = 4096;
  const notes: { pc: number; coeff: number; bass: boolean }[] = [];
  for (let midi = 36; midi < 96; midi++) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    if (f >= fs / 2) break;
    notes.push({ pc: midi % 12, coeff: 2 * Math.cos((2 * Math.PI * f) / fs), bass: midi < 60 });
  }
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));

  const chroma = new Array(12).fill(0);
  // Basse (Do2-Si3) à part : en trap la 808 joue presque toujours la tonique, ce
  // qui départage les confusions de quinte (Fa mineur pris pour Do mineur).
  const bassChroma = new Array(12).fill(0);
  const frame = new Float32Array(N);
  let frames = 0;
  for (let start = 0; start + N <= n; start += N) {
    let energy = 0;
    for (let i = 0; i < N; i++) { const v = x[start + i] * win[i]; frame[i] = v; energy += v * v; }
    if (energy < 1e-6) continue; // silence
    const local = new Array(12).fill(0);
    const localBass = new Array(12).fill(0);
    for (const { pc, coeff, bass } of notes) {
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const s0 = frame[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
      const mag = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
      local[pc] += mag;
      if (bass) localBass[pc] += mag;
    }
    const maxBass = Math.max(...localBass);
    if (maxBass > 0) for (let i = 0; i < 12; i++) bassChroma[i] += localBass[i] / maxBass;
    // Compression log : une note très forte (808) ne doit pas tout écraser.
    const max = Math.max(...local) || 1;
    for (let i = 0; i < 12; i++) chroma[i] += Math.log1p(10 * local[i] / max);
    frames++;
    if (frames % 16 === 0) await new Promise(r => setTimeout(r, 0)); // laisse respirer l'interface
  }
  if (frames < 8) return null;

  const bassMax = Math.max(...bassChroma) || 1;
  const rank = (w: number) => {
    const out: { root: number; scale: 'MAJOR' | 'MINOR'; r: number }[] = [];
    for (let root = 0; root < 12; root++) {
      const bonus = w * (bassChroma[root] / bassMax);
      out.push({ root, scale: 'MAJOR', r: correlate(chroma, rotate(MAJOR, root)) + bonus });
      out.push({ root, scale: 'MINOR', r: correlate(chroma, rotate(MINOR, root)) + bonus });
    }
    return out.sort((a, b) => b.r - a.r);
  };
  const scores = rank(BASS_WEIGHT);
  let best = scores[0];
  if (best.scale === 'MAJOR') {
    const relMinor = scores.find(s => s.scale === 'MINOR' && s.root === (best.root + 9) % 12);
    if (relMinor && best.r - relMinor.r < 0.05) best = relMinor;
  }
  // Écart avec la première tonalité qui n'a pas les mêmes notes : mesure de confiance.
  const sameNotes = (s: { root: number; scale: string }) =>
    s.scale === best.scale ? s.root === best.root
      : s.root === (best.scale === 'MINOR' ? (best.root + 3) % 12 : (best.root + 9) % 12);
  const rival = scores.find(s => !sameNotes(s));
  const confidence = best.r - (rival ? rival.r : 0);
  if (best.r < 0.55 || confidence < 0.04) return null;
  return { rootKey: best.root, scale: best.scale, confidence };
}
