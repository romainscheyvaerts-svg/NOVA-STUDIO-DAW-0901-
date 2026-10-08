// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pont VST : reconnexion automatique (pont planté puis relancé par le
 * superviseur de l'appli) et événements de panne PLUGIN_CRASHED (pont v10).
 * Faux WebSocket : on coupe le « serveur », on le relance, on envoie des événements.
 */

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  static up = true;
  readyState = 0;
  binaryType = 'blob';
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: any }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
    setTimeout(() => {
      if (FakeWS.up) { this.readyState = 1; this.onopen?.(); }
      else { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
    }, 0);
  }
  send(d: string) {
    this.sent.push(d);
    const m = JSON.parse(d);
    const reply = (extra: Record<string, unknown>) => setTimeout(() => this.onmessage?.({ data: JSON.stringify({ action: m.action, req_id: m.req_id, ...extra }) }), 0);
    if (m.action === 'HELLO') reply({ success: true, version: 10, crash_events: true });
    else if (m.action === 'GET_PLUGIN_LIST') reply({ success: true, plugins: [{ path: 'C:/VST3/Plante.vst3', name: 'Plante', quarantined: true }] });
    else if (m.action === 'LOAD_PLUGIN') reply({ success: false, error: 'Plante a fait planter le pont 2 fois : désactivé.', quarantined: true });
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.(), 0); }
  /** Le processus du pont meurt : la connexion se ferme d'elle-même. */
  crash() { this.readyState = 3; this.onclose?.(); }
  event(msg: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

// Pas de 1 ms : un setTimeout(0) posé pendant un rappel de minuterie part au pas suivant.
const flush = async () => { for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1); };

let bridgeMod: typeof import('../services/NovaBridge');

