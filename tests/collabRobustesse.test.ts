import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabOp } from '../services/Collab';

/**
 * Collaboration : pannes injectées. Serveur (daw-session), stockage de l'audio
 * et canal Supabase Realtime simulés ; on coupe le réseau, le direct, on
 * renvoie des opérations en double, dans le désordre, en retard…
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

import { CollabClient, uploadBuffers } from '../services/Collab';
import { CollabOutbox } from '../utils/collabOutbox';
import { applyMixFields, changedFields, fieldSigsOf, legacyMixToFields, LwwClock, mergeMixOps, mixFieldsOf } from '../utils/collabMerge';
import { collabStatusView, initialCollabStatus } from '../utils/collabStatus';
import { makeTrack } from './helpers/fixtures';
import type { PluginInstance } from '../types';

const other = (seq: number, op: Record<string, unknown> = {}, extra: Partial<CollabOp> = {}): CollabOp =>
  ({ seq, kind: 'mix', op: { n: seq, _d: 'autre-appareil', ...op }, role: 'engineer', author_name: 'Max', member_key: 'u:max', ...extra });

const settle = async (c: CollabClient) => { for (let i = 0; i < 6; i++) { await (c as any).chain; await Promise.resolve(); } };

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
  h.registry.clear();
  h.resetUploads();
  h.call.mockClear();
  h.uploadToSignedUrl.mockClear();
});
afterEach(async () => {
  for (const c of clients) await c.leave();
  clients = [];
  vi.useRealTimers();
});

// --- Réseau coupé puis revenu ------------------------------------------------------------

describe('Réseau coupé puis revenu', () => {
  it('hors ligne : les modifications restent en file (état « Hors ligne »), puis partent toutes, dans l\'ordre, au retour', async () => {
    const c = client();
    await c.join(0);
    h.net.up = false;
    c.queue('mix:voix', 'mix', { trackId: 'voix', fields: { pan: -0.3 } });
    c.queue('lock:voix', 'lock', { trackId: 'voix', lock: null });
    c.queue('mix:voix', 'mix', { trackId: 'voix', fields: { volume: 0.5 } }); // même piste : fusionné
    await c.flush();
    await c.catchUp();
    expect(c.outbox.size()).toBe(2);
    const view = collabStatusView(c.getStatus(), { othersOnline: 1 });
    expect(view.code).toBe('offline');
    expect(view.label).toMatch(/2 modifications en attente/);
    expect(view.action).toBe('retry');
    h.net.up = true;
    await c.retryNow();
    expect(c.outbox.size()).toBe(0);
    const sent = h.server.ops.map(o => [o.kind, o.op]);
    expect(sent).toHaveLength(2);
    expect(sent[0][0]).toBe('mix');
    expect(sent[0][1].fields).toEqual({ pan: -0.3, volume: 0.5 }); // la 2e modif complète la 1re
    expect(sent[1][0]).toBe('lock');
    expect(collabStatusView(c.getStatus(), { othersOnline: 1 }).code).toBe('live');
  });

  it('événement « online » du navigateur : rattrapage et envoi sans attendre les 10 s', async () => {
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal('window', { addEventListener: (e: string, cb: () => void) => { listeners[e] = cb; }, removeEventListener: vi.fn() });
    try {
      const c = client();
      await c.join(0);
      h.net.up = false;
      listeners.offline?.();
      expect(c.getStatus().browserOffline).toBe(true);
      c.queue('chat:1', 'chat', { text: 'salut' });
      await c.flush();
      h.net.up = true;
      const before = h.server.calls.filter(x => x.action === 'ops_since').length;
      listeners.online();
      await vi.waitFor(() => expect(h.server.ops.map(o => o.kind)).toEqual(['chat']));
      expect(h.server.calls.filter(x => x.action === 'ops_since').length).toBeGreaterThan(before);
      expect(c.getStatus().browserOffline).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rattrapage sans trou : ce qui a été écrit pendant la coupure arrive au retour', async () => {
    const seen: number[] = [];
    const c = client(o => { seen.push(o.seq); });
    await c.join(0);
    h.net.up = false;
    h.server.ops.push(other(1001), other(1002));
    await c.catchUp();
    expect(seen).toEqual([]);
    h.net.up = true;
    await c.catchUp();
    await settle(c);
    expect(seen).toEqual([1001, 1002]);
  });

  it('réponse perdue (le serveur avait enregistré) : renvoyée avec le même identifiant, appliquée une seule fois chez l\'autre', async () => {
    const c = client();
    await c.join(0);
    h.net.loseResponses = 1;
    c.queue('mix:voix', 'mix', { trackId: 'voix', fields: { pan: 0.2 } });
    await c.flush();
    expect(c.outbox.size()).toBe(1);
    await c.retryNow();
    expect(h.server.ops).toHaveLength(2); // enregistrée deux fois côté serveur…
    expect(h.server.ops[0].op._id).toBe(h.server.ops[1].op._id); // …avec le même identifiant
    // Chez l'autre : appliquée une fois.
    const onOp = vi.fn();
    const peer = new CollabClient({ id: 's1', secret: 'sec' }, 'artist', 'Lina', onOp, vi.fn());
    clients.push(peer);
    (peer as any).deviceId = 'appareil-de-lina';
    await peer.join(0);
    await settle(peer);
    expect(onOp).toHaveBeenCalledTimes(1);
  });
});

// --- Direct Supabase Realtime --------------------------------------------------------------

describe('Direct (Realtime) : coupure et reconnexion', () => {
  it('canal en erreur : état « Sans direct », le rattrapage prend le relais ; reconnecté : rattrapage immédiat, état « En direct »', async () => {
    const seen: number[] = [];
    const c = client(o => { seen.push(o.seq); });
    await c.join(0);
    const ch = h.channels[0];
    ch.status('CHANNEL_ERROR');
    expect(c.getStatus().realtime).toBe('down');
    expect(collabStatusView(c.getStatus(), { othersOnline: 1 }).code).toBe('polling');
    h.server.ops.push(other(1005));
    const n = h.server.calls.filter(x => x.action === 'ops_since').length;
    ch.status('SUBSCRIBED');
    await vi.waitFor(() => expect(h.server.calls.filter(x => x.action === 'ops_since').length).toBe(n + 1));
    await settle(c);
    expect(seen).toEqual([1005]);
    expect(c.getStatus().realtime).toBe('live');
    expect(ch.track).toHaveBeenCalledTimes(2); // présence republiée après la reconnexion
  });

  it('direct jamais établi (6 s) : join se termine quand même, état « Sans direct »', async () => {
    vi.useFakeTimers();
    h.net.realtimeUp = false;
    const c = client();
    const p = c.join(0);
    await vi.advanceTimersByTimeAsync(6100);
    await p;
    expect(c.getStatus().realtime).toBe('down');
    expect(collabStatusView(c.getStatus(), { othersOnline: 0 }).label).toMatch(/toutes les 10 secondes/);
  });

  it('leave() pendant un rattrapage : plus aucun rattrapage ensuite (avant : le minuteur repartait)', async () => {
    vi.useFakeTimers();
    const c = client();
    const p = c.join(0);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    const running = c.catchUp();
    await c.leave();
    await running;
    const n = h.server.calls.filter(x => x.action === 'ops_since').length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.server.calls.filter(x => x.action === 'ops_since').length).toBe(n);
  });
});

// --- Doublons, désordre, retard -----------------------------------------------------------

describe('Opérations en double, dans le désordre, en retard', () => {
  it('même seq reçue en direct et au rattrapage, même _id sous deux numéros : une seule application', async () => {
    const onOp = vi.fn();
    const c = client(onOp);
    await c.join(0);
    const o = other(1010, { _id: 'op-A' });
    h.channels[0].broadcast(o);
    h.channels[0].broadcast(o);
    h.server.ops.push(o, { ...o, seq: 1011 }); // renvoi après réponse perdue
    await c.catchUp();
    await settle(c);
    expect(onOp).toHaveBeenCalledTimes(1);
  });

  it('un autre appareil du MÊME compte (iPad + PC) : ses opérations sont appliquées (avant : ignorées)', async () => {
    const onOp = vi.fn();
    const c = client(onOp);
    await c.join(0);
    h.channels[0].broadcast({ ...other(1020), member_key: 'u:moi' }); // même compte, autre appareil
    h.channels[0].broadcast({ ...other(1021, { _d: c.deviceId }), member_key: 'u:moi' }); // cet appareil : notre écho
    await settle(c);
    expect(onOp.mock.calls.map(x => x[0].seq)).toEqual([1020]);
  });

  it('page rechargée : nos opérations d\'AVANT le rechargement sont rejouées (pas dans l\'instantané chargé), notre écho non', async () => {
    const onOp = vi.fn();
    const c = client(onOp);
    await c.join(0);
    // Même appareil, page précédente (avant un rechargement) : par exemple un accord posé.
    h.server.ops.push({ ...other(1040, { _d: c.deviceId, _p: 'page-precedente' }, { kind: 'chords' }), member_key: 'u:moi' });
    await c.catchUp();
    // Cette page : écho de notre propre envoi, jamais rejoué.
    const seq = await c.send('chords', { upsert: [] });
    h.server.ops.push(...h.server.ops.filter(o => o.seq === seq).map(o => ({ ...o })));
    h.channels[0].broadcast({ ...other(1099, { _d: c.deviceId, _p: c.pageId }), member_key: 'u:moi' });
    await c.catchUp();
    await settle(c);
    expect(onOp.mock.calls.map(x => x[0].seq)).toEqual([1040]);
    expect(h.server.calls.find(x => x.action === 'op')!.body.op).toMatchObject({ _d: c.deviceId, _p: c.pageId });
  });

  it('historique (avant notre arrivée) marqué replay : une demande ancienne n\'est pas retraitée', async () => {
    h.server.ops.push(other(990, {}, { kind: 'vst_param' }));
    const got: CollabOp[] = [];
    const c = client(o => { got.push(o); });
    await c.join(0);
    h.channels[0].broadcast(other(1030, {}, { kind: 'vst_param' }));
    await settle(c);
    expect(got.map(o => [o.seq, !!o.replay])).toEqual([[990, true], [1030, false]]);
  });

  it('LWW : une opération plus ancienne arrivée après une plus récente ne l\'écrase pas', () => {
    const clock = new LwwClock();
    const t = makeTrack({ id: 'voix', pan: 0 });
    applyMixFields(t, { pan: 0.4 }, f => clock.accept(`voix:${f}`, 1040));
    applyMixFields(t, { pan: -0.8 }, f => clock.accept(`voix:${f}`, 1035)); // en retard
    expect(t.pan).toBe(0.4);
    applyMixFields(t, { pan: -0.8 }, f => clock.accept(`voix:${f}`, 1040)); // même numéro rejoué : sans effet nouveau
    expect(t.pan).toBe(-0.8);
  });
});

// --- Deux personnes sur la même piste --------------------------------------------------------

describe('Deux personnes sur la même piste (règle : dernière écriture gagne, par paramètre)', () => {
  const comp: PluginInstance = { id: 'c1', name: 'Comp', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { ratio: 2 } } as PluginInstance;
  const eq: PluginInstance = { id: 'e1', name: 'EQ', type: 'PROEQ12', isEnabled: true, latency: 0, params: { gain: 0 } } as PluginInstance;

  it('seuls les champs modifiés partent ; l\'autre ne perd pas ce qu\'il a changé ailleurs', () => {
    const base = makeTrack({ id: 'voix', volume: 1, pan: 0, plugins: [comp, eq] });
    const known = fieldSigsOf(mixFieldsOf(base));
    // Ingé A : volume. Ingé B (au même moment) : pan et ratio du compresseur.
    const a = changedFields(known, mixFieldsOf({ ...base, volume: 0.6 }));
    const b = changedFields(known, mixFieldsOf({ ...base, pan: -0.5, plugins: [{ ...comp, params: { ratio: 4 } }, eq] }));
    expect(Object.keys(a)).toEqual(['volume']);
    expect(Object.keys(b).sort()).toEqual(['pan', 'plugin:c1']);
    // Chez l'artiste, B arrive (seq 1051) après A (seq 1050) : les deux sont gardés.
    const clock = new LwwClock();
    const t = makeTrack({ id: 'voix', volume: 1, pan: 0, plugins: [comp, eq] });
    applyMixFields(t, a, f => clock.accept(`voix:${f}`, 1050));
    applyMixFields(t, b, f => clock.accept(`voix:${f}`, 1051));
    expect(t.volume).toBe(0.6);
    expect(t.pan).toBe(-0.5);
    expect(t.plugins[0].params.ratio).toBe(4);
    expect(t.plugins.map(p => p.id)).toEqual(['c1', 'e1']);
  });

  it('même paramètre en même temps : celui enregistré en dernier gagne, partout pareil', () => {
    // A (seq 1060) et B (seq 1061) changent tous deux le ratio.
    const a = { 'plugin:c1': { ...comp, params: { ratio: 3 } } };
    const b = { 'plugin:c1': { ...comp, params: { ratio: 8 } } };
    const onA = makeTrack({ id: 'voix', plugins: [{ ...comp, params: { ratio: 3 } }] });
    const onB = makeTrack({ id: 'voix', plugins: [{ ...comp, params: { ratio: 8 } }] });
    const clockA = new LwwClock(); clockA.note('voix:plugin:c1', 1060);
    const clockB = new LwwClock(); clockB.note('voix:plugin:c1', 1061);
    applyMixFields(onA, b, f => clockA.accept(`voix:${f}`, 1061)); // A reçoit B (plus récent) : pris
    applyMixFields(onB, a, f => clockB.accept(`voix:${f}`, 1060)); // B reçoit A (plus ancien) : ignoré
    expect(onA.plugins[0].params.ratio).toBe(8);
    expect(onB.plugins[0].params.ratio).toBe(8);
  });

  it('un réglage local pas encore parti n\'est pas écrasé par celui de l\'autre (le nôtre partira après)', () => {
    const clock = new LwwClock();
    const t = makeTrack({ id: 'voix', pan: 0.7 });
    const pendingLocal = new Set(['pan']);
    applyMixFields(t, { pan: -0.2, volume: 0.4 }, f => clock.accept(`voix:${f}`, 1070) && !pendingLocal.has(f));
    expect(t.pan).toBe(0.7);
    expect(t.volume).toBe(0.4);
  });

  it('ajout / retrait / ordre des effets ; ancien format « mix » complet compris', () => {
    const t = makeTrack({ id: 'voix', plugins: [comp] });
    const clock = new LwwClock();
    applyMixFields(t, { pluginOrder: ['e1', 'c1'], 'plugin:e1': eq }, f => clock.accept(`voix:${f}`, 1080));
    expect(t.plugins.map(p => p.id)).toEqual(['e1', 'c1']);
    applyMixFields(t, legacyMixToFields({ volume: 0.3, plugins: [eq] }), f => clock.accept(`voix:${f}`, 1081));
    expect(t.plugins.map(p => p.id)).toEqual(['e1']);
    expect(t.volume).toBe(0.3);
  });

  it('volume verrouillé par l\'artiste : jamais envoyé ni appliqué', () => {
    const t = makeTrack({ id: 'voix', volume: 0.9, volumeLock: { volume: 0.9, by: 'Lina', at: 1 } });
    expect('volume' in mixFieldsOf(t)).toBe(false);
    applyMixFields(t, { volume: 0.1 }, () => true);
    expect(t.volume).toBe(0.9);
  });

  it('file d\'envoi : deux réglages de la même piste fusionnés champ par champ', () => {
    expect(mergeMixOps({ trackId: 'v', fields: { pan: 1, volume: 0.2 } }, { trackId: 'v', fields: { volume: 0.5 } }))
      .toEqual({ trackId: 'v', fields: { pan: 1, volume: 0.5 } });
  });
});

// --- File d'envoi -------------------------------------------------------------------------------

describe('CollabOutbox', () => {
  it('échec : on s\'arrête (ordre gardé), même identifiant au nouvel essai ; une modif arrivée pendant l\'envoi passe devant', async () => {
    const sent: any[] = [];
    let fail = true;
    let ids = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const box = new CollabOutbox(async (kind, op) => {
      if (kind === 'mix' && op.fields.pan === 0.1) await gate;
      if (fail) throw new Error('réseau');
      sent.push([kind, op]);
    }, { merge: (_k, a, b) => mergeMixOps(a, b), newId: () => `id${++ids}` });
    box.put('mix:v', 'mix', { trackId: 'v', fields: { pan: 0.1 } });
    box.put('chat:1', 'chat', { text: 'yo' });
    const run = box.flush();
    box.put('mix:v', 'mix', { trackId: 'v', fields: { volume: 0.3 } }); // pendant l'envoi de la 1re
    release();
    const r = await run;
    expect(r.failed).toBe(true);
    expect(box.keys()).toEqual(['mix:v', 'chat:1']);
    expect(box.peek('mix:v')).toEqual({ trackId: 'v', fields: { pan: 0.1, volume: 0.3 } });
    fail = false;
    await box.flush();
    expect(sent.map(([k, o]) => [k, o.fields || o.text])).toEqual([['mix', { pan: 0.1, volume: 0.3 }], ['chat', 'yo']]);
    expect(box.size()).toBe(0);
  });

  it('gardée dans le navigateur : rechargée au démarrage', async () => {
    let saved: any[] = [];
    const store = { load: () => saved, save: (e: any[]) => { saved = e; } };
    const a = new CollabOutbox(async () => { throw new Error('hors ligne'); }, { store });
    a.put('lock:v', 'lock', { trackId: 'v', lock: null });
    await a.flush();
    const sent: string[] = [];
    const b = new CollabOutbox(async (kind) => { sent.push(kind); }, { store });
    expect(b.size()).toBe(1);
    await b.flush();
    expect(sent).toEqual(['lock']);
    expect(saved).toEqual([]);
  });
});

// --- Gros fichiers : envoi en morceaux interrompu puis repris --------------------------------

describe('Gros fichiers : envoi en morceaux interrompu puis repris', () => {
  it('coupure au milieu : la reprise n\'envoie que les morceaux manquants ; progression jusqu\'au bout', async () => {
    // 5 morceaux de 4 octets (CHUNK simulé = 4).
    h.registry.set('prise1', { bytes: new Uint8Array(Array.from({ length: 20 }, (_, i) => i)) });
    h.net.uploadFailAt = 3; // le 3e morceau échoue (connexion coupée)
    const progress: [number, number][] = [];
    await expect(uploadBuffers({ id: 's1', secret: 'x' }, ['prise1'], (s, t) => progress.push([s, t]))).rejects.toThrow(/Envoi de l'audio impossible/);
    expect(h.server.uploads).toHaveLength(2);
    const firstTwo = [...h.server.uploads];
    const refs = await uploadBuffers({ id: 's1', secret: 'x' }, ['prise1'], (s, t) => progress.push([s, t]));
    expect(h.server.uploads).toHaveLength(5); // 2 + 3 manquants, rien renvoyé
    expect(h.server.uploads.slice(0, 2)).toEqual(firstTwo);
    expect(new Set(h.server.uploads).size).toBe(5);
    expect(refs.prise1.parts).toHaveLength(5);
    expect(progress.at(-1)).toEqual([12, 12]);
    // Déjà en ligne : plus rien à envoyer.
    await uploadBuffers({ id: 's1', secret: 'x' }, ['prise1']);
    expect(h.server.uploads).toHaveLength(5);
  });

  it('progression affichée dans l\'état (Mo, %), effacée à la fin', () => {
    const s = { ...initialCollabStatus(), joined: true, realtime: 'live' as const, upload: { sent: 30 * 1048576, total: 120 * 1048576 } };
    const v = collabStatusView(s, { othersOnline: 1 });
    expect(v.code).toBe('sending');
    expect(v.label).toMatch(/30 \/ 120 Mo \(25 %\)/);
    expect(v.label).toMatch(/reprendra/);
  });
});

// --- États affichés -----------------------------------------------------------------------------

describe('collabStatusView', () => {
  const live = { ...initialCollabStatus(), joined: true, realtime: 'live' as const };
  it('en direct / en attente de l\'autre / autre actif sans présence', () => {
    expect(collabStatusView(live, { othersOnline: 1 }).code).toBe('live');
    const w = collabStatusView(live, { othersOnline: 0 });
    expect(w.code).toBe('waiting_peer');
    expect(w.label).toMatch(/lien d'invitation/);
    expect(collabStatusView(live, { othersOnline: 0, peerSeenAt: 1000, now: 30_000 }).label).toMatch(/l'autre est actif/);
  });
  it('rattrapage, connexion, erreur avec « Recharger la session »', () => {
    expect(collabStatusView({ ...live, catchingUp: true }, { othersOnline: 1 }).code).toBe('catching_up');
    expect(collabStatusView(initialCollabStatus(), { othersOnline: 0 }).code).toBe('connecting');
    const e = collabStatusView({ ...live, failedOps: 2 }, { othersOnline: 1 });
    expect(e).toMatchObject({ code: 'error', action: 'reload', actionLabel: 'Recharger la session' });
  });
  it('opération abandonnée (6 échecs) : compteur d\'erreurs du client', async () => {
    const c = client(async () => { throw new Error('audio introuvable'); });
    await c.join(0);
    h.channels[0].broadcast(other(1100));
    await settle(c);
    for (let i = 0; i < 7; i++) { await c.catchUp(); await settle(c); }
    expect(c.getStatus().failedOps).toBe(1);
    expect(collabStatusView(c.getStatus(), { othersOnline: 1 }).action).toBe('reload');
  });
});
