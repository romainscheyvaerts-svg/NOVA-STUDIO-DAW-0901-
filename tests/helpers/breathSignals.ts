/**
 * Voix de synthèse pour tester la détection des respirations : mots voisés
 * (harmoniques + formants + un peu de souffle, attaque, fin qui s'éteint),
 * « s » et « ch » collés aux mots, respirations (bruit filtré qui gonfle puis
 * retombe) entre les phrases, bruit de fond. Renvoie aussi la vérité terrain.
 */

export interface SynthVoice {
  x: Float32Array;
  sr: number;
  /** Zones à ne JAMAIS toucher : mots (fin qui s'éteint comprise) et consonnes. */
  words: [number, number][];
  breaths: [number, number][];
  sibilants: [number, number][];
}

type Ev =
  | { k: 'word'; dur: number; f0?: number; release?: number; db?: number }
  | { k: 's' | 'ch'; dur: number; db?: number }
  | { k: 'breath'; dur: number; db?: number }
  | { k: 'gap'; dur: number };

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}

/** Bande passante simple (biquad RBJ) appliquée sur place. */
function bandpass(x: Float32Array, sr: number, f: number, q: number) {
  const w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y; }
}
function highpass(x: Float32Array, sr: number, f: number) {
  const w = Math.tan((Math.PI * f) / sr), q = Math.SQRT1_2, n = 1 / (1 + w / q + w * w);
  const b0 = n, b1 = -2 * n, a1 = 2 * (w * w - 1) * n, a2 = (1 - w / q + w * w) * n;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y; }
}
const rmsOf = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
const norm = (x: Float32Array, targetRms: number) => { const r = rmsOf(x); if (r > 0) for (let i = 0; i < x.length; i++) x[i] *= targetRms / r; };

const WORD_RMS = 0.1; // ≈ -20 dBFS

export function synthVoice(events: Ev[], sr = 44100, seed = 3): SynthVoice {
  const rnd = rng(seed);
  const total = events.reduce((s, e) => s + e.dur + (e.k === 'word' ? (e.release ?? 0.1) : 0), 0) + 0.6;
  const x = new Float32Array(Math.ceil(total * sr));
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.0002; // bruit de fond ≈ -80 dBFS
  const out: SynthVoice = { x, sr, words: [], breaths: [], sibilants: [] };
  let t = 0.3;
  let lastWord: [number, number] | null = null;
  for (const e of events) {
    const a = Math.round(t * sr);
    if (e.k === 'gap') { t += e.dur; lastWord = null; continue; }
    if (e.k === 'word') {
      const rel = e.release ?? 0.1;
      const n = Math.round((e.dur + rel) * sr);
      const seg = new Float32Array(n);
      const f0 = e.f0 ?? 150 + rnd() * 60;
      const F1 = 500 + rnd() * 300, F2 = 1100 + rnd() * 700;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const tt = i / sr;
        const f = f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * tt));
        ph += (2 * Math.PI * f) / sr;
        let v = 0;
        for (let h = 1; h * f0 < 5000; h++) {
          const fh = h * f0;
          const g = 1 / (1 + ((fh - F1) / 150) ** 2) + 0.6 / (1 + ((fh - F2) / 200) ** 2) + 0.05 / h;
          v += g * Math.sin(h * ph);
        }
        v += rnd() * 0.08; // souffle naturel de la voix
        const env = Math.min(1, tt / 0.015) * (tt > e.dur ? Math.exp(-(tt - e.dur) / (rel / 4)) : 1);
        seg[i] = v * env;
      }
      // Niveau : rms de la partie tenue.
      const body = seg.subarray(Math.round(0.02 * sr), Math.round(e.dur * sr));
      const k = (WORD_RMS * Math.pow(10, (e.db ?? 0) / 20)) / Math.max(1e-9, rmsOf(body));
      for (let i = 0; i < n; i++) x[a + i] += seg[i] * k;
      lastWord = [t, t + e.dur + rel];
      out.words.push(lastWord);
      t += e.dur + rel * 0.6; // la consonne suivante commence pendant que la voyelle s'éteint
      continue;
    }
    const n = Math.round(e.dur * sr);
    const seg = new Float32Array(n);
    for (let i = 0; i < n; i++) seg[i] = rnd();
    if (e.k === 's') { highpass(seg, sr, 4500); highpass(seg, sr, 4500); bandpass(seg, sr, 7000, 0.8); }
    else if (e.k === 'ch') { bandpass(seg, sr, 3200, 1.6); bandpass(seg, sr, 3200, 1.6); }
    else { bandpass(seg, sr, 1400, 0.6); const s2 = Float32Array.from(seg); bandpass(s2, sr, 2800, 1); for (let i = 0; i < n; i++) seg[i] += 0.5 * s2[i]; }
    norm(seg, WORD_RMS * Math.pow(10, (e.db ?? (e.k === 'breath' ? -22 : -6)) / 20));
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const env = e.k === 'breath' ? Math.sin(Math.PI * p) ** 1.5 * 1.6 : Math.min(1, i / (0.01 * sr), (n - i) / (0.015 * sr));
      x[a + i] += seg[i] * env;
    }
    const zone: [number, number] = [t, t + e.dur];
    if (e.k === 'breath') { out.breaths.push(zone); lastWord = null; }
    else { out.sibilants.push(zone); out.words.push(zone); if (lastWord) lastWord[1] = Math.max(lastWord[1], zone[1]); }
    t += e.dur;
  }
  return out;
}

