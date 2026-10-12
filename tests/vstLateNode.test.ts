// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C6 — effet VST3 dont le pont rend les blocs en retard : alerte « nova:vst-late », compteur de
 * coupures, tampon agrandi annoncé au moteur (raison « adaptive » : PDC + attente du transport),
 * descente seulement à l'arrêt, réglage « tampon adaptatif » coupable.
 */

const h = vi.hoisted(() => {
  const state = { status: 'connected' as string, error: null };
  const bridge = {
    stateCbs: new Set<(s: any) => void>(),
    subscribe(cb: (s: any) => void) { this.stateCbs.add(cb); cb(state); return () => this.stateCbs.delete(cb); },
    onLicenseDone() { return () => {}; },
    isConnected() { return true; },
    claimSlot(id: string) { return id; },
    releaseSlot() {},
    async loadPlugin() { return { name: 'Pro-C 3', vendor: 'FabFilter', latencySamples: 64, bufferLatencySamples: 0, stateB64: null, isInstrument: false }; },
    unloadPlugin() {},
    onSlotEvent() { return () => {}; },
    attachAudio() { return { fake: 'port' }; },
    detachAudio() {},
    setPluginState: async () => {},
    automatable: async () => [],
  };
  return { bridge, state };
});

vi.mock('../services/NovaBridge', () => ({ novaBridge: h.bridge }));

const created: any[] = [];
class FakeNode {
  conns = new Set<any>();
  port = { postMessage: vi.fn(), onmessage: null as any };
  opts: any;
  constructor(_ctx?: any, _name?: string, opts?: any) { this.opts = opts; if (opts) created.push(this); }
  connect(n: any) { this.conns.add(n); return n; }
  disconnect(n?: any) { if (n === undefined) { this.conns.clear(); return; } this.conns.delete(n); }
}
class FakeAudioContext {
  sampleRate = 48000;
  audioWorklet = { addModule: async () => {} };
  createGain() { return new FakeNode(); }
}

import { VSTPluginNode, setVstTransportPlaying } from '../engine/VSTPluginNode';
import { setVstAdaptiveEnabled, VST_SHRINK_CALM_S } from '../utils/vstAdaptiveBuffer';

const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
const plugin = { id: 'fx-voix-comp', name: 'Pro-C 3', type: 'VST3', isEnabled: true, params: { localPath: 'C:/VST3/FabFilter Pro-C 3.vst3' } } as any;
const SR = 48000;

