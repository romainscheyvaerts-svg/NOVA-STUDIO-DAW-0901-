import { describe, expect, it } from 'vitest';
import { shuffleMoveGroup, ShuffleTrackIn } from '../utils/shuffle';
import { makeClip } from './helpers/fixtures';
import type { Clip } from '../types';

const c = (id: string, start: number, duration: number): Clip => makeClip({ id, start, duration, bufferId: `b-${id}` });
const pos = (clips: Clip[] | undefined) => (clips || []).slice().sort((a, b) => a.start - b.start).map(x => [x.id, +x.start.toFixed(6), +x.duration.toFixed(6)]);

describe('Shuffle : déplacer toute la sélection (Pro Tools)', () => {
  // A : [a1 0–2][a2 2–4][a3 4–5][a4 5–8]
  const A = (): ShuffleTrackIn => ({ id: 'A', kind: 'AUDIO', clips: [c('a1', 0, 2), c('a2', 2, 2), c('a3', 4, 1), c('a4', 5, 3)] });
  // B : [b1 0–3][b2 3–4]
  const B = (): ShuffleTrackIn => ({ id: 'B', kind: 'AUDIO', clips: [c('b1', 0, 3), c('b2', 3, 1)] });
  const M = (): ShuffleTrackIn => ({ id: 'M', kind: 'MIDI', clips: [c('m1', 0, 4)] });

  it('deux clips sélectionnés bougent ensemble : la piste se recolle, ils s’insèrent au bord le plus proche', () => {
    // a2 + a3 (2–5) déplacés vers la fin : la suite (a4) recule de 3 s, puis le bloc va après a4.
    const r = shuffleMoveGroup([A()], ['a2', 'a3'], 'a2', 6.2, 0)!;
    expect(pos(r.tracks.get('A'))).toEqual([['a1', 0, 2], ['a4', 2, 3], ['a2', 5, 2], ['a3', 7, 1]]);
    expect(r.start).toBe(5);
  });

  it('le bloc garde ses écarts et ne laisse jamais de trou ni de chevauchement', () => {
    const r = shuffleMoveGroup([A()], ['a1', 'a3'], 'a1', 2.3, 0)!;
    const list = pos(r.tracks.get('A'));
    // a1 et a3 retirés : a2 0–2, a4 2–5 ; bloc (a1 à 0, a3 à +4) inséré au bord 2 → a4 avance de la longueur du bloc (5 s).
    expect(list).toEqual([['a2', 0, 2], ['a1', 2, 2], ['a3', 6, 1], ['a4', 7, 3]]);
  });

  it('changement de piste : retiré (recollé) sur A, inséré sur B (qui avance), en une seule opération', () => {
    const r = shuffleMoveGroup([A(), B()], ['a2', 'a3'], 'a2', 3.1, 1)!;
    expect(r.trackShift).toBe(1);
    expect(pos(r.tracks.get('A'))).toEqual([['a1', 0, 2], ['a4', 2, 3]]);
    expect(pos(r.tracks.get('B'))).toEqual([['b1', 0, 3], ['a2', 3, 2], ['a3', 5, 1], ['b2', 6, 1]]);
  });

  it('sélection sur deux pistes : chaque piste se recolle et reçoit sa part, au même point d’insertion', () => {
    const r = shuffleMoveGroup([A(), B()], ['a1', 'b1'], 'a1', 4.9, 0)!;
    // A recollé : a2 0–2, a3 2–3, a4 3–6 ; B : b2 0–1. Bord de A le plus proche de 4,9 : 6.
    expect(r.start).toBe(6);
    expect(pos(r.tracks.get('A'))).toEqual([['a2', 0, 2], ['a3', 2, 1], ['a4', 3, 3], ['a1', 6, 2]]);
    // B reçoit b1 au même instant (les deux pistes restent calées l'une sur l'autre).
    expect(pos(r.tracks.get('B'))).toEqual([['b2', 0, 1], ['b1', 6, 3]]);
  });

  it('piste d’arrivée d’un autre genre (MIDI) ou hors de l’arrangement : pas de changement de piste', () => {
    expect(shuffleMoveGroup([A(), M()], ['a2'], 'a2', 2, 1)!.trackShift).toBe(0);
    expect(shuffleMoveGroup([A(), B()], ['a2'], 'a2', 2, -1)!.trackShift).toBe(0);
    // Sélection sur A et B vers le bas : B n'a pas de piste en dessous → refusé.
    expect(shuffleMoveGroup([A(), B()], ['a2', 'b2'], 'a2', 2, 1)!.trackShift).toBe(0);
  });

  it('piste vide à l’arrivée : le bloc se pose au début du morceau ou à sa place', () => {
    const E: ShuffleTrackIn = { id: 'E', kind: 'AUDIO', clips: [] };
    const r = shuffleMoveGroup([A(), E], ['a4'], 'a4', 1, 1)!;
    expect(pos(r.tracks.get('E'))).toEqual([['a4', 0, 3]]);
    expect(pos(r.tracks.get('A'))).toEqual([['a1', 0, 2], ['a2', 2, 2], ['a3', 4, 1]]);
  });

  it('identifiants et contenu des clips conservés ; rien n’est modifié en place', () => {
    const a = A();
    const snap = JSON.stringify(a);
    const r = shuffleMoveGroup([a, B()], ['a2'], 'a2', 0, 1)!;
    expect(JSON.stringify(a)).toBe(snap);
    expect(r.tracks.get('B')!.find(x => x.id === 'a2')).toMatchObject({ bufferId: 'b-a2', duration: 2 });
  });
});
