import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabOp } from '../services/Collab';

/**
 * Pannes injectées : coupure réseau de 30 s pendant une session à DEUX
 * (artiste + ingé). Serveur daw-session (journal numéroté) et canal Supabase
 * Realtime simulés, partagés par les deux clients. Pendant la coupure, les deux
 * continuent à travailler (dizaines de modifications, clés différentes et même
 * clé) ; les minuteurs de nouvel essai tournent (faux temps). Au retour du
 * réseau : aucune opération perdue, aucune appliquée deux fois, files vides,
 * état « En direct » des deux côtés.
 */

const h = vi.hoisted(() => {
  type Handler = { type: string; event: string; cb: (arg: any) => void };
  const net = { up: true, realtimeUp: true };
  const channels: any[] = [];
  class FakeChannel {
    handlers: Handler[] = [];
    statusCb: ((s: string) => void) | null = null;
    constructor(public name: string, public opts: any) {}
    on(type: string, filter: { event: string }, cb: (arg: any) => void) { this.handlers.push({ type, event: filter.event, cb }); return this; }
    subscribe(cb: (status: string) => void) { this.statusCb = cb; if (net.realtimeUp) queueMicrotask(() => cb('SUBSCRIBED')); return this; }
    presenceState() { return {}; }
    track = async () => 'ok';
    // Diffusion en direct vers les AUTRES canaux de la même session (broadcast self:false).
    send = async (m: { type: string; event: string; payload: unknown }) => {
      if (!net.realtimeUp) throw new Error('realtime coupé');
      for (const c of channels) {
        if (c === this || c.name !== this.name || c.closed) continue;
        queueMicrotask(() => c.handlers.filter((x: Handler) => x.type === 'broadcast' && x.event === m.event).forEach((x: Handler) => x.cb({ payload: m.payload })));
      }
      return 'ok';
    };
    closed = false;
    status(s: string) { this.statusCb?.(s); }
  }
  const server = { ops: [] as any[], nextSeq: 5000, calls: 0, failedCalls: 0 };
  const call = vi.fn(async (action: string, body: any) => {
    server.calls++;
    if (!net.up) { server.failedCalls++; throw new Error('Failed to fetch'); }
    const key = `u:${body.name || body.device_id}`;
    if (action === 'join') return { member_key: key, last_seq: server.ops.length ? Math.max(...server.ops.map(o => o.seq)) : 0, members: [], channel: 'collab:s30' };
    if (action === 'ops_since') return { ops: server.ops.filter(o => o.seq > body.after).sort((a, b) => a.seq - b.seq).slice(0, 500) };
    if (action === 'op') {
      const o = { seq: server.nextSeq++, kind: body.kind, op: body.op, role: body.op?._role || 'engineer', author_name: 'x', member_key: `dev:${body.device_id}`, created_at: 'now' };
      server.ops.push(o);
      return { seq: o.seq, role: o.role, author_name: o.author_name, member_key: o.member_key, created_at: o.created_at };
    }
    throw new Error(`action inattendue ${action}`);
  });
  return { FakeChannel, net, server, channels, call };
});

vi.mock('../services/supabase', () => ({
  catalogSupabase: {
    channel: (name: string, opts: any) => { const c = new h.FakeChannel(name, opts); h.channels.push(c); return c; },
    removeChannel: async (c: any) => { c.closed = true; return 'ok'; },
    storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) },
  },
}));
vi.mock('../services/SessionCloud', () => ({ call: h.call, sha1: async () => 'h', CHUNK: 4 }));
vi.mock('../services/AudioUtils', () => ({ wavOf: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }));
vi.mock('../utils/audioBufferRegistry', () => ({ audioBufferRegistry: { get: () => undefined, has: () => false } }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { CollabClient } from '../services/Collab';
import { collabStatusView } from '../utils/collabStatus';

/** Modèle de session d'un participant : réglages par piste, positions de clips, messages. */
class Peer {
  tracks: Record<string, Record<string, number>> = {};
  clips: Record<string, number> = {};
  chats: string[] = [];
  appliedIds: string[] = [];
  client: CollabClient;
  constructor(public who: string, role: 'artist' | 'engineer', device: string) {
    this.client = new CollabClient({ id: 's30', secret: 'sec' }, role, who, (o: CollabOp) => this.receive(o), () => {});
    (this.client as any).deviceId = device;
  }
  private apply(kind: string, op: any) {
    if (kind === 'mix') this.tracks[op.trackId] = { ...(this.tracks[op.trackId] || {}), ...op.fields };
    else if (kind === 'clip') this.clips[op.clipId] = op.start;
    else if (kind === 'chat') this.chats.push(op.id);
  }
  receive(o: CollabOp) { this.appliedIds.push(o.op._id); this.apply(o.kind, o.op); }
  // Modification locale : appliquée tout de suite chez soi, mise en file pour l'autre.
  mix(trackId: string, fields: Record<string, number>) { this.apply('mix', { trackId, fields }); this.client.queue(`mix:${trackId}`, 'mix', { trackId, fields }); }
  moveClip(clipId: string, start: number) { this.apply('clip', { clipId, start }); this.client.queue(`clip:${clipId}`, 'clip', { clipId, start }); }
  chat(id: string) { this.apply('chat', { id }); this.client.queue(`chat:${id}`, 'chat', { id }); }
}

const report: Record<string, unknown> = {};
let peers: Peer[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(h.net, { up: true, realtimeUp: true });
  Object.assign(h.server, { ops: [], nextSeq: 5000, calls: 0, failedCalls: 0 });
  h.channels.length = 0;
});
afterEach(async () => {
  for (const p of peers) await p.client.leave();
  peers = [];
  vi.useRealTimers();
});
afterAll(async () => {
  const out = process.env.NOVA_STAB_OUT;
  if (!out) return;
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'collab_coupure_30s.json'), JSON.stringify(report, null, 1), 'utf-8');
});

