import { describe, expect, it } from 'vitest';
import rawKits from '../data/drum-kits/index.json';
import { BEAT_GENRES, PROGRESSIONS, genreFromText, genreRecipe } from '../utils/beatRecipes';
import {
  applyBeatSkeleton, BEAT_CHORDS_TRACK_ID, beatVariants, buildBeat, chordPcs, DRUM_TRACK_ID, drumMachineFor, parseHits,
  progressionsFor, skeletonDistance, voiceChord,
} from '../utils/beatStarter';
import { BASS808_TRACK_ID } from '../utils/bass808';
import { parseKitIndex } from '../utils/drumKitLibrary';
import { scalePitchClasses } from '../utils/scales';
import { rowStepsPerBar } from '../utils/drumPatterns';
import { TrackType } from '../types';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

const ix = parseKitIndex(rawKits as any);
const pc = (n: number) => ((n % 12) + 12) % 12;

describe('recettes de genre (lot 10)', () => {
  it('6 genres, tempo dans la plage, 3 motifs de batterie bien formés, au moins 3 suites sourcées', () => {
    expect(BEAT_GENRES.map(g => g.id)).toEqual(['trap', 'drill-uk', 'drill-fr', 'boombap', 'rnb', 'afro']);
    for (const g of BEAT_GENRES) {
      expect(g.bpm, g.id).toBeGreaterThanOrEqual(g.bpmRange[0]);
      expect(g.bpm, g.id).toBeLessThanOrEqual(g.bpmRange[1]);
      expect(g.drums.length, g.id).toBe(3);
      expect(g.src.length, g.id).toBeGreaterThan(0);
      for (const d of g.drums) {
        expect(d.src.length, `${g.id} ${d.name}`).toBeGreaterThan(0);
        for (const l of d.lines) {
          const per = rowStepsPerBar({ rate: l.rate });
          const len = parseHits(l.hits).vel.length;
          // Une mesure (répétée) ou toutes les mesures du motif.
          expect([per, per * d.bars], `${g.id} ${d.name} ${l.role}`).toContain(len);
        }
        expect(d.lines.some(l => l.role === 'kick'), `${g.id} ${d.name}`).toBe(true);
      }
      expect(progressionsFor(g.id).length, g.id).toBeGreaterThanOrEqual(3);
    }
    for (const p of PROGRESSIONS) expect(p.src.length, p.id).toBeGreaterThan(0);
  });

  it('les accords des suites sont dans la gamme déclarée', () => {
    for (const p of PROGRESSIONS) {
      const scale = scalePitchClasses(0, p.scale);
      for (const c of p.chords) for (const n of chordPcs(c.off, c.q)) expect(scale.has(n), `${p.id} ${c.off}${c.q}`).toBe(true);
    }
  });

  it('lecture des motifs : accent, coup, ghost, rolls', () => {
    const h = parseHits('Xxo.3|2...');
    expect(h.vel).toEqual([118, 100, 64, 0, 92, 92, 0, 0, 0]);
    expect(h.ratchet).toEqual([1, 1, 1, 1, 3, 2, 1, 1, 1]);
  });

  it('genre reconnu dans une phrase', () => {
    expect(genreFromText('un beat drill fr')).toBe('drill-fr');
    expect(genreFromText('Drill UK sombre')).toBe('drill-uk');
    expect(genreFromText('boom bap old school')).toBe('boombap');
    expect(genreFromText('du R&B')).toBe('rnb');
    expect(genreFromText('afrobeat')).toBe('afro');
    expect(genreFromText('trap')).toBe('trap');
    expect(genreFromText('valse')).toBeNull();
  });
});

