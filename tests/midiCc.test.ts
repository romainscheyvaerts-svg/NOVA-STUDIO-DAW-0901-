import { describe, expect, it } from 'vitest';
import {
  applySustain, playableNotes, ccValueAt, splitCc, linePoints, replacePoints, thinPoints, ccLabel, bendCents, ccGain,
  SUSTAIN, PB,
} from '../utils/midiCc';
import { MidiNote } from '../types';

/** R16 : contrôleurs MIDI (sustain, pitch bend, CC), notes muettes. */

const n = (id: string, pitch: number, start: number, duration: number, extra: Partial<MidiNote> = {}): MidiNote => ({ id, pitch, start, duration, velocity: 0.8, ...extra });

describe('sustain (CC64)', () => {
  it('une note relâchée pédale enfoncée tient jusqu’au relâchement de la pédale', () => {
    const out = applySustain([n('a', 60, 0, 0.5), n('b', 64, 2.5, 0.2)], [{ t: 0.2, v: 127 }, { t: 2, v: 0 }], 4);
    expect(out[0].duration).toBeCloseTo(2, 9);
    expect(out[1].duration).toBeCloseTo(0.2, 9);
  });

  it('la même touche rejouée coupe la note tenue (comme un piano)', () => {
    const out = applySustain([n('a', 60, 0, 0.3), n('b', 60, 1, 0.3)], [{ t: 0, v: 127 }, { t: 3, v: 0 }], 4);
    expect(out[0].duration).toBeCloseTo(1, 9);
    expect(out[1].duration).toBeCloseTo(2, 9);
  });

  it('pédale jamais relâchée : la note tient jusqu’à la fin du clip', () => {
    const out = applySustain([n('a', 60, 0, 0.3)], [{ t: 0, v: 100 }], 4);
    expect(out[0].duration).toBeCloseTo(4, 9);
  });

  it('notes jouables : sans les notes muettes, sustain appliqué, même tableau si rien ne change', () => {
    const notes = [n('a', 60, 0, 0.5), n('b', 62, 1, 0.5, { muted: true })];
    const plain = [n('c', 60, 0, 0.5)];
    expect(playableNotes({ notes: plain, duration: 4 })).toBe(plain);
    const p = playableNotes({ notes, duration: 4, cc: { [SUSTAIN]: [{ t: 0, v: 127 }, { t: 3, v: 0 }] } });
    expect(p.map(x => x.id)).toEqual(['a']);
    expect(p[0].duration).toBeCloseTo(3, 9);
    // Mémorisé : même résultat pour les mêmes entrées.
    expect(playableNotes({ notes, duration: 4, cc: undefined })).not.toBe(p);
  });
});

describe('couloirs', () => {
  it('valeur tenue (marches) et valeur au repos', () => {
    const pts = [{ t: 1, v: 10 }, { t: 2, v: 20 }];
    expect(ccValueAt(pts, 0.5, 64)).toBe(64);
    expect(ccValueAt(pts, 1, 64)).toBe(10);
    expect(ccValueAt(pts, 1.99, 64)).toBe(10);
    expect(ccValueAt(pts, 5, 64)).toBe(20);
  });

  it('ligne : rampe régulière, sustain en tout-ou-rien', () => {
    const l = linePoints('cc1', 0, 0, 1, 127, 0.25);
    expect(l.map(p => p.v)).toEqual([0, 32, 64, 95, 127]);
    const s = linePoints(SUSTAIN, 0, 0, 1, 127, 0.25);
    expect(new Set(s.map(p => p.v))).toEqual(new Set([0, 127]));
    const pb = linePoints(PB, 0, -8192, 1, 8191, 0.5);
    expect(pb[0].v).toBe(-8192);
    expect(pb[pb.length - 1].v).toBe(8191);
  });

  it('crayon : remplace les points du passage dessiné', () => {
    const r = replacePoints([{ t: 0, v: 1 }, { t: 1, v: 2 }, { t: 3, v: 3 }], 0.5, 2, [{ t: 0.6, v: 9 }, { t: 1.8, v: 8 }]);
    expect(r).toEqual([{ t: 0, v: 1 }, { t: 0.6, v: 9 }, { t: 1.8, v: 8 }, { t: 3, v: 3 }]);
  });

  it('allège un flux enregistré sans perdre la dernière valeur', () => {
    const raw = Array.from({ length: 50 }, (_, i) => ({ t: i * 0.001, v: i }));
    const thin = thinPoints([...raw, { t: 0.2, v: 0 }]);
    expect(thin.length).toBeLessThan(20);
    expect(thin[thin.length - 1].v).toBe(0);
  });

  it('découpe d’un clip : la partie droite repart de 0 avec la valeur tenue', () => {
    const [l, r] = splitCc({ pb: [{ t: 0.5, v: 100 }, { t: 2, v: 200 }] }, 1);
    expect(l!.pb).toEqual([{ t: 0.5, v: 100 }]);
    expect(r!.pb).toEqual([{ t: 0, v: 100 }, { t: 1, v: 200 }]);
  });

  it('libellés et effets sur les instruments de NOVA', () => {
    expect(ccLabel('cc64')).toBe('Sustain (CC64)');
    expect(ccLabel('pb')).toBe('Pitch bend');
    expect(ccLabel('cc20')).toBe('CC20');
    expect(bendCents(8191)).toBeCloseTo(200, 6);
    expect(bendCents(-8192)).toBeCloseTo(-200, 6);
    expect(ccGain(127)).toBeCloseTo(1, 9);
  });
});
