// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { TrackType, type Clip, type DAWState, type Marker, type Track } from '../types';
import type { ChordEvent } from '../utils/chordDetect';
import { chordTones } from '../utils/chordDetect';
import { buildTempoMap, quartersToTime, timeToQuarters, type TempoEvent } from '../utils/tempoMap';
import { followTempo } from '../utils/tempoFollow';
import { clipsWithMidiFx } from '../engine/midiFx';
import { contentOf } from '../services/Collab';
import { sanitizeIncomingClips } from '../utils/collabMerge';
import { BEAT_GENRES, type BeatGenreId } from '../utils/beatRecipes';
import {
  addSessionPlayer, allowedAt, drumHitsFor, drumPitchFor, freezeSeance, generateSeanceNotes, refreshSessionPlayers, renderSeanceClip,
  sanitizeSeance, seanceContext, seanceRegions, seanceScale, splitSeanceBySections, updateSeance, drummerKit,
  type SeanceRole, type SeanceSettings,
} from '../utils/sessionPlayer';
import { makeState } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const TS = { numerator: 4, denominator: 4 };
const STYLES = BEAT_GENRES.map(g => g.id) as BeatGenreId[];
const pc = (n: number) => ((n % 12) + 12) % 12;

/** La mineur : Am – F – C – G, une mesure chacun, 8 mesures à `bpm`. */
function chordsAt(bpm: number, bars = 8, prog: [number, ChordEvent['quality']][] = [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']]): ChordEvent[] {
  const bar = (60 / bpm) * 4;
  return Array.from({ length: bars }, (_, i) => ({ id: `c${i}`, start: i * bar, end: (i + 1) * bar, root: prog[i % prog.length][0], quality: prog[i % prog.length][1] }));
}

function project(bpm = 140, extra: Partial<DAWState> = {}): DAWState {
  return makeState([], { bpm, timeSignature: TS, chords: chordsAt(bpm), projectKey: 9, projectScale: 'MINOR', loopStart: 0, loopEnd: 0, ...extra });
}

function add(st: DAWState, role: SeanceRole, style: BeatGenreId, o: { bySection?: boolean; pattern?: number } = {}) {
  const r = addSessionPlayer(st, { role, style, ...o }, null, 'test');
  if (!r.ok) throw new Error(r.error);
  return { st: r.state, track: r.state.tracks.find(t => t.id === r.trackId)! };
}

/** Réglages d'une région de test, rendue sur une piste donnée. */
function region(st: DAWState, track: Track, s: Partial<SeanceSettings>): Clip {
  const c = track.clips[0];
  return renderSeanceClip(c, { ...sanitizeSeance(c.seance)!, ...s }, seanceContext(st), track);
}

describe('musiciens de séance : la basse suit les accords (écart 16)', () => {
  it('100 % des changements d’accord ont la fondamentale, pile au changement (±1 ms), tous styles, complexité 1 à 10', () => {
    for (const style of STYLES) {
      const { st, track } = add(project(), 'bass', style);
      for (let cx = 1; cx <= 10; cx++) {
        const c = region(st, track, { complexity: cx });
        for (const ch of st.chords!) {
          const hit = c.notes!.find(n => Math.abs(c.start + n.start - ch.start) < 1e-3 && pc(n.pitch) === ch.root);
          expect(hit, `${style} c${cx} accord à ${ch.start}`).toBeTruthy();
        }
      }
    }
  });

  it('100 % des notes de basse dans l’accord en cours ou dans la gamme (tonalité du projet, puis déduite des accords)', () => {
    for (const key of [{ projectKey: 9, projectScale: 'MINOR' }, { projectKey: undefined, projectScale: undefined }]) {
      for (const style of STYLES) {
        const base = project(140, key as Partial<DAWState>);
        const { st, track } = add(base, 'bass', style);
        const ctx = seanceContext(st);
        const scale = seanceScale(ctx);
        for (let cx = 1; cx <= 10; cx++) {
          const c = region(st, track, { complexity: cx });
          expect(c.notes!.length).toBeGreaterThan(0);
          for (const n of c.notes!) expect(allowedAt(ctx, c.start + n.start, scale).has(pc(n.pitch)), `${style} c${cx} note ${n.pitch} à ${n.start}`).toBe(true);
        }
      }
    }
  });

  it('808 en trap et en drill (registre Do1-Si1), basse NOVA en boom bap / R&B / afro (Do2-Si2)', () => {
    const trap = add(project(), 'bass', 'trap').track;
    expect(trap.bass808?.glide).toBe(true);
    expect(trap.clips[0].notes!.every(n => n.pitch >= 24 && n.pitch <= 47)).toBe(true);
    const drill = add(project(), 'bass', 'drill-uk').track;
    expect(drill.bass808?.style).toBe('808-dist');
    const rnb = add(project(90), 'bass', 'rnb').track;
    expect(rnb.bass808).toBeUndefined();
    expect(rnb.novaSynth?.presetId).toBe('basse-rnb');
    expect(rnb.clips[0].notes!.every(n => n.pitch >= 36 && n.pitch <= 59)).toBe(true);
  });

  it('les claviers ne jouent que des notes de l’accord en cours', () => {
    for (const style of STYLES) {
      const { st, track } = add(project(), 'keys', style);
      for (const cx of [1, 5, 10]) {
        const c = region(st, track, { complexity: cx, intensity: 9 });
        expect(c.notes!.length).toBeGreaterThan(0);
        for (const n of c.notes!) {
          const ch = st.chords!.find(x => c.start + n.start >= x.start - 1e-6 && c.start + n.start < x.end - 1e-6)!;
          expect(chordTones(ch.root, ch.quality)).toContain(pc(n.pitch));
        }
      }
    }
  });

  it('sans accords, basse et claviers expliquent quoi faire (aucune piste créée)', () => {
    const r = addSessionPlayer(project(140, { chords: [] }), { role: 'bass', style: 'trap' }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/accords/);
    expect(addSessionPlayer(project(140, { chords: [] }), { role: 'drums', style: 'trap' }, null).ok).toBe(true);
  });
});

describe('musiciens de séance : la batterie est calée sur la grille', () => {
  const bpm = 140;
  const six = 60 / bpm / 4;

  it('140 BPM, swing 0 : chaque coup à ±1 ms d’une double-croche ; kick sur le 1, clap sur le 3 (trap half-time)', () => {
    const { st, track } = add(project(bpm), 'drums', 'trap', { pattern: 2 });
    for (let cx = 1; cx <= 4; cx++) {
      const c = region(st, track, { complexity: cx, fills: 0, swing: 0 });
      for (const n of c.notes!) {
        const t = c.start + n.start;
        expect(Math.abs(t - Math.round(t / six) * six) * 1000, `c${cx} ${t}`).toBeLessThan(1);
      }
    }
    const c = region(st, track, { complexity: 5, fills: 0, swing: 0 });
    const rows = track.drumMachine!.rows;
    const kick = drumPitchFor('kick', rows)!, clap = drumPitchFor('clap', rows)!;
    const bar = 4 * 60 / bpm;
    for (let b = 0; b < 8; b++) {
      expect(c.notes!.some(n => n.pitch === kick && Math.abs(n.start - b * bar) < 1e-3)).toBe(true);
      expect(c.notes!.some(n => n.pitch === clap && Math.abs(n.start - (b * bar + 2 * 60 / bpm)) < 1e-3)).toBe(true);
    }
  });

  it('début de région arrondi (à la microseconde près) : le premier coup est gardé', () => {
    const { st, track } = add(project(bpm), 'drums', 'trap');
    const c0 = { ...track.clips[0], start: 2 * 4 * 60 / bpm + 5e-7, duration: 4 * 60 / bpm };
    const notes = generateSeanceNotes(c0, sanitizeSeance(c0.seance)!, seanceContext(st), track);
    expect(notes[0].start).toBe(0);
    expect(notes.some(n => n.start === 0 && n.pitch === drumPitchFor('kick', track.drumMachine!.rows))).toBe(true);
  });

  it('swing de la recette : doubles paires sur la grille, impaires retardées de swing × ½ pas', () => {
    const { st, track } = add(project(bpm), 'drums', 'trap', { pattern: 0 });
    const sw = 0.16;
    const c = region(st, track, { complexity: 4, fills: 0, swing: sw });
    for (const n of c.notes!) {
      const t = c.start + n.start;
      const k = Math.round(t / six);
      const onEven = Math.abs(t - k * six) * 1000 < 1 && k % 2 === 0;
      const onOdd = Math.abs(t - (Math.floor(t / six) * six + sw * six * 0.5)) * 1000 < 1 && Math.floor(t / six) % 2 === 1;
      expect(onEven || onOdd, `${t}`).toBe(true);
    }
  });

  it('rampe de tempo 90 → 140 BPM : chaque coup tombe sur sa double-croche du MORCEAU (à 1 µs)', () => {
    const ev: TempoEvent[] = [{ id: 'r', bar: 4, bpm: 140, ramp: true }];
    const base = project(90, { tempoEvents: ev, chords: [] });
    const { st, track } = add({ ...base, loopStart: 0, loopEnd: buildTempoMap(90, TS, ev) && quartersToTime(buildTempoMap(90, TS, ev), 32) }, 'drums', 'boombap');
    const map = buildTempoMap(90, TS, ev);
    const c = region(st, track, { complexity: 4, fills: 0, swing: 0 });
    expect(c.notes!.length).toBeGreaterThan(40);
    for (const n of c.notes!) {
      const q = timeToQuarters(map, c.start + n.start);
      expect(Math.abs(quartersToTime(map, Math.round(q * 4) / 4) - (c.start + n.start)) * 1e6).toBeLessThan(1);
    }
  });

  it('complexité 1 → 10 : densité croissante (jamais moins de notes), pour chaque style et chaque musicien', () => {
    for (const role of ['drums', 'bass', 'keys'] as SeanceRole[]) {
      for (const style of STYLES) {
        const { st, track } = add(project(), role, style);
        const counts = Array.from({ length: 10 }, (_, i) => region(st, track, { complexity: i + 1, fills: 0 }).notes!.length);
        for (let i = 1; i < 10; i++) expect(counts[i], `${role} ${style} ${counts.join(',')}`).toBeGreaterThanOrEqual(counts[i - 1]);
        expect(counts[9]).toBeGreaterThan(counts[0]);
      }
    }
  });

  it('remplissages : roulement de caisse claire en fin de région et toutes les 4 mesures à 8 et plus ; aucun à 0', () => {
    const { st, track } = add(project(), 'drums', 'boombap');
    const rows = track.drumMachine!.rows;
    const map = seanceContext(st).map;
    const snareRoll = (fills: number) => drumHitsFor({ ...sanitizeSeance(track.clips[0].seance)!, fills }, map, 0, track.clips[0].duration, rows)
      .filter(h => h.role === 'snare' && Math.abs((h.q % 4) - 3.75) < 1e-6).map(h => Math.floor(h.q / 4));
    expect(snareRoll(0)).toEqual([]);
    expect(snareRoll(2)).toEqual([7]);
    expect(snareRoll(9)).toEqual([3, 7]);
  });

  it('intensité : vélocités plus fortes, crash au début de la région à 7 et plus (si le kit a une crash)', () => {
    const { st, track } = add(project(), 'drums', 'trap');
    const soft = region(st, track, { intensity: 2 }), loud = region(st, track, { intensity: 10 });
    const avg = (c: Clip) => c.notes!.reduce((a, n) => a + n.velocity, 0) / c.notes!.length;
    expect(avg(loud)).toBeGreaterThan(avg(soft) * 1.3);
    // Kit avec crash (index de kits chargé) : un coup de crash au premier temps.
    const rows = [...track.drumMachine!.rows, { id: 'crash' }];
    const hits = drumHitsFor({ ...sanitizeSeance(track.clips[0].seance)!, intensity: 8 }, seanceContext(st).map, 0, 4, rows);
    expect(hits.some(h => h.role === 'crash' && h.q === 0)).toBe(true);
  });
});

describe('musiciens de séance : figer, lecture = export, sauvegarde, collaboration', () => {
  it('« Figer en notes MIDI » : exactement les mêmes notes, réglages retirés, plus jamais recalculées', () => {
    const { st, track } = add(project(), 'bass', 'drill-fr');
    const before = track.clips.map(c => c.notes);
    const f = freezeSeance(st, track.id, null);
    const t2 = f.state.tracks.find(t => t.id === track.id)!;
    expect(f.regions).toBe(1);
    expect(t2.clips.map(c => c.notes)).toEqual(before);
    expect(t2.clips.every(c => !c.seance && /\(figé\)$/.test(c.name))).toBe(true);
    // Les accords changent : les notes figées ne bougent pas.
    const moved = { ...f.state, chords: chordsAt(140).map(c => ({ ...c, root: pc(c.root + 2) })) };
    expect(refreshSessionPlayers(f.state, moved)).toBe(moved.tracks);
  });

  it('lecture = export : le moteur (lecture comme export) lit les notes du clip, identiques au calcul', () => {
    const { st, track } = add(project(), 'drums', 'afro');
    const played = clipsWithMidiFx(track, track.clips);
    expect(played[0].notes).toEqual(generateSeanceNotes(track.clips[0], sanitizeSeance(track.clips[0].seance)!, seanceContext(st), track));
  });

  it('les accords changent : la basse suit dans la même mise à jour ; même calcul = mêmes notes et mêmes identifiants', () => {
    const { st, track } = add(project(), 'bass', 'trap');
    const chords = st.chords!.map((c, i) => (i === 1 ? { ...c, root: 2, quality: 'min' as const } : c)); // F → Dm
    const next = { ...st, chords };
    const tracks = refreshSessionPlayers(st, next);
    const c = tracks.find(t => t.id === track.id)!.clips[0];
    const bar = 4 * 60 / 140;
    expect(c.notes!.filter(n => n.start >= bar - 1e-6 && n.start < 2 * bar - 1e-6).every(n => pc(n.pitch) === 2 || pc(n.pitch) === 9 || pc(n.pitch) === 5)).toBe(true);
    expect(c.notes!.some(n => Math.abs(n.start - bar) < 1e-6 && pc(n.pitch) === 2)).toBe(true);
    // Déterministe : recalculer donne exactement le même clip (collaboration : tout le monde obtient pareil).
    const again = refreshSessionPlayers(null, { ...next, tracks: tracks.map(t => (t.id === track.id ? { ...t, clips: t.clips.map(x => ({ ...x, seance: { ...x.seance!, sig: 'périmé' } })) } : t)) });
    expect(again.find(t => t.id === track.id)!.clips[0].notes).toEqual(c.notes);
    // Rien ne change : même tableau (aucun calcul au repos).
    expect(refreshSessionPlayers(next, { ...next, tracks })).toBe(tracks);
  });

  it('changement de tempo (rampe comprise) : mêmes positions musicales, rien n’est figé', () => {
    const { st, track } = add(project(), 'drums', 'drill-uk');
    const ev: TempoEvent[] = [{ id: 'r', bar: 2, bpm: 160, ramp: true }];
    const followed = followTempo(st as any, { tempoEvents: ev }, { keepAudio: false }).state as DAWState;
    const tracks = refreshSessionPlayers(st, followed);
    const c = tracks.find(t => t.id === track.id)!.clips[0];
    expect(c.seance).toBeTruthy();
    const map = buildTempoMap(140, TS, ev), old = buildTempoMap(140, TS, []);
    const qNew = c.notes!.map(n => Math.round(timeToQuarters(map, c.start + n.start) * 1e6));
    const qOld = track.clips[0].notes!.map(n => Math.round(timeToQuarters(old, track.clips[0].start + n.start) * 1e6));
    expect(qNew).toEqual(qOld);
  });

  it('tempo 140 → 150 → 140 puis rechargement : mêmes notes qu’au départ', () => {
    const bar = 4 * 60 / 140;
    const markers: Marker[] = [
      { id: 'a', time: 0, endTime: 2 * bar, name: 'Intro', type: 'REGION', color: '#94a3b8' } as Marker,
      { id: 'b', time: 2 * bar, endTime: 8 * bar, name: 'Refrain', type: 'REGION', color: '#f472b6' } as Marker,
    ];
    const { st, track } = add(project(140, { markers }), 'drums', 'trap', { bySection: true });
    const s2 = followTempo(st as any, { bpm: 150 }, { keepAudio: false, epoch: 'e1' }).state as DAWState;
    const t2 = { ...s2, tracks: refreshSessionPlayers(st, s2) };
    const s3 = followTempo(t2 as any, { bpm: 140 }, { keepAudio: false, epoch: 'e2' }).state as DAWState;
    const t3 = { ...s3, tracks: refreshSessionPlayers(t2, s3) };
    // Rechargé (JSON) puis recalculé de force : toujours les mêmes notes.
    const loaded = JSON.parse(JSON.stringify(t3)) as DAWState;
    const forced = { ...loaded, tracks: loaded.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, seance: { ...c.seance!, sig: 'x' } })) })) };
    const again = refreshSessionPlayers(null, forced).find(t => t.id === track.id)!;
    expect(again.clips.map(c => c.notes!.length)).toEqual(track.clips.map(c => c.notes!.length));
    again.clips.forEach((c, i) => expect(c.notes!.map(n => n.pitch)).toEqual(track.clips[i].notes!.map(n => n.pitch)));
  });

  it('retoucher une note à la main fige la région (la retouche est gardée, jamais écrasée)', () => {
    const { st, track } = add(project(), 'bass', 'boombap');
    const c0 = track.clips[0];
    const edited = { ...c0, notes: c0.notes!.map((n, i) => (i === 3 ? { ...n, pitch: n.pitch + 12 } : n)) };
    const next = { ...st, tracks: st.tracks.map(t => (t.id === track.id ? { ...t, clips: [edited] } : t)) };
    const out = refreshSessionPlayers(st, next).find(t => t.id === track.id)!.clips[0];
    expect(out.seance).toBeUndefined();
    expect(out.notes).toEqual(edited.notes);
    // Sélectionner des notes (isSelected) n'est pas une retouche.
    const sel = { ...c0, notes: c0.notes!.map(n => ({ ...n, isSelected: true })) };
    const next2 = { ...st, tracks: st.tracks.map(t => (t.id === track.id ? { ...t, clips: [sel] } : t)) };
    expect(refreshSessionPlayers(st, next2).find(t => t.id === track.id)!.clips[0].seance).toBeTruthy();
  });

  it('déplacer ou couper la région : les notes sont recalculées à la nouvelle place (pas figées)', () => {
    const { st, track } = add(project(), 'drums', 'trap');
    const bar = 4 * 60 / 140;
    const c0 = track.clips[0];
    const moved = { ...c0, start: c0.start + bar, duration: c0.duration - bar };
    const next = { ...st, tracks: st.tracks.map(t => (t.id === track.id ? { ...t, clips: [moved] } : t)) };
    const out = refreshSessionPlayers(st, next).find(t => t.id === track.id)!.clips[0];
    expect(out.seance).toBeTruthy();
    expect(out.notes).toEqual(generateSeanceNotes(moved, sanitizeSeance(c0.seance)!, seanceContext(st), track));
  });

  it('sauvegarde .zip : réglages et notes relus à l’identique, rien à recalculer à l’ouverture', async () => {
    const { ProjectIO } = await import('../services/ProjectIO');
    const { st } = add(add(project(), 'drums', 'trap').st, 'bass', 'trap');
    const blob = await ProjectIO.saveProject(st, []);
    const json = JSON.parse(await (await JSZip.loadAsync(blob)).file('project.json')!.async('string'));
    expect(json.tracks.filter((t: Track) => t.clips.some(c => c.seance)).length).toBe(2);
    const loaded = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const seance = loaded.tracks.filter(t => t.clips.some(c => c.seance));
    expect(seance.map(t => t.clips.map(c => c.notes))).toEqual(st.tracks.filter(t => t.clips.some(c => c.seance)).map(t => t.clips.map(c => c.notes)));
    const after = refreshSessionPlayers(null, loaded as DAWState);
    expect(after).toBe(loaded.tracks);
  });

  it('collaboration (opération « content ») : la région arrive avec ses réglages, et le recalcul chez l’autre donne les mêmes notes', () => {
    const { st, track } = add(project(), 'keys', 'rnb');
    const wire = JSON.parse(JSON.stringify(contentOf(track)));
    const clips = sanitizeIncomingClips(wire.clips) as unknown as Clip[];
    expect(clips[0].seance?.role).toBe('keys');
    const other: DAWState = { ...st, tracks: st.tracks.map(t => (t.id === track.id ? { ...t, clips } : t)) };
    expect(refreshSessionPlayers(null, other)).toBe(other.tracks);
    expect(sanitizeSeance({ role: 'pirate' })).toBeNull();
    expect(sanitizeSeance({ role: 'drums', complexity: 99, intensity: -4 })).toMatchObject({ complexity: 10, intensity: 1 });
  });
});

