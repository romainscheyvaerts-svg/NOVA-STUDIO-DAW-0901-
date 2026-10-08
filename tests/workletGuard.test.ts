// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Garde des worklets : un processeur audio qui lève une exception (« processorerror »)
 * est signalé, l'effet propriétaire est retrouvé dans la chaîne de la piste et
 * contourné tout de suite (entrée reliée à sa sortie), puis l'appli est prévenue.
 * Sans Web Audio : fausses classes.
 */

class FakeNode extends EventTarget {
  links = new Set<any>();
  connect(n: any) { this.links.add(n); return n; }
  disconnect(n?: any) { if (n) this.links.delete(n); else this.links.clear(); }
}

afterEach(() => { vi.resetModules(); delete (globalThis as any).AudioWorkletNode; });

describe('installWorkletGuard', () => {
  it('remplace AudioWorkletNode : un processorerror prévient les abonnés (nœud + nom du processeur)', async () => {
    class Orig extends FakeNode { constructor(public ctx: any, public name: string) { super(); } }
    (globalThis as any).AudioWorkletNode = Orig;
    const g = await import('../engine/workletGuard');
    expect(g.installWorkletGuard()).toBe(true);
    const seen: [any, string][] = [];
    g.onWorkletCrash((n, p) => seen.push([n, p]));
    const Node = (globalThis as any).AudioWorkletNode;
    const n = new Node({}, 'nova-lofi');
    expect(n).toBeInstanceOf(Orig);
    n.dispatchEvent(new Event('processorerror'));
    expect(seen).toEqual([[n, 'nova-lofi']]);
    // Une 2e installation ne double pas la garde.
    expect(g.installWorkletGuard()).toBe(true);
    new Node({}, 'x').dispatchEvent(new Event('processorerror'));
    expect(seen.length).toBe(2);
  });

  it('Chrome ne prévient que « onprocessorerror » : capté aussi, une seule fois, et le gestionnaire de l\'appli est gardé', async () => {
    class Orig extends FakeNode {
      private h: any = null;
      constructor(public ctx: any, public name: string) { super(); }
      fire() { this.h?.(new Event('processorerror')); }   // seul le gestionnaire natif, pas les écouteurs
    }
    Object.defineProperty(Orig.prototype, 'onprocessorerror', { configurable: true, get(this: any) { return this.h; }, set(this: any, v) { this.h = v; } });
    (globalThis as any).AudioWorkletNode = Orig;
    const g = await import('../engine/workletGuard');
    g.installWorkletGuard();
    const seen: string[] = [];
    g.onWorkletCrash((_n, p) => seen.push(p));
    const n = new (globalThis as any).AudioWorkletNode({}, 'nova-gate');
    const mine = vi.fn();
    n.onprocessorerror = mine;
    expect(n.onprocessorerror).toBe(mine);
    n.fire();
    n.dispatchEvent(new Event('processorerror'));
    expect(seen).toEqual(['nova-gate']);
    expect(mine).toHaveBeenCalledTimes(1);
  });

  it('sans Web Audio (serveur, tests) : rien n\'est installé, pas d\'erreur', async () => {
    const g = await import('../engine/workletGuard');
    expect(g.installWorkletGuard()).toBe(false);
  });
});

describe('ownsNode', () => {
  it('retrouve le nœud dans les propriétés d\'un effet (direct, imbriqué, tableau, Map), pas ailleurs', async () => {
    const { ownsNode } = await import('../engine/workletGuard');
    const w = new FakeNode();
    expect(ownsNode({ worklet: w }, w)).toBe(true);
    expect(ownsNode({ inner: { node: w } }, w)).toBe(true);
    expect(ownsNode({ voices: [{}, { w }] }, w)).toBe(true);
    expect(ownsNode({ m: new Map([['a', w]]) }, w)).toBe(true);
    expect(ownsNode({ worklet: new FakeNode() }, w)).toBe(false);
    const cyc: any = { a: {} }; cyc.a.back = cyc;
    expect(ownsNode(cyc, w)).toBe(false);
    expect(ownsNode({ ownsNode: (n: any) => n === w }, w)).toBe(true);
  });
});

describe('AudioEngine.handleWorkletCrash', () => {
  it('effet de piste : contourné tout de suite (entrée → sortie) et « nova:plugin-crash » envoyé ; une 2e panne du même ne recâble pas', async () => {
    const { AudioEngine } = await import('../engine/AudioEngine');
    const w = new FakeNode();
    const input = new FakeNode(), output = new FakeNode();
    input.connect(w);
    const entry: any = { input, output, instance: { worklet: w } };
    const other: any = { input: new FakeNode(), output: new FakeNode(), instance: { worklet: new FakeNode() } };
    const fake: any = {
      tracksDSP: new Map([
        ['voix', { pluginChain: new Map([['fx-lofi', entry]]) }],
        ['beat', { pluginChain: new Map([['fx-eq', other]]) }],
      ]),
      liveTracks: [{ id: 'voix', name: 'Voix', plugins: [{ id: 'fx-lofi', name: 'Lo-Fi', type: 'LOFI' }] }],
      recSession: null, asioInput: null, humTake: null,
    };
    const events: any[] = [];
    const on = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('nova:plugin-crash', on);
    try {
      const r = AudioEngine.prototype.handleWorkletCrash.call(fake, w as any, 'nova-lofi');
      expect(r).toEqual({ kind: 'plugin', trackId: 'voix', pluginId: 'fx-lofi' });
      expect(entry.crashed).toBe(true);
      expect([...input.links]).toEqual([output]);       // plus le worklet planté : le son sec passe
      expect(other.crashed).toBeUndefined();            // l'autre piste n'est pas touchée
      expect(events).toEqual([{ trackId: 'voix', pluginId: 'fx-lofi', name: 'Lo-Fi', trackName: 'Voix', processor: 'nova-lofi' }]);
      const again = AudioEngine.prototype.handleWorkletCrash.call(fake, w as any, 'nova-lofi');
      expect(again.kind).toBe('unknown');
    } finally {
      window.removeEventListener('nova:plugin-crash', on);
    }
  });

  it('module hors effet (synthé) : « nova:audio-module-crash » avec un nom lisible', async () => {
    const { AudioEngine } = await import('../engine/AudioEngine');
    const w = new FakeNode();
    const fake: any = { tracksDSP: new Map([['m1', { pluginChain: new Map(), synth: { chorus: w } }]]), liveTracks: [], recSession: null, asioInput: null, humTake: null };
    const events: any[] = [];
    const on = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('nova:audio-module-crash', on);
    try {
      expect(AudioEngine.prototype.handleWorkletCrash.call(fake, w as any, 'nova-synth-chorus').kind).toBe('module');
      expect(events[0]).toMatchObject({ module: 'le synthé', trackId: 'm1' });
    } finally {
      window.removeEventListener('nova:audio-module-crash', on);
    }
  });
});

describe('Fenêtre du compresseur : réglages incomplets', () => {
  it('chaque valeur manquante ou invalide prend sa valeur par défaut (avant : plantage toFixed)', async () => {
    const { withCompressorDefaults } = await import('../plugins/CompressorPlugin');
    const p = withCompressorDefaults({ threshold: -24, ratio: undefined as any, attack: NaN, mode: 'OPTO' } as any);
    expect(p).toMatchObject({ threshold: -24, ratio: 4, attack: 0.003, release: 0.25, lookahead: 0, mode: 'OPTO', isEnabled: true });
    expect(withCompressorDefaults(null).ratio).toBe(4);
  });
});
