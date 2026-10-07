import { describe, expect, it } from 'vitest';
import {
  applyGainEvents, autoCrossfadePatches, clipGainAt, clipGainEvents, crossfadeZones, fadeInShape, fadeOutShape,
  findJunctions, junctionNear, makeCrossfade, nudgeSeconds, FADE_CURVES, fadesForRange,
} from '../utils/fades';
import { CrossfadeCurve } from '../types';
import { makeClip } from './helpers/fixtures';

const audio = (over: Parameters<typeof makeClip>[0] = {}) => makeClip({ bufferId: 'buf', ...over });

describe('courbes de fondu', () => {
  it('partent de 0 et arrivent à 1, sans jamais sortir de [0, 1]', () => {
    for (const c of FADE_CURVES) {
      expect(fadeInShape(c, 0)).toBeCloseTo(0, 6);
      expect(fadeInShape(c, 1)).toBeCloseTo(1, 6);
      expect(fadeOutShape(c, 0)).toBeCloseTo(1, 6);
      expect(fadeOutShape(c, 1)).toBeCloseTo(0, 6);
      for (let i = 0; i <= 100; i++) {
        const v = fadeInShape(c, i / 100);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        if (i) expect(v).toBeGreaterThanOrEqual(fadeInShape(c, (i - 1) / 100) - 1e-12); // monotone
      }
    }
  });

  it('formes attendues à mi-course', () => {
    expect(fadeInShape('LINEAR', 0.5)).toBeCloseTo(0.5, 6);
    expect(fadeInShape('EQUAL_POWER', 0.5)).toBeCloseTo(Math.SQRT1_2, 6);   // -3 dB
    expect(fadeInShape('S_CURVE', 0.5)).toBeCloseTo(0.5, 6);
    expect(fadeInShape('EXPONENTIAL', 0.5)).toBeLessThan(0.05);              // ≈ -30 dB
    expect(fadeInShape(undefined, 0.3)).toBeCloseTo(0.3, 6);                  // ancien projet : linéaire
  });

  it('crossfade puissance égale : somme des puissances constante (pas de creux)', () => {
    for (let i = 0; i <= 50; i++) {
      const x = i / 50;
      const p = fadeOutShape('EQUAL_POWER', x) ** 2 + fadeInShape('EQUAL_POWER', x) ** 2;
      expect(p).toBeCloseTo(1, 9);
    }
  });

  it('crossfade linéaire et en S : somme des gains constante', () => {
    for (const c of ['LINEAR', 'S_CURVE'] as CrossfadeCurve[]) {
      for (let i = 0; i <= 50; i++) expect(fadeOutShape(c, i / 50) + fadeInShape(c, i / 50)).toBeCloseTo(1, 9);
    }
  });
});

describe('plan de gain d\'un clip (lecture = export)', () => {
  const clip = audio({ duration: 4, fadeIn: 1, fadeOut: 2, fadeInCurve: 'EQUAL_POWER', fadeOutCurve: 'S_CURVE', gain: 0.5 });

  it('gain en tout point', () => {
    expect(clipGainAt(clip, 0)).toBe(0);
    expect(clipGainAt(clip, 0.5)).toBeCloseTo(0.5 * Math.SQRT1_2, 6);
    expect(clipGainAt(clip, 1.5)).toBeCloseTo(0.5, 6);
    expect(clipGainAt(clip, 3)).toBeCloseTo(0.25, 6);   // milieu d'un fondu en S
    expect(clipGainAt(clip, 4)).toBeCloseTo(0, 6);
  });

  it('depuis le début : deux courbes, jamais superposées', () => {
    const ev = clipGainEvents(clip, 0);
    expect(ev.map(e => e.kind)).toEqual(['curve', 'curve']);
    const [a, b] = ev as Extract<typeof ev[number], { kind: 'curve' }>[];
    expect(a.t).toBe(0); expect(a.d).toBeCloseTo(1);
    expect(b.t).toBeCloseTo(2); expect(b.d).toBeCloseTo(2);
    expect(a.values[0]).toBeCloseTo(0); expect(a.values[a.values.length - 1]).toBeCloseTo(0.5);
    expect(b.values[0]).toBeCloseTo(0.5); expect(b.values[b.values.length - 1]).toBeCloseTo(0);
    expect(a.t + a.d).toBeLessThanOrEqual(b.t + 1e-9);
  });

  it('reprise au milieu du fondu d\'entrée : la courbe repart de la bonne valeur', () => {
    const ev = clipGainEvents(clip, 0.5);
    const a = ev[0] as any;
    expect(a.kind).toBe('curve');
    expect(a.t).toBe(0.5);
    expect(a.values[0]).toBeCloseTo(clipGainAt(clip, 0.5), 6);
  });

  it('reprise entre les fondus : valeur tenue puis fondu de sortie', () => {
    const ev = clipGainEvents(clip, 1.5);
    expect(ev[0]).toEqual({ kind: 'set', t: 1.5, v: 0.5 });
    expect(ev[1].kind).toBe('curve');
    expect(ev[1].t).toBeCloseTo(2);
  });

  it('reprise dans le fondu de sortie : une seule courbe partielle', () => {
    const ev = clipGainEvents(clip, 3);
    expect(ev).toHaveLength(1);
    const c = ev[0] as any;
    expect(c.t).toBe(3);
    expect(c.values[0]).toBeCloseTo(0.25, 6);
  });

  it('sans fondu : une seule valeur', () => {
    expect(clipGainEvents(audio({ duration: 2, gain: 0.8 }), 0)).toEqual([{ kind: 'set', t: 0, v: 0.8 }]);
  });

  it('fondus plus longs que le clip : bornés, sans chevauchement', () => {
    const c = audio({ duration: 1, fadeIn: 0.8, fadeOut: 0.8 });
    const ev = clipGainEvents(c, 0) as any[];
    expect(ev[0].d).toBeCloseTo(0.8);
    expect(ev[1].t).toBeCloseTo(0.8);
    expect(ev[1].d).toBeCloseTo(0.2);
  });

  it('applyGainEvents décale sur l\'horloge du contexte et se replie si une courbe est refusée', () => {
    const calls: string[] = [];
    const param = {
      setValueAtTime: (v: number, t: number) => calls.push(`set ${v.toFixed(2)}@${t.toFixed(2)}`),
      setValueCurveAtTime: () => { throw new Error('refusé'); },
      linearRampToValueAtTime: (v: number, t: number) => calls.push(`ramp ${v.toFixed(2)}@${t.toFixed(2)}`),
    };
    applyGainEvents(param, clipGainEvents(audio({ duration: 1, fadeIn: 0.5 }), 0), 10);
    expect(calls[0]).toBe('set 0.00@10.00');
    expect(calls[calls.length - 1]).toBe('ramp 1.00@10.50');
  });
});

