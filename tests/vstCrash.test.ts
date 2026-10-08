// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Effet VST3 dont le plugin plante sur le pont (PLUGIN_CRASHED) : la piste
 * continue en passe-plat, relance automatique plafonnée, quarantaine respectée.
 */

const h = vi.hoisted(() => {
  const state = { status: 'connected' as string, error: null };
  const bridge = {
    stateCbs: new Set<(s: any) => void>(),
    slotCbs: new Map<string, Set<(e: any) => void>>(),
    loads: [] as any[],
    unloads: [] as string[],
    loadError: null as any,
    subscribe(cb: (s: any) => void) { this.stateCbs.add(cb); cb(state); return () => this.stateCbs.delete(cb); },
    onLicenseDone() { return () => {}; },
    isConnected() { return state.status === 'connected'; },
    setStatus(s: string) { state.status = s; this.stateCbs.forEach(cb => cb({ ...state })); },
    claimSlot(id: string) { return id; },
    releaseSlot() {},
    async loadPlugin(o: any) {
      this.loads.push(o);
      if (this.loadError) throw this.loadError;
      return { name: 'Pro-Q 3', vendor: 'FabFilter', latencySamples: 64, bufferLatencySamples: 0, stateB64: null, isInstrument: false };
    },
    unloadPlugin(id: string) { this.unloads.push(id); },
    onSlotEvent(id: string, cb: (e: any) => void) {
      let s = this.slotCbs.get(id); if (!s) { s = new Set(); this.slotCbs.set(id, s); }
      s.add(cb); return () => { s!.delete(cb); };
    },
    emit(id: string, e: any) { [...(this.slotCbs.get(id) || [])].forEach(cb => cb(e)); },
    attachAudio() { return { fake: 'port' }; },
    detachAudio() {},
    setPluginState: async () => {},
  };
  return { bridge, state };
});

vi.mock('../services/NovaBridge', () => ({ novaBridge: h.bridge }));

class FakeNode {
  conns = new Set<any>();
  port = { postMessage: vi.fn(), onmessage: null as any };
  connect(n: any) { this.conns.add(n); return n; }
  disconnect(n?: any) {
    if (n === undefined) { this.conns.clear(); return; }
    if (!this.conns.has(n)) throw new Error('pas connecté');
    this.conns.delete(n);
  }
}
class FakeAudioContext {
  sampleRate = 48000;
  audioWorklet = { addModule: async () => {} };
  createGain() { return new FakeNode(); }
}

import { VSTPluginNode, resetVstCrashHistory, VST_CRASH_RETRY_DELAY_MS } from '../engine/VSTPluginNode';

const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
const plugin = { id: 'fx-voix-eq', name: 'Pro-Q 3', type: 'VST3', isEnabled: true, params: { localPath: 'C:/VST3/FabFilter Pro-Q 3.vst3' } } as any;

let events: any[] = [];
const onCrashEvent = (e: Event) => events.push((e as CustomEvent).detail);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioContext', FakeAudioContext as any);
  vi.stubGlobal('AudioWorkletNode', FakeNode as any);
  Object.assign(h.bridge, { loads: [], unloads: [], loadError: null });
  h.bridge.slotCbs.clear();
  h.bridge.stateCbs.clear();
  h.state.status = 'connected';
  resetVstCrashHistory();
  events = [];
  window.addEventListener('nova:vst-crash', onCrashEvent);
});
afterEach(() => {
  window.removeEventListener('nova:vst-crash', onCrashEvent);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const passThrough = (n: VSTPluginNode) => (n.input as any).conns.has(n.output);
const crash = (reason = 'exception') => h.bridge.emit(plugin.id, { action: 'PLUGIN_CRASHED', slot_id: plugin.id, reason, error: 'boom', name: 'Pro-Q 3' });

describe('VSTPluginNode : plugin qui plante sur le pont', () => {
  it('panne : passe-plat immédiat, message, événement ; relance ~1 s après', async () => {
    const ctx = new FakeAudioContext() as any;
    const n = new VSTPluginNode(ctx, plugin);
    await settle();
    expect(n.getInfo().status).toBe('active');
    expect(passThrough(n)).toBe(false);
    expect(n.latency).toBeGreaterThan(0);

    crash('hang');
    expect(passThrough(n)).toBe(true);              // la piste continue sans l'effet
    expect(n.latency).toBe(0);
    expect(n.getInfo().status).toBe('error');
    expect(n.getInfo().error).toMatch(/a planté \(il ne répondait plus\) : relance/);
    expect(h.bridge.unloads).toEqual([plugin.id]);  // le slot en panne est libéré sur le pont
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ pluginId: plugin.id, reason: 'hang', willRetry: true });

    await vi.advanceTimersByTimeAsync(VST_CRASH_RETRY_DELAY_MS - 10); await settle();
    expect(h.bridge.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20); await settle();
    expect(h.bridge.loads).toHaveLength(2);         // relancé
    expect(n.getInfo().status).toBe('active');
    expect(passThrough(n)).toBe(false);
    n.dispose();
  });

  it('plafond : 2 relances en 10 min, puis « désactivé : il plante » et plus de relance (même à la reconnexion)', async () => {
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    for (let i = 0; i < 2; i++) {
      crash();
      await vi.advanceTimersByTimeAsync(VST_CRASH_RETRY_DELAY_MS + 10); await settle();
      expect(n.getInfo().status).toBe('active');
    }
    crash('nan');
    expect(events.map(e => e.willRetry)).toEqual([true, true, false]);
    expect(n.getInfo().error).toMatch(/désactivé : il plante \(3 fois en 10 min\)/);
    expect(passThrough(n)).toBe(true);
    await vi.advanceTimersByTimeAsync(60000); await settle();
    expect(h.bridge.loads).toHaveLength(3);
    h.bridge.setStatus('reconnecting');
    h.bridge.setStatus('connected');
    await settle();
    expect(h.bridge.loads).toHaveLength(3);         // pas relancé par la reconnexion
    expect(passThrough(n)).toBe(true);
    n.dispose();
  });

  it('le plafond suit le plugin même si son nœud est recréé ; il se réarme après 10 min', async () => {
    let n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    crash(); await vi.advanceTimersByTimeAsync(VST_CRASH_RETRY_DELAY_MS + 10); await settle();
    crash(); await vi.advanceTimersByTimeAsync(VST_CRASH_RETRY_DELAY_MS + 10); await settle();
    n.dispose();
    n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    crash();
    expect(events.at(-1).willRetry).toBe(false);
    n.dispose();
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    crash();
    expect(events.at(-1).willRetry).toBe(true);
    n.dispose();
  });

  it('plugin en quarantaine : erreur claire, passe-plat, jamais relancé', async () => {
    h.bridge.loadError = Object.assign(new Error('Pro-Q 3 a fait planter le pont 2 fois : désactivé. Rescanner les plugins pour réessayer'), { quarantined: true });
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    expect(n.getInfo().status).toBe('error');
    expect(n.getInfo().error).toMatch(/planter le pont 2 fois/);
    expect(passThrough(n)).toBe(true);
    h.bridge.setStatus('reconnecting');
    h.bridge.setStatus('connected');
    await settle();
    expect(h.bridge.loads).toHaveLength(1);
    n.dispose();
  });

  it('dispose pendant l\'attente de relance : rien n\'est rechargé', async () => {
    const n = new VSTPluginNode(new FakeAudioContext() as any, plugin);
    await settle();
    crash();
    n.dispose();
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(h.bridge.loads).toHaveLength(1);
  });
});
