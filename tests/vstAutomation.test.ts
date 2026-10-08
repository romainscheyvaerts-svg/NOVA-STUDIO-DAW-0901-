import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AutomationPoint, Track } from '../types';
import { laneEvents, vstAutomationFor, vstAutomationSig, VST_AUTO_BLOCK } from '../utils/vstAutomation';
import { AutomationRecorder, AutomationCommit } from '../services/AutomationManager';
import { automationParamLabel, automationRangeText, automationValueText } from '../utils/automationLabels';
import { vstParamCatalog, vstParamTexts } from '../utils/vstParamCatalog';
import { isFreezeStale } from '../utils/freeze';
import { valueAtPoints } from '../utils/automationWrite';

/**
 * R9 · Automation des VST par le pont.
 *  - Les changements envoyés au pont à l'export (laneEvents) sont ceux que le
 *    worklet de lecture envoie pour la même voie (même règle : valeur au début de
 *    chaque bloc si elle bouge, sauts à l'échantillon près).
 *  - Écriture Touch depuis la fenêtre d'un VST (capturePluginParams).
 *  - Noms et valeurs affichés par le plugin dans les voies ; rendu gelé périmé
 *    quand l'automation d'un VST rendu change.
 */

const SR = 48000;
const pts = (list: [number, number, AutomationPoint['curveType']?][]): AutomationPoint[] =>
  list.map(([time, value, curveType], i) => ({ id: `p${i}`, time, value, ...(curveType ? { curveType } : {}) }));

/** Le vrai worklet du pont (public/worklets/vst-bridge-processor-v5.js), sans Web Audio. */
function loadWorklet() {
  const src = fs.readFileSync(path.resolve(__dirname, '../public/worklets/vst-bridge-processor-v5.js'), 'utf8');
  let Cls: any = null;
  class AudioWorkletProcessor { port: any = { postMessage: () => { /* */ }, onmessage: null }; }
  const register = (_n: string, c: any) => { Cls = c; };
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', src)(AudioWorkletProcessor, register);
  return Cls;
}

/**
 * Lecture simulée : l'AudioParam p0 suit la voie échantillon par échantillon
 * (comme le moteur la programme), le worklet produit ses changements par bloc.
 */
function playbackEvents(points: AutomationPoint[], startTime: number, frames: number) {
  const Cls = loadWorklet();
  const sent: { frame: number; value: number }[] = [];
  const proc = new Cls({ processorOptions: { prebufferFrames: 2048 } });
  const bridge = { postMessage: (m: any) => { const p = m.params; if (p) for (let i = 0; i < p.length; i += 3) sent.push({ frame: m.seq * VST_AUTO_BLOCK + p[i + 1], value: p[i + 2] }); } };
  proc.port.onmessage({ data: { type: 'port', port: { ...bridge, set onmessage(_f: any) { /* */ } } } });
  proc.port.onmessage({ data: { type: 'active', on: true } });
  proc.port.onmessage({ data: { type: 'arm', index: 0, on: true } });
  const sorted = [...points].sort((a, b) => a.time - b.time);
  for (let b = 0; b * VST_AUTO_BLOCK < frames; b++) {
    const arr = new Float32Array(VST_AUTO_BLOCK);
    for (let s = 0; s < VST_AUTO_BLOCK; s++) arr[s] = valueAtPoints(sorted, startTime + (b * VST_AUTO_BLOCK + s) / SR, 0);
    const params: Record<string, Float32Array> = {};
    for (let i = 0; i < 32; i++) params[`p${i}`] = i === 0 ? arr : new Float32Array([-1]);
    const inp = [new Float32Array(VST_AUTO_BLOCK).fill(0.1), new Float32Array(VST_AUTO_BLOCK).fill(0.1)];
    proc.process([inp, []], [[new Float32Array(VST_AUTO_BLOCK), new Float32Array(VST_AUTO_BLOCK)]], params);
  }
  return sent;
}

