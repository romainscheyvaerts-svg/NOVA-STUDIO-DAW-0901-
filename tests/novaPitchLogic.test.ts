/**
 * Nova Pitch (éditeur de notes de la voix) : gestes, saisie, découpage,
 * annuler / rétablir (un geste = une étape), sauvegarde .zip (analyse +
 * retouches), anciens projets, collaboration (op « content »).
 */
import { describe, expect, it } from 'vitest';
import type { PitchNote } from '../utils/pitchAnalysis';
import { analyzePitch, segmentNotes } from '../utils/pitchAnalysis';
import { NEUTRAL_EDIT, isNeutral, type NoteEdit } from '../utils/pitchCorrect';
import { editsForNotes, storeEdits } from '../utils/pitchEdit';
import { fmtDuration, fmtPitch, parseDuration, parsePitch, roundFine } from '../utils/pitchText';
import { centerOf, correctNotes, dragPitch, editsAfterCut, editsAfterJoin, magnetize, nudge, remapIndices, withCenter } from '../utils/pitchOps';
import { infoSig, layoutOf, needsRender, pendingPatch, pitchRegion, renderedPatch, storeLayout } from '../utils/novaPitch';
import { applyLayout, cutAt, joinAfter } from '../engine/pitch/notes';
import { moveNote, renderedSpan, resetLength, stretchEnd, stretchGroup, stretchStart, type ElasticCtx } from '../engine/pitch/elastic';
import { buildTimeMap, dstToSrc, quietFinder, srcToDst } from '../engine/pitch/timeMap';
import { decodeAnalysis, encodeAnalysis } from '../engine/pitch/analysis';
import { synthVoice } from './helpers/synthVoice';
import { makeClip } from './helpers/fixtures';

const note = (index: number, start: number, end: number, center = 60): PitchNote => ({ index, i0: Math.round(start / 0.005), i1: Math.round(end / 0.005), start, end, center, spread: 0 });

describe('saisie et affichage des hauteurs et durées', () => {
  it('« La3 +4 c » (La3 = MIDI 69, Do3 = 60 dans NOVA), noms français et anglais, nombres, écarts relatifs', () => {
    expect(fmtPitch(57.04)).toBe('La2 +4 c');
    expect(fmtPitch(69)).toBe('La3 ±0 c');
    expect(fmtPitch(60.98)).toBe('Do#3 −2 c');
    expect(parsePitch('La3 +4')).toBeCloseTo(69.04, 6);
    expect(parsePitch('la3+4c')).toBeCloseTo(69.04, 6);
    expect(parsePitch('Sol#2 -10 c')).toBeCloseTo(55.9, 6);
    expect(parsePitch('A3+4')).toBeCloseTo(69.04, 6);
    expect(parsePitch('Ré3')).toBe(62);
    expect(parsePitch('57,04')).toBeCloseTo(57.04, 6);
    expect(parsePitch('+2 c', 60)).toBeCloseTo(60.02, 6);
    expect(parsePitch('−1 dt', 60)).toBeCloseTo(59, 6);
    expect(parsePitch('bla')).toBeNull();
  });

  it('durées : ms, s, temps, fractions de ronde', () => {
    expect(parseDuration('420 ms', 120)).toBeCloseTo(0.42, 9);
    expect(parseDuration('0,5 s', 120)).toBeCloseTo(0.5, 9);
    expect(parseDuration('2 t', 120)).toBeCloseTo(1, 9);
    expect(parseDuration('1/8', 120)).toBeCloseTo(0.25, 9);
    expect(parseDuration('?', 120)).toBeNull();
    expect(fmtDuration(0.5, 120)).toBe('500 ms · 1,00 t');
  });
});

