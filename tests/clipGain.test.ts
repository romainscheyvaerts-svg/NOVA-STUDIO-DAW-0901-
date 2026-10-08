import { describe, expect, it } from 'vitest';
import type { Clip, ClipGainPoint } from '../types';
import {
  addGainPoint, applyPencilToAutomation, applyPencilToClip, clipEnvelopeGain, dbToLin, envelopeDbAt, envelopeRampsInClip,
  lineDb, lineY, linToDb, moveGainPoint, nudgeClipGain, offsetGainRange, pencilShape, removeGainPoint, renderGainToChannels,
  renderedClipPatch, replaceGainRange, revertGainRenderPatch, segmentShape, setSegmentCurve,
} from '../utils/clipGain';
import { clipGainAt, clipGainEvents, GainEvent } from '../utils/fades';
import { findConflicts, chordFromEvent, findShortcut } from '../utils/keymap';
import { makeClip } from './helpers/fixtures';

const audio = (over: Partial<Clip> = {}) => makeClip({ bufferId: 'buf', ...over });
const db = (g: number) => 20 * Math.log10(g);

/**
 * Valeur d'un AudioParam programmé par `clipGainEvents` à l'instant t (s
 * depuis le début du clip) : setValueAtTime + setValueCurveAtTime (courbe
 * interpolée linéairement entre ses valeurs, comme la Web Audio API).
 */
export function paramAt(events: GainEvent[], t: number): number {
  let v = 1;
  for (const e of events) {
    if (e.t > t + 1e-12) break;
    if (e.kind === 'set') { v = e.v; continue; }
    const n = e.values.length;
    if (t >= e.t + e.d) { v = e.values[n - 1]; continue; }
    const pos = ((t - e.t) / e.d) * (n - 1);
    const k = Math.min(n - 2, Math.floor(pos));
    v = e.values[k] + (e.values[k + 1] - e.values[k]) * (pos - k);
  }
  return v;
}

describe('ligne de gain : enveloppe aux points', () => {
  const pts: ClipGainPoint[] = [{ t: 1, db: 0 }, { t: 2, db: -12 }, { t: 3, db: -12 }, { t: 4, db: 6 }];

  it('vaut le niveau exact de chaque point, tenu avant le premier et après le dernier', () => {
    expect(envelopeDbAt(pts, 0)).toBe(0);
    expect(envelopeDbAt(pts, 1)).toBe(0);
    expect(envelopeDbAt(pts, 2)).toBe(-12);
    expect(envelopeDbAt(pts, 2.5)).toBe(-12);
    expect(envelopeDbAt(pts, 4)).toBe(6);
    expect(envelopeDbAt(pts, 9)).toBe(6);
    expect(envelopeDbAt([], 3)).toBe(0);
  });

  it('interpole en dB entre deux points (droit), et suit la courbure demandée', () => {
    expect(envelopeDbAt(pts, 1.5)).toBeCloseTo(-6, 9);
    expect(envelopeDbAt(pts, 3.5)).toBeCloseTo(-3, 9);
    const curved = setSegmentCurve(pts, 0, 0.6);
    expect(curved[0].curve).toBe(0.6);
    const mid = envelopeDbAt(curved, 1.5);
    expect(mid).toBeGreaterThan(-6);              // départ lent : on reste plus haut à mi-chemin
    expect(envelopeDbAt(curved, 1)).toBe(0);      // les points ne bougent pas
    expect(envelopeDbAt(curved, 2)).toBe(-12);
    for (const c of [-1, -0.4, 0, 0.3, 1]) {      // forme monotone de 0 à 1
      expect(segmentShape(0, c)).toBeCloseTo(0, 9);
      expect(segmentShape(1, c)).toBeCloseTo(1, 9);
      for (let i = 1; i <= 20; i++) expect(segmentShape(i / 20, c)).toBeGreaterThanOrEqual(segmentShape((i - 1) / 20, c));
    }
  });

  it('gain du clip = gain global × ligne (points en temps source, offset compris)', () => {
    const c = audio({ start: 10, offset: 1, duration: 3, gain: dbToLin(-3), gainPoints: pts });
    expect(db(clipGainAt(c, 0))).toBeCloseTo(-3, 6);       // source 1 → 0 dB
    expect(db(clipGainAt(c, 1))).toBeCloseTo(-15, 6);      // source 2 → −12 dB
    expect(db(clipGainAt(c, 0.5))).toBeCloseTo(-9, 6);     // milieu de la pente
    expect(db(clipEnvelopeGain(c, 2))).toBeCloseTo(-12, 6);
  });

  it('zones où la ligne varie : seulement les pentes, bornées au clip', () => {
    expect(envelopeRampsInClip(pts, 0, 10)).toEqual([[1, 2], [3, 4]]);
    expect(envelopeRampsInClip(pts, 1.5, 2)).toEqual([[0, 0.5], [1.5, 2]]);
  });

  it('édition des points : ajouter, déplacer (sans doubler ses voisins), enlever', () => {
    const r = addGainPoint(pts, 2.5, -20);
    expect(r.points.map(p => p.t)).toEqual([1, 2, 2.5, 3, 4]);
    expect(r.index).toBe(2);
    const m = moveGainPoint(r.points, 2, 5, -6);
    expect(m[2].t).toBeLessThan(3);               // reste avant le point suivant
    expect(m[2].db).toBe(-6);
    expect(removeGainPoint(m, 2)).toHaveLength(4);
  });
});

