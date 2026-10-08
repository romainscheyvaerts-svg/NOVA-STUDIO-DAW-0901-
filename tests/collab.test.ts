import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabOp } from '../services/Collab';

/**
 * Collaboration : le serveur (fonction daw-session, via `call`) et le canal
 * Supabase Realtime sont simulés. On vérifie qu'une opération n'est appliquée
 * qu'une fois, jamais avant l'instantané chargé (floorSeq), réessayée en cas
 * d'échec, et que le rattrapage relit une marge en arrière.
 */

const h = vi.hoisted(() => {
  type Handler = { type: string; event: string; cb: (arg: any) => void };
  class FakeChannel {
    handlers: Handler[] = [];
    presence: Record<string, { name: string; role: string }[]> = {};
    track = vi.fn(async () => 'ok');
    send = vi.fn(async () => 'ok');
    constructor(public name: string, public opts: any) {}
    on(type: string, filter: { event: string }, cb: (arg: any) => void) { this.handlers.push({ type, event: filter.event, cb }); return this; }
    subscribe(cb: (status: string) => void) { queueMicrotask(() => cb('SUBSCRIBED')); return this; }
    presenceState() { return this.presence; }
    /** Message reçu d'un autre membre. */
    broadcast(payload: unknown) { this.handlers.filter(x => x.type === 'broadcast' && x.event === 'op').forEach(x => x.cb({ payload })); }
    sync() { this.handlers.filter(x => x.type === 'presence' && x.event === 'sync').forEach(x => x.cb({})); }
  }
  const server = {
    ops: [] as any[],
    nextSeq: 1000,
    calls: [] as { action: string; body: any }[],
    /** Réponse lente / bloquée de ops_since si définie. */
    gate: null as null | Promise<void>,
  };
  const channels: FakeChannel[] = [];
  const call = vi.fn(async (action: string, body: any) => {
    server.calls.push({ action, body });
    if (action === 'join') return { member_key: 'me', last_seq: 0, members: [{ member_key: 'me', role: body.role, display_name: body.name }], channel: 'collab:s1' };
    if (action === 'ops_since') {
      if (server.gate) await server.gate;
      const ops = server.ops.filter(o => o.seq > body.after).sort((a, b) => a.seq - b.seq).slice(0, 500);
      return { ops };
    }
    if (action === 'op') return { seq: server.nextSeq++, role: 'artist', author_name: 'Moi', member_key: 'me', created_at: 'now' };
    throw new Error(`action inattendue ${action}`);
  });
  const removeChannel = vi.fn(async () => 'ok');
  return { FakeChannel, server, channels, call, removeChannel };
});