describe('musiciens de séance : sections et réglages', () => {
  const markers = (bpm: number): Marker[] => {
    const bar = 4 * 60 / bpm;
    return [
      { id: 'm1', time: 0, endTime: 2 * bar, name: 'Intro', type: 'REGION', color: '#94a3b8' } as Marker,
      { id: 'm2', time: 2 * bar, endTime: 6 * bar, name: 'Refrain', type: 'REGION', color: '#f472b6' } as Marker,
      { id: 'm3', time: 6 * bar, endTime: 8 * bar, name: 'Couplet', type: 'REGION', color: '#22d3ee' } as Marker,
    ];
  };

  it('une région par section, chacune avec ses réglages ; intro plus calme que le refrain', () => {
    const base = project(140, { markers: markers(140) });
    expect(seanceRegions(base, true).map(r => r.section)).toEqual(['Intro', 'Refrain', 'Couplet']);
    const { track } = add(base, 'drums', 'trap', { bySection: true });
    expect(track.clips.map(c => c.name)).toEqual(['Batteur · Trap · Intro', 'Batteur · Trap · Refrain', 'Batteur · Trap · Couplet']);
    const [intro, refrain] = track.clips;
    expect(intro.seance!.intensity).toBeLessThan(refrain.seance!.intensity);
    expect(intro.notes!.length / intro.duration).toBeLessThan(refrain.notes!.length / refrain.duration);
  });

  it('« Une région par section » après coup, et réglage d’une seule région (les autres ne bougent pas)', () => {
    const { st, track } = add(project(140, { markers: markers(140) }), 'bass', 'rnb');
    expect(track.clips.length).toBe(1);
    const r = splitSeanceBySections(st, track.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.state.tracks.find(x => x.id === track.id)!;
    expect(t.clips.length).toBe(3);
    const upd = updateSeance(r.state, track.id, [t.clips[1].id], { complexity: 10 });
    const t2 = upd.tracks.find(x => x.id === track.id)!;
    expect(t2.clips[0]).toBe(t.clips[0]);
    expect(t2.clips[1].notes!.length).toBeGreaterThan(t.clips[1].notes!.length);
    expect(t2.clips[1].seance!.complexity).toBe(10);
    const none = splitSeanceBySections(project(), add(project(), 'bass', 'rnb').track.id);
    expect(none.ok).toBe(false);
  });

  it('kit du batteur sans index chargé : kit synthé du genre, aucun motif (le batteur joue tout)', () => {
    const dm = drummerKit('boombap', null);
    expect(dm.rows.every(r => r.steps.every(v => v === 0))).toBe(true);
    expect(drumPitchFor('kick', dm.rows)).toBe(60);
    expect(drumPitchFor('hihat', dm.rows)).not.toBeNull();
  });
});
