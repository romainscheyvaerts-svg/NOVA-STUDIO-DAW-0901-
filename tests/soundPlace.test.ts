import { describe, expect, it } from 'vitest';
import rawKits from '../data/drum-kits/index.json';
import { parseKitIndex } from '../utils/drumKitLibrary';
import { loopBars, loopContent, placeLoop, placeStudioSound, snapToBar, withDrumMachine } from '../utils/soundPlace';
import { loopHitTimes } from '../utils/soundPreview';
import { DRUM_TRACK_ID } from '../utils/beatStarter';
import { BASS808_TRACK_ID } from '../utils/bass808';
import { PROGRESSIONS } from '../utils/beatRecipes';
import { midiTarget, withClipNotes } from '../components/SonsBeatHost';
import { editSelectionStore } from '../utils/editSelection';
import { TrackType } from '../types';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

const ix = parseKitIndex(rawKits as any);
const vox = makeTrack({ id: 'track-rec-main', name: 'REC' });

describe('boucles NOVA : contenu et calage', () => {
  it('pré-écoute calée au tempo : chaque coup sur la grille, écart ≤ 1 ms par mesure', () => {
    for (const bpm of [70, 90, 106, 140, 142]) {
      // Motifs sans swing (trap C, drill UK C) : la grille exacte.
      for (const ref of ['loop:drums:trap:2', 'loop:drums:drill-uk:2']) {
        const c = loopContent(ref, bpm, ix)!;
        const hits = loopHitTimes(c, bpm);
        expect(hits.length).toBeGreaterThan(8);
        const six = 60 / bpm / 4;
        for (const h of hits) {
          // Doubles-croches, triolets de doubles-croches (1/24 de mesure) ou rolls (1/2, 1/3 de pas).
          const grid = [six, (4 * 60 / bpm) / 24, six / 2, six / 3];
          const ok = grid.some(g => Math.abs(h.t / g - Math.round(h.t / g)) * g <= 0.001);
          expect(ok, `${ref} à ${bpm} : ${h.t}`).toBe(true);
        }
        // Début de chaque mesure : un kick pile sur la mesure.
        const bar = 4 * 60 / bpm;
        for (let b = 0; b < c.bars; b++) expect(hits.some(h => Math.abs(h.t - b * bar) <= 0.001), `${ref} mesure ${b + 1}`).toBe(true);
      }
    }
  });

  it('longueur des boucles d’accords : la suite entière, au moins 4 mesures', () => {
    for (const p of PROGRESSIONS) expect(loopBars(p)).toBeGreaterThanOrEqual(4);
    expect(snapToBar(5.1, 120)).toBe(4);
    expect(snapToBar(0.3, 120)).toBe(0);
  });
});

