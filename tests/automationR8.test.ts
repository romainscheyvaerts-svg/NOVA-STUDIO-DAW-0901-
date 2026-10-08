import { describe, expect, it } from 'vitest';
import { MappedParam, AutomationSet, legacyAutomatable, LEGACY_AUTOMATABLE, mixWet, mixDry, mixFromWet, paramsWithoutAutomated, hasPluginLane, parseEqKey, pluginParamStaticValue } from '../engine/automationParams';
import { automationParamLabel, automationValueText, automationRangeText } from '../utils/automationLabels';
import { muteGainPoints, isMutedAt, MUTE_PARAM } from '../utils/muteAutomation';
import { copyAutomationRange, pasteAutomationRange, clearAutomationRange, moveAutomationWithClips, sliceLane, replaceRange } from '../utils/automationEdit';
import { valueAtPoints } from '../utils/automationWrite';
import type { AutomationPoint, Track } from '../types';

/** AudioParam factice : journal des événements programmés + valeur relue (dernière posée). */
class FakeParam {
  value = 0;
  events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) { this.events.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(['ramp', v, t]); this.value = v; return this; }
  setTargetAtTime(v: number, t: number) { this.events.push(['target', v, t]); this.value = v; return this; }
  cancelScheduledValues(t: number) { this.events.push(['cancel', 0, t]); return this; }
}
const ctx = { currentTime: 1 } as any as BaseAudioContext;
const fp = () => new FakeParam() as any as AudioParam & FakeParam;