describe('lecture = export : plan de gain avec la ligne', () => {
  const pts: ClipGainPoint[] = [{ t: 0.5, db: 0 }, { t: 1, db: -12 }, { t: 2, db: -12 }, { t: 2.5, db: 4 }];

  it('le plan programmé donne le niveau de chaque point à 0,1 dB près', () => {
    const c = audio({ duration: 4, gain: dbToLin(2), gainPoints: pts });
    const ev = clipGainEvents(c, 0);
    for (const p of pts) expect(db(paramAt(ev, p.t))).toBeCloseTo(2 + p.db, 1);
    for (let t = 0.01; t < 3.99; t += 0.037) expect(Math.abs(db(paramAt(ev, t)) - db(clipGainAt(c, t)))).toBeLessThan(0.1);
  });

  it('jamais deux évènements superposés (contrainte Web Audio), même en partant au milieu', () => {
    const c = audio({ duration: 4, fadeIn: 0.2, fadeOut: 0.3, gainPoints: pts, breaths: [{ start: 1.2, end: 1.6, gainDb: -15 }] });
    for (const from of [0, 0.1, 0.7, 1.3, 2.2, 3.8]) {
      const ev = clipGainEvents(c, from);
      for (let i = 1; i < ev.length; i++) {
        const prev = ev[i - 1];
        const prevEnd = prev.kind === 'curve' ? prev.t + prev.d : prev.t;
        expect(ev[i].t).toBeGreaterThanOrEqual(prevEnd - 1e-9);
      }
      for (let t = from + 0.005; t < 3.99; t += 0.05) expect(Math.abs(paramAt(ev, t) - clipGainAt(c, t))).toBeLessThan(0.012);
    }
  });

  it('se combine avec les respirations, les fondus et le gain global (produit des gains)', () => {
    const base = audio({ duration: 4, fadeIn: 0.25, fadeOut: 0.5, fadeOutCurve: 'S_CURVE', gain: 0.7, breaths: [{ start: 1.3, end: 1.7, gainDb: -20 }] });
    const withLine = { ...base, gainPoints: pts };
    for (let t = 0.01; t < 4; t += 0.0731) {
      expect(clipGainAt(withLine, t)).toBeCloseTo(clipGainAt(base, t) * clipEnvelopeGain(withLine, t), 9);
    }
    const ev = clipGainEvents(withLine, 0);
    for (let t = 0.01; t < 3.99; t += 0.0311) expect(Math.abs(paramAt(ev, t) - clipGainAt(withLine, t))).toBeLessThan(0.012);
  });

  it('sans ligne ni respirations : plan inchangé (pas de régression des fondus)', () => {
    const c = audio({ duration: 4, fadeIn: 1, fadeOut: 1 });
    const ev = clipGainEvents(c, 0);
    expect(ev.map(e => e.kind)).toEqual(['curve', 'curve']);
  });
});

