import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { keyRoutes, pdcKeysFor, latencyBefore, setPluginKeySource, supportsSidechain, sidechainLoop } from '../engine/sidechain';
import type { PluginInstance, Track } from '../types';
import { TrackType } from '../types';

/**
 * R10 · Side-chain des VST : la barre « Clé » et le routage de R7 s'appliquent aux
 * VST3 (source piste ou bus, avant / après fader, boucles refusées, clé recalée par
 * la PDC sur la latence des effets placés avant le VST) ; le worklet du pont envoie
 * la clé en 4 canaux.
 */

const vst = (id: string, extra: Partial<PluginInstance> = {}): PluginInstance => ({
  id, name: 'Pro-C 3', type: 'VST3', isEnabled: true, latency: 0, params: { name: 'Pro-C 3', localPath: 'C:/x.vst3' }, ...extra,
});
const tr = (id: string, name: string, extra: Partial<Track> = {}): Track => ({
  id, name, type: TrackType.AUDIO, color: '#0ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...extra,
} as Track);
const master = () => tr('master', 'Master', { type: TrackType.BUS, outputTrackId: '' });

describe('R10 · clé des VST', () => {
  it('un VST3 accepte une clé, comme le Compresseur', () => {
    expect(supportsSidechain('VST3')).toBe(true);
    const tracks = [tr('kick', 'Kick'), tr('808', '808', { plugins: [vst('proc')] }), master()];
    const r = setPluginKeySource(tracks, '808', 'proc', 'kick', 'pre');
    expect('tracks' in r).toBe(true);
    const routes = keyRoutes((r as { tracks: Track[] }).tracks);
    expect(routes).toEqual([{ targetTrackId: '808', pluginId: 'proc', sources: ['kick'], tap: 'pre', hpf: 20, lpf: 20000 }]);
  });

  it('boucle refusée : la 808 ne peut pas être la clé de son propre VST', () => {
    const tracks = [tr('808', '808', { plugins: [vst('proc')] }), master()];
    expect(sidechainLoop(tracks, '808', '808', 'proc')).not.toBeNull();
  });

  it('VST en bypass ou inactif : pas de clé câblée', () => {
    const tracks = [tr('kick', 'Kick'), tr('808', '808', { plugins: [vst('proc', { sidechainSourceId: 'kick', isEnabled: false })] }), master()];
    expect(keyRoutes(tracks)).toEqual([]);
  });

  it('PDC : la clé est recalée sur la latence des effets placés AVANT le VST', () => {
    const tracks = [tr('kick', 'Kick'), tr('808', '808', { plugins: [vst('lim'), vst('proc', { sidechainSourceId: 'kick' })] }), master()];
    const routes = keyRoutes(tracks);
    const lat: Record<string, number> = { lim: 0.005, proc: 2048 / 48000 };
    const keys = pdcKeysFor(routes, 'kick', (_t, pid) => latencyBefore(['lim', 'proc'], pid, id => lat[id]));
    expect(keys).toEqual([{ id: 'proc', target: '808', offset: 0.005 }]);
  });

  it('worklet du pont : 2e entrée = clé, envoyée en 4 canaux seulement quand elle est active', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../public/worklets/vst-bridge-processor-v5.js'), 'utf8');
    let Cls: any = null;
    class AudioWorkletProcessor { port: any = { postMessage: () => { /* */ }, onmessage: null }; }
    // eslint-disable-next-line no-new-func
    new Function('AudioWorkletProcessor', 'registerProcessor', src)(AudioWorkletProcessor, (_n: string, c: any) => { Cls = c; });
    const sent: any[] = [];
    const p = new Cls({ processorOptions: { prebufferFrames: 2048 } });
    p.port.onmessage({ data: { type: 'port', port: { postMessage: (m: any) => sent.push(m), set onmessage(_f: any) { /* */ } } } });
    p.port.onmessage({ data: { type: 'active', on: true } });
    const main = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.25)];
    const key = [new Float32Array(128).fill(0.75), new Float32Array(128).fill(0.75)];
    const outs = [[new Float32Array(128), new Float32Array(128)]];
    const params: Record<string, Float32Array> = {};
    for (let i = 0; i < 32; i++) params[`p${i}`] = new Float32Array([-1]);
    p.process([main, key], outs, params);
    expect(sent[0].nch).toBe(2);
    p.port.onmessage({ data: { type: 'sidechain', on: true } });
    p.process([main, key], outs, params);
    expect(sent[1].nch).toBe(4);
    expect(Array.from(sent[1].data.slice(0, 4))).toEqual([0.25, 0.25, 0.75, 0.75]);
  });
});