let late: any[] = [];
const onLate = (e: Event) => late.push((e as CustomEvent).detail);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioContext', FakeAudioContext as any);
  vi.stubGlobal('AudioWorkletNode', FakeNode as any);
  created.length = 0;
  late = [];
  setVstAdaptiveEnabled(true);
  setVstTransportPlaying(false);
  window.addEventListener('nova:vst-late', onLate);
});
afterEach(() => {
  window.removeEventListener('nova:vst-late', onLate);
  setVstAdaptiveEnabled(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const worklet = () => created[created.length - 1];
const fromWorklet = (data: any) => worklet().port.onmessage({ data });
let seq = 0;
const stats = (o: any = {}) => fromWorklet({ type: 'stats', seq: (seq += 375), underruns: 0, dropouts: 0, late: 0, grows: 0, delayFrames: 2048, delayId: 0, ageMaxFrames: 256, recvPeriod: 375, paramsSent: 0, paramBlocks: 0, ...o });

describe('C6 · VSTPluginNode face à un pont en retard', () => {
  it('worklet créé avec un plafond de 8192 ; latence = tampon + plugin', async () => {
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    expect(worklet().opts.processorOptions).toEqual({ prebufferFrames: 2048, maxPrebufferFrames: 8192 });
    expect(n.latency).toBeCloseTo((2048 + 64) / SR, 9);
    n.dispose();
  });

  it('agrandissement en lecture : latence suivie, moteur prévenu (« adaptive »), alerte claire', async () => {
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    const why: any[] = [];
    n.setLatencyListener((r) => why.push(r));
    await settle();
    expect(why).toEqual([undefined]);      // chargement : latence connue (pas d'attente du transport)
    why.length = 0;
    setVstTransportPlaying(true);
    stats({ dropouts: 1, underruns: 3 });
    fromWorklet({ type: 'delay', frames: 3072, grows: 1 });
    expect(n.latency).toBeCloseTo((3072 + 64) / SR, 9);
    expect(why).toEqual(['adaptive']);
    expect(late.length).toBeGreaterThanOrEqual(1);
    const last = late[late.length - 1];
    expect(last).toMatchObject({ pluginId: plugin.id, name: 'Pro-C 3', grown: true, bufferMs: 64 });
    expect(last.message).toBe('Le plugin Pro-C 3 a pris du retard : 1 coupure en 10 s. Tampon agrandi à 64 ms, retard compensé : la piste reste calée.');
    const info = n.getInfo();
    expect(info).toMatchObject({ dropouts10s: 1, dropoutsTotal: 1, bufferMs: 64, bufferGrown: true, bufferAtMax: false, underruns: 3 });
    n.dispose();
  });

  it('12 coupures en 10 s : compteur ; plus rien après 10 s', async () => {
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    stats({ dropouts: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    stats({ dropouts: 12 });
    expect(n.getInfo().dropouts10s).toBe(12);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(n.getInfo().dropouts10s).toBe(0);
    // La pastille est prévenue quand la fenêtre se vide (stats suivantes, sans nouvelle coupure).
    const { onVstNodesChange } = await import('../engine/VSTPluginNode');
    let notified = 0;
    const off = onVstNodesChange(() => { notified++; });
    stats({ dropouts: 12 });
    expect(notified).toBe(1);
    stats({ dropouts: 12 });
    expect(notified).toBe(1);
    off();
    expect(n.getInfo().dropoutsTotal).toBe(12);
    n.dispose();
  });

  it('descente : jamais en lecture ; à l’arrêt après 15 s de flux sans coupure, ordre envoyé au worklet', async () => {
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    window.dispatchEvent(new Event('nova:transport-start'));
    fromWorklet({ type: 'delay', frames: 6144, grows: 3 });
    for (let s = 0; s <= VST_SHRINK_CALM_S + 1; s++) stats({ delayFrames: 6144 });
    const delays = () => worklet().port.postMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.type === 'delay');
    expect(delays()).toEqual([]);
    expect(n.getPrebufferFrames()).toBe(6144);
    window.dispatchEvent(new CustomEvent('nova:transport-stop', { detail: { time: 3 } }));
    expect(delays()).toEqual([{ type: 'delay', frames: 2048, id: 1 }]);
    expect(n.latency).toBeCloseTo((2048 + 64) / SR, 9);
    n.dispose();
  });

  it('« Revenir au tampon normal » en pleine lecture : fait à l’arrêt seulement', async () => {
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    window.dispatchEvent(new Event('nova:transport-start'));
    fromWorklet({ type: 'delay', frames: 4096, grows: 2 });
    n.resetPrebuffer();
    expect(n.getPrebufferFrames()).toBe(4096);
    window.dispatchEvent(new CustomEvent('nova:transport-stop', { detail: { time: 1 } }));
    expect(n.getPrebufferFrames()).toBe(2048);
    n.dispose();
  });

  it('tampon adaptatif coupé (réglage) : avance fixe, comme avant', async () => {
    setVstAdaptiveEnabled(false);
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    expect(worklet().opts.processorOptions).toEqual({ prebufferFrames: 2048, maxPrebufferFrames: 2048 });
    stats({ dropouts: 4 });
    expect(late[late.length - 1].message).toBe('Le plugin Pro-C 3 a pris du retard : 4 coupures en 10 s. Ferme les programmes inutiles ou gèle la piste.');
    n.dispose();
  });
});