describe('R9 · changements envoyés au pont', () => {
  it('palier à 2 s : appliqué à l’échantillon exact, une seule fois', () => {
    const ev = laneEvents(pts([[0, 0.7, 'HOLD'], [2, 0.3]]), 0, SR, 3 * SR);
    expect(ev.frames).toEqual([0, 2 * SR]);
    expect(ev.values[0]).toBeCloseTo(0.7);
    expect(ev.values[1]).toBeCloseTo(0.3);
  });

  it('rendu qui commence plus loin dans le morceau (aperçu) : images relatives au rendu', () => {
    const ev = laneEvents(pts([[0, 0.7, 'HOLD'], [2, 0.3]]), 1.5, SR, SR);
    expect(ev.frames).toEqual([0, Math.round(0.5 * SR)]);
  });

  it('rampe : une valeur tous les 2 blocs au plus, débit borné', () => {
    const ev = laneEvents(pts([[0, 0], [1, 1]]), 0, SR, 2 * SR);
    expect(ev.frames.every(f => f % VST_AUTO_BLOCK === 0)).toBe(true);
    expect(ev.frames.length).toBeLessThanOrEqual(Math.ceil(SR / VST_AUTO_BLOCK) + 2);
    // Valeur juste : au début de chaque bloc.
    const k = ev.frames.indexOf(128 * 100);
    expect(ev.values[k]).toBeCloseTo(128 * 100 / SR, 4);
    // Plus rien après la fin de la rampe.
    expect(Math.max(...ev.frames)).toBeLessThanOrEqual(SR + VST_AUTO_BLOCK);
  });

  it('export = lecture : mêmes changements que le worklet pour la même voie', () => {
    const lane = pts([[0, 0.5], [0.4, 0.9, 'HOLD'], [1.0013, 0.2], [1.6, 0.6, 'S_CURVE'], [2.2, 0.1]]);
    const frames = Math.round(2.5 * SR);
    const exp = laneEvents(lane, 0, SR, frames);
    const live = playbackEvents(lane, 0, frames);
    expect(live.length).toBe(exp.frames.length);
    live.forEach((e, i) => {
      expect(e.frame).toBe(exp.frames[i]);
      expect(e.value).toBeCloseTo(exp.values[i], 5);
    });
  });

  it('20 réglages automatisés : charge vers le pont mesurée (changements par seconde)', () => {
    const lanes = Array.from({ length: 20 }, (_, i) => pts([[0, 0], [4, 1], [4 + i * 0.1, 0.2, 'HOLD'], [8, 0.9]]));
    const per = lanes.map(l => laneEvents(l, 0, SR, 8 * SR).frames.length);
    const total = per.reduce((a, b) => a + b, 0);
    // 20 rampes simultanées : au plus 1 valeur tous les 2 blocs et par réglage (188/s à 48 kHz) + les paliers,
    // 8 octets chacune : ≈ 29 Ko/s vers le pont au pire (l'audio stéréo du même bloc : 375 Ko/s).
    expect(total).toBeLessThanOrEqual(20 * (8 * SR / VST_AUTO_BLOCK / 2 + 4));
    expect((total * 8) / 8 / 1024).toBeLessThan(64);
  });

  it('voies d’un VST de la piste seulement, mode Off ignoré', () => {
    const track = {
      automationMode: 'read', automationLanes: [
        { id: 'a', parameterName: 'plugin::vst1::threshold', points: pts([[0, 0.7]]), color: '', isExpanded: false, min: 0, max: 1 },
        { id: 'b', parameterName: 'plugin::other::threshold', points: pts([[0, 0.2]]), color: '', isExpanded: false, min: 0, max: 1 },
        { id: 'c', parameterName: 'volume', points: pts([[0, 1]]), color: '', isExpanded: false, min: 0, max: 1.5 },
      ],
    } as unknown as Track;
    expect(vstAutomationFor(track, 'vst1', 0, SR, SR).map(l => l.name)).toEqual(['threshold']);
    expect(vstAutomationFor({ ...track, automationMode: 'off' } as Track, 'vst1', 0, SR, SR)).toEqual([]);
  });
});

function vstTrack(mode: Track['automationMode'], lanes: Track['automationLanes'] = []): Track {
  return {
    id: 'b808', name: '808', type: 'AUDIO' as any, color: '#0ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], totalLatency: 0, automationMode: mode, automationLanes: lanes,
    plugins: [{ id: 'proc', type: 'VST3', name: 'Pro-C 3', isEnabled: true, latency: 0, params: { name: 'Pro-C 3', localPath: 'C:/x.vst3', stateB64: 'AAA' } } as any],
  };
}