describe("anti-clic au début d'une courbe", () => {
  it('la valeur de départ est posée juste avant la courbe (la source peut partir un échantillon plus tôt)', () => {
    const calls: [string, number, number][] = [];
    const param = {
      setValueAtTime: (v: number, t: number) => calls.push(['set', v, t]),
      setValueCurveAtTime: (vals: Float32Array, t: number) => calls.push(['curve', vals[0], t]),
    };
    applyGainEvents(param, clipGainEvents(audio({ duration: 1, fadeIn: 0.5, fadeInCurve: 'S_CURVE' }), 0), 2);
    expect(calls[0][0]).toBe('set');
    expect(calls[0][1]).toBe(0);
    expect(calls[0][2]).toBeLessThan(2);
    expect(calls[0][2]).toBeGreaterThan(1.999);
    expect(calls[1]).toEqual(['curve', 0, 2]);
  });
});

describe('crossfades', () => {
  it('jonctions : bout à bout et chevauchement, pas un clip caché dans un autre', () => {
    const clips = [
      audio({ id: 'a', start: 0, duration: 2 }),
      audio({ id: 'b', start: 2, duration: 2 }),
      audio({ id: 'c', start: 3.5, duration: 2 }),
      audio({ id: 'd', start: 4, duration: 0.5 }),     // caché dans c
      audio({ id: 'm', start: 1, duration: 3, isMuted: true }),
    ];
    const j = findJunctions(clips);
    expect(j.map(x => `${x.a}>${x.b}`)).toEqual(['a>b', 'b>c']);
    expect(j[1].overlap).toBeCloseTo(0.5);
    expect(junctionNear(clips, 2.01, 0.05)?.b).toBe('b');
    expect(junctionNear(clips, 2.5, 0.05)).toBeNull();
  });

  it('crossfade centré sur une jonction bout à bout (assez d\'audio des deux côtés)', () => {
    const a = audio({ id: 'a', start: 0, duration: 2, offset: 0 });
    const b = audio({ id: 'b', start: 2, duration: 2, offset: 1 });
    const x = makeCrossfade(a, b, 0.2, 'EQUAL_POWER', { aMaxEnd: 10, bMinStart: 1 })!;
    expect(x.start).toBeCloseTo(1.9); expect(x.end).toBeCloseTo(2.1);
    expect(x.a).toMatchObject({ fadeOutCurve: 'EQUAL_POWER' });
    expect(x.a.duration).toBeCloseTo(2.1); expect(x.a.fadeOut).toBeCloseTo(0.2);
    expect(x.b.start).toBeCloseTo(1.9); expect(x.b.offset).toBeCloseTo(0.9); expect(x.b.duration).toBeCloseTo(2.1); expect(x.b.fadeIn).toBeCloseTo(0.2);
  });

  it('pas d\'audio après la fin de a : le crossfade glisse avant la jonction', () => {
    const a = audio({ id: 'a', start: 0, duration: 2 });
    const b = audio({ id: 'b', start: 2, duration: 2, offset: 1 });
    const x = makeCrossfade(a, b, 0.2, 'LINEAR', { aMaxEnd: 2, bMinStart: 1 })!;
    expect(x.start).toBeCloseTo(1.8); expect(x.end).toBeCloseTo(2);
  });

  it('aucun audio de part et d\'autre : impossible', () => {
    const a = audio({ id: 'a', start: 0, duration: 2 });
    const b = audio({ id: 'b', start: 2, duration: 2, offset: 0 });
    expect(makeCrossfade(a, b, 0.2, 'LINEAR', { aMaxEnd: 2, bMinStart: 2 })).toBeNull();
  });

  it('chevauchement : longueur demandée centrée sur le milieu de la zone commune', () => {
    const a = audio({ id: 'a', start: 0, duration: 3 });
    const b = audio({ id: 'b', start: 2, duration: 3, offset: 2 });
    const x = makeCrossfade(a, b, 0.4, 'S_CURVE', { aMaxEnd: 3, bMinStart: 0 })!;
    expect(x.start).toBeCloseTo(2.3); expect(x.end).toBeCloseTo(2.7);
    expect(x.a.duration).toBeCloseTo(2.7); expect(x.b.start).toBeCloseTo(2.3); expect(x.b.offset).toBeCloseTo(2.3);
  });

  it('crossfade auto après une édition : chevauchement entier, puis bout à bout anti-clic', () => {
    const clips = [
      audio({ id: 'a', start: 0, duration: 2, fadeIn: 0.05 }),
      audio({ id: 'b', start: 1.5, duration: 2, offset: 0 }),
      audio({ id: 'c', start: 3.5, duration: 1, offset: 1 }),
      audio({ id: 'z', start: 10, duration: 5 }),
    ];
    const p = autoCrossfadePatches(clips, new Set(['b']), 'EQUAL_POWER', () => 20);
    expect(p.get('a')).toMatchObject({ fadeOut: 0.5, fadeOutCurve: 'EQUAL_POWER', fadeIn: 0.05 });
    expect(p.get('b')!.fadeIn).toBeCloseTo(0.5);
    expect(p.get('c')!.fadeIn).toBeCloseTo(0.01);
    expect(p.get('c')!.start).toBeCloseTo(3.495);
    expect(p.has('z')).toBe(false);
    // Clips non modifiés : rien ne change.
    expect(autoCrossfadePatches(clips, new Set(['z']), 'LINEAR', () => 20).size).toBe(0);
  });

  it('chevauchement trop long (prises empilées) : pas de crossfade auto', () => {
    const clips = [audio({ id: 'a', start: 0, duration: 10 }), audio({ id: 'b', start: 5, duration: 10 })];
    expect(autoCrossfadePatches(clips, new Set(['b']), 'LINEAR', () => 20).size).toBe(0);
  });

  it('zones de crossfade à dessiner', () => {
    const clips = [
      audio({ id: 'a', start: 0, duration: 2, fadeOut: 0.5 }),
      audio({ id: 'b', start: 1.5, duration: 2, fadeIn: 0.5 }),
      audio({ id: 'c', start: 3, duration: 2 }),   // chevauche b sans fondus : pas un crossfade
    ];
    expect(crossfadeZones(clips)).toEqual([{ a: 'a', b: 'b', start: 1.5, end: 2 }]);
  });
});

