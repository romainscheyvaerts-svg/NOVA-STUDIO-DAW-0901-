import { describe, expect, it } from 'vitest';
import { pitchOfFrame } from '../utils/pitchAnalysis';
import { holdStats, MODE_RANGE, readNote, TunerSmoother, tuneState, midiOf } from '../utils/tuner';

const SR = 48000;
const cents = (f: number, c: number) => f * Math.pow(2, c / 1200);

/** Sinus pur. */
function sine(f: number, n = 8192, sr = SR, amp = 0.3): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr + 0.3);
  return x;
}

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };

/**
 * Voix de test : train d'impulsions glottiques (harmoniques en 1/n^1.3)
 * passé par deux formants (voyelle « a » : F1 ≈ 750 Hz, F2 ≈ 1200 Hz),
 * vibrato, micro-instabilité (jitter) et souffle.
 */
function voice(f0: number, n: number, opts: { vibCents?: number; vibHz?: number; jitter?: number; breath?: number; f1?: number; f2?: number } = {}): Float32Array {
  const { vibCents = 0, vibHz = 5.5, jitter = 0.002, breath = 0.01, f1 = 750, f2 = 1200 } = opts;
  const x = new Float32Array(n);
  const H = Math.floor(4000 / f0);
  const amps: number[] = [];
  const res = (f: number, F: number, B: number) => 1 / Math.sqrt(1 + ((f - F) / B) ** 2);
  for (let h = 1; h <= H; h++) amps.push((1 / Math.pow(h, 1.3)) * (0.3 + res(h * f0, f1, 120) + 0.6 * res(h * f0, f2, 150)));
  let phase = 0;
  let jit = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 480 === 0) jit = jitter * rnd() * 2;
    const f = f0 * Math.pow(2, (vibCents * Math.sin(2 * Math.PI * vibHz * t)) / 1200) * (1 + jit);
    phase += 2 * Math.PI * f / SR;
    let s = 0;
    for (let h = 1; h <= H; h++) s += amps[h - 1] * Math.sin(h * phase);
    x[i] = 0.08 * s + breath * rnd();
  }
  return x;
}

/** Corde pincée (Karplus-Strong) : son de guitare ou de basse enregistré, harmoniques qui s'éteignent. */
function pluck(f: number, n: number): Float32Array {
  const P = SR / f;
  const L = Math.floor(P);
  const frac = P - L;
  const line = new Float32Array(L + 2);
  for (let i = 0; i < line.length; i++) line[i] = rnd();
  const x = new Float32Array(n);
  let w = 0;
  // Allpass de fraction de période (sinon la hauteur est arrondie à l'échantillon).
  const c = (1 - frac) / (1 + frac);
  let apX = 0, apY = 0;
  for (let i = 0; i < n; i++) {
    const a = line[w], b = line[(w + 1) % (L)];
    const avg = 0.996 * 0.5 * (a + b);
    const y = c * avg + apX - c * apY;
    apX = avg; apY = y;
    line[w] = y;
    x[i] = 0.4 * a;
    w = (w + 1) % L;
  }
  return x;
}

