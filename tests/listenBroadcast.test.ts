import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Diffusion du mix aux clients des liens d'écoute (services/ListenBroadcast) et
 * réception chez le client (services/ListenReceiver), avec un faux canal
 * Supabase Realtime et une fausse liaison WebRTC : on vérifie QUI reçoit le mix
 * (seulement les clients présents qui ont demandé à écouter, sur les liens actifs
 * avec le direct) et qu'un lien révoqué ou expiré n'est plus servi.
 */

const { FakeChannel, channels, FakeRtc, rtcs, listResult } = vi.hoisted(() => {
  type Cb = (arg: any) => void;
  class FakeChannel {
    handlers: { type: string; event: string; cb: Cb }[] = [];
    tracked: any[] = [];
    sent: any[] = [];
    state: Record<string, any[]> = {};
    removed = false;
    untracked = false;
    constructor(public name: string, public opts: any) {}
    on(type: string, filter: { event: string }, cb: Cb) { this.handlers.push({ type, event: filter.event, cb }); return this; }
    subscribe(cb: (s: string) => void) { cb('SUBSCRIBED'); return this; }
    track(meta: any) { this.tracked.push(meta); return Promise.resolve('ok'); }
    untrack() { this.untracked = true; return Promise.resolve('ok'); }
    send(msg: any) { this.sent.push(msg); return Promise.resolve('ok'); }
    presenceState() { return this.state; }
    /** Simule la présence (sync) ou un message reçu. */
    sync(state: Record<string, any[]>) { this.state = state; this.handlers.filter(h => h.type === 'presence' && h.event === 'sync').forEach(h => h.cb({})); }
    receive(event: string, payload: any) { this.handlers.filter(h => h.type === 'broadcast' && h.event === event).forEach(h => h.cb({ payload })); }
  }
  const channels: any[] = [];
  const rtcs: any[] = [];
  class FakeRtc {
    peers: string[][] = [];
    handled: any[] = [];
    local: [string, any][] = [];
    resyncs: string[] = [];
    closed = false;
    constructor(public o: any) { rtcs.push(this); }
    setPeers(k: string[]) { this.peers.push(k); }
    setLocal(kind: string, s: any) { this.local.push([kind, s]); }
    handle(sig: any) { this.handled.push(sig); return Promise.resolve(); }
    requestResync(peer: string) { this.resyncs.push(peer); }
    connectionStates() { return {}; }
    close() { this.closed = true; }
    health() { return Promise.resolve('son'); }
    quality() { return { stereo: true, kbps: 510 }; }
  }
  const listResult: { links: any[] } = { links: [] };
  return { FakeChannel, channels, FakeRtc, rtcs, listResult };
});

vi.mock('../services/supabase', () => ({
  catalogSupabase: {
    channel: (name: string, opts: any) => { const c = new FakeChannel(name, opts); channels.push(c); return c; },
    removeChannel: (c: any) => { c.removed = true; return Promise.resolve('ok'); },
  },
}));

vi.mock('../services/CollabRtc', () => ({ CollabRtc: FakeRtc }));

vi.mock('../services/ListenLinks', () => ({ listListenLinks: vi.fn(async () => listResult.links) }));

import { ListenHost } from '../services/ListenBroadcast';
import { ListenReceiver } from '../services/ListenReceiver';

const link = (id: string, extra: Record<string, unknown> = {}) => ({
  id, token: 'T'.repeat(32), label: '', live: true, versions: true, comments: false, has_password: false,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), channel: `nova-listen-${id}`, opens: 0, last_opened_at: null, ...extra,
});
const stream = { getAudioTracks: () => [{ id: 'piste' }] } as unknown as MediaStream;
const S = { id: 'abcdefghijkl', secret: 's'.repeat(32) };

beforeEach(() => { channels.length = 0; rtcs.length = 0; listResult.links = []; });
afterEach(() => { vi.useRealTimers(); });

