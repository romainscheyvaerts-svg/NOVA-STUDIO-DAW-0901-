import { describe, expect, it } from 'vitest';
import {
  addResult, clearHistory, comfortableRoot, EXERCISES, fiveNotePattern, foldCents, holdTarget, loadHistory, loadTessiture, PROGRAM,
  progressOf, saveTessiture, scoreGuided, scoreSiren, SOURCES, streakDays, tessitureOf, trillPattern, type PitchPoint,
} from '../utils/vocalWarmup';

class MemStore { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

/** Hauteurs chantées sur un motif guidé : attaque en retard de `lag`, écart `cents`, octave `oct`. */
function sing(targets: { t0: number; t1: number; midi: number }[], cents = 0, lag = 0.08, oct = 0, hop = 0.025): PitchPoint[] {
  const out: PitchPoint[] = [];
  const end = targets[targets.length - 1].t1;
  for (let t = targets[0].t0; t < end; t += hop) {
    const n = targets.find(x => t >= x.t0 + lag && t < x.t1 + lag) || targets.find(x => t >= x.t0 && t < x.t1)!;
    out.push({ t, midi: n.midi + oct * 12 + cents / 100 + 0.03 * Math.sin(t * 30) });
  }
  return out;
}

describe('programme et sources', () => {
  it('chaque exercice du programme existe et cite au moins une source connue', () => {
    for (const id of PROGRAM) expect(EXERCISES.find(e => e.id === id), id).toBeTruthy();
    for (const e of EXERCISES) {
      expect(e.sources.length, e.id).toBeGreaterThan(0);
      for (const s of e.sources) expect(SOURCES[s], `${e.id} → ${s}`).toBeTruthy();
      expect(e.steps.length).toBeGreaterThan(1);
    }
    const flows = EXERCISES.filter(e => e.kind === 'flow').map(e => e.bpm);
    expect(flows).toEqual(expect.arrayContaining([80, 90, 140]));
  });
});

describe('tessiture et gammes', () => {
  it('tessiture : centiles 5-95 d’une sirène, éclats ignorés', () => {
    const track: PitchPoint[] = [];
    for (let i = 0; i <= 200; i++) track.push({ t: i * 0.02, midi: 45 + (19 * (i < 100 ? i : 200 - i)) / 100 });
    track.push({ t: 5, midi: 90 }, { t: 5.1, midi: NaN });
    const t = tessitureOf(track)!;
    expect(t.low).toBeGreaterThanOrEqual(45);
    expect(t.low).toBeLessThanOrEqual(47);
    expect(t.high).toBeGreaterThanOrEqual(62);
    expect(t.high).toBeLessThanOrEqual(64);
    expect(tessitureOf([{ t: 0, midi: 50 }])).toBeNull();
  });

  it('gamme de 5 notes : les 3 tours restent sous le haut de la tessiture', () => {
    const t = { low: 45, high: 64 };
    const r = comfortableRoot(t);
    expect(r).toBeGreaterThanOrEqual(45);
    expect(r + 7 + 2).toBeLessThanOrEqual(64);
    expect(comfortableRoot({ low: 50, high: 55 })).toBe(50);
    expect(holdTarget(t)).toBeGreaterThan(45);
    expect(holdTarget(t)).toBeLessThan(64);
  });

  it('justesse guidée : juste, 30 cents bas, une octave dessous (pas faux), notes manquées', () => {
    const pat = fiveNotePattern(48, 0, 0.45);
    expect(pat.map(n => n.midi - 48)).toEqual([0, 2, 4, 5, 7, 5, 4, 2, 0]);
    const juste = scoreGuided(sing(pat, 0), pat);
    expect(juste.sung).toBe(9);
    expect(juste.medianAbsCents).toBeLessThan(5);
    expect(juste.score).toBeGreaterThan(90);
    const bas = scoreGuided(sing(pat, -30), pat);
    expect(bas.meanCents).toBeLessThan(-25);
    expect(bas.score).toBeLessThan(50);
    const octave = scoreGuided(sing(pat, 0, 0.08, -1), pat);
    expect(octave.score).toBeGreaterThan(90);
    const partiel = scoreGuided(sing(pat).filter(p => p.t < 2), pat);
    expect(partiel.sung).toBeLessThan(9);
    expect(partiel.score).toBeLessThan(juste.score);
    expect(foldCents(57 - 12 + 0.1, 57)).toBeCloseTo(10, 5);
    expect(trillPattern(50, 0).map(n => n.midi - 50)).toEqual([0, 4, 7, 4, 0]);
  });

  it('sirène : étendue, continuité, cassures', () => {
    const lisse: PitchPoint[] = [];
    for (let i = 0; i <= 120; i++) lisse.push({ t: i * 0.025, midi: 48 + 14 * Math.sin(Math.PI * i / 120) });
    const a = scoreSiren(lisse);
    expect(a.rangeSemis).toBeGreaterThan(12);
    expect(a.breaks).toBe(0);
    expect(a.score).toBeGreaterThan(90);
    const casse = lisse.map((p, i) => ({ t: p.t, midi: i % 10 < 4 ? NaN : p.midi + (i > 60 ? 3 * (i % 2) : 0) }));
    const b = scoreSiren(casse);
    expect(b.continuity).toBeLessThan(0.8);
    expect(b.breaks).toBeGreaterThan(0);
    expect(b.score).toBeLessThan(a.score - 20);
  });
});

describe('historique sur l’appareil', () => {
  it('ajout, progrès, effacement, données abîmées ignorées', () => {
    const s = new MemStore();
    const day = 86400000, now = Date.now();
    addResult({ id: 'flow-80-croches', at: now - 2 * day, score: 60, value: 40 }, s);
    addResult({ id: 'flow-80-croches', at: now - day, score: 72, value: 25 }, s);
    addResult({ id: 'flow-80-croches', at: now, score: 88, value: 12 }, s);
    addResult({ id: 'tenue', at: now, score: 70, value: 14 }, s);
    const p = progressOf(loadHistory(s), 'flow-80-croches')!;
    expect(p.count).toBe(3);
    expect(p.best).toBe(88);
    expect(p.first).toBe(60);
    expect(p.recent).toEqual([60, 72, 88]);
    expect(streakDays(loadHistory(s), now)).toBe(3);
    expect(progressOf(loadHistory(s), 'souffle')).toBeNull();
    s.setItem('nova_echauffement_v1', '{pas du json');
    expect(loadHistory(s)).toEqual([]);
    clearHistory(s);
    expect(loadHistory(s)).toEqual([]);
    saveTessiture({ low: 45, high: 64 }, s);
    expect(loadTessiture(s)).toEqual({ low: 45, high: 64 });
  });

  it('limite à 600 résultats', () => {
    const s = new MemStore();
    for (let i = 0; i < 620; i++) addResult({ id: 'tenue', at: i, score: 50, value: 10 }, s);
    expect(loadHistory(s).length).toBe(600);
  });
});
