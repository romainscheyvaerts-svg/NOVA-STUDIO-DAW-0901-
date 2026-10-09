// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectIO } from '../services/ProjectIO';
import { SessionSerializer } from '../services/SessionSerializer';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import type { Clip } from '../types';
import { contentOf } from '../services/Collab';
import { sanitizeIncomingClips, applyMixFields, mixFieldsOf } from '../utils/collabMerge';
import { clipSig, contentDelta, isEmptyDelta, KnownContent, knownOf, mergeClips, noteMerged, noteSent, pendingClipIds } from '../utils/collabContent';
import { LwwClock } from '../utils/collabMerge';
import { trackPrint } from '../utils/collabFingerprint';
import { enforceClipLocks, toggleClipLock } from '../utils/clipLock';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

beforeEach(() => audioBufferRegistry.clear());

describe('sauvegarde : solo safe et verrous de clip', () => {
  it('le .zip garde le solo safe de la piste et le verrou de chaque clip', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-a');
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'rec-b');
    const st = makeState([
      makeTrack({ id: 'lead', name: 'LEAD', clips: [makeClip({ id: 'a', bufferId: 'rec-a', duration: 0.1, lock: 'edit' }), makeClip({ id: 'b', bufferId: 'rec-b', start: 1, duration: 0.1, lock: 'time' })] }),
      makeTrack({ id: 'clic', name: 'Clic', soloSafe: true }),
    ]);
    const blob = await ProjectIO.saveProject(st, []);
    audioBufferRegistry.clear();
    const s = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    expect(s.tracks.find(t => t.id === 'clic')!.soloSafe).toBe(true);
    expect(s.tracks.find(t => t.id === 'lead')!.clips.map(c => c.lock)).toEqual(['edit', 'time']);
    // Session JSON légère (sans audio) : mêmes champs.
    const j = SessionSerializer.serializeSession(st);
    expect(j.tracks[1].soloSafe).toBe(true);
    expect(j.tracks[0].clips[0].lock).toBe('edit');
  });
});