describe('Collaboration à deux : coupure réseau de 30 s', () => {
  it('aucune opération perdue ni appliquée deux fois ; files vidées ; retour « En direct »', async () => {
    const lina = new Peer('Lina', 'artist', 'pc-lina');
    const tom = new Peer('Tom', 'engineer', 'mac-tom');
    peers = [lina, tom];
    await lina.client.join(0);
    await tom.client.join(0);

    // --- Avant la coupure
    lina.chat('L-avant-1'); lina.mix('voix', { volume: 0.9 }); lina.moveClip('prise-1', 1);
    tom.chat('T-avant-1'); tom.mix('beat', { volume: 0.7 }); tom.mix('partagee', { volume: 0.5 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lina.chats).toEqual(['L-avant-1', 'T-avant-1']);
    expect(tom.tracks.voix).toEqual({ volume: 0.9 });

    // --- Coupure : réseau ET direct, 30 s
    h.net.up = false;
    h.net.realtimeUp = false;
    h.channels.forEach(c => c.status('CHANNEL_ERROR'));
    const during = { lina: { chats: [] as string[] }, tom: { chats: [] as string[] } };
    for (let step = 0; step < 60; step++) {            // une modification toutes les 0,5 s, des deux côtés
      const t = step / 2;
      if (step % 2 === 0) {
        const id = `L-${step}`; lina.chat(id); during.lina.chats.push(id);
        lina.mix('voix', { volume: 0.5 + step / 200 });       // même clé : fusionnée dans la file
        if (step % 4 === 0) lina.mix('voix', { pan: -0.5 + step / 120 });
        lina.moveClip(`prise-${step % 7}`, t);                 // 7 clés de clip, réécrites
        lina.mix('partagee', { pan: step / 100 });             // piste partagée : Lina règle le pan
      } else {
        const id = `T-${step}`; tom.chat(id); during.tom.chats.push(id);
        tom.mix('beat', { volume: 0.3 + step / 200, eq: step });
        tom.mix(`fx-${step % 5}`, { send: step / 60 });         // 5 clés différentes
        tom.mix('partagee', { volume: step / 60 });             // piste partagée : Tom règle le volume
      }
      await vi.advanceTimersByTimeAsync(500);
    }
    // Pendant la coupure : tout est en file, rien n'est arrivé chez l'autre, état « Hors ligne ».
    const pendingLina = lina.client.outbox.size();
    const pendingTom = tom.client.outbox.size();
    expect(pendingLina).toBeGreaterThan(0);
    expect(pendingTom).toBeGreaterThan(0);
    expect(collabStatusView(lina.client.getStatus(), { othersOnline: 1 }).code).toBe('offline');
    expect(collabStatusView(tom.client.getStatus(), { othersOnline: 1 }).code).toBe('offline');
    expect(tom.chats.filter(c => c.startsWith('L-') && c !== 'L-avant-1')).toEqual([]);
    expect(h.server.failedCalls).toBeGreaterThan(4); // les nouveaux essais (minuteurs de 10 s) ont bien tourné

    // --- Retour du réseau et du direct
    h.net.up = true;
    h.net.realtimeUp = true;
    h.channels.forEach(c => c.status('SUBSCRIBED'));
    await vi.advanceTimersByTimeAsync(11_000);

    // --- Après
    lina.chat('L-apres'); lina.mix('voix', { volume: 0.33 });
    tom.chat('T-apres'); tom.mix('beat', { volume: 0.44 });
    await vi.advanceTimersByTimeAsync(11_000);

    // 1. Files vides, état « En direct » des deux côtés.
    expect(lina.client.outbox.size()).toBe(0);
    expect(tom.client.outbox.size()).toBe(0);
    expect(collabStatusView(lina.client.getStatus(), { othersOnline: 1 }).code).toBe('live');
    expect(collabStatusView(tom.client.getStatus(), { othersOnline: 1 }).code).toBe('live');

    // 2. Chaque message écrit pendant la coupure est arrivé chez l'autre, une fois, dans l'ordre.
    expect(tom.chats.filter(c => c.startsWith('L-'))).toEqual(['L-avant-1', ...during.lina.chats, 'L-apres']);
    expect(lina.chats.filter(c => c.startsWith('T-'))).toEqual(['T-avant-1', ...during.tom.chats, 'T-apres']);

    // 3. Mêmes réglages des deux côtés (dernière valeur de chaque champ, fusions comprises).
    expect(tom.tracks).toEqual(lina.tracks);
    expect(tom.clips).toEqual(lina.clips);
    expect(lina.tracks.partagee).toEqual({ volume: 59 / 60, pan: 58 / 100 });
    expect(lina.tracks.voix).toMatchObject({ volume: 0.33, pan: -0.5 + 56 / 120 });

    // 4. Aucune opération appliquée deux fois ; aucune perdue côté serveur.
    for (const p of [lina, tom]) expect(new Set(p.appliedIds).size).toBe(p.appliedIds.length);
    const serverChats = h.server.ops.filter(o => o.kind === 'chat').map(o => o.op.id);
    expect(new Set(serverChats).size).toBe(serverChats.length);
    expect(serverChats.length).toBe(2 + 60 + 2);

    Object.assign(report, {
      scenario: 'Session à deux (artiste Lina, ingé Tom), coupure réseau + direct de 30 s, une modification toutes les 0,5 s',
      modifications_pendant_coupure: { lina: 30 * 3 + 8, tom: 30 * 3 },
      messages_pendant_coupure: { lina: during.lina.chats.length, tom: during.tom.chats.length },
      en_file_a_la_fin_de_la_coupure: { lina: pendingLina, tom: pendingTom },
      essais_reseau_echoues_pendant_coupure: h.server.failedCalls,
      operations_enregistrees_serveur: h.server.ops.length,
      appliquees_chez_lina: lina.appliedIds.length,
      appliquees_chez_tom: tom.appliedIds.length,
      doublons_appliques: 0,
      operations_perdues: 0,
      etats_identiques: true,
      etat_final: { lina: collabStatusView(lina.client.getStatus(), { othersOnline: 1 }).code, tom: collabStatusView(tom.client.getStatus(), { othersOnline: 1 }).code },
    });
  });

  it('le direct revient AVANT le journal (ou l\'inverse) : rien ne se perd non plus', async () => {
    const lina = new Peer('Lina', 'artist', 'pc-lina');
    const tom = new Peer('Tom', 'engineer', 'mac-tom');
    peers = [lina, tom];
    await lina.client.join(0);
    await tom.client.join(0);
    h.net.up = false;
    h.net.realtimeUp = false;
    h.channels.forEach(c => c.status('CHANNEL_ERROR'));
    for (let i = 0; i < 20; i++) { lina.chat(`L${i}`); tom.chat(`T${i}`); await vi.advanceTimersByTimeAsync(1500); }
    // Le direct revient d'abord (le serveur ne répond toujours pas) : les envois échouent encore.
    h.net.realtimeUp = true;
    h.channels.forEach(c => c.status('SUBSCRIBED'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(lina.client.outbox.size()).toBe(20);
    h.net.up = true;
    await vi.advanceTimersByTimeAsync(10_500);
    expect(tom.chats.filter(c => c.startsWith('L'))).toEqual(Array.from({ length: 20 }, (_, i) => `L${i}`));
    expect(lina.chats.filter(c => c.startsWith('T'))).toEqual(Array.from({ length: 20 }, (_, i) => `T${i}`));
    for (const p of [lina, tom]) expect(new Set(p.appliedIds).size).toBe(p.appliedIds.length);
    expect(lina.client.outbox.size() + tom.client.outbox.size()).toBe(0);
  });
});
