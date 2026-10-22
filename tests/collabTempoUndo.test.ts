import { describe, it, expect } from 'vitest';
import { TrackType, type Clip, type Track } from '../types';
import { followTempo, keepAudioFor, type FollowState } from '../utils/tempoFollow';
import { sanitizeTempoOp, applyTempoOp, applyTempoOpFollowing, tempoOpOf, tempoHistoryMove, undoKeepsAudio } from '../utils/collabTempo';
import { hashOf, trackParts } from '../utils/collabFingerprint';

/**
 * Annuler un changement de tempo en collaboration (22/10/2026) : Ctrl+Z renvoie l'opération
 * inverse AVEC le suivi, comme le changement lui-même. Deux membres : A (auteur, possède la piste
 * « a ») et B (possède la piste « b »). Changement puis annulation : états identiques.
 */

const TS = { numerator: 4, denominator: 4 };
function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const track = (id: string, clips: Clip[], type = TrackType.MIDI): Track => ({ id, name: id, type, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips, plugins: [], automationLanes: [], totalLatency: 0 });
const midiClip = (id: string, start: number, duration: number, notes: { s: number; d: number }[]): Clip => ({
  id, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: id, color: '#0ff', type: TrackType.MIDI,
  notes: notes.map((n, i) => ({ id: `${id}-n${i}`, pitch: 60, start: n.s, duration: n.d, velocity: 0.8 })),
});
const audioClip = (id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({ id, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: id, color: '#f0f', type: TrackType.AUDIO, bufferId: `b-${id}`, ...extra });
const state = (tracks: Track[], extra: Partial<FollowState> = {}): FollowState => ({ bpm: 90, timeSignature: TS, tempoEvents: [], tracks, markers: [{ id: 'm', name: 'Refrain', time: 8, type: 'MARKER', color: '#fff' } as any], loopStart: 2, loopEnd: 10, ...extra });
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
/** Projet tel qu'il se compare entre membres : pistes, repères, boucle, tempo. */
const sig = (s: FollowState) => JSON.stringify({ t: s.tracks, m: s.markers, l: [s.loopStart, s.loopEnd], tempo: tempoOpOf(s) });
const maxGap = (a: FollowState, b: FollowState) => {
  let g = 0;
  a.tracks.forEach((t, i) => t.clips.forEach((c, k) => {
    const d = b.tracks[i].clips[k];
    g = Math.max(g, Math.abs(c.start - d.start), Math.abs(c.duration - d.duration));
    (c.notes || []).forEach((n, j) => { g = Math.max(g, Math.abs(n.start - d.notes![j].start), Math.abs(n.duration - d.notes![j].duration)); });
  }));
  return g;
};

/** Un changement suivi (chez A), reçu chez B ; puis Ctrl+Z chez A (instantané), opération inverse reçue chez B. */
function scenario(s0: FollowState, next: Partial<FollowState>, opts: { keepAudio: boolean; contentFirst?: boolean }) {
  // 1. A change le tempo (App.applyTempoChange) : contenu suivi, opération avec follow.
  const e1 = 'tf-change';
  const a1 = followTempo(s0, next, { keepAudio: opts.keepAudio, epoch: e1 }).state;
  const op1 = sanitizeTempoOp(wire({ ...tempoOpOf(a1), follow: { id: e1, keepAudio: opts.keepAudio } }))!;
  const b1 = applyTempoOpFollowing(s0, op1).state;
  // 2. Ctrl+Z chez A : l'instantané d'avant le changement (withProjectOf), transformé par tempoHistoryMove.
  const e2 = 'tf-undo';
  const keep = undoKeepsAudio(a1, s0);
  const move = tempoHistoryMove(a1, s0, { epoch: e2, keepAudio: keep })!;
  const a2 = move.state;
  // 3. Chez B : opération inverse (avec follow) ; le contenu de la piste de A peut arriver avant elle.
  const op2 = sanitizeTempoOp(wire(move.op))!;
  const pre = opts.contentFirst ? { ...b1, tracks: b1.tracks.map(t => (t.id === 'a' ? a2.tracks.find(x => x.id === 'a')! : t)) } : b1;
  let b2 = applyTempoOpFollowing(pre, op2).state;
  // Contenu de la piste de A (seule piste qu'il possède) : mêmes valeurs que celles calculées chez B.
  b2 = { ...b2, tracks: b2.tracks.map(t => (t.id === 'a' ? wire(a2.tracks.find(x => x.id === 'a')!) : t)) };
  // Avant la correction : l'annulation repartait SANS suivi (tempo seul), B gardait la piste « b » déplacée.
  const avant = { ...applyTempoOp(b1, op2), tracks: b1.tracks.map(t => (t.id === 'a' ? s0.tracks.find(x => x.id === 'a')! : t)) };
  return { a1, b1, a2, b2, op2, keep, avant };
}

describe('collaboration : annuler un changement de tempo (convergence)', () => {
  const s0 = state([
    track('a', [midiClip('ma', 1, 4, [{ s: 0, d: 0.5 }, { s: 1.5, d: 0.25 }]), audioClip('aa', 6, 2)], TrackType.MIDI),
    track('b', [midiClip('mb', 2.666666666, 2, [{ s: 0.333333, d: 1 }]), audioClip('ab', 3.1, 1)], TrackType.AUDIO),
  ]);

  it('90 → 140 puis Ctrl+Z : A et B identiques, et revenus au projet d\'avant (± 1 ns)', () => {
    const r = scenario(s0, { bpm: 140 }, { keepAudio: false });
    expect(sig(r.b1)).toBe(sig(r.a1));                       // le changement converge (déjà le cas)
    expect(r.op2.follow).toEqual({ id: 'tf-undo', keepAudio: false });   // l'inverse part AVEC le suivi
    expect(sig(r.b2)).toBe(sig(r.a2));                       // l'annulation converge
    expect(r.a2.bpm).toBe(90);
    expect(maxGap(r.a2, s0 as FollowState)).toBeLessThan(2e-9);   // tout est revenu à sa place
    expect(r.a2.markers[0].time).toBeCloseTo(8, 8);
    expect(r.a2.loopEnd).toBeCloseTo(10, 8);
    // Avant : la piste « b » (pas à A) restait déplacée chez B.
    expect(sig(r.avant)).not.toBe(sig(r.a2));
    expect(maxGap(r.avant, s0 as FollowState)).toBeGreaterThan(0.5);
  });

  it('le contenu de la piste de A arrive avant l\'opération inverse : rien ne bouge deux fois', () => {
    const r = scenario(s0, { bpm: 75 }, { keepAudio: false, contentFirst: true });
    expect(sig(r.b2)).toBe(sig(r.a2));
  });

  it('« garder les clips audio à leur place » : retrouvé à l\'annulation, l\'audio non calé ne bouge pas', () => {
    const r = scenario(s0, { bpm: 120 }, { keepAudio: true });
    expect(r.keep).toBe(true);
    expect(sig(r.b2)).toBe(sig(r.a2));
    expect(r.a2.tracks[1].clips[1].start).toBe(3.1);
  });

  it('rampe ajoutée puis annulée, 200 séances au hasard : convergence chaque fois', () => {
    const r = rng(7);
    for (let run = 0; run < 200; run++) {
      const mk = (id: string, type: TrackType) => track(id, Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => (r() < 0.6
        ? midiClip(`${id}m${k}`, r() * 30, 1 + r() * 6, Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({ s: r() * 4, d: 0.05 + r() })))
        : audioClip(`${id}a${k}`, r() * 30, 1 + r() * 4, r() < 0.3 ? { warp: { enabled: true, mode: 'BEATS', preservePitch: true, originalBpm: 100 } } : {}))), type);
      const base = state([mk('a', TrackType.MIDI), mk('b', TrackType.AUDIO)], { bpm: 60 + Math.floor(r() * 120) });
      const nb = 60 + Math.floor(r() * 120);
      const next = r() < 0.5 ? { bpm: nb === base.bpm ? nb + 7 : nb } : { tempoEvents: [{ id: 'e', bar: 2 + Math.floor(r() * 4), bpm: 70 + Math.floor(r() * 90), ramp: r() < 0.6 }] };
      const keepAudio = r() < 0.5 ? keepAudioFor(base) : true;
      const s = scenario(base, next, { keepAudio, contentFirst: r() < 0.5 });
      expect(sig(s.b2)).toBe(sig(s.a2));
      expect(maxGap(s.a2, base)).toBeLessThan(5e-9);
    }
  });

  it('membre qui recharge (journal rejoué, dernière opération tempo seule) : même empreinte, marque de tempo ignorée', () => {
    const r = scenario(s0, { bpm: 140 }, { keepAudio: false });
    const reloaded = { ...r.a2, tracks: r.a2.tracks.map(t => ({ ...t, clips: t.clips.map(c => { const { tempoEpoch: _e, ...rest } = c; return { ...rest, start: c.start + 3e-10 }; }) })) };
    r.a2.tracks.forEach((t, i) => expect(hashOf(trackParts(reloaded.tracks[i]))).toBe(hashOf(trackParts(t))));
  });

  it('même tempo des deux côtés (annulation d\'autre chose) : aucune opération', () => {
    expect(tempoHistoryMove(s0, { ...s0, tracks: [] }, { epoch: 'x', keepAudio: false })).toBeNull();
  });
});
