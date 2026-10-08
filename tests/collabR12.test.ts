import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabOp } from '../services/Collab';

/**
 * Collaboration (R12) : groupes et opérations sur le temps. Serveur
 * (daw-session) et canal Supabase Realtime simulés, comme collabTempo.test.ts.
 */

const h = vi.hoisted(() => {
  type Handler = { type: string; event: string; cb: (arg: any) => void };
  class FakeChannel {
    handlers: Handler[] = [];
    presence: Record<string, { name: string; role: string }[]> = {};
    statusCb: ((s: string) => void) | null = null;
    track = vi.fn(async () => 'ok');
    send = vi.fn(async () => 'ok');
    constructor(public name: string, public opts: any) {}
    on(type: string, filter: { event: string }, cb: (arg: any) => void) { this.handlers.push({ type, event: filter.event, cb }); return this; }
    subscribe(cb: (status: string) => void) { this.statusCb = cb; if (net.realtimeUp) queueMicrotask(() => cb('SUBSCRIBED')); return this; }
    presenceState() { return this.presence; }
    broadcast(payload: unknown) { this.handlers.filter(x => x.type === 'broadcast' && x.event === 'op').forEach(x => x.cb({ payload })); }
    status(s: string) { this.statusCb?.(s); }
  }
  const net = { up: true, realtimeUp: true, loseResponses: 0, uploadFailAt: -1 };
  const server = {
    ops: [] as any[],
    nextSeq: 1000,
    calls: [] as { action: string; body: any }[],
    stored: new Set<string>(),
    uploads: [] as string[],
  };
  const channels: FakeChannel[] = [];
  const call = vi.fn(async (action: string, body: any) => {
    server.calls.push({ action, body });
    if (!net.up) throw new Error('Failed to fetch');
    if (action === 'join') return { member_key: 'u:moi', last_seq: server.ops.length ? Math.max(...server.ops.map(o => o.seq)) : 0, members: [], channel: 'collab:s1' };
    if (action === 'ops_since') return { ops: server.ops.filter(o => o.seq > body.after).sort((a, b) => a.seq - b.seq).slice(0, 500) };
    if (action === 'op') {
      const o = { seq: server.nextSeq++, kind: body.kind, op: body.op, role: 'engineer', author_name: 'Moi', member_key: 'u:moi', created_at: 'now' };
      server.ops.push(o);
      // Réponse perdue : enregistrée côté serveur, mais le client ne le sait pas.
      if (net.loseResponses > 0) { net.loseResponses--; throw new Error('timeout'); }
      return { seq: o.seq, role: o.role, author_name: o.author_name, member_key: o.member_key, created_at: o.created_at };
    }
    if (action === 'sign_upload') {
      const uploads: Record<string, { path: string; token: string }> = {};
      for (const p of body.parts) if (!server.stored.has(p)) uploads[p] = { path: `daw-sessions/s1/${p}`, token: 't' };
      return { uploads };
    }
    throw new Error(`action inattendue ${action}`);
  });
  let uploadCount = 0;
  const uploadToSignedUrl = vi.fn(async (path: string) => {
    uploadCount++;
    if (!net.up || uploadCount === net.uploadFailAt) return { error: { message: 'connexion coupée' } };
    const hash = path.split('/').pop()!;
    server.stored.add(hash);
    server.uploads.push(hash);
    return { error: null };
  });
  const resetUploads = () => { uploadCount = 0; };
  const removeChannel = vi.fn(async () => 'ok');
  const registry = new Map<string, any>();
  return { FakeChannel, net, server, channels, call, removeChannel, uploadToSignedUrl, resetUploads, registry };
});