describe('R8 · MappedParam : réglage d’effet programmé comme un AudioParam', () => {
  it('loi affine : les rampes passent telles quelles, sur chaque cible', () => {
    const wet = fp(), dry = fp();
    const mp = new MappedParam(ctx, [{ param: wet }, { param: dry, map: v => 1 - v }], { min: 0, max: 1, value: 1, affine: true });
    expect(wet.value).toBe(1); expect(dry.value).toBe(0);
    wet.events.length = 0; dry.events.length = 0;
    mp.setValueAtTime(0.2, 2).linearRampToValueAtTime(0.8, 4);
    expect(wet.events).toEqual([['set', 0.2, 2], ['ramp', 0.8, 4]]);
    expect(dry.events[1][1]).toBeCloseTo(0.2, 9);
  });
  it('loi non affine (mix puissance constante) : la rampe devient des marches ≤ 5 ms, exactes aux bouts', () => {
    const wet = fp(), dry = fp();
    const mp = new MappedParam(ctx, [{ param: wet, map: mixWet }, { param: dry, map: mixDry }], { min: 0, max: 1, value: 0, inverse: mixFromWet });
    wet.events.length = 0;
    mp.setValueAtTime(0, 10).linearRampToValueAtTime(1, 11);
    const ramps = wet.events.filter(e => e[0] === 'ramp');
    expect(ramps.length).toBe(200);
    expect(ramps[ramps.length - 1]).toEqual(['ramp', 1, 11]);
    // Milieu de la rampe : mix 0,5 → effet = sin(π/4).
    expect(ramps[99][1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(ramps[99][2]).toBeCloseTo(10.5, 9);
    expect(mp.value).toBeCloseTo(1, 9);
  });
  it('réglage fixe posé seulement s’il change (une voie garde la main), forcé sinon', () => {
    const p = fp();
    const mp = new MappedParam(ctx, [{ param: p }], { min: -60, max: 0, value: -18, affine: true });
    p.events.length = 0;
    mp.setStatic(-18);
    expect(p.events.length).toBe(0);
    mp.setStatic(-24);
    expect(p.events).toEqual([['target', -24, 1]]);
    mp.setStatic(-24, { force: true });
    expect(p.events.length).toBe(2);
    mp.setValueAtTime(-40, 2);            // automation
    mp.restoreStatic();                   // arrêt, voie effacée
    expect(p.value).toBe(-24);
  });
  it('bornes : une valeur hors course est ramenée dans la course', () => {
    const p = fp();
    const mp = new MappedParam(ctx, [{ param: p }], { min: 1, max: 20, value: 4, affine: true });
    mp.setValueAtTime(50, 2);
    expect(p.value).toBe(20);
  });
  it('AutomationSet.setFrom n’applique que les clés présentes', () => {
    const a = fp(), b = fp();
    const set = new AutomationSet();
    set.add('threshold', new MappedParam(ctx, [{ param: a }], { min: -60, max: 0, value: -18, affine: true }));
    set.add('ratio', new MappedParam(ctx, [{ param: b }], { min: 1, max: 20, value: 4, affine: true }));
    a.events.length = 0; b.events.length = 0;
    set.setFrom({ ratio: 8 });
    expect(a.events.length).toBe(0);
    expect(b.value).toBe(8);
  });
});

describe('R8 · catalogue des réglages automatisables (« + voie »)', () => {
  it('chaque effet historique expose des réglages nommés en français', () => {
    for (const t of ['COMPRESSOR', 'PROEQ12', 'REVERB', 'DELAY', 'DEESSER', 'VOCALSATURATOR', 'DOUBLER', 'AUTOTUNE']) {
      const list = legacyAutomatable(t);
      expect(list.length, t).toBeGreaterThan(0);
      for (const a of list) {
        expect(a.max, `${t}.${a.id}`).toBeGreaterThan(a.min);
        expect(a.label).toMatch(/[a-zé]/);
      }
    }
    expect(legacyAutomatable('PROEQ12').filter(a => /Freq$/.test(a.id)).length).toBe(12);
  });
  it('libellés des voies : « Compresseur · Seuil », « EQ · Bande 3 : fréquence », « Muet »', () => {
    const tracks = [{ id: 't', plugins: [
      { id: 'c1', type: 'COMPRESSOR', name: 'Compresseur', isEnabled: true, params: {} },
      { id: 'e1', type: 'PROEQ12', name: 'Pro EQ', isEnabled: true, params: {} },
      { id: 'r1', type: 'REVERB', name: 'Reverb', isEnabled: true, params: {} },
    ] }] as any;
    expect(automationParamLabel('plugin::c1::threshold', tracks)).toMatch(/· Seuil$/);
    expect(automationParamLabel('plugin::e1::b3Freq', tracks)).toMatch(/· Bande 3 : fréquence$/);
    expect(automationParamLabel('plugin::r1::mix', tracks)).toMatch(/· Mix$/);
    expect(automationParamLabel(MUTE_PARAM)).toBe('Muet');
    expect(automationValueText(MUTE_PARAM, 1)).toBe('Muet');
    expect(automationValueText(MUTE_PARAM, 0)).toBe('Son');
    expect(automationRangeText(MUTE_PARAM, 0, 1)).toBe('Son / Muet');
  });
  it('EQ : clés à plat (b3Freq) et valeur fixe lue dans la bande', () => {
    expect(parseEqKey('b3Freq')).toEqual({ band: 2, field: 'frequency' });
    expect(parseEqKey('b12Q')).toEqual({ band: 11, field: 'q' });
    expect(parseEqKey('b13Gain')).toBeNull();
    expect(pluginParamStaticValue({ bands: [{}, {}, { frequency: 300 }] }, 'b3Freq')).toBe(300);
    expect(pluginParamStaticValue({ threshold: -20 }, 'threshold')).toBe(-20);
    expect(Object.keys(LEGACY_AUTOMATABLE)).toContain('AUTOTUNE');
  });
  it('moteur : les réglages tenus par une voie ne sont pas reposés pendant la lecture', () => {
    const lanes = [{ parameterName: 'plugin::c1::threshold', points: [{}] }, { parameterName: 'plugin::c2::ratio', points: [{}] }, { parameterName: 'plugin::c1::ratio', points: [] }];
    const p = { threshold: -18, ratio: 4, mix: 1 };
    expect(paramsWithoutAutomated(p, lanes, 'c1', true)).toEqual({ ratio: 4, mix: 1 });
    expect(paramsWithoutAutomated(p, lanes, 'c1', false)).toBe(p);
    expect(paramsWithoutAutomated(p, lanes, 'c3', true)).toBe(p);
    expect(hasPluginLane(lanes, 'c1')).toBe(true);
    expect(hasPluginLane(lanes, 'c3')).toBe(false);
  });
});

describe('R8 · automation du mute', () => {
  it('voie « Muet » (1 = muet) → gain 0 / 1 en paliers, triés', () => {
    const pts: AutomationPoint[] = [{ id: 'b', time: 2, value: 1 }, { id: 'a', time: 0, value: 0 }, { id: 'c', time: 3, value: 0.2 }];
    const g = muteGainPoints(pts);
    expect(g.map(p => [p.time, p.value, p.curveType])).toEqual([[0, 1, 'HOLD'], [2, 0, 'HOLD'], [3, 1, 'HOLD']]);
    expect(muteGainPoints(pts)).toBe(g); // mémorisé
    // Paliers : 1 jusqu'à 2 s, 0 de 2 à 3 s.
    expect(valueAtPoints(g, 1.999, 1)).toBe(1);
    expect(valueAtPoints(g, 2.5, 1)).toBe(0);
  });
  it('isMutedAt suit la voie (mode Off : jamais muet)', () => {
    const t = { automationLanes: [{ id: 'l', parameterName: 'mute', points: [{ id: 'a', time: 0, value: 0 }, { id: 'b', time: 4, value: 1 }], color: '', isExpanded: true, min: 0, max: 1 }] } as any as Track;
    expect(isMutedAt(t, 3)).toBe(false);
    expect(isMutedAt(t, 5)).toBe(true);
    expect(isMutedAt({ ...t, automationMode: 'off' } as Track, 5)).toBe(false);
  });
});

const lane = (name: string, pts: [number, number][], extra: Partial<AutomationPoint> = {}) => ({
  id: `l-${name}`, parameterName: name, color: '#fff', isExpanded: true, min: 0, max: 1.5,
  points: pts.map(([time, value], i) => ({ id: `${name}${i}`, time, value, ...extra })),
});
const trk = (id: string, lanes: any[], plugins: any[] = []) => ({ id, color: '#0ff', automationLanes: lanes, plugins }) as any as Track;
const at = (t: Track, name: string, time: number) => { const l = t.automationLanes.find(x => x.parameterName === name)!; return valueAtPoints([...l.points].sort((a, b) => a.time - b.time), time, NaN); };

describe('R8 · copier / coller l’automation d’une plage', () => {
  it('le morceau copié garde la courbe exacte, ancrée aux bords (rampe coupée en deux)', () => {
    const pts = lane('volume', [[0, 0], [4, 1]]).points;
    const piece = sliceLane(pts, 1, 3);
    expect(piece[0].time).toBe(0);
    expect(piece[0].value).toBeCloseTo(0.25, 9);
    expect(piece[piece.length - 1].time).toBe(2);
    expect(piece[piece.length - 1].value).toBeCloseTo(0.75, 9);
  });
  it('coller remplace la plage, la courbe d’origine ne bouge pas autour', () => {
    const src = trk('a', [lane('volume', [[0, 1], [1, 0.2], [2, 1]])]);
    const dst = trk('b', [lane('volume', [[0, 0.5], [10, 0.5]])]);
    const clip = copyAutomationRange(src, 0.5, 1.5)!;
    expect(clip.lanes.length).toBe(1);
    const r = pasteAutomationRange(dst, clip, 5);
    expect(r.pasted).toBe(1);
    expect(at(r.track, 'volume', 4)).toBeCloseTo(0.5, 6);
    expect(at(r.track, 'volume', 5)).toBeCloseTo(0.6, 6);    // valeur copiée à 0,5 s
    expect(at(r.track, 'volume', 5.5)).toBeCloseTo(0.2, 6);  // creux copié à 1 s
    expect(at(r.track, 'volume', 6)).toBeCloseTo(0.6, 6);
    expect(at(r.track, 'volume', 7)).toBeCloseTo(0.5, 6);
    // Avant le premier point d'origine : inchangé aussi.
    const empty = trk('c', [lane('volume', [[8, 0.9]])]);
    const r2 = pasteAutomationRange(empty, clip, 2);
    expect(at(r2.track, 'volume', 1)).toBeCloseTo(0.9, 6);
    expect(at(r2.track, 'volume', 9)).toBeCloseTo(0.9, 6);
  });
  it('crée la voie absente ; un réglage d’effet va sur l’effet du même type d’une autre piste, sinon il est ignoré', () => {
    const src = trk('a', [lane('plugin::c1::threshold', [[0, -10], [2, -30]]), lane('pan', [[0, -1], [2, 1]])], [{ id: 'c1', type: 'COMPRESSOR' }]);
    const clip = copyAutomationRange(src, 0, 2)!;
    const withComp = trk('b', [], [{ id: 'c9', type: 'COMPRESSOR' }]);
    const r = pasteAutomationRange(withComp, clip, 0);
    expect(r.track.automationLanes.map(l => l.parameterName).sort()).toEqual(['pan', 'plugin::c9::threshold']);
    const noComp = trk('c', [], []);
    const r2 = pasteAutomationRange(noComp, clip, 0);
    expect(r2.skipped).toEqual(['plugin::c1::threshold']);
    expect(r2.track.automationLanes.map(l => l.parameterName)).toEqual(['pan']);
  });
  it('effacer une plage : ligne droite entre les valeurs aux bords', () => {
    const t = trk('a', [lane('volume', [[0, 1], [1, 0], [2, 1], [4, 1]])]);
    const r = clearAutomationRange(t, 0.5, 1.5);
    expect(at(r, 'volume', 0.5)).toBeCloseTo(0.5, 6);
    expect(at(r, 'volume', 1)).toBeCloseTo(0.5, 6);
    expect(at(r, 'volume', 3)).toBeCloseTo(1, 6);
  });
  it('replaceRange sur une voie vide : le morceau seul', () => {
    const r = replaceRange([], [{ id: 'x', time: 0, value: 0.3 }, { id: 'y', time: 1, value: 0.7 }], 2, 1);
    expect(r.map(p => [p.time, p.value])).toEqual([[2, 0.3], [3, 0.7]]);
  });
});

describe('R8 · l’automation suit les clips déplacés (Automation Follows Edit)', () => {
  it('dans le temps : le creux de volume du clip part avec lui ; l’ancienne place se referme', () => {
    const t = trk('v', [lane('volume', [[0, 1], [2, 1], [2.5, 0.3], [3, 1], [10, 1]])]);
    const [r] = moveAutomationWithClips([t], [{ clipId: 'c', fromTrackId: 'v', toTrackId: 'v', fromStart: 2, duration: 1, toStart: 6 }]);
    expect(at(r, 'volume', 2.5)).toBeCloseTo(1, 6);
    expect(at(r, 'volume', 6.5)).toBeCloseTo(0.3, 6);
    expect(at(r, 'volume', 5)).toBeCloseTo(1, 6);
    expect(at(r, 'volume', 8)).toBeCloseTo(1, 6);
  });
  it('vers une autre piste : la courbe va sur la piste d’arrivée', () => {
    const a = trk('a', [lane('mute', [[0, 0], [1, 1], [1.5, 0]], { curveType: 'HOLD' })]);
    const b = trk('b', []);
    const [ra, rb] = moveAutomationWithClips([a, b], [{ clipId: 'c', fromTrackId: 'a', toTrackId: 'b', fromStart: 0.5, duration: 1.5, toStart: 0.5 }]);
    expect(isMutedAt(rb, 1.2)).toBe(true);
    expect(rb.automationLanes[0].parameterName).toBe('mute');
    expect(isMutedAt(ra, 1.2)).toBe(false);
  });
  it('déplacement nul ou clip sans durée : rien ne change (même tableau)', () => {
    const tracks = [trk('a', [lane('volume', [[0, 1]])])];
    expect(moveAutomationWithClips(tracks, [{ clipId: 'c', fromTrackId: 'a', toTrackId: 'a', fromStart: 1, duration: 1, toStart: 1 }])).toBe(tracks);
  });
});