describe('R9 · écriture depuis la fenêtre du VST', () => {
  it('Touch : le réglage bougé dans le plugin est écrit dans une voie 0–1, référence = valeur d’avant', () => {
    let tracks: Track[] = [vstTrack('touch')];
    const env = { time: 1, wall: 0, commits: [] as AutomationCommit[] };
    const rec = new AutomationRecorder();
    rec.configure({
      getTracks: () => tracks, getTime: () => env.time, isPlaying: () => true,
      setOverride: () => { /* */ }, beginUndoStep: () => { /* */ },
      commit: (c) => { env.commits.push(c); tracks = tracks.map(t => ({ ...t, automationLanes: [...t.automationLanes.filter(l => l.parameterName !== c.param), { id: 'n', parameterName: c.param, points: c.points, color: '', isExpanded: false, min: c.spec.min, max: c.spec.max }] })); },
      setTrackMode: () => { /* */ }, wallClock: () => env.wall,
    });
    rec.onPlay();
    expect(rec.canWrite('b808')).toBe(true);
    // Le pont signale 0.73 → 0.5 sur « threshold » (valeur brute du plugin).
    expect(rec.capturePluginParams('b808', 'proc', { threshold: 0.5 }, { threshold: 0.73 })).toBe(true);
    for (let i = 0; i < 60; i++) { env.time += 1 / 60; env.wall += 1000 / 60; rec.tick(); }
    rec.onStop(env.time);
    const c = env.commits.find(x => x.param === 'plugin::proc::threshold')!;
    expect(c).toBeTruthy();
    expect(c.spec.min).toBe(0);
    expect(c.spec.max).toBe(1);
    expect(valueAtPoints(c.points, 0.5, 0)).toBeCloseTo(0.73, 3);   // avant le geste : la valeur d'avant
    expect(valueAtPoints(c.points, 1.05, 0)).toBeCloseTo(0.5, 3);   // pendant : la valeur écrite
  });

  it('pas d’écriture en Read ni à l’arrêt', () => {
    const rec = new AutomationRecorder();
    let playing = false;
    const tracks = [vstTrack('read')];
    rec.configure({ getTracks: () => tracks, getTime: () => 0, isPlaying: () => playing, setOverride: () => { /* */ }, beginUndoStep: () => { /* */ }, commit: () => { /* */ }, setTrackMode: () => { /* */ } });
    expect(rec.capturePluginParams('b808', 'proc', { threshold: 0.5 })).toBe(false);
    playing = true;
    expect(rec.canWrite('b808')).toBe(false);
  });
});

describe('R9 · voies d’un VST en vraies unités', () => {
  it('nom et valeur affichés par le plugin', () => {
    vstParamCatalog.set('proc', [{ name: 'threshold', displayName: 'Threshold', value: 0.73, text: '-16.00 dB' }]);
    vstParamTexts.set('proc::threshold', Array.from({ length: 101 }, (_, i) => `${(-60 + i * 0.6).toFixed(2)} dB`));
    const tr = [vstTrack('read')];
    expect(automationParamLabel('plugin::proc::threshold', tr)).toBe('Pro-C 3 · Threshold');
    expect(automationParamLabel('plugin::proc::threshold')).toBe('Threshold');
    expect(automationValueText('plugin::proc::threshold', 0.5)).toBe('-30.00 dB');
    expect(automationRangeText('plugin::proc::threshold', 0, 1)).toBe('-60.00 dB à 0.00 dB');
  });
});

describe('R9 · rendu gelé et automation des VST', () => {
  it('changer la voie d’un VST rendu périme le rendu', () => {
    const lane = { id: 'a', parameterName: 'plugin::proc::threshold', points: pts([[0, 0.7, 'HOLD'], [2, 0.3]]), color: '', isExpanded: false, min: 0, max: 1 };
    const t = { ...vstTrack('read', [lane]), frozenClip: { id: 'f' } as any, frozenUpToPluginIndex: 0 } as Track;
    t.frozenPluginSig = undefined;
    t.frozenVstAutoSig = vstAutomationSig(t, 0);
    t.frozenSourceSig = undefined;
    expect(isFreezeStale(t)).toBe(false);
    const moved = { ...t, automationLanes: [{ ...lane, points: pts([[0, 0.7, 'HOLD'], [2.5, 0.3]]) }] };
    expect(isFreezeStale(moved)).toBe(true);
    // Rendu d'avant R9 (sans empreinte) avec de l'automation de VST : à refaire.
    expect(isFreezeStale({ ...t, frozenVstAutoSig: undefined })).toBe(true);
    // Sans automation de VST : rien ne change.
    expect(vstAutomationSig(vstTrack('read'))).toBe('');
  });
});