describe('pose d’une boucle (une seule étape d’annulation)', () => {
  it('accords : nouvelle piste d’instrument calée sur la mesure, accords ajoutés, tonalité prise si le projet n’en a pas', () => {
    const st = makeState([vox], { bpm: 140 });
    const r = placeLoop(st, 'loop:chords:trap-melo:9:cloches', 5.2, ix)!;
    const bar = 4 * 60 / 140;
    const t = r.state.tracks.find(x => x.id.startsWith('track-boucle-'))!;
    expect(t.type).toBe(TrackType.MIDI);
    expect(t.melodicSampler?.instrument).toBe('cloches');
    expect(t.clips[0].start).toBeCloseTo(Math.floor(5.2 / bar) * bar, 6);
    expect(t.clips[0].duration).toBeCloseTo(4 * bar, 6);
    expect(r.state.chords!.length).toBe(4);
    expect(r.state.chords![0].start).toBeCloseTo(t.clips[0].start, 6);
    expect(r.state.projectKey).toBe(9);
    expect(r.state.projectScale).toBe('MINOR');
    expect(r.message).toContain('mesure');
    // Projet déjà en tonalité : on n'y touche pas.
    expect(placeLoop(makeState([vox], { projectKey: 2, projectScale: 'MAJOR' }), 'loop:chords:trap-melo:9:cloches', 0, ix)!.state.projectKey).toBe(2);
  });

  it('808 : sur la piste 808, la partie recouverte d’un ancien clip est remplacée, le reste gardé', () => {
    const bar = 4 * 60 / 120;
    const old = makeClip({ id: 'old', type: TrackType.MIDI, start: 0, duration: 8 * bar, notes: [
      { id: 'a', pitch: 30, start: 0, duration: 1, velocity: 1 }, { id: 'b', pitch: 30, start: 6 * bar, duration: 1, velocity: 1 },
    ] });
    const t808 = makeTrack({ id: BASS808_TRACK_ID, type: TrackType.MIDI, clips: [old], bass808: { style: '808', glide: true } as any });
    const r = placeLoop(makeState([vox, t808]), 'loop:808:drilluk-phryg:7', 2 * bar, ix)!;
    const clips = r.state.tracks.find(t => t.id === BASS808_TRACK_ID)!.clips.sort((a, b) => a.start - b.start);
    expect(clips.map(c => [Math.round(c.start / bar), Math.round(c.duration / bar)])).toEqual([[0, 2], [2, 4], [6, 2]]);
    expect(clips[2].notes!.map(n => n.pitch)).toEqual([30]);
  });

  it('batterie : la boîte à rythmes reçoit le motif et le kit du genre', () => {
    const r = placeLoop(makeState([vox]), 'loop:drums:afro:1', 0, ix)!;
    const d = r.state.tracks.find(t => t.id === DRUM_TRACK_ID)!;
    expect(d.drumMachine!.kitId.startsWith('nova:afro')).toBe(true);
    expect(d.clips.length).toBeGreaterThan(0);
  });

  it('palette posée en une fois : plusieurs boucles dans le même état suivant', () => {
    let s = makeState([vox], { bpm: 140, projectKey: 9, projectScale: 'MINOR' });
    for (const ref of ['loop:drums:trap:0', 'loop:chords:trap-maskoff:9:cloches', 'loop:808:trap-maskoff:9']) s = placeLoop(s, ref, 0, ix)!.state;
    expect(s.tracks.some(t => t.id === DRUM_TRACK_ID)).toBe(true);
    expect(s.tracks.some(t => t.id === BASS808_TRACK_ID)).toBe(true);
    expect(s.tracks.some(t => t.id.startsWith('track-boucle-'))).toBe(true);
  });

  it('référence inconnue : rien n’est posé', () => {
    expect(placeLoop(makeState([vox]), 'loop:chords:inconnue:0:piano', 0, ix)).toBeNull();
    expect(placeLoop(makeState([vox]), 'pas-une-boucle', 0, ix)).toBeNull();
  });

  it('son de la batterie du studio : nouveau pad (30 au plus), nom générique', () => {
    const r = placeStudioSound(null, 'kick-31742016')!;
    expect(r.dm.rows[r.rowIndex].sound).toBe('url:/drums/lib/kick-31742016.wav');
    expect(r.dm.rows[r.rowIndex].name).toMatch(/^Kick \d+$/);
    const s = withDrumMachine(makeState([vox]), r.dm);
    expect(s.tracks.find(t => t.id === DRUM_TRACK_ID)!.drumMachine!.rows.length).toBe(r.dm.rows.length);
  });
});

describe('Prolonger / Varier : clip visé et remplacement', () => {
  it('clip sélectionné, sinon le 1er clip MIDI de la piste sélectionnée ; jamais la batterie', () => {
    const c1 = makeClip({ id: 'm1', type: TrackType.MIDI, notes: [{ id: 'n', pitch: 60, start: 0, duration: 0.5, velocity: 1 }] });
    const midi = makeTrack({ id: 'piano', type: TrackType.MIDI, clips: [c1] });
    const st = makeState([vox, midi], { selectedTrackId: 'piano' });
    editSelectionStore.set({ clipIds: [] });
    expect(midiTarget(st)?.clip.id).toBe('m1');
    expect(midiTarget(makeState([vox, midi]))).toBeNull();
    editSelectionStore.set({ clipIds: ['m1'] });
    expect(midiTarget(makeState([vox, midi]))?.track.id).toBe('piano');
    editSelectionStore.set({ clipIds: [] });
    const n = withClipNotes(st, 'piano', 'm1', [], 8);
    expect(n.tracks[1].clips[0].duration).toBe(8);
    expect(st.tracks[1].clips[0].duration).toBe(4);
  });
});
