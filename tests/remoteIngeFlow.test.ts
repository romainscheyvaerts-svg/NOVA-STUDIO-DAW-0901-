// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { DAWState, PluginInstance, PluginType, Track, TrackType } from '../types';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

/**
 * Mode « Ingé à distance » de bout en bout dans le hook (sans navigateur) :
 * deux sessions (artiste, ingé) reliées par un serveur simulé (journal
 * d'opérations), rendus simulés (pont VST « connecté » ou non).
 * On vérifie l'aller-retour automatique, l'absence de boucle et de doublon,
 * la file d'attente hors ligne et l'attente du pont VST.
 */

const h = vi.hoisted(() => {
  const server = {
    ops: [] as any[],
    seq: 100,
    offline: false,
    clients: [] as any[],
    uploads: 0,
  };
  let renders = 0;
  const bridge = { on: true, listeners: new Set<(s: any) => void>() };
  return { server, bridge, nextRender: () => ++renders, renderCount: () => renders, resetRenders: () => { renders = 0; } };
});

vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null, getTrackLatency: () => 0.058 } }));
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map(), onVstNodesChange: () => () => {} }));
vi.mock('../services/NovaBridge', () => ({
  novaBridge: {
    isConnected: () => h.bridge.on,
    getBridgeState: () => ({ status: h.bridge.on ? 'connected' : 'idle' }),
    subscribe: (cb: any) => { h.bridge.listeners.add(cb); return () => h.bridge.listeners.delete(cb); },
  },
}));
vi.mock('../services/SessionCloud', () => ({ linkToString: (l: any) => `${l.id}.${l.secret}` }));
vi.mock('../services/RemoteInge', () => {
  class RemoteIngeClient {
    lastSeq = 0;
    memberKey: string;
    constructor(public link: any, public role: string, public name: string, private onOp: (o: any) => any, private onPresence: (m: any) => void) {
      this.memberKey = `${role}-${Math.random().toString(36).slice(2, 6)}`;
    }
    static async createLink() { return { id: 'abcdefghijk1', secret: 'ABCDEFGHJKLMNPQRSTUVWXYZ23' }; }
    async join(fromSeq: number) {
      h.server.clients.push(this);
      // Rattrapage : ce qui a été envoyé avant la connexion.
      for (const o of h.server.ops.filter(x => x.seq > fromSeq && x.member_key !== this.memberKey)) await this.onOp(o);
      this.lastSeq = h.server.seq;
      return [];
    }
    async catchUp() {}
    async leave() { h.server.clients = h.server.clients.filter(c => c !== this); }
    private async send(kind: string, op: any) {
      if (h.server.offline) throw new Error('hors ligne');
      const o = { seq: ++h.server.seq, kind, op: JSON.parse(JSON.stringify(op)), role: this.role, author_name: this.name, member_key: this.memberKey };
      h.server.ops.push(o);
      for (const c of h.server.clients) if (c !== this) queueMicrotask(() => { void c.onOp(o); });
      return o.seq;
    }
    sendTrack(p: any, ids: string[]) { h.server.uploads += ids.length; return this.send('ri_send', { ...p, audio: {} }); }
    sendReturn(p: any, ids: string[]) { h.server.uploads += ids.length; return this.send('ri_return', { ...p, audio: {} }); }
    sendFx(p: any) { return this.send('ri_fx', p); }
    sendPhase(phase: string) { return this.send('ri_phase', { phase }); }
    sendAck(a: any) { return this.send('ri_ack', a); }
    async ensureAudio() {}
  }
  return { RemoteIngeClient, REMOTE_KINDS: new Set(['ri_send', 'ri_return', 'ri_fx', 'ri_phase', 'ri_ack']), remoteInviteUrl: (l: any) => `https://nova.test/daw?inge=${l.id}.${l.secret}` };
});
vi.mock('../services/VstFreeze', async () => {
  const { anchorClipsToRender, pluginsSignature, freezeSignature } = await import('../utils/freeze');
  const { makeFreezeBase } = await import('../utils/preFxEdits');
  return {
    renderTrackFreeze: async (t: Track, upTo: number) => {
      const id = `frozen-${t.id}-${h.nextRender()}`;
      return {
        clip: { id, bufferId: id, start: 0, offset: 0, duration: 12, fadeIn: 0, fadeOut: 0, name: 'rendu', color: '#000', type: 'AUDIO' },
        upTo, clipIds: t.clips.map(c => c.id), sig: freezeSignature(t.clips, t.plugins, upTo), pluginSig: pluginsSignature(t.plugins, upTo),
        anchors: anchorClipsToRender(t.clips, id),
      };
    },
    applyFreezeResult: (t: Track, r: any, by?: string) => {
      t.frozenClip = r.clip; t.frozenUpToPluginIndex = r.upTo; t.frozenClipIds = r.clipIds; t.frozenSourceSig = r.sig; t.frozenPluginSig = r.pluginSig;
      t.clips = t.clips.map(c => (r.anchors.get(c.id) ? { ...c, freezeRef: r.anchors.get(c.id) } : c));
      t.freezeBase = makeFreezeBase(t, r.clip.id, by);
    },
    busesNeedingVstRender: () => [],
    renderBusFreeze: async () => { throw new Error('pas de bus VST dans ce test'); },
    applyBusFreezeResult: () => [],
  };
});