describe('la ligne survit aux découpes et aux rognages', () => {
  const pts: ClipGainPoint[] = [{ t: 1, db: 0 }, { t: 1.5, db: -10 }, { t: 3, db: -10 }, { t: 3.5, db: 3 }];
  const orig = audio({ start: 8, offset: 0.25, duration: 4, gainPoints: pts, gain: 0.9 });
  /** Gain à l'instant T de la timeline d'un ensemble de clips (celui qui le couvre). */
  const gainAtTimeline = (clips: Clip[], T: number) => {
    const c = clips.find(x => T >= x.start && T < x.start + x.duration);
    return c ? clipGainAt(c, T - c.start) : 0;
  };

  it('découpe (comme « Séparer ») : chaque morceau garde le même gain au même endroit', () => {
    const at = 9.6;
    const a = { ...orig, duration: at - orig.start };
    const b = { ...orig, id: 'b', start: at, duration: orig.duration - (at - orig.start), offset: orig.offset + (at - orig.start) };
    for (let T = 8.01; T < 11.99; T += 0.05) expect(gainAtTimeline([a, b], T)).toBeCloseTo(gainAtTimeline([orig], T), 9);
  });

  it('rognage du début et de la fin : le gain ne glisse pas sous le son', () => {
    const trimmed = { ...orig, start: 9, offset: orig.offset + 1, duration: 2 };
    for (let T = 9.01; T < 10.99; T += 0.05) expect(gainAtTimeline([trimmed], T)).toBeCloseTo(gainAtTimeline([orig], T), 9);
  });

  it('déplacement : la ligne suit le clip', () => {
    const moved = { ...orig, start: orig.start + 3.3 };
    for (let t = 0.01; t < 3.99; t += 0.1) expect(clipGainAt(moved, t)).toBeCloseTo(clipGainAt(orig, t), 12);
  });
});

