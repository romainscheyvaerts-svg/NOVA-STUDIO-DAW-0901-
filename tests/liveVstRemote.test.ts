import { describe, expect, it, vi } from 'vitest';
import { applyRemoteVstParams, catalogOf, LiveVstDeps, readRemoteVstParams, VstRemoteRequests } from '../services/LiveVstRemote';
import { MODE_INFO } from '../components/CollabPanel';

/**
 * Collaboration « En direct » : l'ingé règle les VST hébergés par le pont du PC
 * de l'artiste. Le pont est simulé : on vérifie que le réglage est appliqué par
 * le pont de l'artiste, RELU, et que l'état du plugin revient à l'ingé.
 */
function deps(over: Partial<LiveVstDeps> = {}): LiveVstDeps & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    isConnected: () => true,
    paramsText: () => true,
    slotOf: (id) => (id === 'pl-comp' ? 'slot-1' : null),
    setParams: vi.fn(async (slot, params) => {
      calls.push({ slot, params });
      return { results: params.map(p => ({ name: p.name, ok: true, text: p.text ?? `${p.real} dB` })), latencySamples: 0, latencyChanged: false };
    }),
    getParams: vi.fn(async () => [
      { name: 'threshold', display_name: 'Threshold', value: 0.4, text: '-18.0 dB' },
      { name: 'ratio', value: 0.2, text: '4:1', values: ['2:1', '4:1', '8:1'] },
    ]),
    syncState: vi.fn(async () => 'bm91dmVs'),
    ...over,
  };
}

describe('En direct : VST de l\'artiste réglés par l\'ingé', () => {
  it('applique par le pont de l\'artiste, relit la valeur et renvoie le nouvel état', async () => {
    const d = deps();
    const ack = await applyRemoteVstParams({ reqId: 'r1', trackId: 'lead', pluginId: 'pl-comp', params: [{ name: 'threshold', real: -22 }] }, d);
    expect(d.calls).toEqual([{ slot: 'slot-1', params: [{ name: 'threshold', real: -22 }] }]);
    expect(ack).toMatchObject({ reqId: 'r1', pluginId: 'pl-comp', ok: true, stateB64: 'bm91dmVs' });
    expect(ack.results[0]).toMatchObject({ name: 'threshold', ok: true, text: '-22 dB' });
  });

  it('messages clairs : pont fermé, pont trop ancien, plugin pas chargé chez l\'artiste', async () => {
    const req = { reqId: 'r', trackId: 't', pluginId: 'pl-comp', params: [{ name: 'x', text: 'On' }] };
    expect((await applyRemoteVstParams(req, deps({ isConnected: () => false }))).error).toMatch(/pont VST de l'artiste n'est pas connecté/);
    expect((await applyRemoteVstParams(req, deps({ paramsText: () => false }))).error).toMatch(/version 7/);
    expect((await applyRemoteVstParams({ ...req, pluginId: 'autre' }, deps())).error).toMatch(/pas chargé chez l'artiste/);
    expect((await applyRemoteVstParams({ ...req, params: [{ bad: 1 }] as any }, deps())).error).toMatch(/Aucun réglage/);
    const failing = deps({ setParams: async () => { throw new Error('plugin planté'); } });
    expect(await applyRemoteVstParams(req, failing)).toMatchObject({ ok: false, error: 'plugin planté' });
  });

  it('lit les réglages (valeurs texte et choix possibles)', async () => {
    const r = await readRemoteVstParams({ reqId: 'q', pluginId: 'pl-comp' }, deps());
    expect(r.ok).toBe(true);
    expect(r.parameters).toEqual([
      { name: 'threshold', displayName: 'Threshold', text: '-18.0 dB' },
      { name: 'ratio', text: '4:1', values: ['2:1', '4:1', '8:1'] },
    ]);
  });

  it('liste des VST de l\'artiste (sans les instruments), catégorie déduite', () => {
    const list = catalogOf([
      { id: '1', name: 'Pro-C 2', vendor: 'FabFilter', category: 'Effect', path: 'C:\\VST3\\ProC.vst3', uid: 'a' },
      { id: '2', name: 'Serum', vendor: 'Xfer', category: 'Instrument', path: 'C:\\VST3\\Serum.vst3', uid: 'b', isInstrument: true },
      { id: '3', name: 'ValhallaRoom', vendor: 'Valhalla DSP', category: 'Effect', path: 'C:\\VST3\\Room.vst3', uid: 'c' },
    ]);
    expect(list.map(x => [x.name, x.category])).toEqual([['Pro-C 2', 'compressor'], ['ValhallaRoom', 'reverb']]);
  });

  it('attente des réponses : résolue une fois, délai avec un message qui dit quoi faire', async () => {
    vi.useFakeTimers();
    try {
      const reqs = new VstRemoteRequests<{ ok: boolean }>();
      const a = reqs.create(1000);
      expect(reqs.resolve(a.reqId, { ok: true })).toBe(true);
      expect(reqs.resolve(a.reqId, { ok: true })).toBe(false); // doublon (canal + rattrapage) ignoré
      await expect(a.promise).resolves.toEqual({ ok: true });
      const b = reqs.create(1000);
      const caught = b.promise.catch(e => e.message);
      vi.advanceTimersByTime(1001);
      expect(await caught).toMatch(/NOVA Studio pour Windows/);
      expect(reqs.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('choix du mode de collaboration', () => {
  it('deux modes, chacun expliqué en une phrase', () => {
    expect(MODE_INFO.live.title).toBe('En direct');
    expect(MODE_INFO.remote.title).toBe('Ingé à distance (ses propres VST)');
    for (const m of Object.values(MODE_INFO)) expect(m.help.split(/[.!?](\s|$)/).filter(x => x && x.trim()).length).toBe(1);
    expect(MODE_INFO.live.help).toMatch(/VST installés sur ton PC/);
    expect(MODE_INFO.remote.help).toMatch(/SES VST/);
  });
});