describe('accordeur : détection de hauteur', () => {
  it('sinus de 440 Hz et 440 Hz ±3 cents : La3, écart lu au cent près', () => {
    for (const c of [0, 3, -3]) {
      const p = pitchOfFrame(sine(cents(440, c), 4096), SR, { fmin: MODE_RANGE.chromatique.fmin, fmax: MODE_RANGE.chromatique.fmax });
      expect(p).not.toBeNull();
      const r = readNote(p!.hz);
      expect(r.note).toBe('La');
      expect(r.octave).toBe(3);
      expect(r.en).toBe('A4');
      expect(Math.abs(r.cents - c)).toBeLessThan(0.5);
    }
  });

  it('sinus sur toute l’étendue (basse 31 Hz → voix de tête 1 kHz) : moins de 1 cent d’erreur', () => {
    for (const f of [30.87, 41.2, 55, 82.41, 110, 196, 261.63, 523.25, 987.77]) {
      const n = f < 45 ? 8192 : 4096;
      const p = pitchOfFrame(sine(f, n), SR, { fmin: f < 45 ? 28 : 30, fmax: 1600 });
      expect(p, `${f} Hz`).not.toBeNull();
      expect(Math.abs(1200 * Math.log2(p!.hz / f)), `${f} Hz`).toBeLessThan(1);
    }
  });

  it('44,1 kHz aussi', () => {
    const p = pitchOfFrame(sine(cents(440, 3), 4096, 44100), 44100, { fmin: 30, fmax: 1600 });
    expect(Math.abs(readNote(p!.hz).cents - 3)).toBeLessThan(0.5);
  });

  it('voix de test (voyelle, harmoniques, souffle) : homme 110-220 Hz, femme 330-440 Hz, à ±3 cents', () => {
    for (const f of [110, 146.83, 220, 329.63, 440]) {
      const x = voice(cents(f, 12), 4096, { breath: 0.01, jitter: 0.001 });
      const p = pitchOfFrame(x, SR, { fmin: 60, fmax: 1100 });
      expect(p, `${f} Hz`).not.toBeNull();
      const r = readNote(p!.hz);
      expect(r.target, `${f} Hz`).toBe(Math.round(midiOf(f)));
      expect(Math.abs(r.cents - 12), `${f} Hz`).toBeLessThan(3);
    }
  });

  it('voix grave avec un fondamental faible (formants hauts) : pas d’erreur d’octave', () => {
    const x = voice(98, 4096, { f1: 500, f2: 1500 });
    const p = pitchOfFrame(x, SR, { fmin: 60, fmax: 1100 });
    expect(Math.abs(1200 * Math.log2(p!.hz / 98))).toBeLessThan(5);
  });

  it('silence et bruit : aucune note', () => {
    expect(pitchOfFrame(new Float32Array(4096), SR)).toBeNull();
    const noise = new Float32Array(4096).map(() => 0.2 * rnd());
    expect(pitchOfFrame(noise, SR, { threshold: 0.15 })).toBeNull();
  });

  it('La2 de guitare (A2 = 110 Hz, corde pincée) reconnu en mode guitare : 5e corde', () => {
    const x = pluck(110, 24000);
    // Lecture 150 ms après l'attaque, comme l'accordeur en direct.
    const p = pitchOfFrame(x.subarray(7200, 7200 + 4096), SR, MODE_RANGE.guitare);
    expect(p).not.toBeNull();
    const r = readNote(p!.hz, 'guitare');
    expect(r.en).toBe('A2');
    expect(r.note + r.octave).toBe('La1');
    expect(r.string).toBe(5);
    expect(Math.abs(r.cents)).toBeLessThan(3);
  });

  it('corde de basse grave (Mi 41,2 Hz) en mode basse : 4e corde', () => {
    const x = pluck(41.2, 30000);
    const p = pitchOfFrame(x.subarray(9000, 9000 + 8192), SR, MODE_RANGE.basse);
    const r = readNote(p!.hz, 'basse');
    expect(r.en).toBe('E1');
    expect(r.string).toBe(4);
    expect(Math.abs(r.cents)).toBeLessThan(3);
  });
});

describe('accordeur : modes et lissage', () => {
  it('guitare : une corde basse de 30 cents vise la bonne corde', () => {
    const r = readNote(cents(146.83, -30), 'guitare');
    expect(r.en).toBe('D3');
    expect(r.string).toBe(4);
    expect(r.cents).toBeCloseTo(-30, 0);
  });

  it('tonalité du morceau (Do mineur) : un Mi (hors gamme) vise le Mi♭ ou le Fa le plus proche', () => {
    const r = readNote(329.63, 'tonalite', { root: 0, scale: 'MINOR' });
    expect(['Mi♭', 'Fa']).toContain(r.note);
    expect(Math.abs(r.cents)).toBeCloseTo(100, 0);
    const juste = readNote(311.13, 'tonalite', { root: 0, scale: 'MINOR' });
    expect(juste.note).toBe('Mi♭');
    expect(Math.abs(juste.cents)).toBeLessThan(1);
  });

  it('états juste / presque / faux', () => {
    expect(tuneState(3)).toBe('juste');
    expect(tuneState(-12)).toBe('presque');
    expect(tuneState(30)).toBe('faux');
  });

  it('lissage : un saut d’octave isolé est ignoré, la note tient après la fin du son', () => {
    const s = new TunerSmoother(5, 600, 250);
    let out = 0;
    [220, 220, 440, 220, 220].forEach((f, i) => { out = s.push(f, i * 25)!; });
    expect(out).toBeCloseTo(220, 0);
    expect(s.push(null, 400)).toBeCloseTo(220, 0);
    expect(s.push(null, 1200)).toBeNull();
  });

  it('tenue de note : score de justesse en cents', () => {
    const juste = Array.from({ length: 200 }, (_, i) => 57 + 0.03 * Math.sin(i / 5));
    const a = holdStats(juste, 57);
    expect(a.medianAbsCents).toBeLessThan(3);
    expect(a.inTune).toBe(1);
    expect(a.score).toBeGreaterThan(90);
    const bas = Array.from({ length: 200 }, () => 57 - 0.3);
    const b = holdStats(bas, 57);
    expect(b.meanCents).toBeCloseTo(-30, 0);
    expect(b.inTune).toBe(0);
    expect(b.score).toBeLessThan(60);
    const instable = Array.from({ length: 200 }, (_, i) => 57 + 0.4 * Math.sin(i / 3));
    expect(holdStats(instable, 57).score).toBeLessThan(a.score - 20);
  });
});
