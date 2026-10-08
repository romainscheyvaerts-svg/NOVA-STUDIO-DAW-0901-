import { describe, it, expect } from 'vitest';
import { createPsolaCore, createHarmonyMath } from '../engine/psolaCore';
import { harmonizerToCore } from '../engine/v21Nodes';
import { SCALE_INTERVALS } from '../utils/scales';
import { chordOfCode, chordSteps, decodeChord, encodeChord, ChordEvent, ChordQuality } from '../utils/chordDetect';
import { vowel, f0Of } from './helpers/v21Signals';

/**
 * Harmoniseur qui suit la piste d'accords : calcul des voix (notes de
 * l'accord en cours), codage de l'accord pour l'AudioParam « chord » et
 * changement d'accord à l'échantillon près dans le cœur PSOLA.
 */
const SR = 48000;
const math = createHarmonyMath();
const CHR = SCALE_INTERVALS.CHROMATIC, MINOR = SCALE_INTERVALS.MINOR;
const code = (root: number, quality: ChordQuality) => encodeChord({ root, quality });
const Am = code(9, 'min'), F = code(5, 'maj'), C = code(0, 'maj'), G = code(7, 'maj');
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);
const ev = (id: string, start: number, end: number, root: number, quality: ChordQuality): ChordEvent => ({ id, start, end, root, quality });

describe("Accord codé pour l'AudioParam", () => {
  it('encodeChord / decodeChord / chordOfCode : aller-retour exact pour toutes les qualités', () => {
    expect(encodeChord(null)).toBe(0);
    expect(decodeChord(0)).toBeNull();
    for (let r = 0; r < 12; r++) for (const q of ['maj', 'min', '7', 'maj7', 'min7', 'sus2', 'sus4', 'dim'] as ChordQuality[]) {
      const c = encodeChord({ root: r, quality: q });
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(49152);
      expect(Math.fround(c)).toBe(c);           // exact dans un AudioParam (Float32)
      expect(decodeChord(c)!.root).toBe(r);
      expect(chordOfCode(c)).toEqual({ root: r, quality: q });
    }
    expect(decodeChord(Am)!.tones).toEqual([0, 4, 9]);
  });
  it('chordSteps : un palier au départ puis un par changement, trous compris', () => {
    const list = [ev('a', 0, 2, 9, 'min'), ev('b', 2, 4, 5, 'maj'), ev('c', 5, 6, 0, 'maj')];
    expect(chordSteps(list, 1, 7)).toEqual([{ t: 1, code: Am }, { t: 2, code: F }, { t: 4, code: 0 }, { t: 5, code: C }, { t: 6, code: 0 }]);
    expect(chordSteps(list, 2.5, 3)).toEqual([{ t: 2.5, code: F }]);
    expect(chordSteps([], 0, 10)).toEqual([{ t: 0, code: 0 }]);
  });
});

describe('Voix calées sur l\'accord en cours', () => {
  it('« tierce = la tierce de l\'accord » : sur la fondamentale chantée, tierce et quinte de Am, F, C, G (même en tonalité inconnue)', () => {
    // Tonalité inconnue (chromatique) : sans accord, la tierce serait majeure partout (La → Do#).
    expect(math.shiftFor(57, 0, CHR, 2)).toBe(4);
    expect(math.shiftFor(57, 0, CHR, 2, Am)).toBe(3);   // La → Do
    expect(math.shiftFor(53, 0, CHR, 2, F)).toBe(4);    // Fa → La
    expect(math.shiftFor(60, 0, CHR, 2, C)).toBe(4);    // Do → Mi
    expect(math.shiftFor(55, 0, CHR, 2, G)).toBe(4);    // Sol → Si
    expect(math.shiftFor(57, 0, CHR, 4, Am)).toBe(7);   // quinte de Am : Mi
    expect(math.shiftFor(55, 0, CHR, 4, G)).toBe(7);    // quinte de G : Ré
    expect(math.shiftFor(57, 0, CHR, 7, Am)).toBe(12);  // l'octave reste l'octave
    expect(math.shiftFor(57, 0, CHR, -7, F)).toBe(-12);
    expect(math.shiftFor(57, 0, CHR, 0, F)).toBe(0);    // unisson
  });
  it('une note tenue (Do) sur Am → F → C → G : la tierce suit chaque accord (Mi, Fa, Mi, Ré)', () => {
    expect([Am, F, C, G].map(c => 60 + math.shiftFor(60, 9, MINOR, 2, c))).toEqual([64, 65, 64, 62]);
    // Tierce en dessous : La, La, Sol, Sol.
    expect([Am, F, C, G].map(c => 60 + math.shiftFor(60, 9, MINOR, -2, c))).toEqual([57, 57, 55, 55]);
  });
  it('chaque voix tombe sur une note de l\'accord, du bon côté de la note chantée, pour toutes les notes et tous les accords', () => {
    for (let r = 0; r < 12; r++) for (const q of ['maj', 'min', '7', 'min7', 'sus4', 'dim'] as ChordQuality[]) {
      const c = encodeChord({ root: r, quality: q });
      const tones = decodeChord(c)!.tones;
      for (let note = 48; note < 72; note++) for (const deg of [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]) {
        const t = note + math.shiftFor(note, 9, MINOR, deg, c);
        expect(tones.includes(((t % 12) + 12) % 12), `${r}${q} ${note} ${deg}`).toBe(true);
        expect(Math.sign(t - note) === Math.sign(deg) || t === note, `${r}${q} ${note} ${deg} → ${t}`).toBe(true);
        expect(Math.abs(t - note)).toBeLessThan(13);
      }
    }
  });
  it('sans accord (code 0) : la gamme seule, comme avant', () => {
    for (let note = 50; note < 70; note++) for (const deg of [-7, -2, 2, 4, 7]) expect(math.shiftFor(note, 9, MINOR, deg, 0)).toBe(math.shiftFor(note, 9, MINOR, deg));
  });
  it('réglage « Suivre la piste d\'accords » : coché par défaut, décochable', () => {
    expect(harmonizerToCore({ voices: 1 }).follow).toBe(true);
    expect(harmonizerToCore({ voices: 1, followChords: 1 }).follow).toBe(true);
    expect(harmonizerToCore({ voices: 1, followChords: 0 }).follow).toBe(false);
  });
});