import { useRemoteInge, RemoteInge } from '../hooks/useRemoteInge';

const vst = (id: string, name: string): PluginInstance => ({ id, name, type: 'VST3' as PluginType, isEnabled: true, latency: 0, params: { name, localPath: `C:\\VST3\\${name}.vst3` } });

interface Side { root: Root; api: { remote: RemoteInge; get: () => DAWState; set: (fn: (d: DAWState) => DAWState) => void }; notes: string[] }

function mount(initial: DAWState): Side {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const side: Side = { root, api: null as any, notes: [] };
  const Harness = () => {
    const [st, setSt] = useState(initial);
    const stateRef = useRef(st);
    useEffect(() => { stateRef.current = st; }, [st]);
    const set = useCallback((fn: (p: DAWState) => DAWState) => setSt(prev => fn(prev)), []);
    const remote = useRemoteInge({
      tracks: st.tracks, remoteInge: st.remoteInge, isRecording: !!st.isRecording, showLanding: false,
      stateRef, setState: set, setSilently: set, notify: (m) => side.notes.push(m), gate: async () => true,
      saveSession: async () => {}, releaseBuffer: () => {}, author: () => 'Test',
    });
    side.api = { remote, get: () => stateRef.current, set };
    return null;
  };
  act(() => { root.render(React.createElement(Harness)); });
  return side;
}

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const opsOf = (kind: string) => h.server.ops.filter(o => o.kind === kind);

function artistProject() {
  const lead = makeTrack({
    id: 'lead', name: 'LEAD', plugins: [], sends: [],
    clips: [
      makeClip({ id: 'p1', start: 1, offset: 1, duration: 2, bufferId: 'take1' }),
      makeClip({ id: 'p2', start: 4, offset: 4, duration: 2, bufferId: 'take1' }),
    ],
  });
  return makeState([lead, makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] })]);
}
function engineerProject() {
  return makeState([
    makeTrack({ id: 'send-verb-short', name: 'VERB PRO', type: TrackType.SEND, sends: [], plugins: [{ id: 'nv', name: 'REVERB', type: 'REVERB', isEnabled: true, latency: 0, params: { decay: 2 } }] }),
    makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] }),
  ], { id: 'proj-inge' });
}

let sides: Side[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.server.ops = []; h.server.clients = []; h.server.offline = false; h.server.uploads = 0;
  h.bridge.on = true;
  h.resetRenders();
  try { localStorage.clear(); } catch { /* */ }
});
afterEach(() => {
  sides.forEach(s => act(() => s.root.unmount()));
  sides = [];
  vi.useRealTimers();
});

async function linked() {
  const artist = mount(artistProject());
  const inge = mount(engineerProject());
  sides.push(artist, inge);
  await act(async () => { await artist.api.remote.start('artist', 'Lina'); });
  await act(async () => { await inge.api.remote.start('engineer', 'Max', artist.api.remote.inviteUrl!); });
  return { artist, inge };
}

