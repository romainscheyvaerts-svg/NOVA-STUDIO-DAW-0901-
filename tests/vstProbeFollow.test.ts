// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { novaBridge, PROBE_POLL_MS } from '../services/NovaBridge';

/**
 * 1re ouverture sur un PC (rien en cache) : le pont lit les plugins en arrière-plan (shells Waves,
 * Antares…). La liste est relue toute seule pendant la lecture, sans clic, puis plus du tout.
 */

const LISTES = [
  { instruments_pending: true, probe_progress: [0, 3], plugins: [{ id: 'w', name: 'WaveShell1-VST3 17.4_x64', path: 'C:/VST3/WaveShell1-VST3 17.4_x64.vst3', category: 'Effect', is_instrument: null }] },
  { instruments_pending: true, probe_progress: [1, 3], plugins: [
    { id: 'w#C6', name: 'C6 Stereo', vendor: 'Waves', path: 'C:/VST3/WaveShell1-VST3 17.4_x64.vst3', plugin_name: 'C6 Stereo', category: 'Effect', is_instrument: false, shell: 'WaveShell1-VST3 17.4_x64' },
    { id: 'at', name: 'Auto-Tune Pro', path: 'C:/VST3/Auto-Tune Pro.vst3', category: 'Effect', is_instrument: null }] },
  { instruments_pending: false, plugins: [
    { id: 'w#C6', name: 'C6 Stereo', vendor: 'Waves', path: 'C:/VST3/WaveShell1-VST3 17.4_x64.vst3', plugin_name: 'C6 Stereo', category: 'Effect', is_instrument: false, shell: 'WaveShell1-VST3 17.4_x64' },
    { id: 'at', name: 'Auto-Tune Pro', vendor: 'Antares', path: 'C:/VST3/Auto-Tune Pro.vst3', category: 'Effect', is_instrument: false }] },
];

class FakeWS {
  static lists = 0;
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: any }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = 'arraybuffer';
  constructor(public url: string) { setTimeout(() => this.onopen?.(), 0); }
  send(data: any) {
    if (typeof data !== 'string') return;
    const m = JSON.parse(data);
    if (m.action === 'HELLO') this.reply({ action: 'HELLO', req_id: m.req_id, success: true, version: 14 });
    else if (m.action === 'GET_PLUGIN_LIST') {
      const l = LISTES[Math.min(FakeWS.lists++, LISTES.length - 1)];
      this.reply({ action: m.action, req_id: m.req_id, success: true, ...l });
    } else this.reply({ action: m.action, req_id: m.req_id, success: true });
  }
  reply(obj: any) { setTimeout(() => this.onmessage?.({ data: JSON.stringify(obj) }), 0); }
  close() { this.onclose?.(); }
}

describe('lecture des plugins à la 1re ouverture : liste suivie sans clic', () => {
  const realWS = (globalThis as any).WebSocket;
  const realWorker = (globalThis as any).Worker;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.lists = 0;
    (globalThis as any).WebSocket = FakeWS as any;
    (globalThis as any).Worker = class { postMessage() { /* */ } terminate() { /* */ } };
  });
  afterEach(() => { novaBridge.disconnect(); vi.useRealTimers(); (globalThis as any).WebSocket = realWS; (globalThis as any).Worker = realWorker; });

  it('relit la liste pendant la lecture, puis s\'arrête', async () => {
    const p = novaBridge.connect();
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toBe(true);
    expect(FakeWS.lists).toBe(1);                       // liste demandée après HELLO
    expect(novaBridge.getBridgeState().instrumentsPending).toEqual([0, 3]);
    const rev0 = novaBridge.getBridgeState().pluginsRev;

    await vi.advanceTimersByTimeAsync(PROBE_POLL_MS + 50);
    expect(FakeWS.lists).toBe(2);                       // relue toute seule
    expect(novaBridge.getCachedPlugins().map(x => x.name)).toEqual(['C6 Stereo', 'Auto-Tune Pro']);
    expect(novaBridge.getBridgeState().pluginsRev).not.toBe(rev0);

    await vi.advanceTimersByTimeAsync(PROBE_POLL_MS + 50);
    expect(FakeWS.lists).toBe(3);
    expect(novaBridge.getBridgeState().instrumentsPending).toBeNull();
    expect(novaBridge.getCachedPlugins()[1].vendor).toBe('Antares');

    await vi.advanceTimersByTimeAsync(PROBE_POLL_MS * 4);
    expect(FakeWS.lists).toBe(3);                       // lecture finie : plus aucune requête
  });
});

describe('groupes Waves pas encore lus, chargement long', () => {
  it('reconnaît un WaveShell pas déplié, pas un plugin Waves déjà lu', async () => {
    const { isUnreadShell, unreadShellText } = await import('../components/VstBrowserTab');
    const base = { id: 'x', vendor: '', category: 'Effect', path: 'C:/VST3/WaveShell1-VST3 17.4_x64.vst3', uid: '', isInstrument: null } as any;
    expect(isUnreadShell({ ...base, name: 'WaveShell1-VST3 17.4_x64', pluginName: null })).toBe(true);
    expect(isUnreadShell({ ...base, name: 'C6 Stereo', pluginName: 'C6 Stereo', shell: 'WaveShell1-VST3 17.4_x64' })).toBe(false);
    expect(isUnreadShell({ ...base, name: 'Auto-Tune Pro', path: 'C:/VST3/Auto-Tune Pro.vst3', pluginName: null })).toBe(false);
    expect(unreadShellText(false)).toMatch(/Waves Central/);
  });
  it('message de chargement long : licence, sans jargon', async () => {
    const { vstSlowLoadText, VST_SLOW_LOAD_MS } = await import('../engine/VSTPluginNode');
    expect(VST_SLOW_LOAD_MS).toBe(20000);
    const t = vstSlowLoadText('Auto-Tune Pro');
    expect(t).toMatch(/Auto-Tune Pro met longtemps/);
    expect(t).toMatch(/licence/);
    expect(t).not.toMatch(/pont/i);
  });
});