vi.mock('../services/supabase', () => ({
  catalogSupabase: {
    channel: (name: string, opts: any) => { const c = new h.FakeChannel(name, opts); h.channels.push(c); return c; },
    removeChannel: h.removeChannel,
    storage: { from: () => ({ uploadToSignedUrl: h.uploadToSignedUrl }) },
  },
}));
vi.mock('../services/SessionCloud', () => ({
  call: h.call,
  // Empreinte = contenu (les morceaux identiques ont la même empreinte, comme un SHA-1).
  sha1: async (b: Uint8Array) => `h${Array.from(b.subarray(0, 4)).join('-')}-${b.length}`,
  CHUNK: 4,
}));
vi.mock('../services/AudioUtils', () => ({ wavOf: (buf: { bytes: Uint8Array }) => ({ arrayBuffer: async () => buf.bytes.buffer.slice(0) }) }));
vi.mock('../utils/audioBufferRegistry', () => ({ audioBufferRegistry: { get: (id: string) => h.registry.get(id), has: (id: string) => h.registry.has(id) } }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { CollabClient } from '../services/Collab';
import { LwwClock } from '../utils/collabMerge';
import { applyGroupsOp, createGroup, groupsOpOf, groupsSig, sanitizeGroupsOp, setSuspended, toggleGroup } from '../utils/editGroups';
import { applyTimeOp, sanitizeTimeOp, TimeOp } from '../utils/timeOps';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import type { DAWState } from '../types';

let clients: CollabClient[] = [];
function client(onOp: (o: CollabOp) => any = () => {}) {
  const c = new CollabClient({ id: 's1', secret: 'sec' }, 'engineer', 'Tom', onOp, vi.fn());
  clients.push(c);
  return c;
}
beforeEach(() => {
  Object.assign(h.net, { up: true, realtimeUp: true, loseResponses: 0, uploadFailAt: -1 });
  Object.assign(h.server, { ops: [], nextSeq: 1000, calls: [], stored: new Set(), uploads: [] });
  h.channels.length = 0;
});
afterEach(async () => { for (const c of clients) await c.leave(); clients = []; });

function session(): DAWState {
  const lane = { id: 'l1', parameterName: 'volume', color: '#fff', isExpanded: false, min: 0, max: 1, points: [{ id: 'a', time: 0, value: 0.3 }, { id: 'b', time: 8, value: 0.9 }] };
  return makeState([
    makeTrack({ id: 'lead', name: 'LEAD', clips: [makeClip({ id: 'c1', start: 2, duration: 6 })], automationLanes: [lane] }),
    makeTrack({ id: 'dbl', name: 'DOUBLE', clips: [makeClip({ id: 'c2', start: 2, duration: 6 })] }),
    makeTrack({ id: 'backs', name: 'BACKS', clips: [makeClip({ id: 'c3', start: 4, duration: 2 })] }),
    makeTrack({ id: 'master', name: 'MASTER' }),
  ], {
    trackGroups: [],
    markers: [{ id: 'm1', name: 'Couplet', time: 2, type: 'MARKER', color: '#fff' }, { id: 'm2', name: 'Refrain', time: 6, type: 'MARKER', color: '#fff' }],
    chords: [{ id: 'k1', start: 2, end: 6, root: 9, quality: 'min' as any }],
    tempoEvents: [{ id: 't5', bar: 5, bpm: 100 }],
  });
}

/** Ce que l'autre appareil reçoit : même code que l'appli (App.applyCollabOp). */
function receiver(get: () => DAWState, set: (s: DAWState) => void) {
  const lww = new LwwClock();
  return (o: CollabOp) => {
    if (o.kind === 'groups') {
      if (!lww.accept('groups', o.seq)) return;
      const op = sanitizeGroupsOp(o.op);
      if (op) set(applyGroupsOp(get(), op));
    } else if (o.kind === 'timeop') {
      const op = sanitizeTimeOp(o.op);
      if (op) set(applyTimeOp(get(), op).state);
    }
  };
}
const others = () => { h.server.ops = h.server.ops.map(o => ({ ...o, member_key: 'u:max', op: { ...o.op, _d: 'autre-appareil' } })); };

describe('collaboration R12 : groupes et temps, une opération chacun', () => {
  it('les groupes (liste + suspension + <TOUT>) partent en UNE opération et arrivent identiques', async () => {
    let ici = session();
    ici = createGroup(ici, { id: 'g-vox', name: 'VOX', trackIds: ['lead', 'dbl', 'backs'] });
    ici = setSuspended(toggleGroup(ici, '__tout__'), true);
    const a = client();
    await a.join(0);
    a.queue('groups', 'groups', groupsOpOf(ici) as unknown as Record<string, unknown>);
    await a.flush();
    expect(h.server.ops.filter(o => o.kind === 'groups')).toHaveLength(1);
    expect(h.server.ops).toHaveLength(1);

    let la = session();
    others();
    const b = client(receiver(() => la, s => { la = s; }));
    await b.join(0);
    await b.catchUp();
    expect(groupsSig(la)).toBe(groupsSig(ici));
    expect(la.tracks.find(t => t.id === 'dbl')!.groupId).toBe('g-vox');
  });

  it('insérer du temps puis dupliquer une section : 2 opérations, projet identique chez l\'autre (ids compris)', async () => {
    let ici = session();
    const ops: TimeOp[] = [
      { kind: 'insert', id: 'op-a', at: 4, length: 2, tracks: 'all', rulers: true },
      { kind: 'section', id: 'op-b', mode: 'copy', start: 8, end: 10, to: 10 },
    ];
    const a = client();
    await a.join(0);
    for (const op of ops) { ici = applyTimeOp(ici, op).state; a.queue(`timeop:${op.id}`, 'timeop', op as unknown as Record<string, unknown>); }
    await a.flush();
    expect(h.server.ops.filter(o => o.kind === 'timeop')).toHaveLength(2);
    expect(h.server.ops).toHaveLength(2);

    let la = session();
    others();
    const b = client(receiver(() => la, s => { la = s; }));
    await b.join(0);
    await b.catchUp();
    const pick = (s: DAWState) => JSON.stringify({ tracks: s.tracks, markers: s.markers, chords: s.chords, tempo: [s.bpm, s.timeSignature, s.tempoEvents], loop: [s.loopStart, s.loopEnd] });
    expect(pick(la)).toBe(pick(ici));
    // Rejouée une 2e fois (rattrapage) : le client ne l'applique pas deux fois.
    await b.catchUp();
    expect(pick(la)).toBe(pick(ici));
  });
});
