// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Direct tombé qui ne revient PAS tout seul (vu en vrai le 21/10 : onglet resté en
 * arrière-plan, canal fermé par le serveur) : « Réessayer le direct », le retour sur
 * l'onglet et le chien de garde rebranchent un NOUVEAU canal (jeton rafraîchi).
 */

const h = vi.hoisted(() => {
  const net = { realtimeUp: true };
  const channels: any[] = [];
  class FakeChannel {
    statusCb: ((s: string) => void) | null = null;
    closed = false;
    constructor(public name: string) {}
    on() { return this; }
    // Un canal qui n'a pas pu se brancher reste mort (comme un canal fermé côté serveur).
    subscribe(cb: (status: string) => void) { this.statusCb = cb; if (net.realtimeUp) queueMicrotask(() => cb('SUBSCRIBED')); return this; }
    presenceState() { return {}; }
    track = async () => 'ok';
    send = async () => 'ok';
    status(s: string) { this.statusCb?.(s); }
  }
  const setAuth = vi.fn();
  const call = vi.fn(async (action: string) => {
    if (action === 'join') return { member_key: 'me', last_seq: 0, members: [], channel: 'collab:r1' };
    if (action === 'ops_since') return { ops: [] };
    return { seq: 1, role: 'artist', author_name: 'x', member_key: 'me', created_at: 'now' };
  });
  return { FakeChannel, net, channels, setAuth, call };
});

vi.mock('../services/supabase', () => ({
  catalogSupabase: {
    channel: (name: string) => { const c = new h.FakeChannel(name); h.channels.push(c); return c; },
    removeChannel: async (c: any) => { c.closed = true; return 'ok'; },
    auth: { getSession: async () => ({ data: { session: { access_token: 'jeton-frais' } } }) },
    realtime: { setAuth: h.setAuth },
    storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) },
  },
}));
vi.mock('../services/SessionCloud', () => ({ call: h.call, sha1: async () => 'h', CHUNK: 4 }));
vi.mock('../services/AudioUtils', () => { const w = () => ({ arrayBuffer: async () => new ArrayBuffer(0) }); return { wavOf: w, wav16Of: w }; });
vi.mock('../utils/audioBufferRegistry', () => ({ audioBufferRegistry: { get: () => undefined, has: () => false } }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { CollabClient } from '../services/Collab';

let client: CollabClient;
const realtime = () => client.getStatus().realtime;

beforeEach(async () => {
  vi.useFakeTimers();
  h.net.realtimeUp = true;
  h.channels.length = 0;
  h.setAuth.mockClear();
  client = new CollabClient({ id: 'r1', secret: 's' }, 'artist', 'Lina', () => {}, () => {});
  await client.join(0);
  expect(realtime()).toBe('live');
  // Le direct tombe et le serveur ne le rouvre pas.
  h.net.realtimeUp = false;
  h.channels[0].status('CLOSED');
  expect(realtime()).toBe('down');
});
afterEach(async () => { await client.leave(); vi.useRealTimers(); });

describe('Collaboration : le direct se rebranche', () => {
  it('« Réessayer le direct » rebranche un nouveau canal avec un jeton rafraîchi', async () => {
    h.net.realtimeUp = true;
    await client.retryNow();
    expect(h.channels).toHaveLength(2);
    expect(h.channels[0].closed).toBe(true);
    expect(h.setAuth).toHaveBeenCalledWith('jeton-frais');
    expect(realtime()).toBe('live');
  });

  it('retour sur l\'onglet : rebranché tout de suite', async () => {
    h.net.realtimeUp = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.channels).toHaveLength(2);
    expect(realtime()).toBe('live');
  });

  it('chien de garde : nouvel essai après 20 s, puis de plus en plus espacés', async () => {
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.channels).toHaveLength(1);               // pas avant 20 s
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.channels).toHaveLength(2);               // 1er essai (le direct est encore coupé)
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.channels).toHaveLength(3);               // 2e essai 20 s plus tard
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.channels).toHaveLength(3);               // 3e essai : attendre 40 s
    h.net.realtimeUp = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.channels).toHaveLength(4);
    expect(realtime()).toBe('live');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.channels).toHaveLength(4);               // branché : plus d'essai
  });
});