describe('ListenHost (ingé) : qui reçoit le mix', () => {
  it('sans séance ou sans moteur audio : message clair, rien ne part', async () => {
    const h = new ListenHost();
    expect(await h.start(async () => stream)).toBe(false);
    expect(h.state().error).toMatch(/séance en ligne/);
    h.configure(S, 'Max');
    expect(await h.start(async () => null)).toBe(false);
    expect(h.state().error).toMatch(/moteur audio/);
    expect(channels).toHaveLength(0);
  });

  it('rejoint seulement les liens actifs avec le direct, s\'annonce « host » et envoie le mix', async () => {
    const h = new ListenHost();
    h.configure(S, 'Max');
    h.setLinks([link('aaaaaaaaaaaaaaaa'), link('bbbbbbbbbbbbbbbb', { live: false }), link('cccccccccccccccc', { expires_at: new Date(Date.now() - 1000).toISOString() })]);
    expect(await h.start(async () => stream)).toBe(true);
    expect(channels.map(c => c.name)).toEqual(['nova-listen-aaaaaaaaaaaaaaaa']);
    expect(channels[0].tracked[0]).toEqual({ role: 'host', live: true, name: 'Max' });
    expect(channels[0].opts.config.presence.key).toMatch(/^h-/);
    expect(rtcs[0].local).toEqual([['mix', stream]]);
    h.stop();
  });

  it('le mix ne part qu\'aux clients présents qui ont touché « Écouter » ; signaux des autres ignorés', async () => {
    const h = new ListenHost();
    h.configure(S, 'Max');
    h.setLinks([link('aaaaaaaaaaaaaaaa')]);
    await h.start(async () => stream);
    const ch = channels[0], rtc = rtcs[0];
    ch.sync({ 'l-client01': [{ role: 'listener', want: true }], 'l-client02': [{ role: 'listener', want: false }], 'h-intrus': [{ role: 'host', live: true }] });
    expect(rtc.peers.at(-1)).toEqual(['l-client01']);
    expect(h.state().links.aaaaaaaaaaaaaaaa).toMatchObject({ visitors: 2, listening: 1 });
    const me = ch.opts.config.presence.key;
    ch.receive('rtc', { from: 'l-client02', to: me, type: 'offer', sdp: 'x' });
    ch.receive('rtc', { from: 'l-client01', to: 'h-autre', type: 'answer', sdp: 'x' });
    expect(rtc.handled).toHaveLength(0);
    ch.receive('rtc', { from: 'l-client01', to: me, type: 'answer', sdp: 'x' });
    expect(rtc.handled).toHaveLength(1);
    // Le client arrête : il ne reçoit plus rien.
    ch.sync({ 'l-client01': [{ role: 'listener', want: false }] });
    expect(rtc.peers.at(-1)).toEqual([]);
    h.stop();
  });

  it('révocation : le lien est quitté tout de suite (clients coupés), canal retiré', async () => {
    const h = new ListenHost();
    h.configure(S, 'Max');
    h.setLinks([link('aaaaaaaaaaaaaaaa'), link('dddddddddddddddd')]);
    await h.start(async () => stream);
    expect(channels).toHaveLength(2);
    h.forget('aaaaaaaaaaaaaaaa');
    expect(rtcs[0].closed).toBe(true);
    expect(channels[0].removed).toBe(true);
    expect(channels[0].untracked).toBe(true);
    expect(rtcs[1].closed).toBe(false);
    expect(Object.keys(h.state().links)).toEqual(['dddddddddddddddd']);
    h.stop();
    expect(rtcs[1].closed).toBe(true);
    expect(h.state().on).toBe(false);
  });

  it('expiration pendant la diffusion : quitté dans les 5 s ; révoqué ailleurs : quitté à la relecture (20 s)', async () => {
    vi.useFakeTimers();
    const h = new ListenHost();
    h.configure(S, 'Max');
    const soon = link('eeeeeeeeeeeeeeee', { expires_at: new Date(Date.now() + 3000).toISOString() });
    const other = link('ffffffffffffffff');
    h.setLinks([soon, other]);
    await h.start(async () => stream);
    expect(channels).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(channels[0].removed).toBe(true);
    expect(channels[1].removed).toBe(false);
    listResult.links = []; // révoqué depuis un autre appareil
    await vi.advanceTimersByTimeAsync(20_000);
    expect(channels[1].removed).toBe(true);
    h.stop();
  });

  it('une autre séance arrête la diffusion', async () => {
    const h = new ListenHost();
    h.configure(S, 'Max');
    h.setLinks([link('aaaaaaaaaaaaaaaa')]);
    await h.start(async () => stream);
    h.configure({ id: 'zzzzzzzzzzzz', secret: 'x'.repeat(32) }, 'Max');
    expect(h.state().on).toBe(false);
    expect(rtcs[0].closed).toBe(true);
  });
});

describe('ListenReceiver (client) : écoute seule', () => {
  it('« En direct » d\'après la présence de l\'ingé ; Écouter = présence want ; signaux acceptés de l\'ingé seulement', () => {
    vi.useFakeTimers();
    const states: any[] = [];
    const r = new ListenReceiver('nova-listen-aaaaaaaaaaaaaaaa', s => states.push(s));
    r.start();
    const ch = channels[0], rtc = rtcs[0];
    expect(ch.opts.config.presence.key).toMatch(/^l-/);
    expect(ch.tracked.at(-1)).toEqual({ role: 'listener', want: false });
    expect(r.st.channel).toBe('live');
    ch.sync({ 'h-inge0001': [{ role: 'host', live: true, name: 'Max' }] });
    expect(r.st.host).toEqual({ live: true, name: 'Max' });
    r.setWant(true);
    expect(ch.tracked.at(-1)).toEqual({ role: 'listener', want: true });
    const me = ch.opts.config.presence.key;
    ch.receive('rtc', { from: 'l-autreclient', to: me, type: 'offer', sdp: 'x' });
    ch.receive('rtc', { from: 'h-imposteur', to: me, type: 'offer', sdp: 'x' });
    expect(rtc.handled).toHaveLength(0);
    ch.receive('rtc', { from: 'h-inge0001', to: me, type: 'offer', sdp: 'x' });
    expect(rtc.handled).toHaveLength(1);
    // Rien reçu au bout de 4 s : reprise demandée à l'ingé.
    vi.advanceTimersByTime(5_200);
    expect(rtc.resyncs).toContain('h-inge0001');
    r.setWant(false);
    expect(ch.tracked.at(-1)).toEqual({ role: 'listener', want: false });
    r.stop();
    expect(ch.removed).toBe(true);
    expect(rtc.closed).toBe(true);
  });

  it('le flux reçu de l\'ingé est joué ; un flux d\'un autre est ignoré', () => {
    const r = new ListenReceiver('nova-listen-aaaaaaaaaaaaaaaa', () => {});
    r.start();
    const ch = channels[0], rtc = rtcs[0];
    ch.sync({ 'h-inge0001': [{ role: 'host', live: true }] });
    rtc.o.onRemote('h-autre', 'mix', stream);
    expect(r.st.stream).toBeNull();
    rtc.o.onRemote('h-inge0001', 'talk', stream);
    expect(r.st.stream).toBeNull();
    rtc.o.onRemote('h-inge0001', 'mix', stream);
    expect(r.st.stream).toBe(stream);
    rtc.o.onRemote('h-inge0001', 'mix', null);
    expect(r.st.stream).toBeNull();
    r.stop();
  });
});
