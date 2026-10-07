// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { applyChordOps, chordChanges, chordLaneVisible, chordSig, detectChordsInClips, placeChord, replaceRange, resizeChord, sanitizeChords } from '../utils/chordTrack';
import { ChordEvent, chordPitches, chordSymbol } from '../utils/chordDetect';
import { CollabOutbox } from '../utils/collabOutbox';
import { LwwClock, mergeQueuedOps } from '../utils/collabMerge';
import { SessionSerializer } from '../services/SessionSerializer';
import { ProjectIO } from '../services/ProjectIO';
import { makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const ch = (id: string, start: number, end: number, root: number, quality: ChordEvent['quality'] = 'min'): ChordEvent => ({ id, start, end, root, quality });
const names = (l: ChordEvent[]) => l.map(c => `${chordSymbol(c.root, c.quality)}@${c.start}-${c.end}`).join(' ');

describe('piste d’accords : édition', () => {
  it('poser un accord coupe ou raccourcit ceux qu’il recouvre', () => {
    let l: ChordEvent[] = [ch('a', 0, 8, 9)];
    l = placeChord(l, ch('b', 2, 4, 5, 'maj'));
    expect(names(l)).toBe('Am@0-2 F@2-4 Am@4-8');
    l = placeChord(l, ch('c', 4, 8, 0, 'maj'));
    expect(names(l)).toBe('Am@0-2 F@2-4 C@4-8');
    l = resizeChord(l, 'b', 6);
    expect(names(l)).toBe('Am@0-2 F@2-4 C@4-8'); // ne dépasse pas l'accord suivant
    l = resizeChord(l, 'b', 3);
    expect(names(l)).toBe('Am@0-2 F@2-3 C@4-8');
    expect(names(replaceRange(l, 1, 5, [ch('x', 1, 5, 7, 'maj')]))).toBe('Am@0-1 G@1-5 C@5-8');
  });

  it('données reçues nettoyées (rétrocompatible : absent = aucun accord)', () => {
    expect(sanitizeChords(undefined)).toEqual([]);
    expect(sanitizeChords([{ id: 'x', start: 2, end: 1, root: 0, quality: 'maj' }, { id: 'y', start: 0, end: 1, root: 14, quality: 'maj' }, { id: 'z', start: 0, end: 1, root: 0, quality: 'zzz' }]))
      .toEqual([{ id: 'y', start: 0, end: 1, root: 2, quality: 'maj' }]);
  });

  it('couloir masqué par défaut en mode simple, visible en avancé, sinon le choix de l’artiste', () => {
    expect(chordLaneVisible(null, true)).toBe(false);
    expect(chordLaneVisible(null, false)).toBe(true);
    expect(chordLaneVisible(true, true)).toBe(true);
    expect(chordLaneVisible(false, false)).toBe(false);
  });
});

describe('piste d’accords : sauvegarde', () => {
  it('voyage dans le projet (JSON léger et projet .zip)', async () => {
    const chords = [ch('a', 0, 2, 9), ch('b', 2, 4, 5, 'maj7')];
    const st = makeState([makeTrack({ id: 'voix' })], { chords });
    expect(SessionSerializer.serializeSession(st).chords).toEqual(chords);
    const blob = await ProjectIO.saveProject(st, []);
    const json = JSON.parse(await (await JSZip.loadAsync(blob)).file('project.json')!.async('string'));
    expect(json.chords).toEqual(chords);
    const back = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    expect(back.chords).toEqual(chords);
    // Ancien projet sans accords : rien ne casse.
    const old = makeState([makeTrack({ id: 'voix' })]);
    const back2 = await ProjectIO.loadProject(new File([await ProjectIO.saveProject(old, [])], 'p.zip'));
    expect(sanitizeChords(back2.chords)).toEqual([]);
  });
});

describe('piste d’accords : collaboration (opération « chords »)', () => {
  /** Un participant : ses accords, ce qu'il a déjà envoyé / reçu, son horloge. */
  const peer = () => ({ chords: [] as ChordEvent[], known: new Map<string, string>(), lww: new LwwClock() });
  type Peer = ReturnType<typeof peer>;
  /** Ce que fait App.tsx : les changements locaux partent en une opération. */
  const outgoing = (p: Peer) => {
    const { upsert, remove } = chordChanges(p.known, p.chords);
    upsert.forEach(c => p.known.set(c.id, chordSig(c)));
    remove.forEach(id => p.known.delete(id));
    return upsert.length || remove.length ? { upsert, remove } : null;
  };
  /** Ce que fait App.tsx à la réception (journal ordonné par seq) ; `pending` : nos accords pas encore enregistrés. */
  const receive = (p: Peer, op: any, seq: number, pending?: Set<string>) => {
    p.chords = applyChordOps(p.chords, op.upsert, op.remove, id => p.lww.accept(`chord:${id}`, seq), pending);
    p.chords.forEach(c => { if (!pending?.has(c.id)) p.known.set(c.id, chordSig(c)); });
    (op.remove || []).forEach((id: string) => { if (!p.chords.some(c => c.id === id)) p.known.delete(id); });
  };
  /** Notre opération enregistrée sous le numéro seq (App : client.onSent). */
  const sentAs = (p: Peer, op: any, seq: number) => [...op.upsert.map((c: ChordEvent) => c.id), ...op.remove].forEach((id: string) => p.lww.note(`chord:${id}`, seq));

  it('les accords posés chez l’un apparaissent chez l’autre, modifiés et supprimés', () => {
    const a = peer(), b = peer();
    a.chords = [ch('a1', 0, 2, 9), ch('a2', 2, 4, 5, 'maj')];
    let seq = 1;
    receive(b, outgoing(a)!, seq++);
    expect(names(b.chords)).toBe('Am@0-2 F@2-4');
    expect(outgoing(b)).toBeNull(); // rien à renvoyer (pas d'écho)
    // B change l'accord a2 et en ajoute un ; A supprime a1.
    b.chords = placeChord(b.chords, { ...b.chords[1], quality: 'maj7' });
    b.chords = placeChord(b.chords, ch('b1', 4, 6, 0, 'maj'));
    receive(a, outgoing(b)!, seq++);
    a.chords = a.chords.filter(c => c.id !== 'a1');
    receive(b, outgoing(a)!, seq++);
    expect(names(a.chords)).toBe('Fmaj7@2-4 C@4-6');
    expect(names(b.chords)).toBe(names(a.chords));
  });

  for (const order of ['B reçoit A avant d’avoir sa réponse', 'B reçoit A après sa réponse']) {
    it(`modifications croisées, même résultat des deux côtés (${order})`, () => {
      const a = peer(), b = peer();
      a.chords = [ch('k', 0, 4, 9)];
      receive(b, outgoing(a)!, 1);
      // En même temps : A passe l'accord en Am7, B pose un Dm sur 2-4 (qui raccourcit l'accord k).
      a.chords = placeChord(a.chords, { ...a.chords[0], quality: 'min7' });
      b.chords = placeChord(b.chords, ch('d', 2, 4, 2));
      const opA = outgoing(a)!, opB = outgoing(b)!;
      // Le serveur range A (seq 2) puis B (seq 3).
      sentAs(a, opA, 2);
      const pendingB = new Set<string>([...opB.upsert.map(c => c.id), ...opB.remove]);
      if (order.includes('avant')) { receive(b, opA, 2, pendingB); sentAs(b, opB, 3); } else { sentAs(b, opB, 3); receive(b, opA, 2); }
      receive(a, opB, 3);
      expect(names(a.chords)).toBe('Am@0-2 Dm@2-4');
      expect(names(b.chords)).toBe(names(a.chords));
      // Opération arrivée en retard (plus ancienne) : ignorée.
      receive(a, { upsert: [ch('k', 0, 4, 9)], remove: [] }, 1);
      expect(names(a.chords)).toBe('Am@0-2 Dm@2-4');
    });
  }

  it('hors ligne : deux lots d’accords en file se cumulent, rien n’est perdu', async () => {
    const sent: any[] = [];
    const box = new CollabOutbox(async (kind, op) => { sent.push({ kind, op }); }, { merge: mergeQueuedOps });
    box.put('chords', 'chords', { upsert: [ch('a', 0, 2, 9)], remove: [] });
    box.put('chords', 'chords', { upsert: [ch('b', 2, 4, 5, 'maj')], remove: ['z'] });
    await box.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('chords');
    expect(sent[0].op.upsert.map((c: ChordEvent) => c.id)).toEqual(['a', 'b']);
    expect(sent[0].op.remove).toEqual(['z']);
  });
});

describe('détection sur les clips du projet', () => {
  it('accords du beat recalés sur la timeline (clip posé à 2 s, offset 1 s)', () => {
    const SR = 22050, bpm = 120, beat = 0.5;
    const prog = [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']] as const;
    // Le fichier commence 1 s avant le début du clip (offset).
    const len = Math.round((1 + 8) * SR);
    const data = new Float32Array(len);
    prog.forEach(([r, q], k) => {
      for (const p of chordPitches(r, q)) {
        const f = 440 * Math.pow(2, (p - 69) / 12);
        for (let i = Math.round((1 + k * 2) * SR); i < Math.round((1 + (k + 1) * 2) * SR); i++) for (let h = 1; h <= 4; h++) data[i] += (0.06 / h) * Math.sin(2 * Math.PI * f * h * i / SR);
      }
    });
    const buffer = { sampleRate: SR, length: len, numberOfChannels: 1, duration: len / SR, getChannelData: () => data };
    const found = detectChordsInClips([{ start: 2, duration: 8, offset: 1, buffer }], bpm, 4, 'Léo');
    expect(found.map(c => chordSymbol(c.root, c.quality))).toEqual(['Am', 'F', 'C', 'G']);
    expect(found.map(c => c.start)).toEqual([2, 4, 6, 8]);
    expect(found.every(c => c.auto && c.by === 'Léo' && Math.abs(c.start / beat - Math.round(c.start / beat)) < 1e-9)).toBe(true);
  });
});