describe('Ingé à distance : aller-retour dans les deux sessions', () => {
  it('envoi → l\'ingé traite et renvoie → l\'artiste reçoit ; ses coupes repartent et reviennent toutes seules, sans boucle', async () => {
    const { artist, inge } = await linked();
    expect(artist.api.get().remoteInge).toMatchObject({ role: 'artist', phase: 'recording' });
    expect(inge.api.remote.role).toBe('engineer');

    // 1. L'artiste glisse sa piste sur « Lead ».
    await act(async () => { artist.api.remote.sendTrack('lead', 'lead'); });
    await flush(10);
    expect(opsOf('ri_send')).toHaveLength(1);
    const et = () => inge.api.get().tracks.find(t => t.remote?.peerTrackId === 'lead')!;
    expect(et().name).toBe('LEAD'); // déjà nommée comme son emplacement
    expect(et().clips.map(c => c.id)).toEqual(['p1', 'p2']);
    expect(artist.api.remote.artistRows[0].status.label).toBe("Chez l'ingé…");

    // 2. L'ingé pose ses VST et « Geler et envoyer à l'artiste ».
    act(() => inge.api.set(s => ({ ...s, tracks: s.tracks.map(t => (t.remote ? { ...t, plugins: [vst('i-comp', 'Pro-C 2')], sends: [{ id: 'send-verb-short', level: 0.3, isEnabled: true }] } : t)) })));
    await flush(400); // réglages de la reverb de NOVA partis en direct
    expect(opsOf('ri_fx')).toHaveLength(1);
    expect(artist.api.get().tracks.find(t => t.id === 'ri-send-verb-short')?.plugins[0].params.decay).toBe(2);
    await act(async () => { await inge.api.remote.returnTrack(et().id); });
    await flush(10);
    expect(opsOf('ri_return')).toHaveLength(1);
    expect(et().isFrozen).toBe(true);
    expect(et().remote).toMatchObject({ returnedV: 1, auto: true });

    // 3. Chez l'artiste : bouton « Recevoir les réglages de l'ingé ».
    let al = artist.api.get().tracks.find(t => t.id === 'lead')!;
    expect(al.remote?.pending).toBeTruthy();
    expect(artist.api.remote.artistRows[0].status.label).toBe("Réglages de l'ingé prêts");
    await act(async () => { await artist.api.remote.receive('lead'); });
    al = artist.api.get().tracks.find(t => t.id === 'lead')!;
    expect(al.isFrozen).toBe(true);
    expect(al.plugins[0]).toMatchObject({ name: 'Pro-C 2', params: { remoteBaked: true } });
    expect(al.plugins[0].params.localPath).toBeUndefined();
    expect(al.sends).toEqual([{ id: 'ri-send-verb-short', level: 0.3, isEnabled: true }]);
    expect(artist.api.remote.artistRows[0].status.label).toBe('Mise à jour reçue');

    // Rien ne repart tout seul (aucune boucle) même après de longues attentes.
    await flush(15000);
    expect(opsOf('ri_send')).toHaveLength(1);
    expect(opsOf('ri_return')).toHaveLength(1);

    // 4. L'artiste coupe un bout de la phrase 2 et la remplace par une autre prise.
    act(() => artist.api.set(s => ({ ...s, tracks: s.tracks.map(t => (t.id === 'lead' ? { ...t, clips: [t.clips[0], { ...t.clips[1], duration: 1 }, makeClip({ id: 'n1', start: 5, offset: 0, duration: 1, bufferId: 'take2' })] } : t)) })));
    await flush(2600); // envoi automatique
    expect(opsOf('ri_send')).toHaveLength(2);
    expect(h.server.ops.filter(o => o.kind === 'ri_ack').map(o => o.op.state)).toContain('processing');
    await flush(1300); // retraitement automatique chez l'ingé (pont connecté)
    await flush(10);
    expect(et().clips.map(c => c.id)).toEqual(['p1', 'p2', 'n1']);
    expect(et().isFrozen).toBe(true);
    expect(et().remote).toMatchObject({ recvV: 2, returnedV: 2 });
    expect(opsOf('ri_return')).toHaveLength(2);
    al = artist.api.get().tracks.find(t => t.id === 'lead')!;
    expect(al.remote?.appliedV).toBe(2); // appliquée toute seule (déjà acceptée une fois)
    expect(al.clips.find(c => c.id === 'n1')?.freezeRef?.renderId).toBe(al.frozenClip!.id);
    expect(artist.notes.join('\n')).toMatch(/Mise à jour reçue de l'ingé/);

    // 5. Toujours pas de boucle ni de doublon.
    const before = h.server.ops.filter(o => o.kind !== 'ri_ack').length;
    await flush(30000);
    expect(h.server.ops.filter(o => o.kind !== 'ri_ack').length).toBe(before);
    expect(h.renderCount()).toBe(2);
  });

  it('hors ligne : l\'envoi attend dans la file, une seule fois, et part à la reconnexion', async () => {
    const { artist } = await linked();
    await act(async () => { artist.api.remote.sendTrack('lead', 'lead'); });
    await flush(10);
    h.server.offline = true;
    for (let i = 0; i < 3; i++) {
      act(() => artist.api.set(s => ({ ...s, tracks: s.tracks.map(t => (t.id === 'lead' ? { ...t, clips: t.clips.map(c => ({ ...c, gain: 0.5 + i * 0.1 })) } : t)) })));
      await flush(2600);
    }
    expect(artist.api.remote.queuedCount).toBe(1);
    expect(artist.api.remote.artistRows[0].status.code).toBe('queued');
    h.server.offline = false;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await flush(10);
    expect(opsOf('ri_send')).toHaveLength(2); // la dernière version, une seule fois
    expect(opsOf('ri_send')[1].op.clips[0].gain).toBeCloseTo(0.7);
    expect(artist.api.remote.queuedCount).toBe(0);
  });

  it('pont VST fermé chez l\'ingé : la version attend, l\'artiste le sait ; traitée dès que le pont revient', async () => {
    const { artist, inge } = await linked();
    await act(async () => { artist.api.remote.sendTrack('lead'); });
    await flush(10);
    const et = () => inge.api.get().tracks.find(t => t.remote?.peerTrackId === 'lead')!;
    act(() => inge.api.set(s => ({ ...s, tracks: s.tracks.map(t => (t.remote ? { ...t, plugins: [vst('i-comp', 'Pro-C 2')] } : t)) })));
    await act(async () => { await inge.api.remote.returnTrack(et().id); });
    await flush(10);
    await act(async () => { await artist.api.remote.receive('lead'); });
    h.bridge.on = false;
    act(() => h.bridge.listeners.forEach(l => l({ status: 'idle' })));
    act(() => artist.api.set(s => ({ ...s, tracks: s.tracks.map(t => (t.id === 'lead' ? { ...t, clips: [t.clips[0]] } : t)) })));
    await flush(2600);
    await flush(1300);
    expect(opsOf('ri_return')).toHaveLength(1);
    expect(artist.api.remote.artistRows[0].status.label).toMatch(/pont VST est fermé/);
    expect(inge.api.remote.engineerRows[0].label).toMatch(/pont VST fermé/);
    h.bridge.on = true;
    act(() => h.bridge.listeners.forEach(l => l({ status: 'connected' })));
    await flush(1300);
    await flush(10);
    expect(opsOf('ri_return')).toHaveLength(2);
    expect(artist.api.get().tracks.find(t => t.id === 'lead')!.remote?.appliedV).toBe(2);
  });

  it('règle des envois : une reverb en insert bloque l\'envoi, « Déplacer en envoi » répare ; verrou d\'enregistrement', async () => {
    const { artist, inge } = await linked();
    await act(async () => { artist.api.remote.sendTrack('lead'); });
    await flush(10);
    const et = () => inge.api.get().tracks.find(t => t.remote?.peerTrackId === 'lead')!;
    act(() => inge.api.set(s => ({ ...s, tracks: s.tracks.map(t => (t.remote ? { ...t, plugins: [{ id: 'rv', name: 'REVERB', type: 'REVERB', isEnabled: true, latency: 0, params: { mix: 0.2 } }] } : t)) })));
    await act(async () => { expect(await inge.api.remote.returnTrack(et().id)).toBe(false); });
    expect(inge.notes.join('\n')).toMatch(/Déplacer en envoi/);
    expect(inge.api.remote.engineerRows[0].issues[0].code).toBe('temporal-insert');
    await act(async () => { inge.api.remote.fixIssue(inge.api.remote.engineerRows[0].issues[0]); });
    expect(et().plugins).toHaveLength(0);
    expect(et().sends[0].level).toBe(0.2);
    expect(inge.api.remote.checkAdd(et().id, vst('v', 'ValhallaRoom'))).toMatchObject({ ok: false, code: 'vst-temporal-recording' });
    await act(async () => { inge.api.remote.setPhase('mixing'); });
    await flush(10);
    expect(artist.api.get().remoteInge?.phase).toBe('mixing');
    expect(inge.api.remote.checkAdd(et().id, vst('v', 'ValhallaRoom'))).toEqual({ ok: true });
    expect(inge.api.remote.mixRule()).toEqual({ phase: 'mixing', trackIds: [et().id] });
    await act(async () => { expect(await inge.api.remote.returnTrack(et().id)).toBe(true); });
  });
});