vi.mock('../services/supabase', () => ({
  catalogSupabase: {
    channel: (name: string, opts: any) => { const c = new h.FakeChannel(name, opts); h.channels.push(c); return c; },
    removeChannel: h.removeChannel,
  },
}));
vi.mock('../services/SessionCloud', () => ({ call: h.call, sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { CollabClient, contentBufferIds, contentOf, isVocalTrack, mixOf, ownsContent, sigOf } from '../services/Collab';
import { Track, TrackType } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

const op = (seq: number, member = 'other', kind = 'clip'): CollabOp =>
  ({ seq, kind, op: { n: seq }, role: 'engineer', author_name: 'Ingé', member_key: member });

/** Attend que la file d'application (série) soit vide. */
const settle = async (c: CollabClient) => {
  for (let i = 0; i < 5; i++) { await (c as any).chain; await Promise.resolve(); }
};

const opsSinceCalls = () => h.server.calls.filter(c => c.action === 'ops_since');

let clients: CollabClient[] = [];
function client(onOp: (o: CollabOp) => any = () => {}) {
  const onPresence = vi.fn();
  const c = new CollabClient({ id: 's1', secret: 'sec' }, 'artist', 'Lina', onOp, onPresence);
  clients.push(c);
  return { c, onPresence };
}

beforeEach(() => {
  h.server.ops = [];
  h.server.calls = [];
  h.server.nextSeq = 1000;
  h.server.gate = null;
  h.channels.length = 0;
  h.call.mockClear();
  h.removeChannel.mockClear();
});
afterEach(async () => {
  for (const c of clients) await c.leave();
  clients = [];
  vi.useRealTimers();
});

describe('CollabClient.join', () => {
  it('rejoint avec rôle et nom, se branche au canal de la session (présence = member_key)', async () => {
    const { c } = client();
    const members = await c.join(0);
    const join = h.server.calls.find(x => x.action === 'join')!;
    expect(join.body).toMatchObject({ id: 's1', secret: 'sec', role: 'artist', name: 'Lina', device_id: expect.any(String) });
    expect(c.memberKey).toBe('me');
    expect(members).toEqual([{ member_key: 'me', role: 'artist', display_name: 'Lina' }]);
    const ch = h.channels[0];
    expect(ch.name).toBe('collab:s1');
    expect(ch.opts.config.presence.key).toBe('me');
    expect(ch.opts.config.broadcast.self).toBe(false);
    expect(ch.track).toHaveBeenCalledWith({ name: 'Lina', role: 'artist' });
  });

  it('rattrape le journal à la connexion et applique dans l\'ordre', async () => {
    h.server.ops = [op(3), op(1), op(2)];
    const seen: number[] = [];
    const { c } = client(o => { seen.push(o.seq); });
    await c.join(0);
    await settle(c);
    expect(seen).toEqual([1, 2, 3]);
    expect(c.lastSeq).toBe(3);
  });

  // (corrigé : join() attend le rattrapage en cours)
  it('join(fromSeq > 0) ne se résout qu\'une fois le rattrapage terminé', async () => {
    let open!: () => void;
    h.server.gate = new Promise<void>(r => { open = r; });
    h.server.ops = [op(6), op(7)];
    const { c } = client();
    let joined = false;
    const p = c.join(5).then(() => { joined = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(joined).toBe(false);
    open();
    await p;
    expect(c.lastSeq).toBe(7);
  });

  it('présence : liste des membres en ligne', async () => {
    const { c, onPresence } = client();
    await c.join(0);
    h.channels[0].presence = { me: [{ name: 'Lina', role: 'artist' }], k2: [{ name: 'Tom', role: 'engineer' }] };
    h.channels[0].sync();
    expect(onPresence).toHaveBeenLastCalledWith([
      { member_key: 'me', role: 'artist', display_name: 'Lina', online: true },
      { member_key: 'k2', role: 'engineer', display_name: 'Tom', online: true },
    ]);
  });
});

describe('CollabClient : application unique', () => {
  it('même opération reçue en direct puis au rattrapage : appliquée une fois', async () => {
    const onOp = vi.fn();
    const { c } = client(onOp);
    await c.join(0);
    h.channels[0].broadcast(op(5));
    h.channels[0].broadcast(op(5));
    h.server.ops = [op(5)];
    await c.catchUp();
    await settle(c);
    expect(onOp).toHaveBeenCalledTimes(1);
  });

  it('floorSeq : rien de ce qui est déjà dans l\'instantané chargé n\'est rejoué', async () => {
    const seen: number[] = [];
    const { c } = client(o => { seen.push(o.seq); });
    h.server.ops = [op(99), op(100), op(101)];
    await c.join(100);
    // join() peut se résoudre avant la fin du rattrapage (voir le todo plus haut)
    await vi.waitFor(() => expect(seen).toEqual([101]));
    await settle(c);
    h.channels[0].broadcast(op(50));
    h.channels[0].broadcast(op(100));
    h.channels[0].broadcast(op(102));
    await settle(c);
    expect(seen).toEqual([101, 102]);
    // Le rattrapage ne relit jamais avant l'instantané
    expect(opsSinceCalls().every(x => x.body.after >= 100)).toBe(true);
  });

  it('nos propres opérations ne sont jamais rejouées', async () => {
    const onOp = vi.fn();
    const { c } = client(onOp);
    await c.join(0);
    const seq = await c.send('mix', { vol: 1 });
    expect(seq).toBe(1000);
    expect(h.server.calls.find(x => x.action === 'op')!.body).toMatchObject({ id: 's1', secret: 'sec', kind: 'mix', op: { vol: 1 } });
    expect(h.channels[0].send).toHaveBeenCalledWith({
      type: 'broadcast', event: 'op',
      payload: { seq: 1000, kind: 'mix', op: expect.objectContaining({ vol: 1, _id: expect.any(String), _d: expect.any(String) }), role: 'artist', author_name: 'Moi', member_key: 'me', created_at: 'now' },
    });
    // Écho au rattrapage, ou opération d'un autre appareil sous notre clé
    h.server.ops = [{ ...op(1000, 'me'), kind: 'mix' }, op(1001, 'me')];
    await c.catchUp();
    await settle(c);
    expect(onOp).not.toHaveBeenCalled();
  });

  it('opérations appliquées en série (une lente ne se fait pas doubler)', async () => {
    const log: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>(r => { release = r; });
    const { c } = client(async o => {
      log.push(`début ${o.seq}`);
      if (o.seq === 1) await slow;
      log.push(`fin ${o.seq}`);
    });
    await c.join(0);
    h.channels[0].broadcast(op(1));
    h.channels[0].broadcast(op(2));
    await Promise.resolve(); await Promise.resolve();
    expect(log).toEqual(['début 1']);
    release();
    await settle(c);
    expect(log).toEqual(['début 1', 'fin 1', 'début 2', 'fin 2']);
  });

  it('opération invalide ignorée', async () => {
    const onOp = vi.fn();
    const { c } = client(onOp);
    await c.join(0);
    h.channels[0].broadcast(null);
    h.channels[0].broadcast({ kind: 'x' });
    h.channels[0].broadcast({ seq: '3', kind: 'x' });
    await settle(c);
    expect(onOp).not.toHaveBeenCalled();
  });
});

describe('CollabClient : échecs et réessais', () => {
  it('échec (audio pas encore là) : réessayée au rattrapage suivant, puis réussie', async () => {
    let fail = true;
    const onOp = vi.fn(async () => { if (fail) throw new Error('audio introuvable'); });
    const { c } = client(onOp);
    await c.join(0);
    h.channels[0].broadcast(op(7));
    await settle(c);
    expect(onOp).toHaveBeenCalledTimes(1);
    fail = false;
    await c.catchUp();
    await settle(c);
    expect(onOp).toHaveBeenCalledTimes(2);
    // Réussie : plus jamais rejouée
    await c.catchUp();
    await settle(c);
    expect(onOp).toHaveBeenCalledTimes(2);
  });

  it('6 échecs : abandon signalé par onFailure, plus de réessai', async () => {
    const onOp = vi.fn(async () => { throw new Error('KO'); });
    const { c } = client(onOp);
    const onFailure = vi.fn();
    c.onFailure = onFailure;
    await c.join(0);
    h.channels[0].broadcast(op(7));
    await settle(c);
    for (let i = 0; i < 8; i++) { await c.catchUp(); await settle(c); }
    expect(onOp).toHaveBeenCalledTimes(6);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].seq).toBe(7);
  });

  // (corrigé : une opération déjà en file n'est pas remise en file)
  it('une opération en échec dont le réessai est encore en file n\'est pas remise en file', async () => {
    let release: (() => void) | null = null;
    let n = 0;
    const onOp = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('KO');
      await new Promise<void>(r => { release = r; });
    });
    const { c } = client(onOp);
    await c.join(0);
    h.channels[0].broadcast(op(7));
    await settle(c);
    await c.catchUp();
    for (let i = 0; i < 50 && !release; i++) await new Promise(r => setTimeout(r, 1));
    await c.catchUp();
    await c.catchUp();
    (release as unknown as () => void)();
    await settle(c);
    expect(onOp).toHaveBeenCalledTimes(2);
  });

  it('erreur réseau pendant le rattrapage : pas d\'exception, le suivant repart', async () => {
    const onOp = vi.fn();
    const { c } = client(onOp);
    await c.join(0);
    h.call.mockImplementationOnce(async () => { throw new Error('réseau'); });
    await expect(c.catchUp()).resolves.toBeUndefined();
    h.server.ops = [op(4)];
    await c.catchUp();
    await settle(c);
    expect(onOp).toHaveBeenCalledTimes(1);
  });
});

describe('CollabClient : rattrapage avec marge', () => {
  it('relit 50 opérations en arrière (numéros validés dans le désordre)', async () => {
    const seen: number[] = [];
    const { c } = client(o => { seen.push(o.seq); });
    h.server.ops = [op(990), op(1000)];
    await c.join(0);
    await settle(c);
    expect(c.lastSeq).toBe(1000);
    // L'opération 995 est validée après la 1000 : la marge la récupère.
    h.server.ops.push(op(995));
    await c.catchUp();
    await settle(c);
    expect(opsSinceCalls().at(-1)!.body.after).toBe(950);
    expect(seen).toEqual([990, 1000, 995]);
  });

  it('la marge ne descend jamais sous floorSeq', async () => {
    const { c } = client();
    await c.join(980);
    await vi.waitFor(() => expect(opsSinceCalls().length).toBeGreaterThan(0));
    await c.catchUp();
    expect(opsSinceCalls().every(x => x.body.after === 980)).toBe(true);
  });

  it('pagination : 500 opérations par page, on continue après la dernière', async () => {
    const seen: number[] = [];
    const { c } = client(o => { seen.push(o.seq); });
    h.server.ops = Array.from({ length: 620 }, (_, i) => op(i + 1));
    await c.join(0);
    await settle(c);
    expect(seen.length).toBe(620);
    expect(opsSinceCalls().map(x => x.body.after)).toEqual([0, 500]);
    expect(c.lastSeq).toBe(620);
  });

  it('rattrapage automatique toutes les 10 s, arrêté par leave()', async () => {
    vi.useFakeTimers();
    const { c } = client();
    const joining = c.join(0);
    await vi.advanceTimersByTimeAsync(0);
    await joining;
    const n0 = opsSinceCalls().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opsSinceCalls().length).toBe(n0 + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opsSinceCalls().length).toBe(n0 + 2);
    await c.leave();
    expect(h.removeChannel).toHaveBeenCalledWith(h.channels[0]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(opsSinceCalls().length).toBe(n0 + 2);
  });
});

// --- Domaines : qui possède quoi ------------------------------------------------

describe('isVocalTrack / ownsContent', () => {
  const voice = makeTrack({ id: 'v', type: TrackType.AUDIO });
  const beat = makeTrack({ id: 'instrumental', type: TrackType.AUDIO, instrumentId: 'x' });
  const catalog = makeTrack({ id: 'cat', type: TrackType.AUDIO, instrumentId: 'x' });
  const drums = makeTrack({ id: 'd', type: TrackType.DRUM_RACK });
  const midi = makeTrack({ id: 'm', type: TrackType.MIDI });
  const sampler = makeTrack({ id: 's', type: TrackType.SAMPLER });
  const bus = makeTrack({ id: 'b', type: TrackType.BUS });
  const send = makeTrack({ id: 'send-verb-short', type: TrackType.SEND });
  const master = makeTrack({ id: 'master', type: TrackType.AUDIO });

  it('isVocalTrack', () => {
    expect(isVocalTrack(voice)).toBe(true);
    expect(isVocalTrack(beat)).toBe(false);
    expect(isVocalTrack(catalog)).toBe(false);
    expect(isVocalTrack(midi)).toBe(false);
    expect(isVocalTrack({ ...voice, collabOwner: 'engineer' })).toBe(false);
    expect(isVocalTrack({ ...voice, collabOwner: 'artist' })).toBe(true);
  });

  it('voix -> artiste ; batterie / MIDI / sampler -> beatmaker', () => {
    expect(ownsContent(voice, 'artist')).toBe(true);
    expect(ownsContent(voice, 'engineer')).toBe(false);
    expect(ownsContent(voice, 'beatmaker')).toBe(false);
    for (const t of [drums, midi, sampler]) {
      expect(ownsContent(t, 'beatmaker')).toBe(true);
      expect(ownsContent(t, 'artist')).toBe(false);
    }
  });

  it('beat, master, bus et envois : à personne', () => {
    for (const t of [beat, master, bus, send]) {
      for (const r of ['artist', 'engineer', 'beatmaker'] as const) expect(ownsContent(t, r)).toBe(false);
    }
    // Même avec un propriétaire explicite
    expect(ownsContent({ ...beat, collabOwner: 'artist' }, 'artist')).toBe(false);
  });

  it('propriétaire explicite prioritaire', () => {
    expect(ownsContent({ ...voice, collabOwner: 'beatmaker' }, 'beatmaker')).toBe(true);
    expect(ownsContent({ ...voice, collabOwner: 'beatmaker' }, 'artist')).toBe(false);
    expect(ownsContent({ ...midi, collabOwner: 'artist' }, 'artist')).toBe(true);
  });
});

describe('contentOf / mixOf / contentBufferIds / sigOf', () => {
  const t = (over: Partial<Track> = {}) => makeTrack({
    id: 't1', name: 'Voix', volume: 0.7, pan: -0.2,
    clips: [
      { ...makeClip({ id: 'c1', bufferId: 'b1', audioRef: 'audio/b1.wav', isFreezeSlice: true }), buffer: {} as AudioBuffer },
      makeClip({ id: 'c2', bufferId: 'b1' }),
      makeClip({ id: 'c3', bufferId: 'b2' }),
    ],
    ...over,
  });

  it('contentOf : les réglages de la 808 voyagent avec les notes', () => {
    const c = contentOf(t({ type: 'MIDI' as any, bass808: { style: '808', glide: true } }));
    expect(c.bass808).toEqual({ style: '808', glide: true });
  });

  it('contentOf : clips sans buffer / audioRef / tranche de gel, sans réglages de mix', () => {
    const c = contentOf(t());
    expect(c.clips.map(x => x.id)).toEqual(['c1', 'c2', 'c3']);
    for (const k of ['buffer', 'audioRef', 'isFreezeSlice']) expect(k in c.clips[0]).toBe(false);
    expect(c.clips[0].bufferId).toBe('b1');
    expect(c).not.toHaveProperty('volume');
    expect(c).not.toHaveProperty('pan');
    expect(c).not.toHaveProperty('plugins');
    expect(c.instrumentRender).toBeUndefined();
  });

  it('contentOf : pads sans buffer ; instrument VST sans son du plugin, rendu joint si gelé', () => {
    const tr = t({
      drumPads: [{ id: 1, name: 'Kick', sampleName: 'k', volume: 1, pan: 0, isMuted: false, isSolo: false, midiNote: 60, buffer: {} as AudioBuffer }],
      vstInstrument: { name: 'Serum', path: 'C:/serum.vst3', stateB64: 'AAAA' },
      isFrozen: true,
      frozenClip: { ...makeClip({ id: 'fz', bufferId: 'fzb' }), audioRef: 'x' },
      frozenClipIds: ['c1'], frozenSourceSig: 'sig',
    });
    const c = contentOf(tr);
    expect('buffer' in c.drumPads![0]).toBe(false);
    expect(c.vstInstrument).toMatchObject({ name: 'Serum', path: 'C:/serum.vst3', stateB64: undefined });
    expect(c.instrumentRender).toMatchObject({ frozenClipIds: ['c1'], frozenSourceSig: 'sig' });
    expect(c.instrumentRender!.frozenClip.id).toBe('fz');
    expect('audioRef' in c.instrumentRender!.frozenClip).toBe(false);
    expect(contentBufferIds(tr)).toEqual(['b1', 'b2', 'fzb']);
    // Pas gelé : pas de rendu joint
    expect(contentOf({ ...tr, isFrozen: false }).instrumentRender).toBeUndefined();
    expect(contentBufferIds({ ...tr, isFrozen: false })).toEqual(['b1', 'b2']);
  });

  it('contentBufferIds : uniques, sans rendu gelé pour une piste audio', () => {
    expect(contentBufferIds(t())).toEqual(['b1', 'b2']);
    expect(contentBufferIds(t({ isFrozen: true, frozenClip: makeClip({ bufferId: 'fz' }) }))).toEqual(['b1', 'b2']);
  });

  it('mixOf : volume omis quand l\'artiste l\'a verrouillé', () => {
    const m = mixOf(t());
    expect(m).toMatchObject({ volume: 0.7, pan: -0.2, isMuted: false, outputTrackId: 'master' });
    expect(m.sends).toHaveLength(2);
    const locked = mixOf(t({ volumeLock: { volume: 0.9, by: 'Lina', at: 1 } }));
    expect(locked.volume).toBeUndefined();
    expect(locked.pan).toBe(-0.2);
  });

  it('sigOf : stable, sensible au moindre changement', () => {
    const a = sigOf(contentOf(t()));
    expect(sigOf(contentOf(t()))).toBe(a);
    expect(a).toMatch(/^\d+:[0-9a-f]+$/);
    const moved = t();
    moved.clips[2].start = 0.001;
    expect(sigOf(contentOf(moved))).not.toBe(a);
    expect(sigOf(mixOf(t()))).not.toBe(sigOf(mixOf(t({ pan: 0.3 }))));
    expect(sigOf(undefined)).toBe(sigOf(undefined));
  });
});

describe('instantané : jusqu’où tout est appliqué (safeSeq)', () => {
  it('une opération en échec (audio pas encore en ligne) n’est jamais annoncée comme contenue dans l’instantané', async () => {
    h.server.ops = [op(1001), op(1002), op(1003)];
    const { c } = client(o => { if (o.seq === 1002) throw new Error('audio pas encore en ligne'); });
    await c.join(0);
    await settle(c);
    await Promise.resolve();
    expect(c.lastSeq).toBe(1003);
    expect(c.safeSeq).toBe(1001); // 1002 a échoué : celui qui arrive doit la rejouer
  });
});