beforeEach(async () => {
  vi.useFakeTimers();
  FakeWS.instances = [];
  FakeWS.up = true;
  vi.stubGlobal('WebSocket', FakeWS as any);
  vi.stubGlobal('Worker', class { postMessage() { /* */ } terminate() { /* */ } } as any);
  delete (window as any).__novaDesktop;
  vi.resetModules();
  bridgeMod = await import('../services/NovaBridge');
});
afterEach(() => {
  bridgeMod.novaBridge.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Reconnexion automatique du pont VST', () => {
  it('attente progressive 1 s, 2 s, 4 s, 8 s puis 10 s au plus', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(bridgeMod.reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  });

  it('pont planté : statut « reconnecting » visible, essais espacés, reconnecté quand il revient', async () => {
    const b = bridgeMod.novaBridge;
    const seen: string[] = [];
    b.subscribe(s => seen.push(s.status));
    const p = b.connect();
    await flush();
    expect(await p).toBe(true);
    expect(b.getBridgeState().status).toBe('connected');

    FakeWS.up = false;
    FakeWS.instances.at(-1)!.crash();
    let st = b.getBridgeState();
    expect(st.status).toBe('reconnecting');
    expect(st.attempt).toBe(1);
    expect(st.nextRetryAt! - Date.now()).toBe(1000);
    expect(st.error).toMatch(/reconnexion automatique/);

    await vi.advanceTimersByTimeAsync(1000); await flush();   // essai 1 : échec
    st = b.getBridgeState();
    expect(st.status).toBe('reconnecting');
    expect(st.attempt).toBe(2);
    expect(st.nextRetryAt! - Date.now()).toBeGreaterThan(1990);
    expect(st.nextRetryAt! - Date.now()).toBeLessThanOrEqual(2000);
    await vi.advanceTimersByTimeAsync(2000); await flush();   // essai 2 : échec
    expect(b.getBridgeState().attempt).toBe(3);

    FakeWS.up = true;                                          // le superviseur a relancé le pont
    await vi.advanceTimersByTimeAsync(4000); await flush();
    st = b.getBridgeState();
    expect(st.status).toBe('connected');
    expect(st.attempt).toBe(0);
    expect(st.nextRetryAt).toBeNull();
    expect(FakeWS.instances.length).toBe(4);
    expect(seen).toContain('reconnecting');
    expect(seen).not.toContain('unavailable');
  });

  it('retryNow : essai immédiat sans attendre la minuterie', async () => {
    const b = bridgeMod.novaBridge;
    void b.connect(); await flush();
    FakeWS.up = false;
    FakeWS.instances.at(-1)!.crash();
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(b.getBridgeState().attempt).toBe(2);              // prochain essai dans 2 s
    FakeWS.up = true;
    const r = b.retryNow(); await flush();
    expect(await r).toBe(true);
    expect(b.getBridgeState().status).toBe('connected');
  });

  it('disconnect() arrête les essais (aucune nouvelle connexion ensuite)', async () => {
    const b = bridgeMod.novaBridge;
    void b.connect(); await flush();
    FakeWS.up = false;
    FakeWS.instances.at(-1)!.crash();
    expect(b.getBridgeState().status).toBe('reconnecting');
    b.disconnect();
    expect(b.getBridgeState().status).toBe('idle');
    const n = FakeWS.instances.length;
    await vi.advanceTimersByTimeAsync(120000); await flush();
    expect(FakeWS.instances.length).toBe(n);
  });

  it('fermeture voulue (disconnect) d\'une connexion ouverte : pas de reconnexion', async () => {
    const b = bridgeMod.novaBridge;
    void b.connect(); await flush();
    b.disconnect(); await flush();
    expect(b.getBridgeState().status).toBe('idle');
    const n = FakeWS.instances.length;
    await vi.advanceTimersByTimeAsync(60000); await flush();
    expect(FakeWS.instances.length).toBe(n);
  });

  it('navigateur sans pont (jamais connecté) : un seul essai, « unavailable », pas de boucle', async () => {
    FakeWS.up = false;
    const b = bridgeMod.novaBridge;
    const r = b.connect(); await flush();
    expect(await r).toBe(false);
    expect(b.getBridgeState().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(60000); await flush();
    expect(FakeWS.instances.length).toBe(1);
  });

  it('appli Windows : le pont pas encore prêt est réessayé tout seul', async () => {
    (window as any).__novaDesktop = { version: '1.5.0' };
    FakeWS.up = false;
    const b = bridgeMod.novaBridge;
    void b.connect(); await flush();
    expect(b.getBridgeState().status).toBe('reconnecting');
    FakeWS.up = true;
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(b.getBridgeState().status).toBe('connected');
  });
});

describe('Pannes de plugin (pont v10)', () => {
  it('PLUGIN_CRASHED : transmis aux écouteurs du slot et à onPluginCrash', async () => {
    const b = bridgeMod.novaBridge;
    void b.connect(); await flush();
    const slotEvents: any[] = [];
    const global: any[] = [];
    b.onSlotEvent('fx-1', e => slotEvents.push(e));
    b.onSlotEvent('fx-2', e => slotEvents.push({ wrong: e }));
    b.onPluginCrash(e => global.push(e));
    FakeWS.instances.at(-1)!.event({ action: 'PLUGIN_CRASHED', slot_id: 'fx-1', reason: 'hang', error: 'le plugin ne répond plus', name: 'Pro-Q 3' });
    expect(slotEvents).toEqual([{ action: 'PLUGIN_CRASHED', slot_id: 'fx-1', reason: 'hang', error: 'le plugin ne répond plus', name: 'Pro-Q 3' }]);
    expect(global).toEqual([{ slotId: 'fx-1', reason: 'hang', error: 'le plugin ne répond plus', name: 'Pro-Q 3' }]);
  });

  it('plugin en quarantaine : erreur marquée quarantined, drapeau dans la liste', async () => {
    const b = bridgeMod.novaBridge;
    void b.connect(); await flush();
    const list = b.listPlugins(); await flush();
    expect((await list)[0].quarantined).toBe(true);
    const load = b.loadPlugin({ slotId: 'a', path: 'C:/VST3/Plante.vst3', sampleRate: 48000 }).catch(e => e);
    await flush();
    const err = await load;
    expect(err).toBeInstanceOf(Error);
    expect(err.quarantined).toBe(true);
    expect(err.message).toMatch(/planter le pont 2 fois/);
  });
});