describe('gestes de hauteur', () => {
  const n = note(0, 0.1, 0.5, 57.37);
  const key = { root: 9, scale: 'MINOR' };
  it('aimants : gamme, demi-ton, libre au pas de 2 cents', () => {
    expect(magnetize(56.4, 'scale', key)).toBe(57); // Sol# hors gamme → La
    expect(magnetize(56.4, 'semi', key)).toBe(56);
    expect(magnetize(56.4137, 'free', key)).toBeCloseTo(56.42, 9);
    const e = dragPitch([n], [undefined], [0], 1.01, 'free', key)[0]!;
    const q = (n.center + e.shift) / 0.02;
    expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-6);
  });
  it('flèches : demi-ton juste, Maj = 2 cents sur une grille absolue', () => {
    expect(n.center + nudge(n, undefined, 1, false).shift).toBeCloseTo(58, 6);
    const a = nudge(n, undefined, 1, true);
    expect(n.center + a.shift).toBeCloseTo(57.38, 6); // 57,37 → premier pas sur la grille
    const b = nudge(n, a, 1, true);
    expect((b.shift - a.shift) * 100).toBeCloseTo(2, 6);
    expect(roundFine(57.371)).toBeCloseTo(57.38, 9);
  });
  it('centre de hauteur et « Corriger la sélection »', () => {
    expect(withCenter(n, undefined, 100, key).shift).toBeCloseTo(-0.37, 6);
    expect(withCenter(n, undefined, 50, key).shift).toBeCloseTo(-0.185, 6);
    expect(centerOf(n, withCenter(n, undefined, 40, key), key)).toBe(40);
    const out = correctNotes([n, note(1, 0.5, 0.9, 59.8)], [undefined, { ...NEUTRAL_EDIT, gainDb: -3 }], [0, 1], key, 100, 60);
    expect(out[0]).toMatchObject({ drift: 0.6 });
    expect(out[1]!.gainDb).toBe(-3);
    expect(59.8 + out[1]!.shift).toBeCloseTo(60, 6);
  });
});

describe('couper / fusionner des notes', () => {
  const x = synthVoice(48000, 1.6, [{ midi: 60, at: 0.1, len: 1.2 }]);
  const tr = analyzePitch(x, 48000);
  const base = segmentNotes(tr);
  it('couper au milieu puis refusionner : retour au découpage d’origine', () => {
    expect(base.length).toBe(1);
    const l1 = cutAt(tr, base, {}, 0.7)!;
    const n1 = applyLayout(tr, base, l1);
    expect(n1.length).toBe(2);
    expect(n1[0].end).toBeCloseTo(0.7, 2);
    const l2 = joinAfter(n1, l1, 0)!;
    expect(applyLayout(tr, base, l2).length).toBe(1);
    expect(l2.cuts).toBeUndefined();
  });
  it('retouches réparties à la coupe et réunies à la fusion ; indices suivis', () => {
    const e: NoteEdit = { shift: 1, drift: 0, vibrato: 1, dt0: 0.01, dt1: 0.05 };
    const cut = editsAfterCut([e], 0, 0.03);
    expect(cut[0]).toMatchObject({ shift: 1, dt0: 0.01, dt1: 0.03 });
    expect(cut[1]).toMatchObject({ shift: 1, dt0: 0.03, dt1: 0.05 });
    expect(editsAfterJoin(cut, 0)[0]).toMatchObject({ shift: 1, dt0: 0.01, dt1: 0.05 });
    expect([...remapIndices(new Set([0, 2]), 1, 1)]).toEqual([0, 3]);
    expect([...remapIndices(new Set([0, 2]), 0, -1)]).toEqual([0, 1]);
  });
  it('découpage rangé en instants du son d’origine, relu dans la région', () => {
    const st = storeLayout({ cuts: [0.5], joins: [1.25] }, 2);
    expect(st).toEqual({ cuts: [2.5], joins: [3.25] });
    expect(layoutOf(st, 2)).toEqual({ cuts: [0.5], joins: [1.25] });
  });
});