describe('Cœur PSOLA : changement d\'accord au bon temps', { timeout: 60000 }, () => {
  /** Do3 tenu 4 s ; Am, F, C, G d'une seconde chacun, envoyés bloc par bloc (a-rate) comme l'AudioParam. */
  const runChords = (follow: boolean) => {
    const core = createPsolaCore(SR, math);
    core.setParams({ dry: 0, root: 9, scale: MINOR, stereo: false, follow, voices: [{ on: true, semis: 0, degree: 2, formant: 0, follow: false, gainL: 1, gainR: 1, delayMs: 0, detune: 0, drift: 0 }] });
    const lat = core.latencySamples();
    const x = vowel(hz(60), 4);
    const n = x.length + lat;
    const inp = new Float32Array(n); inp.set(x);
    const out = new Float32Array(n);
    const cb = new Float32Array(128);
    const seq = [Am, F, C, G];
    for (let s = 0; s < n; s += 128) {
      const k = Math.min(128, n - s);
      for (let j = 0; j < k; j++) cb[j] = seq[Math.min(3, Math.floor((s + j) / SR))];
      core.chordIn(cb.subarray(0, k));
      core.process(inp.subarray(s, s + k), null, out.subarray(s, s + k), null, k);
    }
    return { y: out.subarray(lat), core };
  };
  it('la tierce mesurée suit Am → F → C → G à moins d\'un cent', () => {
    const { y, core } = runChords(true);
    const want = [64, 65, 64, 62];
    for (let k = 0; k < 4; k++) {
      const f = f0Of(y.subarray(Math.round((k + 0.3) * SR), Math.round((k + 0.8) * SR)));
      expect(Math.abs(cents(f, hz(want[k]))), `accord ${k} → ${f.toFixed(2)} Hz`).toBeLessThan(1);
    }
    expect(core.lateSamples()).toBe(0);
  });
  it('le changement tombe sur le temps (à une période près), latence comprise', () => {
    const { y } = runChords(true);
    // Hauteur glissante (fenêtres de 20 ms, pas de 2 ms) autour du changement Am → F (1,000 s) : Mi → Fa.
    const track: [number, number][] = [];
    for (let t = 0.9; t < 1.1; t += 0.002) track.push([t, f0Of(y.subarray(Math.round(t * SR), Math.round((t + 0.02) * SR)), SR, 200, 600)]);
    const mid = Math.sqrt(hz(64) * hz(65));
    const first = track.find(([, f]) => f > mid)!;
    // Fenêtre de 20 ms : elle bascule quand sa moitié passe le changement (≈ 0,990 s).
    expect(first[0] + 0.01).toBeGreaterThan(0.985);
    expect(first[0] + 0.01).toBeLessThan(1.015);
  });
  it('décoché : la gamme seule (La mineur : tierce de Do = Mi partout)', () => {
    const { y } = runChords(false);
    for (let k = 0; k < 4; k++) {
      const f = f0Of(y.subarray(Math.round((k + 0.3) * SR), Math.round((k + 0.8) * SR)));
      expect(Math.abs(cents(f, hz(64)))).toBeLessThan(1);
    }
  });
});