describe('crayon : formes libre, ligne, triangle, carré, aléatoire', () => {
  it('ligne : une droite du départ à l’arrivée', () => {
    expect(pencilShape({ shape: 'line', t0: 2, t1: 1, v0: -3, v1: 0, period: 0.5 })).toEqual([{ t: 1, v: 0 }, { t: 2, v: -3 }]);
  });

  it('triangle : alterne départ / hauteur tous les demi-pas de grille', () => {
    const s = pencilShape({ shape: 'triangle', t0: 0, t1: 1, v0: 0, v1: -12, period: 0.5, step: 0.5 });
    expect(s.map(p => p.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(s.map(p => p.v)).toEqual([0, -12, 0, -12, 0]);
  });

  it('carré : créneaux avec des rampes (jamais de saut vertical)', () => {
    const s = pencilShape({ shape: 'square', t0: 0, t1: 1, v0: 0, v1: -10, period: 0.5, ramp: 0.005 });
    for (let i = 1; i < s.length; i++) {
      expect(s[i].t).toBeGreaterThan(s[i - 1].t);   // temps strictement croissants
      if (s[i].v !== s[i - 1].v) expect(s[i].t - s[i - 1].t).toBeGreaterThanOrEqual(0.005 - 1e-9);
    }
    expect(new Set(s.map(p => p.v))).toEqual(new Set([0, -10]));
  });

  it('aléatoire : stable pendant le geste (même graine), entre les deux bornes', () => {
    const st = { shape: 'random' as const, t0: 0, t1: 2, v0: -20, v1: 0, period: 0.25, seed: 42 };
    const a = pencilShape(st), b = pencilShape(st);
    expect(a).toEqual(b);
    expect(a.every(p => p.v >= -20 && p.v <= 0)).toBe(true);
    expect(new Set(a.map(p => p.v.toFixed(3))).size).toBeGreaterThan(3);
  });

  it('libre : simplifié ; avec la grille, un point par pas de grille', () => {
    const samples = Array.from({ length: 101 }, (_, i) => ({ t: i / 100, v: -10 * (i / 100) }));
    const free = pencilShape({ shape: 'free', t0: 0, t1: 1, v0: 0, v1: -10, period: 0.25, samples });
    expect(free.length).toBe(2);                  // une droite : deux points suffisent
    const grid = pencilShape({ shape: 'free', t0: 0, t1: 1, v0: 0, v1: -10, period: 0.25, step: 0.25, samples });
    expect(grid.map(p => +p.t.toFixed(6))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(grid[2].v).toBeCloseTo(-5, 6);
  });

  it('sur un clip : valeurs à l’écran = gain total, rampes de 5 ms aux bords', () => {
    const c = audio({ start: 10, offset: 2, duration: 4, gain: dbToLin(-6), gainPoints: [{ t: 2, db: 0 }, { t: 6, db: 0 }] });
    const pts = applyPencilToClip(c, { shape: 'line', t0: 11, t1: 12, v0: -6, v1: -18, period: 0.5 })!;
    expect(envelopeDbAt(pts, 3)).toBeCloseTo(0, 6);       // −6 total − (−6) global = 0
    expect(envelopeDbAt(pts, 4)).toBeCloseTo(-12, 6);
    expect(envelopeDbAt(pts, 4.005)).toBeCloseTo(0, 6);   // rampe de 5 ms vers la ligne d'avant
    expect(envelopeDbAt(pts, 1)).toBeCloseTo(0, 6);
  });

  it('sur une ligne d’automation : points remplacés dans la plage, courbe d’avant gardée autour', () => {
    const old = [{ id: 'a', time: 0, value: 1 }, { id: 'b', time: 1.5, value: 1 }, { id: 'c', time: 4, value: 0.5 }];
    let n = 0;
    const out = applyPencilToAutomation(old, { shape: 'line', t0: 1, t1: 2, v0: 0.2, v1: 0.8, period: 0.5 }, () => 1, () => `p${n++}`, 0.002);
    expect(out.find(p => p.id === 'b')).toBeUndefined();
    expect(out.some(p => Math.abs(p.time - 1) < 1e-9 && Math.abs(p.value - 0.2) < 1e-9)).toBe(true);
    expect(out.some(p => Math.abs(p.time - 2) < 1e-9 && Math.abs(p.value - 0.8) < 1e-9)).toBe(true);
    expect(out[0].id).toBe('a');
    expect(out[out.length - 1].id).toBe('c');
  });
});

describe('nudge du gain et gain sur la plage', () => {
  it('sans plage : tout le clip (gain global), ±0,5 / ±0,1 dB', () => {
    const c = audio({ gain: 1 });
    expect(db(nudgeClipGain(c, 0.5).gain!)).toBeCloseTo(0.5, 9);
    expect(db(nudgeClipGain({ ...c, gain: dbToLin(-3) }, -0.1).gain!)).toBeCloseTo(-3.1, 9);
  });

  it('avec une plage : seulement la plage, rampes de 5 ms à l’extérieur', () => {
    const c = audio({ offset: 0, duration: 4 });
    const p = nudgeClipGain(c, -6, [1, 2]).gainPoints!;
    expect(envelopeDbAt(p, 0.5)).toBe(0);
    expect(envelopeDbAt(p, 1)).toBeCloseTo(-6, 9);
    expect(envelopeDbAt(p, 1.5)).toBeCloseTo(-6, 9);
    expect(envelopeDbAt(p, 2)).toBeCloseTo(-6, 9);
    expect(envelopeDbAt(p, 2.006)).toBe(0);
    const twice = offsetGainRange(p, 1, 2, -6);
    expect(envelopeDbAt(twice, 1.5)).toBeCloseTo(-12, 9);   // les nudges se cumulent
  });

  it('remplacer une plage garde la ligne autour', () => {
    const p = replaceGainRange([{ t: 0, db: -3 }, { t: 10, db: -3 }], 4, 5, [{ t: 4, db: -10 }, { t: 5, db: -10 }]);
    expect(envelopeDbAt(p, 2)).toBeCloseTo(-3, 9);
    expect(envelopeDbAt(p, 4.5)).toBeCloseTo(-10, 9);
    expect(envelopeDbAt(p, 8)).toBeCloseTo(-3, 9);
  });
});

describe('rendre le gain dans le fichier (non destructif)', () => {
  it('le son rendu = son × gain × ligne ; « Revenir » remet tout', () => {
    const sr = 1000;
    const src = new Float32Array(4000).map((_, i) => Math.sin(i / 7));
    const pts: ClipGainPoint[] = [{ t: 1, db: 0 }, { t: 2, db: -12 }];
    const [out] = renderGainToChannels([src], sr, pts, 0.5);
    for (const i of [0, 500, 1000, 1500, 2000, 3999]) expect(out[i]).toBeCloseTo(src[i] * 0.5 * dbToLin(envelopeDbAt(pts, i / sr)), 6);
    const clip = audio({ bufferId: 'orig', gain: 0.5, gainPoints: pts });
    const r = renderedClipPatch(clip, 'rendu');
    expect(r).toMatchObject({ bufferId: 'rendu', gain: 1, gainPoints: undefined, gainRender: { sourceBufferId: 'orig', gain: 0.5 } });
    const back = revertGainRenderPatch({ ...clip, ...r }, id => id === 'orig')!;
    expect(back).toMatchObject({ bufferId: 'orig', gain: 0.5, gainRender: undefined });
    expect(back.gainPoints).toEqual(pts);
    expect(revertGainRenderPatch({ ...clip, ...r }, () => false)).toBeNull();
  });
});

describe('échelle à l’écran et raccourcis', () => {
  it('dB ↔ hauteur : aller-retour exact sur la plage affichée', () => {
    for (const d of [-39, -24, -6, 0, 3, 12]) expect(lineDb(120, lineY(120, d))).toBeCloseTo(d, 6);
    expect(lineDb(120, lineY(120, -40))).toBe(-60);             // tout en bas : silence (−∞)
    expect(lineY(120, 0)).toBeLessThan(lineY(120, -6));
  });

  it('raccourcis sans conflit ; Ctrl+Maj+− (QWERTY / AZERTY), Ctrl+H, Alt+R, Ctrl+Maj+↑', () => {
    expect(findConflicts()).toEqual([]);
    expect(findShortcut(chordFromEvent({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }), false)?.id).toBe('pt.clipGainLine');
    expect(findShortcut(chordFromEvent({ key: '6', code: 'Digit6', ctrlKey: true, shiftKey: true }), false)?.id).toBe('pt.clipGainLine');
    expect(findShortcut(chordFromEvent({ key: 'g', code: 'KeyG', altKey: true }), false)?.id).toBe('pt.clipGainLine');
    expect(findShortcut(chordFromEvent({ key: 'h', code: 'KeyH', ctrlKey: true }), false)?.command).toBe('heal');
    expect(findShortcut(chordFromEvent({ key: 'r', code: 'KeyR', altKey: true }), false)?.command).toBe('repeatClips');
    const up = findShortcut(chordFromEvent({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true }), false)!;
    expect(up.command).toBe('clipGainNudge');
    expect(up.arg.db).toBe(0.5);
    expect(findShortcut(chordFromEvent({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, altKey: true, shiftKey: true }), false)?.arg.db).toBe(-0.1);
    expect(linToDb(1)).toBe(0);
  });
});

describe('piste gelée : la ligne déjà rendue n’est pas appliquée deux fois', () => {
  it('tranche du rendu : rien si la ligne est celle du gel, sinon l’écart seulement', async () => {
    const { sliceGainPoints } = await import('../utils/freeze');
    const pts: ClipGainPoint[] = [{ t: 1, db: 0 }, { t: 2, db: -6 }];
    const ref = { renderId: 'r', anchor: 10, from: 0, to: 4, fadeIn: 0, fadeOut: 0, gain: 1, gainPoints: pts };
    expect(sliceGainPoints({ gainPoints: pts }, ref)).toBeUndefined();
    const changed = sliceGainPoints({ gainPoints: [{ t: 1, db: 0 }, { t: 2, db: -12 }] }, ref)!;
    expect(envelopeDbAt(changed, 12)).toBeCloseTo(-6, 9);     // temps du rendu = ancrage + temps source
    expect(envelopeDbAt(changed, 11)).toBeCloseTo(0, 9);
    expect(envelopeDbAt(sliceGainPoints({ gainPoints: undefined }, ref)!, 12)).toBeCloseTo(6, 9);   // ligne retirée : on remonte
  });
});