describe('nudge', () => {
  it('pas en secondes', () => {
    expect(nudgeSeconds('MS10', 120)).toBeCloseTo(0.01);
    expect(nudgeSeconds('MS1', 120)).toBeCloseTo(0.001);
    expect(nudgeSeconds('FRAME', 120)).toBeCloseTo(1 / 30);
    expect(nudgeSeconds('BEAT', 120)).toBeCloseTo(0.5);
    expect(nudgeSeconds('BAR', 120)).toBeCloseTo(2);
    expect(nudgeSeconds('GRID', 120, '1/16')).toBeCloseTo(0.125);
    expect(nudgeSeconds('GRID', 120, '1/8t')).toBeCloseTo(0.25 * 2 / 3);
    expect(nudgeSeconds('GRID', 120, '1/1')).toBeCloseTo(2);
  });
});

describe('fondus depuis une sélection (Ctrl+F)', () => {
  it('début de clip → fondu d\'entrée, fin → fondu de sortie, jonction → crossfade', () => {

    const clips = [
      audio({ id: 'a', start: 0, duration: 4 }),
      audio({ id: 'b', start: 4, duration: 4, offset: 2 }),
    ];
    const head = fadesForRange(clips, 0, 0.5, 'S_CURVE', () => 20);
    expect(head.get('a')).toMatchObject({ fadeIn: 0.5, fadeInCurve: 'S_CURVE' });
    const tail = fadesForRange(clips, 7, 8, 'LINEAR', () => 20);
    expect(tail.get('b')).toMatchObject({ fadeOut: 1, fadeOutCurve: 'LINEAR' });
    const x = fadesForRange(clips, 3.9, 4.1, 'EQUAL_POWER', () => 20);
    expect(x.get('a')!.fadeOut).toBeCloseTo(0.2);
    expect(x.get('b')!.fadeIn).toBeCloseTo(0.2);
    expect(x.get('b')!.start).toBeCloseTo(3.9);
  });
});