describe('collaboration : le verrou voyage, le solo safe reste local', () => {
  it('contentOf envoie le verrou ; un verrou abîmé est retiré à la réception', () => {
    const t = makeTrack({ id: 'lead', clips: [makeClip({ id: 'a', lock: 'edit' })] });
    expect((contentOf(t).clips[0] as Clip).lock).toBe('edit');
    const inc = sanitizeIncomingClips([{ ...makeClip({ id: 'x' }), lock: 'n’importe quoi' } as any, makeClip({ id: 'y', lock: 'time' })]);
    expect('lock' in inc[0]).toBe(false);
    expect(inc[1].lock).toBe('time');
  });

  it('solo safe : hors de l’empreinte partagée et jamais écrasé par un mix reçu (comme le solo)', () => {
    const a = makeTrack({ id: 'clic', soloSafe: true });
    const b = makeTrack({ id: 'clic' });
    expect(trackPrint(a).sig).toBe(trackPrint(b).sig);
    expect(JSON.stringify(mixFieldsOf(a))).not.toContain('soloSafe');
    const draft = { ...a };
    applyMixFields(draft, { ...mixFieldsOf(b), volume: 0.3 }, () => true);
    expect(draft.soloSafe).toBe(true);
    expect(draft.volume).toBe(0.3);
    // Le verrou, lui, fait partie de ce qui est partagé.
    const l = makeTrack({ id: 'lead', clips: [makeClip({ id: 'a', lock: 'edit' })] });
    const u = makeTrack({ id: 'lead', clips: [makeClip({ id: 'a' })] });
    l.clips[0].id = u.clips[0].id = 'a';
    expect(trackPrint({ ...l, clips: [{ ...u.clips[0], lock: 'edit' }] }).sig).not.toBe(trackPrint(u).sig);
  });

  // Même banc que tests/collabContentConvergence : opérations dans le désordre, en double.
  class Server { seq = 100; ops: { seq: number; clips: Clip[]; changed: string[]; removed: string[] }[] = [];
    post(clips: Clip[], changed: string[], removed: string[]) { const o = { seq: ++this.seq, clips: JSON.parse(JSON.stringify(clips)), changed: [...changed], removed: [...removed] }; this.ops.push(o); return o; } }
  class Peer {
    clips: Clip[]; known: KnownContent; lww = new LwwClock(); seen = new Set<number>();
    constructor(initial: Clip[]) { this.clips = JSON.parse(JSON.stringify(initial)); this.known = knownOf('m', this.clips); }
    /** Modification LOCALE : passe par la vérification des verrous, comme dans App. */
    edit(fn: (c: Clip[]) => Clip[]): boolean {
      const prev = [{ ...makeTrack({ id: 't' }), clips: this.clips }];
      const next = [{ ...prev[0], clips: fn(JSON.parse(JSON.stringify(this.clips))) }];
      const g = enforceClipLocks(prev, next);
      this.clips = g.tracks[0].clips;
      return g.refused.length === 0;
    }
    flush(s: Server) {
      const d = contentDelta(this.known, 'm', this.clips);
      if (isEmptyDelta({ ...d, meta: false })) return null;
      const o = s.post(this.clips, d.changed, d.removed);
      this.seen.add(o.seq);
      [...d.changed, ...d.removed].forEach(id => this.lww.note(`clip:${id}`, o.seq));
      this.known = noteSent(this.known, { meta: 'm', clips: this.clips, changed: d.changed, removed: d.removed });
      return o;
    }
    receive(o: Server['ops'][number]) {
      if (this.seen.has(o.seq)) return;
      this.seen.add(o.seq);
      const r = mergeClips(this.clips, sanitizeIncomingClips(o.clips), o, id => this.lww.accept(`clip:${id}`, o.seq), pendingClipIds(this.known, this.clips));
      this.clips = r.clips;
      this.known = noteMerged(this.known, r.taken, r.dropped);
    }
    view() { return [...this.clips].sort((a, b) => (a.id < b.id ? -1 : 1)).map(c => `${c.id}:${clipSig(c)}`); }
  }
  const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const settle = (s: Server, peers: Peer[], rand: () => number) => {
    for (let round = 0; round < 30; round++) {
      const sent = peers.map(p => p.flush(s)).filter(Boolean);
      for (const p of peers) { for (const o of [...s.ops].sort(() => rand() - 0.5)) { p.receive(o); if (rand() < 0.2) p.receive(o); } }
      if (!sent.length && peers.every(p => !p.flush(s))) return round;
    }
    return -1;
  };

  it('l’ingé verrouille la phrase 1 pendant que l’artiste déplace la phrase 2 : tout le monde converge, verrou compris', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const init = [makeClip({ id: 'p1', start: 0, duration: 2 }), makeClip({ id: 'p2', start: 3, duration: 2 }), makeClip({ id: 'p3', start: 6, duration: 2 })];
      const s = new Server();
      const inge = new Peer(init), artiste = new Peer(init), beat = new Peer(init);
      expect(inge.edit(c => { const ids = ['p1']; return toggleClipLock([{ ...makeTrack({ id: 't' }), clips: c }], ids, 'edit').tracks[0].clips; })).toBe(true);
      expect(artiste.edit(c => c.map(x => (x.id === 'p2' ? { ...x, start: 3.5 } : x)))).toBe(true);
      expect(settle(s, [inge, artiste, beat], rand)).toBeGreaterThanOrEqual(0);
      expect(artiste.view()).toEqual(inge.view());
      expect(beat.view()).toEqual(inge.view());
      expect(beat.clips.find(c => c.id === 'p1')!.lock).toBe('edit');
      expect(beat.clips.find(c => c.id === 'p2')!.start).toBe(3.5);
      // Le verrou est arrivé : chez l'artiste, déplacer la phrase 1 est refusé (rien ne part).
      expect(artiste.edit(c => c.map(x => (x.id === 'p1' ? { ...x, start: 1 } : x)))).toBe(false);
      expect(artiste.flush(s)).toBeNull();
      // L'ingé déverrouille et déplace : tout le monde suit.
      expect(inge.edit(c => c.map(x => { if (x.id !== 'p1') return x; const { lock: _l, ...r } = x; return { ...r, start: 0.25 } as Clip; }))).toBe(true);
      expect(settle(s, [inge, artiste, beat], rand)).toBeGreaterThanOrEqual(0);
      expect(artiste.view()).toEqual(inge.view());
      expect(beat.view()).toEqual(inge.view());
      expect(beat.clips.find(c => c.id === 'p1')).toMatchObject({ start: 0.25 });
      expect('lock' in beat.clips.find(c => c.id === 'p1')!).toBe(false);
    }
  });
});
