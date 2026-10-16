// @vitest-environment jsdom
/**
 * Instruments restés « formulaire » jusqu'en 1.5.1 : Sampler, Drum sampler, Drum Rack,
 * et l'écran du Sampler mélodique (curseurs → boutons rotatifs ; tests/fixtures/pluginsFinGolden3.json).
 * tests/fixtures/pluginsFinGolden2.json a été capturé sur les ANCIENS éditeurs (commit
 * 0630b91f, anciens potards pilotés à la souris, curseurs du Drum Rack) : on rejoue les
 * mêmes gestes sur les nouvelles façades (boutons du kit plugins/hw, Début / Fin = butées)
 * et on exige exactement les mêmes envois au moteur et à la piste.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import golden from './fixtures/pluginsFinGolden2.json';

const fake: any = { calls: [] as any[] };
vi.mock('../engine/AudioEngine', () => ({
  audioEngine: {
    tracksDSP: { get: () => ({ sampler: { setADSR: (a: any) => fake.calls.push({ setADSR: JSON.parse(JSON.stringify(a)) }), getBuffer: () => null } }) },
    getDrumSamplerNode: () => fake.drum,
    triggerTrackAttack: (...a: any[]) => fake.calls.push({ trigger: a }),
    init: async () => {}, loadSamplerBuffer: () => {}, loadDrumRackSample: () => {},
    getMelodicSamplerNode: () => ({ hasSound: () => true }), onSamplerReady: () => () => {}, triggerTrackRelease: () => {}, ctx: null,
  },
}));
vi.mock('../components/WaveformRenderer', () => ({ default: () => null }));
const fakeBuf = { getChannelData: () => new Float32Array(2000).map((_, i) => Math.sin(i / 10)), numberOfChannels: 1, sampleRate: 48000, length: 2000, duration: 2000 / 48000 };
vi.mock('../utils/audioBufferRegistry', () => ({ audioBufferRegistry: { get: () => fakeBuf } }));
import SamplerEditor from '../components/SamplerEditor';
import DrumSamplerEditor from '../components/DrumSamplerEditor';
import DrumRack from '../components/DrumRack';
import SamplerPanel from '../components/SamplerPanel';
import { DEFAULT_SAMPLER } from '../utils/melodicSampler';
import golden3 from './fixtures/pluginsFinGolden3.json';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const clone = (x: any) => JSON.parse(JSON.stringify(x ?? null));
const hosts: (() => void)[] = [];
afterEach(() => { while (hosts.length) hosts.pop()!(); });
function mount(el: React.ReactElement) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host); act(() => root.render(el));
  hosts.push(() => { act(() => root.unmount()); host.remove(); });
  return host;
}
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const click = (el: Element | null | undefined) => { expect(el, 'élément introuvable').toBeTruthy(); act(() => { (el as HTMLElement).click(); }); };
const knob = (host: Element, id: string) => host.querySelector(`[data-nova-param='${id}'] [role=slider]`)!;
const G = golden as any;
HTMLCanvasElement.prototype.getContext = function () { return new Proxy({}, { get: () => () => {}, set: () => true }) as any; } as any;

describe('Sampler : mêmes envois qu\'avant', () => {
  it('ouverture + 8 butées de l\'enveloppe', () => {
    fake.calls = [];
    const host = mount(h(SamplerEditor, { plugin: { id: 'p', type: 'SAMPLER', params: {} } as any, trackId: 't', onClose: () => {} }));
    expect(fake.calls).toEqual(G.SAMPLER[0].log);
    for (const g of G.SAMPLER.slice(1)) {
      fake.calls = [];
      const [id, what] = g.action.split(':');
      key(knob(host, id), what === 'max' ? 'End' : 'Home');
      expect(fake.calls, g.action).toEqual(g.log);
    }
    expect(host.querySelector("[data-nova-plugin='SAMPLER'] h2")?.textContent).toBe('Sampler');
    expect(host.querySelectorAll('input[type=range]').length).toBe(0);
    expect(host.textContent).not.toMatch(/Drop Audio|Drag & Drop/);
  });
});

describe('Drum sampler : mêmes envois qu\'avant', () => {
  it('24 butées, poussoirs, groupe d\'étouffement, écoute', () => {
    let params: any = { gain: 0, transpose: 0, fineTune: 0, sampleStart: 0, sampleEnd: 1, attack: 0.005, hold: 0.05, decay: 0.2, sustain: 0, release: 0.1, cutoff: 20000, resonance: 0, pan: 0, velocitySens: 0.8, reverse: false, normalize: false, chokeGroup: 1, isEnabled: true };
    fake.drum = { getParams: () => ({ ...params }), getBuffer: () => null, updateParams: (p: any) => { fake.calls.push({ update: clone(p) }); params = { ...params, ...p }; }, trigger: (...a: any[]) => fake.calls.push({ trigger: a }) };
    const host = mount(h(DrumSamplerEditor, { plugin: { id: 'p', type: 'DRUM_SAMPLER', params: {} } as any, trackId: 't', onClose: () => {} }));
    const BTN: Record<string, string> = { Rev: "[data-nova-param='reverse'] [role=checkbox]", Norm: "[data-nova-param='normalize'] [role=checkbox]" };
    let identiques = 0;
    for (const g of G.DRUM_SAMPLER) {
      fake.calls = [];
      const [kind, arg] = g.action.split(':');
      if (kind === 'bouton') {
        if (BTN[arg]) click(host.querySelector(BTN[arg]));
        else click([...host.querySelectorAll("[data-nova-param='chokeGroup'] [role=radio]")].find(b => b.textContent?.trim() === arg));
      } else if (kind === 'ecouter') click(host.querySelector('[data-nova-drum-preview]'));
      else key(knob(host, kind), arg === 'max' ? 'End' : 'Home');
      if (!fake.calls.length && g.log.length === 1 && g.log[0].update) {
        // Rien d'envoyé : bouton déjà en butée (l'ancien éditeur renvoyait la même valeur).
        const [k, v] = Object.entries(g.log[0].update)[0];
        expect(params[k], g.action).toBe(v);
        continue;
      }
      expect(fake.calls, g.action).toEqual(g.log);
      identiques++;
    }
    expect(identiques).toBeGreaterThanOrEqual(27);
    expect(host.querySelectorAll('input[type=range]').length).toBe(0);
  });
});

describe('Drum Rack : mêmes envois qu\'avant', () => {
  it('pad, volume, pan, muet, solo', () => {
    const pads = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Pad ${i + 1}`, sampleName: i === 0 ? 'Kick' : 'Empty', volume: 0.8, pan: 0, isMuted: false, isSolo: false, midiNote: 60 + i }));
    const track: any = { id: 'dr', type: 'DRUM_RACK', drumPads: pads };
    const updates: any[] = [];
    // Piste figée (comme lors de la capture) : chaque geste part de l'état initial du pad.
    const host = mount(h(DrumRack, { track, onUpdateTrack: (t: any) => { updates.push(t); } }));
    const [g0, ...rest] = G.DRUM_RACK_UI;
    fake.calls = [];
    act(() => { host.querySelector("[data-nova-pad='1']")!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(fake.calls).toEqual(g0.log);
    expect(host.querySelector('[data-nova-rack-selected]')?.textContent).toBe('Pad 1 · Kick');
    for (const g of rest) {
      updates.length = 0;
      const [kind, arg] = g.action.split(':');
      if (kind === 'bouton') click(host.querySelector(`[data-nova-param='${arg === 'M' ? 'isMuted' : 'isSolo'}'] [role=checkbox]`));
      else key(knob(host, kind), arg === 'max' ? 'End' : 'Home');
      expect(clone(updates[updates.length - 1].drumPads[0]), g.action).toEqual(g.pad);
    }
    expect(host.querySelectorAll('input[type=range]').length).toBe(0);
    expect(host.textContent).not.toMatch(/Empty|Drag & Drop|MIDI Map/);
  });
});

describe('Sampler mélodique (écran) : mêmes envois qu\'avant', () => {
  it('11 réglages en butée, Poly / Mono', () => {
    const LABEL_ID: Record<string, string> = {
      'Accord fin': 'fineTune', Attaque: 'attack', 'Déclin': 'decay', Maintien: 'sustain', 'Relâchement': 'release', 'Glissé': 'glide',
      'Pitch bend': 'bendRange', 'Vélocité': 'velSens', Filtre: 'cutoff', 'Résonance': 'resonance', Volume: 'gainDb',
    };
    const patches: any[] = [];
    const s = { ...DEFAULT_SAMPLER, sampleId: 'x', sampleName: 'Son' } as any;
    const host = mount(h(SamplerPanel, { track: { id: 't', melodicSampler: s } as any, isMobile: false, bpm: 120, onChange: (p: any) => patches.push(clone(p)),
      onClose: () => {}, onBackToSynth: () => {}, ensureEngine: async () => {}, notify: () => {}, sessionClips: [] }));
    expect(host.querySelectorAll('input[type=range]').length).toBe(0);
    expect(host.querySelector("[data-nova-plugin='MELODIC_SAMPLER'] h2")?.textContent).toBe('Sampler');
    let identiques = 0;
    for (const g of (golden3 as any).MELODIC_SAMPLER as any[]) {
      patches.length = 0;
      const [label, what] = g.action.split(':');
      if (label === 'bouton') click(host.querySelector(`[data-testid='sampler-${what.toLowerCase()}']`));
      else key(knob(host, LABEL_ID[label]), what === 'max' ? 'End' : 'Home');
      if (!g.patches.length) { expect(patches, g.action).toEqual([]); continue; } // déjà en butée : rien d'envoyé, avant comme après
      expect(patches.length, g.action).toBe(1);
      const [[k, v]] = Object.entries(g.patches[0]) as [string, any][];
      expect(Object.keys(patches[0]), g.action).toEqual([k]);
      // Les anciens curseurs logarithmiques donnaient la borne à 1e-15 près (0,0010000000000000002) : même valeur.
      if (typeof v === 'number') expect(patches[0][k], g.action).toBeCloseTo(v, 12); else expect(patches[0][k], g.action).toBe(v);
      identiques++;
    }
    expect(identiques).toBe(21);
  });
});
