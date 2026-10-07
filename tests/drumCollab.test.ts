import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V16 : un motif de batterie modifié voyage en collaboration (opération
 * « content ») : motifs, placement, fill, groove et pads perso arrivent tels
 * quels chez l'autre, et l'autre rejoue exactement les mêmes notes.
 * Le serveur et le canal Realtime sont simulés (comme dans collab.test.ts).
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
  let seq = 500;
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
import { TrackType, Track } from '../types';
import { makeDrumMachine, DrumMachine } from '../utils/drumKits';
import { addPattern, commitActive, drumSongClips, placePattern } from '../utils/drumPatterns';
import { assignSample } from '../utils/drumSamples';
import { makeTrack } from './helpers/fixtures';

const BPM = 120;
const clients: CollabClient[] = [];
beforeEach(() => { h.channels.length = 0; });
afterEach(async () => { for (const c of clients) await c.leave(); clients.length = 0; });

function drumTrack(dm: DrumMachine): Track {
  const d = commitActive(dm);
  return makeTrack({ id: 'track-drums', type: TrackType.DRUM_RACK, drumMachine: d, clips: drumSongClips(d, BPM, 16, 'c') as any });
}

describe('collaboration : un motif modifié voyage', () => {
  it('le beatmaker modifie le motif B et le place : l\'ingé reçoit la même batterie et les mêmes notes', async () => {
    // Batterie de départ : A + B, couplet = A, refrain = B, un pad perso.
    let dm = makeDrumMachine('trap');
    dm = addPattern(dm);
    const b = dm.activePattern!;
    dm = assignSample(dm, 'k1', { name: 'Mon kick', duration: 0.4 }, {})!.dm;
    const a = dm.patterns![0].id;
    dm = placePattern(placePattern(dm, a, 0, 4, 8), b, 4, 8, 8);
    const before = drumTrack(dm);

    // Modification : 3 coups de caisse claire dans B, fill toutes les 4 mesures, groove MPC.
    const edited = drumTrack({
      ...dm, fill: { every: 4 }, groove: 'mpc',
      rows: dm.rows.map(r => (r.id === 'snare' ? { ...r, steps: r.steps.map((_, i) => (i === 4 || i === 12 || i === 14 ? 110 : 0)) } : r)),
    });
    expect(sigOf(contentOf(edited))).not.toBe(sigOf(contentOf(before)));

    // Le beatmaker envoie l'opération « content » (comme App.tsx)…
    const sender = new CollabClient({ id: 's1', secret: 'x' }, 'beatmaker' as any, 'bm', () => {}, () => {});
    clients.push(sender);
    await sender.join(0);
    await sender.send('content', { trackId: edited.id, content: contentOf(edited), audio: [] });
    const sent = (h.channels[0].send.mock.calls[0] as any[])[0].payload;

    // … l'ingé la reçoit par le canal.
    const received: any[] = [];
    const receiver = new CollabClient({ id: 's1', secret: 'x' }, 'engineer' as any, 'inge', o => { received.push(o); }, () => {});
    clients.push(receiver);
    await receiver.join(0);
    h.channels[1].broadcast(JSON.parse(JSON.stringify(sent)));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const got = received[0].op.content.drumMachine as DrumMachine;
    expect(received[0].kind).toBe('content');
    expect(got).toEqual(JSON.parse(JSON.stringify(edited.drumMachine)));
    expect(got.patterns!.find(p => p.id === b)!.steps.snare.filter(v => v > 0)).toHaveLength(3);
    expect(got.song!.slice(0, 8)).toEqual([a, a, a, a, b, b, b, b]);
    expect(got.samples!.k1.name).toBe('Mon kick');
    // L'ingé régénère exactement les mêmes notes que le beatmaker.
    const theirs = drumSongClips(got, BPM, 16, 'c');
    expect(theirs.map(c => c.notes)).toEqual(edited.clips.map(c => c.notes));
    expect(received[0].op.content.clips.map((c: any) => c.name)).toEqual(['Motif A', 'Motif B']);
  });

  it('une ancienne version (sans motifs) lit encore le motif affiché dans rows', () => {
    let dm = addPattern(makeDrumMachine('trap'));
    dm = { ...dm, rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, steps: r.steps.map((_, i) => (i === 3 ? 100 : 0)) } : r)) };
    const wire = JSON.parse(JSON.stringify(contentOf(drumTrack(dm)))).drumMachine;
    const legacy = { kitId: wire.kitId, bars: wire.bars, swing: wire.swing, rows: wire.rows };
    expect(legacy.rows.find((r: any) => r.id === 'kick').steps[3]).toBe(100);
    expect(legacy.rows.every((r: any) => Array.isArray(r.steps) && Array.isArray(r.ratchet))).toBe(true);
  });
});
