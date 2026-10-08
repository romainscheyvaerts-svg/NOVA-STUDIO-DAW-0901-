import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabOp } from '../services/Collab';

/**
 * Collaboration (R2) : tempo, mesure et piste tempo. Serveur (daw-session) et
 * canal Supabase Realtime simulés, comme dans collabRobustesse.test.ts.
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
import { tempoOpOf, tempoOpSig, sanitizeTempoOp, applyTempoOp } from '../utils/collabTempo';
import { LwwClock, mergeQueuedOps } from '../utils/collabMerge';
import { upsertTempoEvent, buildTempoMap, barToTime } from '../utils/tempoMap';

/**
 * R2 : le tempo, la mesure et la piste tempo voyagent dans la collaboration
 * (opération « tempo » du journal, dernière écriture gagnante).
 */
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

describe('collaboration : tempo et mesure', () => {
  it("l'ingé change le tempo, la mesure et pose un changement : l'artiste reçoit la même carte", async () => {
    const ingeState = { bpm: 140, timeSignature: { numerator: 4, denominator: 4 }, tempoEvents: [] as any[] };
    const edited = { ...ingeState, bpm: 92, timeSignature: { numerator: 6, denominator: 8 }, tempoEvents: upsertTempoEvent([], { bar: 8, bpm: 100, numerator: 4, denominator: 4 }) };
    const a = client();
    await a.join(0);
    a.queue('tempo', 'tempo', tempoOpOf(edited) as unknown as Record<string, unknown>);
    await a.flush();
    const sent = h.server.ops.filter(o => o.kind === 'tempo');
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toMatchObject({ bpm: 92, timeSignature: { numerator: 6, denominator: 8 } });

    // Réception chez l'artiste (autre appareil) : même code que l'appli (sanitize + LWW + apply).
    let artiste = { bpm: 140, timeSignature: { numerator: 4, denominator: 4 }, tempoEvents: [] as any[] };
    const lww = new LwwClock();
    const b = client(o => {
      if (o.kind !== 'tempo' || !lww.accept('tempo', o.seq)) return;
      const op = sanitizeTempoOp(o.op);
      if (op) artiste = applyTempoOp(artiste, op);
    });
    h.server.ops = h.server.ops.map(o => ({ ...o, member_key: 'u:max', op: { ...o.op, _d: 'autre-appareil' } }));
    await b.join(0);
    await b.catchUp();
    expect(tempoOpSig(tempoOpOf(artiste))).toBe(tempoOpSig(tempoOpOf(edited)));
    const mA = buildTempoMap(edited.bpm, edited.timeSignature, edited.tempoEvents);
    const mB = buildTempoMap(artiste.bpm, artiste.timeSignature, artiste.tempoEvents);
    expect(barToTime(mB, 12)).toBeCloseTo(barToTime(mA, 12), 9);
  });
  it('dernière écriture gagnante ; deux changements en file : le plus récent part seul', () => {
    const lww = new LwwClock();
    expect(lww.accept('tempo', 10)).toBe(true);
    expect(lww.accept('tempo', 9)).toBe(false);
    expect(mergeQueuedOps('tempo', { bpm: 100 }, { bpm: 120 })).toEqual({ bpm: 120 });
  });
  it('opération reçue mal formée ou hors bornes : ignorée ou nettoyée', () => {
    expect(sanitizeTempoOp({ bpm: 5 })).toBeNull();
    expect(sanitizeTempoOp(null)).toBeNull();
    const op = sanitizeTempoOp({ bpm: 128, timeSignature: { numerator: 99, denominator: 3 }, tempoEvents: [{ bar: -2 }, { bar: 4, bpm: 2000, numerator: 7, denominator: 8 }] })!;
    expect(op.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    expect(op.tempoEvents).toEqual([{ id: 'tempo-4', bar: 4, numerator: 7, denominator: 8 }]);
    const s = { bpm: 128, timeSignature: { numerator: 4, denominator: 4 }, tempoEvents: op.tempoEvents };
    expect(applyTempoOp(s, op)).toBe(s);
  });
});