describe('Démarrer un beat : règles prouvées', () => {
  it('100 % des notes (accords, 808) dans la gamme ou dans l’accord, sur tous les genres, toniques et variantes', () => {
    for (const g of BEAT_GENRES) for (let root = 0; root < 12; root++) for (const mode of ['minor', 'major'] as const) for (let v = 0; v < 3; v++) {
      const sk = buildBeat({ genre: g.id, root, mode, variant: v });
      const scale = scalePitchClasses(sk.root, sk.scale);
      for (const n of [...sk.chordNotes, ...sk.bassNotes]) {
        const ch = sk.chords.find(c => n.start >= c.start - 1e-6 && n.start < c.end - 1e-6);
        const ok = scale.has(pc(n.pitch)) || (!!ch && chordPcs(ch.root, ch.quality).includes(pc(n.pitch)));
        expect(ok, `${g.id} ${root} ${mode} v${v} note ${n.pitch}@${n.start}`).toBe(true);
      }
    }
  });

  it('la 808 tombe sur la fondamentale de l’accord à chaque changement', () => {
    for (const g of BEAT_GENRES) for (const root of [0, 5, 9]) for (let v = 0; v < 3; v++) {
      const sk = buildBeat({ genre: g.id, root, variant: v });
      for (const c of sk.chords) {
        const hit = sk.bassNotes.find(n => Math.abs(n.start - c.start) < 1e-6);
        expect(hit, `${g.id} v${v} accord à ${c.start}`).toBeTruthy();
        expect(pc(hit!.pitch)).toBe(pc(c.root));
      }
    }
  });

  it('le dé : 3 variantes distinctes (au moins 30 % des notes et des coups diffèrent), avec plusieurs graines', () => {
    for (const g of BEAT_GENRES) for (const seed of [0, 1, 2, 7]) for (const root of [0, 6]) {
      const vs = beatVariants({ genre: g.id, root, seed });
      expect(vs.length).toBe(3);
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        expect(skeletonDistance(vs[i], vs[j]), `${g.id} graine ${seed} ${i}/${j}`).toBeGreaterThanOrEqual(0.3);
      }
    }
  });

  it('relancer le dé change les 3 variantes', () => {
    for (const g of BEAT_GENRES) {
      const a = beatVariants({ genre: g.id, root: 0, seed: 0 }), b = beatVariants({ genre: g.id, root: 0, seed: 1 });
      for (let i = 0; i < 3; i++) expect(skeletonDistance(a[i], b[i]), `${g.id} variante ${i}`).toBeGreaterThan(0);
    }
  });

  it('tempo du genre par défaut, tonalité choisie, 8 mesures', () => {
    const sk = buildBeat({ genre: 'drill-uk', root: 5, mode: 'minor' });
    expect(sk.bpm).toBe(142);
    expect(sk.root).toBe(5);
    expect(sk.bars).toBe(8);
    expect(sk.chords[sk.chords.length - 1].end).toBeCloseTo(8 * 4 * 60 / 142, 6);
    expect(sk.summary).toContain('Fa mineur');
    // Majeur demandé sur un genre sans suite majeure : la suite mineure reste.
    expect(buildBeat({ genre: 'trap', root: 0, mode: 'major' }).scale).toBe('MINOR');
    expect(buildBeat({ genre: 'afro', root: 7 }).scale).toBe('MAJOR');
  });

  it('voicings resserrés (conduite des voix) dans le registre médium', () => {
    const a = voiceChord(0, 'min', null);
    const b = voiceChord(8, 'maj', a);
    for (const v of [a, b]) for (const n of v) { expect(n).toBeGreaterThanOrEqual(52); expect(n).toBeLessThanOrEqual(79); }
    const move = b.reduce((s, n) => s + Math.min(...a.map(x => Math.abs(x - n))), 0);
    expect(move).toBeLessThanOrEqual(6);
  });

  it('batterie : kit NOVA du genre, motif posé sur les bons pads (triolets compris), repli synthé hors ligne', () => {
    const sk = buildBeat({ genre: 'drill-uk', variant: 2 });
    const dm = drumMachineFor(sk, ix, 2);
    expect(dm.kitId.startsWith('nova:drill')).toBe(true);
    const hat = dm.rows.find(r => r.id === 'hatc')!;
    expect(hat.rate).toBe('16t');
    expect(hat.steps.length).toBe(48);
    const snare = dm.rows.find(r => r.id === 'snare')!;
    expect(snare.steps.map((v, i) => (v ? i : -1)).filter(i => i >= 0)).toEqual([10, 28]);
    const off = drumMachineFor(buildBeat({ genre: 'trap', variant: 0 }), null, 0);
    expect(off.kitId).toBe('trap');
    expect(off.rows.find(r => r.id === 'clap')!.steps.filter(v => v > 0).length).toBe(2);
  });
});

describe('pose du squelette (une seule étape d’annulation)', () => {
  const vox = makeTrack({ id: 'track-rec-main', name: 'REC' });

  it('projet vide : batterie, 808, instrument, piste d’accords, tempo et tonalité', () => {
    const st = makeState([vox], { bpm: 120 });
    const sk = buildBeat({ genre: 'trap', root: 9, variant: 1 });
    const r = applyBeatSkeleton(st, sk, ix);
    const n = r.state;
    expect(r.keptTempo).toBe(false);
    expect(n.bpm).toBe(140);
    expect(n.projectKey).toBe(9);
    expect(n.projectScale).toBe('MINOR');
    const drums = n.tracks.find(t => t.id === DRUM_TRACK_ID)!;
    expect(drums.type).toBe(TrackType.DRUM_RACK);
    expect(drums.clips.length).toBeGreaterThan(0);
    expect(drums.drumMachine!.bpmUsed).toBe(140);
    const b = n.tracks.find(t => t.id === BASS808_TRACK_ID)!;
    expect(b.clips[0].notes!.length).toBe(sk.bassNotes.length);
    const acc = n.tracks.find(t => t.id === BEAT_CHORDS_TRACK_ID)!;
    expect(acc.melodicSampler?.instrument).toBe(genreRecipe('trap').instruments[0]);
    expect(n.chords!.length).toBe(sk.chords.length);
    expect(st.tracks.length).toBe(1); // l'état d'origine n'est pas touché
    expect(r.message).toContain('Ctrl+Z');
  });

  it('une instru est chargée : son tempo et sa tonalité sont gardés, les notes suivent ce tempo', () => {
    const beat = makeTrack({ id: 'instrumental', name: 'BEAT', clips: [makeClip({ duration: 60 })] });
    const st = makeState([beat, vox], { bpm: 95, projectKey: 2, projectScale: 'MINOR' });
    const sk = buildBeat({ genre: 'boombap', root: 2, bpm: 95 });
    const r = applyBeatSkeleton(st, sk, ix);
    expect(r.keptTempo).toBe(true);
    expect(r.state.bpm).toBe(95);
    expect(r.state.projectKey).toBe(2);
    expect(r.state.tracks.findIndex(t => t.id === DRUM_TRACK_ID)).toBe(1);
  });

  it('reposer un squelette remplace le précédent (pas de piste en double)', () => {
    const st = makeState([vox]);
    const a = applyBeatSkeleton(st, buildBeat({ genre: 'afro' }), ix).state;
    const b = applyBeatSkeleton(a, buildBeat({ genre: 'rnb' }), ix).state;
    expect(b.tracks.filter(t => t.id === DRUM_TRACK_ID).length).toBe(1);
    expect(b.tracks.filter(t => t.id === BEAT_CHORDS_TRACK_ID).length).toBe(1);
    expect(b.tracks.filter(t => t.id === BASS808_TRACK_ID).length).toBe(1);
    expect(b.bpm).toBe(75);
  });
});
