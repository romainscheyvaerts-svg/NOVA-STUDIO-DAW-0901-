/**
 * Beat synthétique pour les tests R23 (changer de beat) : kick sur 1 et 3,
 * caisse claire sur 2 et 4, charleston en croches, basse (808) sur la tonique
 * et nappe d'accord mineur. `firstDownbeat` : instant du premier temps fort ;
 * une levée de charleston le précède (la musique ne commence pas sur le 1).
 */
export interface SynthBeatOptions {
  bpm: number;
  /** Tonique MIDI (55 = Sol). */
  root: number;
  minor?: boolean;
  firstDownbeat: number;
  bars: number;
  sr?: number;
  seed?: number;
}

export function synthBeat(o: SynthBeatOptions): Float32Array {
  const sr = o.sr ?? 44100;
  const beat = 60 / o.bpm;
  const dur = o.firstDownbeat + o.bars * 4 * beat + 1;
  const n = Math.round(dur * sr);
  const x = new Float32Array(n);
  let s = o.seed ?? 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
  const add = (t0: number, len: number, f: (tt: number) => number) => {
    const a = Math.round(t0 * sr), L = Math.min(Math.round(len * sr), n - a);
    for (let i = 0; i < L; i++) if (a + i >= 0) x[a + i] += f(i / sr);
  };
  const third = o.minor === false ? 4 : 3;
  // Levée : deux charlestons avant le premier temps.
  for (const k of [1, 0.5]) add(o.firstDownbeat - k * beat, 0.05, tt => 0.15 * rnd() * Math.exp(-tt * 60));
  for (let b = 0; b < o.bars * 4; b++) {
    const t = o.firstDownbeat + b * beat;
    if (b % 2 === 0) add(t, 0.3, tt => 0.8 * Math.sin(2 * Math.PI * (45 * tt + 110 / 25 * (1 - Math.exp(-tt * 25)))) * Math.exp(-tt * 9));
    else add(t, 0.2, tt => 0.45 * rnd() * Math.exp(-tt * 20));
    add(t, 0.05, tt => 0.12 * rnd() * Math.exp(-tt * 60));
    add(t + beat / 2, 0.05, tt => 0.12 * rnd() * Math.exp(-tt * 60));
    // Basse sur la tonique, une note par temps fort.
    if (b % 4 === 0) add(t, beat * 4, tt => 0.25 * Math.sin(2 * Math.PI * hz(o.root - 24) * tt) * Math.min(1, tt * 200) * Math.exp(-tt * 0.8));
    // Nappe (accord de tonique), par mesure.
    if (b % 4 === 0) for (const iv of [0, third, 7, 12]) add(t, beat * 4, tt => 0.04 * Math.sin(2 * Math.PI * hz(o.root + iv) * tt) * Math.min(1, tt * 20));
  }
  return x;
}
