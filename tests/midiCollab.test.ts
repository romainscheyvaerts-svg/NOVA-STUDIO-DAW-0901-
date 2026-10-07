import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V25 : en collaboration, une transformation MIDI (outil du piano roll, groove,
 * clip capturé, .mid importé) est UNE écriture de la piste, donc UNE opération
 * « content » ; l'autre reçoit exactement les mêmes notes. Serveur et canal
 * Realtime simulés (comme drumCollab.test.ts).
 */

const h = vi.hoisted(() => {
  type Handler = { type: string; event: string; cb: (arg: any) => void };
  class FakeChannel {
    handlers: Handler[] = [];
    send = vi.fn(async () => 'ok');
    track = vi.fn(async () => 'ok');
    constructor(public name: string, public opts: any) {}
    on(type: string, filter: { event: string }, cb: (arg: any) => void) { this.handlers.push({ type, event: filter.event, cb }); return this; }
    subscribe(cb: (status: string) => void) { queueMicrotask(() => cb('SUBSCRIBED')); return this; }
    presenceState() { return {}; }
    broadcast(payload: unknown) { this.handlers.filter(x => x.type === 'broadcast' && x.event === 'op').forEach(x => x.cb({ payload })); }
  }
  const channels: FakeChannel[] = [];
  let seq = 900;
  const call = vi.fn(async (action: string, body: any) => {
    if (action === 'join') return { member_key: body.name, last_seq: 0, members: [], channel: 'collab:s1' };
    if (action === 'ops_since') return { ops: [] };
    if (action === 'op') return { seq: seq++, role: 'beatmaker', author_name: 'Beatmaker', member_key: 'bm', created_at: 'now' };
    throw new Error(`action inattendue ${action}`);
  });
  return { FakeChannel, channels, call };
});

vi.mock('../services/supabase', () => ({
  catalogSupabase: {
    channel: (name: string, opts: any) => { const c = new h.FakeChannel(name, opts); h.channels.push(c); return c; },
    removeChannel: vi.fn(async () => 'ok'),
  },
}));
vi.mock('../services/SessionCloud', () => ({ call: h.call, sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { CollabClient, contentOf, sigOf } from '../services/Collab';
import { MidiNote, Track, TrackType } from '../types';
import { roll, strum } from '../utils/midiTools';
import { setClipGroove, swingTemplate, applyGroove } from '../utils/groove';
import { makeTrack } from './helpers/fixtures';

const clients: CollabClient[] = [];
beforeEach(() => { h.channels.length = 0; h.call.mockClear(); });
afterEach(async () => { for (const c of clients) await c.leave(); clients.length = 0; });

const hats: MidiNote[] = [0, 0.25, 0.5, 0.75].map((s, i) => ({ id: `h${i}`, pitch: 63, start: s, duration: 0.25, velocity: 0.8 }));
const midiTrack = (notes: MidiNote[], extra: any = {}): Track => makeTrack({
  id: 'track-hats', name: 'HATS', type: TrackType.MIDI,
  clips: [{ id: 'c1', start: 0, duration: 2, offset: 0, fadeIn: 0, fadeOut: 0, name: 'Hats', color: '#fff', type: TrackType.MIDI, notes, ...extra }],
});

/**
 * Comme App.tsx : une piste dont l'empreinte de contenu change devient « à
 * envoyer » ; toutes les 10 s, une opération par piste à envoyer.
 */
function dirtyAfter(states: Track[][]): number {
  const known = new Map<string, string>();
  states[0].forEach(t => known.set(t.id, sigOf(contentOf(t))));
  const dirty = new Set<string>();
  for (const s of states.slice(1)) for (const t of s) if (known.get(t.id) !== sigOf(contentOf(t))) dirty.add(t.id);
  return dirty.size;
}

async function sendAndReceive(track: Track) {
  const sender = new CollabClient({ id: 's1', secret: 'x' }, 'beatmaker' as any, 'bm', () => {}, () => {});
  clients.push(sender);
  await sender.join(0);
  await sender.send('content', { trackId: track.id, content: contentOf(track), audio: [] });
  const opCalls = h.call.mock.calls.filter(c => c[0] === 'op');
  const sent = (h.channels[0].send.mock.calls[0] as any[])[0].payload;
  const received: any[] = [];
  const receiver = new CollabClient({ id: 's1', secret: 'x' }, 'engineer' as any, 'inge', o => { received.push(o); }, () => {});
  clients.push(receiver);
  await receiver.join(0);
  h.channels[1].broadcast(JSON.parse(JSON.stringify(sent)));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  return { opCalls: opCalls.length, op: received[0] };
}

describe('collaboration : une transformation MIDI = une opération', () => {
  it('roll de hi-hats (outil du piano roll) : une seule écriture, une seule opération, mêmes notes chez l’autre', async () => {
    const before = midiTrack(hats);
    // Le piano roll écrit le résultat de l'outil en une fois (applyToolResult).
    const rolled = roll(hats, new Set(['h3']), { bpm: 120 }, { rate: '1/32', ramp: 'up', from: 0.4, to: 1 });
    const after = midiTrack(rolled);
    expect(rolled).toHaveLength(3 + 4);
    expect(dirtyAfter([[before], [after]])).toBe(1);

    const { opCalls, op } = await sendAndReceive(after);
    expect(opCalls).toBe(1);
    expect(op.kind).toBe('content');
    expect(op.op.content.clips[0].notes).toEqual(JSON.parse(JSON.stringify(rolled)));
  });

  it('strum puis groove réglé trois fois en moins de 10 s : la piste part une seule fois, avec son groove', async () => {
    const before = midiTrack(hats);
    const s1 = midiTrack(strum(hats, null, { bpm: 120 }, { direction: 'up', spreadMs: 20 }));
    const clip = s1.clips[0];
    const g1 = setClipGroove(clip, { template: swingTemplate(16, 55), amount: 1, velocity: 0 }, 120);
    const g2 = setClipGroove({ ...clip, ...g1 }, { template: swingTemplate(16, 58), amount: 1, velocity: 0 }, 120);
    const g3 = setClipGroove({ ...clip, ...g2 }, { template: swingTemplate(16, 62), amount: 0.8, velocity: 0.5 }, 120);
    const states = [[before], [s1], [midiTrack(g1.notes, { groove: g1.groove })], [midiTrack(g2.notes, { groove: g2.groove })], [midiTrack(g3.notes, { groove: g3.groove })]];
    expect(dirtyAfter(states)).toBe(1);

    const final = states[4][0];
    const { opCalls, op } = await sendAndReceive(final);
    expect(opCalls).toBe(1);
    const got = op.op.content.clips[0];
    // Une ancienne version lit seulement `notes` : elle joue déjà le clip groové.
    expect(got.notes).toEqual(JSON.parse(JSON.stringify(g3.notes)));
    // NOVA à jour : le groove reste réglable chez l'autre (même résultat recalculé).
    expect(applyGroove(got.groove.source, got.groove, { bpm: 120, clipStart: 0 })).toEqual(JSON.parse(JSON.stringify(g3.notes)));
  });
});
