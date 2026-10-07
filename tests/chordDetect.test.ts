import { describe, expect, it } from 'vitest';
import {
  chordAt, chordPitches, chordSymbol, chordTones, detectChords, diatonicChords, parseChordSymbol, scoreChroma, ChordQuality, QUALITY_INTERVALS,
} from '../utils/chordDetect';

const SR = 44100;
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

let seed = 3;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

interface Ch { root: number; quality: ChordQuality; beats: number }

/**
 * « Beat » synthétique : accords (sons riches en harmoniques, voix serrées),
 * basse sur la fondamentale, kick et hi-hats qui salissent le spectre.
 */
function renderBeat(prog: Ch[], bpm: number, opts: { drums?: boolean; bass?: boolean; detune?: number } = {}): { x: Float32Array; truth: { start: number; end: number; root: number; quality: ChordQuality }[] } {
  const beat = 60 / bpm;
  const total = prog.reduce((a, c) => a + c.beats, 0) * beat;
  const x = new Float32Array(Math.ceil(total * SR));
  const truth: { start: number; end: number; root: number; quality: ChordQuality }[] = [];
  let t0 = 0;
  for (const c of prog) {
    const dur = c.beats * beat;
    truth.push({ start: t0, end: t0 + dur, root: c.root, quality: c.quality });
    const notes = chordPitches(c.root, c.quality, { center: 62 });
    const a = Math.round(t0 * SR), n = Math.round(dur * SR);
    for (const p of notes) {
      const f = hz(p + (opts.detune ?? 0));
      for (let h = 1; h <= 8; h++) {
        const fh = f * h;
        if (fh > 8000) break;
        const amp = 0.08 / h;
        for (let i = 0; i < n && a + i < x.length; i++) {
          const env = Math.min(1, i / 400) * Math.exp(-i / SR * 0.8) * Math.min(1, (n - i) / 400);
          x[a + i] += amp * env * Math.sin(2 * Math.PI * fh * i / SR);
        }
      }
    }
    if (opts.bass !== false) {
      const fb = hz(36 + c.root);
      for (let i = 0; i < n && a + i < x.length; i++) {
        const env = Math.min(1, i / 300) * Math.min(1, (n - i) / 300);
        x[a + i] += 0.25 * env * Math.sin(2 * Math.PI * fb * i / SR);
      }
    }
    t0 += dur;
  }
  if (opts.drums) {
    for (let b = 0; b * beat < total; b += 0.5) {
      const a = Math.round(b * beat * SR);
      for (let i = 0; i < 0.05 * SR && a + i < x.length; i++) x[a + i] += 0.12 * rnd() * Math.exp(-i / SR * 60);
      if (b % 1 === 0) { let ph = 0; for (let i = 0; i < 0.25 * SR && a + i < x.length; i++) { ph += 2 * Math.PI * (50 + 90 * Math.exp(-i / SR * 30)) / SR; x[a + i] += 0.5 * Math.sin(ph) * Math.exp(-i / SR * 10); } }
    }
  }
  return { x, truth };
}

/** Taux de réussite par temps : l'accord trouvé au milieu de chaque temps est-il le bon ? */
function hitRate(found: { start: number; end: number; root: number; quality: ChordQuality }[], truth: { start: number; end: number; root: number; quality: ChordQuality }[], beat: number, sameNotes = false) {
  let ok = 0, n = 0;
  for (const t of truth) {
    for (let b = t.start; b < t.end - 1e-6; b += beat) {
      n++;
      const f = chordAt(found, b + beat / 2);
      if (!f) continue;
      if (sameNotes ? f.root === t.root && QUALITY_INTERVALS[f.quality].slice(0, 3).join() === QUALITY_INTERVALS[t.quality].slice(0, 3).join() : f.root === t.root && f.quality === t.quality) ok++;
    }
  }
  return ok / n;
}