describe('élastique : les voisines s’adaptent, rien ne se chevauche', () => {
  // Trois notes : 1 et 2 collées (voix liée), un silence de 0,3 s avant la 3.
  const notes = [note(0, 0.2, 0.6), note(1, 0.6, 1.0), note(2, 1.3, 1.7)];
  const quiet = (a: number, b: number) => (a >= 0.99 && b <= 1.31 ? b - a : a < 0.2 && b <= 0.21 ? b - a : b - a > 0.1 ? b - a : 0);
  const ctx = (edits: (NoteEdit | undefined)[] = [], ripple = false, extend = 0): ElasticCtx => ({ notes, edits, quietLen: quiet, regionLen: 2.2, extend, ripple });
  const spans = (c: ElasticCtx) => notes.map((_, k) => renderedSpan(c, k));
  const sane = (c: ElasticCtx) => { const s = spans(c); for (let k = 1; k < s.length; k++) expect(s[k][0]).toBeGreaterThanOrEqual(s[k - 1][1] - 1e-9); };

  it('allonger la note 1 : la note 2 (collée) raccourcit, bord commun, pas de trou', () => {
    const r = stretchEnd(ctx(), 0, 0.7);
    const c = ctx(r.edits);
    expect(spans(c)[0]).toEqual([0.2, 0.7]);
    expect(spans(c)[1][0]).toBeCloseTo(0.7, 9);
    expect(spans(c)[1][1]).toBeCloseTo(1.0, 9);
    sane(c);
  });
  it('allonger la note 2 : le silence avant la note 3 se resserre, la note 3 ne bouge pas', () => {
    const r = stretchEnd(ctx(), 1, 1.2);
    const c = ctx(r.edits);
    expect(spans(c)[1][1]).toBeCloseTo(1.2, 9);
    expect(spans(c)[2]).toEqual([1.3, 1.7]);
  });
  it('« décaler la suite » : tout ce qui suit glisse, la fin du clip aussi', () => {
    const r = stretchEnd(ctx([], true), 0, 0.8);
    const c = ctx(r.edits, true, r.extend);
    expect(r.extend).toBeCloseTo(0.2, 9);
    expect(spans(c)[1]).toEqual([0.8, 1.2]);
    expect(spans(c)[2][0]).toBeCloseTo(1.5, 9);
  });
  it('bornes ×0,25 à ×4 ; double-clic = durée d’origine', () => {
    const r = stretchEnd(ctx(), 2, 9);
    expect(renderedSpan(ctx(r.edits), 2)[1]).toBeLessThanOrEqual(1.3 + 4 * 0.4 + 1e-9);
    const r2 = stretchStart(ctx(), 2, 1.69);
    expect(renderedSpan(ctx(r2.edits), 2)[0]).toBeCloseTo(1.7 - 0.1, 9);
    const back = resetLength(ctx(r.edits), 2);
    const s = renderedSpan(ctx(back.edits), 2);
    expect(s[1] - s[0]).toBeCloseTo(0.4, 9);
  });
  it('déplacer une note : les deux voisines s’adaptent', () => {
    const r = moveNote(ctx(), 1, 0.05);
    const c = ctx(r.edits);
    expect(spans(c)[1]).toEqual([0.65, 1.05]);
    expect(spans(c)[0][1]).toBeCloseTo(0.65, 9);
    sane(c);
  });
  it('plusieurs notes étirées ensemble, proportionnellement', () => {
    const r = stretchGroup(ctx([], true), [0, 1], 1.5);
    const c = ctx(r.edits, true, r.extend);
    const s = spans(c);
    expect(s[0][1] - s[0][0]).toBeCloseTo(0.6, 9);
    expect(s[1][1] - s[1][0]).toBeCloseTo(0.6, 9);
    expect(s[1][0]).toBeCloseTo(s[0][1], 9);
    expect(r.extend).toBeCloseTo(0.4, 9);
  });
});

describe('carte du temps : seule la partie tenue s’étire', () => {
  it('attaque et chute à vitesse 1, blanc absorbé par le silence, alignement à l’échantillon', () => {
    const sr = 48000;
    const rms = new Float32Array(400).fill(-20);
    for (let f = 150; f < 200; f++) rms[f] = -90; // silence 0,75–1,0 s
    const map = buildTimeMap([
      { start: 0.2 * sr, end: 0.7 * sr, s0: 0.25 * sr, s1: 0.65 * sr, d0: 0, d1: Math.round(0.1 * sr) },
      { start: 1.0 * sr, end: 1.5 * sr, s0: 1.05 * sr, s1: 1.45 * sr, d0: 0, d1: 0 },
    ], 2 * sr, 0, quietFinder(rms, 240, sr));
    expect(srcToDst(map, 0.22 * sr) - 0.22 * sr).toBeCloseTo(0, 6); // attaque : rien ne bouge
    expect(srcToDst(map, 0.68 * sr) - 0.68 * sr).toBeCloseTo(0.1 * sr, 6); // chute : décalée en bloc
    expect(srcToDst(map, 1.2 * sr)).toBeCloseTo(1.2 * sr, 6); // note suivante intacte
    expect(dstToSrc(map, srcToDst(map, 0.5 * sr))).toBeCloseTo(0.5 * sr, 6);
  });
});