/** Une phrase de rap type : mots, « s » final, respiration entre deux phrases. */
export function rapPhrases(seed = 3, sr = 44100, breathDb = -22): SynthVoice {
  const ev: Ev[] = [];
  const r = rng(seed * 7 + 1);
  for (let p = 0; p < 6; p++) {
    const words = 3 + Math.floor((r() + 1) * 2);
    for (let w = 0; w < words; w++) {
      ev.push({ k: 'word', dur: 0.12 + (r() + 1) * 0.12, release: 0.06 + (r() + 1) * 0.06, db: -2 + r() * 2 });
      const c = r();
      if (c > 0.55) ev.push({ k: 's', dur: 0.09 + (r() + 1) * 0.05, db: -5 + r() * 2 });
      else if (c < -0.7) ev.push({ k: 'ch', dur: 0.08 + (r() + 1) * 0.04, db: -7 });
      ev.push({ k: 'gap', dur: 0.02 + (r() + 1) * 0.03 });
    }
    ev.push({ k: 'gap', dur: 0.08 + (r() + 1) * 0.05 });
    ev.push({ k: 'breath', dur: 0.22 + (r() + 1) * 0.15, db: breathDb + r() * 3 });
    ev.push({ k: 'gap', dur: 0.06 + (r() + 1) * 0.04 });
  }
  return synthVoice(ev, sr, seed);
}

/** Mesures : respirations trouvées, fausses alarmes, mots touchés (zones + fondus). */
export function scoreDetection(v: SynthVoice, found: { start: number; end: number }[]) {
  const ov = (a: [number, number], b: { start: number; end: number }) => Math.max(0, Math.min(a[1], b.end) - Math.max(a[0], b.start));
  const hit = v.breaths.filter(b => found.some(f => ov(b, f) >= 0.3 * (b[1] - b[0]) || ov(b, f) >= 0.8 * (f.end - f.start)));
  const falseAlarms = found.filter(f => !v.breaths.some(b => ov(b, f) > 0.5 * (f.end - f.start)));
  const wordsTouched = found.filter(f => v.words.some(w => ov(w, f) > 0));
  const sibilantsTouched = found.filter(f => v.sibilants.some(s => ov(s, f) > 0));
  return { recall: hit.length / Math.max(1, v.breaths.length), found: found.length, breaths: v.breaths.length, falseAlarms: falseAlarms.length, wordsTouched: wordsTouched.length, sibilantsTouched: sibilantsTouched.length };
}