describe('noms et notes des accords', () => {
  it('symboles et lecture', () => {
    expect(chordSymbol(9, 'min')).toBe('Am');
    expect(chordSymbol(5, 'maj')).toBe('F');
    expect(chordSymbol(7, '7')).toBe('G7');
    expect(chordSymbol(2, 'min7')).toBe('Dm7');
    expect(parseChordSymbol('F#m7')).toEqual({ root: 6, quality: 'min7' });
    expect(parseChordSymbol('Bb')).toEqual({ root: 10, quality: 'maj' });
    expect(parseChordSymbol('Xm')).toBeNull();
    expect(chordTones(9, 'min')).toEqual([9, 0, 4]);
  });

  it('accords de la gamme : La mineur → Am, Bdim, C, Dm, Em, F, G', () => {
    expect(diatonicChords(9, 'MINOR').map(c => chordSymbol(c.root, c.quality))).toEqual(['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
    expect(diatonicChords(0, 'MAJOR').map(c => chordSymbol(c.root, c.quality))).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
  });

  it('chroma pur → accord exact', () => {
    for (const q of ['maj', 'min', '7', 'maj7', 'min7', 'sus2', 'sus4', 'dim'] as ChordQuality[]) {
      for (const r of [0, 4, 9]) {
        const c = new Array(12).fill(0.02);
        chordTones(r, q).forEach(p => { c[p] = 1; });
        const best = scoreChroma(c)[0];
        // Csus4 et Fsus2 ont les mêmes notes : on compare les notes.
        expect(chordTones(best.root, best.quality).sort().join()).toBe(chordTones(r, q).sort().join());
      }
    }
  });
});

describe('détection des accords d’un beat synthétique', () => {
  it('Am F C G (une mesure chacun), avec batterie : > 90 % des temps', () => {
    const bpm = 90, beat = 60 / bpm;
    const prog: Ch[] = [{ root: 9, quality: 'min', beats: 4 }, { root: 5, quality: 'maj', beats: 4 }, { root: 0, quality: 'maj', beats: 4 }, { root: 7, quality: 'maj', beats: 4 }];
    const { x, truth } = renderBeat([...prog, ...prog], bpm, { drums: true });
    const found = detectChords(x, SR, { bpm });
    if (process.env.DBG) process.stdout.write(String.fromCharCode(10) + found.map(f => `${(f.start / beat).toFixed(1)}-${(f.end / beat).toFixed(1)} ${chordSymbol(f.root, f.quality)} ${f.score.toFixed(2)}`).join(String.fromCharCode(10)));
    expect(hitRate(found, truth, beat)).toBeGreaterThan(0.9);
    // Les changements tombent sur les temps.
    for (const f of found) expect(Math.abs(f.start / beat - Math.round(f.start / beat))).toBeLessThan(1e-6);
    expect(found.slice(0, 4).map(f => chordSymbol(f.root, f.quality))).toEqual(['Am', 'F', 'C', 'G']);
  });

  it('accords de 7e et sus, changements toutes les 2 mesures et à la demi-mesure', () => {
    const bpm = 120, beat = 60 / bpm;
    const prog: Ch[] = [
      { root: 2, quality: 'min7', beats: 4 }, { root: 7, quality: '7', beats: 4 }, { root: 0, quality: 'maj7', beats: 8 },
      { root: 9, quality: 'min', beats: 2 }, { root: 7, quality: 'sus4', beats: 2 }, { root: 7, quality: 'maj', beats: 4 },
      { root: 11, quality: 'dim', beats: 4 }, { root: 4, quality: 'sus2', beats: 4 },
    ];
    const { x, truth } = renderBeat(prog, bpm, { drums: true });
    const found = detectChords(x, SR, { bpm });
    const exact = hitRate(found, truth, beat);
    const triad = hitRate(found, truth, beat, true);
    expect(exact).toBeGreaterThan(0.8);
    expect(triad).toBeGreaterThan(0.85);
  });

  it('progression trap mineure, sans basse et un peu désaccordée (+20 cents)', () => {
    const bpm = 140, beat = 60 / bpm;
    const prog: Ch[] = [{ root: 4, quality: 'min', beats: 8 }, { root: 0, quality: 'maj', beats: 8 }, { root: 9, quality: 'min', beats: 8 }, { root: 11, quality: 'maj', beats: 8 }];
    const { x, truth } = renderBeat(prog, bpm, { drums: true, bass: false, detune: 0.2 });
    const found = detectChords(x, SR, { bpm });
    if (process.env.DBG) process.stdout.write(String.fromCharCode(10) + found.map(f => `${(f.start / beat).toFixed(1)}-${(f.end / beat).toFixed(1)} ${chordSymbol(f.root, f.quality)} ${f.score.toFixed(2)}`).join(String.fromCharCode(10)));
    expect(hitRate(found, truth, beat)).toBeGreaterThan(0.9);
  });

  it('silence : aucun accord', () => {
    expect(detectChords(new Float32Array(SR * 4), SR, { bpm: 120 })).toEqual([]);
  });
});