describe('le clip : un geste = une étape, son rendu posé sans étape', () => {
  const clip = makeClip({ id: 'c1', name: 'Prise 1', bufferId: 'rec-1', start: 4, offset: 1, duration: 2 });
  const stored = [{ t0: 1.2, t1: 1.5, shift: 0.02, drift: 0, vibrato: 1 }];
  const region = { start: 0.75, end: 3.25 };

  it('geste : retouches tout de suite (son inchangé, rendu en attente), puis son rendu', () => {
    const p1 = pendingPatch(clip, { sourceBufferId: 'rec-1', sourceOffset: 1, region, edits: stored });
    expect(p1.bufferId).toBeUndefined();
    expect(p1.pitchEdit).toMatchObject({ sourceBufferId: 'rec-1', regionStart: 0.75, regionEnd: 3.25, renderSig: '' });
    const c1 = { ...clip, ...p1 };
    expect(needsRender(c1, () => true)).toBe(true);
    const sig = infoSig(c1.pitchEdit);
    const p2 = renderedPatch(c1, 'nvp-c1-1', sig)!;
    expect(p2).toMatchObject({ bufferId: 'nvp-c1-1', offset: 0.25, name: 'Prise 1 (notes retouchées)' });
    const c2 = { ...c1, ...p2 };
    expect(needsRender(c2, () => true)).toBe(false);
    // Geste suivant : nouvelles retouches, l'ancien rendu reste joué en attendant.
    const p3 = pendingPatch(c2, { sourceBufferId: 'rec-1', sourceOffset: 1, region, edits: [{ ...stored[0], shift: 0.04 }] });
    expect(p3.bufferId).toBeUndefined();
    const c3 = { ...c2, ...p3 };
    expect(c3.pitchEdit!.renderSig).toBe(sig);
    expect(needsRender(c3, () => true)).toBe(true);
    // Annuler = retour à c2 (son et retouches cohérents) : rien à recalculer.
    expect(needsRender(c2, () => true)).toBe(false);
    // Son libéré de la mémoire (historique) : recalculé.
    expect(needsRender(c2, id => id !== 'nvp-c1-1')).toBe(true);
  });

  it('« décaler la suite » : la durée du clip suit ; la région rangée est réutilisée', () => {
    const p = pendingPatch(clip, { sourceBufferId: 'rec-1', sourceOffset: 1, region, edits: stored, extend: 0.3 });
    expect(p.duration).toBeCloseTo(2.3, 9);
    const c = { ...clip, ...p };
    expect(pitchRegion(c, 1, 10)).toEqual(region);
  });

  it('retouches rangées : gain et timing relus à l’identique', () => {
    const n = [note(0, 0.45, 0.75)];
    const e: NoteEdit = { shift: 0.02, drift: 0, vibrato: 1, gainDb: -3, dt0: 0.01, dt1: 0.12 };
    const st = storeEdits(n, [e], 0.75);
    expect(st[0]).toMatchObject({ gain: -3, dt0: 0.01, dt1: 0.12 });
    expect(editsForNotes(n, st, 0.75)[0]).toEqual(e);
    expect(isNeutral({ ...NEUTRAL_EDIT, dt1: 0.05 })).toBe(false);
  });
});

describe('analyse rangée dans le projet', () => {
  it('encodage binaire → relu à l’identique', () => {
    const x = synthVoice(48000, 0.8, [{ midi: 62, at: 0.1, len: 0.6 }]);
    const track = analyzePitch(x, 48000);
    const notes = segmentNotes(track);
    const r = decodeAnalysis(encodeAnalysis({ track, notes }, { regionStart: 1.5 }))!;
    expect(r.extra.regionStart).toBe(1.5);
    expect(Array.from(r.analysis.track.midi).map(v => (Number.isNaN(v) ? -1 : v))).toEqual(Array.from(track.midi).map(v => (Number.isNaN(v) ? -1 : v)));
    expect(r.analysis.notes).toEqual(notes);
    expect(decodeAnalysis(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});
