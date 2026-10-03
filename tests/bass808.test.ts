import { describe, expect, it } from 'vitest';
import { bass808RootNote, events808, kit808Style, midiToHz, plan808, rateForPitch, starter808Notes, BASS808_ROOT } from '../utils/bass808';
import { makeDrumMachine, DRUM_KITS, drumClipFor, drumPadsFor, DrumMachine } from '../utils/drumKits';

const n = (pitch: number, start: number, duration: number, velocity = 0.9) => ({ pitch, start, duration, velocity });

describe('808 : hauteur', () => {
  it('vitesse de lecture = 2^(demi-tons / 12) autour de la note du sample', () => {
    expect(rateForPitch(BASS808_ROOT)).toBe(1);
    expect(rateForPitch(BASS808_ROOT + 12)).toBeCloseTo(2, 10);
    expect(rateForPitch(BASS808_ROOT - 12)).toBeCloseTo(0.5, 10);
    expect(rateForPitch(BASS808_ROOT + 7)).toBeCloseTo(1.4983, 4);
    // la fréquence jouée suit la note
    expect(midiToHz(BASS808_ROOT) * rateForPitch(31)).toBeCloseTo(midiToHz(31), 6);
  });

  it('tonique du morceau dans l\'octave grave (Do 1 … Si 1)', () => {
    expect(bass808RootNote(0)).toBe(24);
    expect(bass808RootNote(6)).toBe(30); // Fa#
    expect(bass808RootNote(11)).toBe(35);
    expect(bass808RootNote(-1)).toBe(35);
    expect(bass808RootNote(undefined)).toBe(24);
    expect(midiToHz(bass808RootNote(9))).toBeCloseTo(55, 6); // La 1
  });

  it('style : saturée en drill, propre sinon', () => {
    expect(kit808Style('drill')).toBe('808-dist');
    expect(kit808Style('trap')).toBe('808');
    expect(kit808Style(undefined)).toBe('808');
  });
});

describe('808 : notes de départ', () => {
  it('tonique sur le rythme 808 du kit, tenue jusqu\'au coup suivant', () => {
    const step = 60 / 120 / 4;
    const notes = starter808Notes({ projectKey: 7, bpm: 120, bars: 2, kitId: 'trap' });
    expect(notes.map(x => x.pitch)).toEqual(Array(6).fill(31));
    expect(notes.map(x => Math.round(x.start / step))).toEqual([0, 7, 10, 16, 23, 26]);
    expect(notes.map(x => Math.round(x.duration / step))).toEqual([7, 3, 6, 7, 3, 6]);
    // jamais de chevauchement : pas de glissé involontaire
    expect(plan808(notes, true)).toHaveLength(6);
  });

  it('kit sans rythme 808 : premier temps de chaque mesure', () => {
    const notes = starter808Notes({ bpm: 90, bars: 4, kitId: 'house' });
    expect(notes).toHaveLength(4);
    expect(notes[1].start).toBeCloseTo((60 / 90) * 4, 9);
    expect(notes[0].duration).toBeCloseTo((60 / 90) * 4, 9);
  });
});

describe('808 : plan monophonique', () => {
  it('notes séparées : une voix par note, tenue sur la longueur de la note', () => {
    const v = plan808([n(36, 0, 0.5), n(31, 1, 0.25)], true);
    expect(v).toEqual([
      { start: 0, end: 0.5, velocity: 0.9, steps: [{ t: 0, pitch: 36 }] },
      { start: 1, end: 1.25, velocity: 0.9, steps: [{ t: 1, pitch: 31 }] },
    ]);
  });

  it('chevauchement + glissé : pas de réattaque, la hauteur glisse, la voix finit avec la nouvelle note', () => {
    const v = plan808([n(36, 0, 1), n(43, 0.75, 0.5)], true);
    expect(v).toHaveLength(1);
    expect(v[0].steps).toEqual([{ t: 0, pitch: 36 }, { t: 0.75, pitch: 43 }]);
    expect(v[0].end).toBe(1.25);
  });

  it('chevauchement sans glissé : la nouvelle note coupe la précédente (mono)', () => {
    const v = plan808([n(36, 0, 1), n(43, 0.75, 0.5)], false);
    expect(v.map(x => [x.start, x.end, x.steps[0].pitch])).toEqual([[0, 0.75, 36], [0.75, 1.25, 43]]);
  });

  it('notes collées (fin = début) : réattaque, pas de glissé', () => {
    const v = plan808([n(36, 0, 0.5), n(38, 0.5, 0.5)], true);
    expect(v).toHaveLength(2);
  });

  it('accord : la note la plus grave gagne, une seule voix', () => {
    const v = plan808([n(48, 0, 1), n(36, 0, 1), n(43, 0, 0.5)], false);
    expect(v).toHaveLength(1);
    expect(v[0].steps).toEqual([{ t: 0, pitch: 36 }]);
  });

  it('ordre des notes indifférent ; notes vides ignorées', () => {
    const a = plan808([n(43, 0.75, 0.5), n(36, 0, 1), n(40, 3, 0)], true);
    expect(a).toEqual(plan808([n(36, 0, 1), n(43, 0.75, 0.5)], true));
  });
});

describe('808 : événements par fenêtre (lecture en direct)', () => {
  const voices = plan808([n(36, 0, 1), n(43, 0.75, 0.5), n(31, 1.25, 0.5)], true);

  it('dans l\'ordre du temps, relâchement avant attaque au même instant', () => {
    expect(events808(voices, 0, 2)).toEqual([
      { kind: 'start', t: 0, pitch: 36, velocity: 0.9 },
      { kind: 'glide', t: 0.75, pitch: 43 },
      { kind: 'stop', t: 1.25 },
      { kind: 'start', t: 1.25, pitch: 31, velocity: 0.9 },
      { kind: 'stop', t: 1.75 },
    ]);
  });

  it('fenêtres successives : chaque événement une seule fois', () => {
    const all = [0, 0.5, 1, 1.5].flatMap(w => events808(voices, w, w + 0.5));
    expect(all).toEqual(events808(voices, 0, 2));
  });
});

describe('Batterie : la 808 quitte le séquenceur', () => {
  it('nouveaux kits sans rangée 808 (7 pads)', () => {
    for (const k of DRUM_KITS) {
      const dm = makeDrumMachine(k.id);
      expect(dm.rows.some(r => r.id === '808')).toBe(false);
      expect(dm.rows).toHaveLength(7);
    }
  });

  it('ancien projet avec rangée 808 : elle joue toujours (pad 2, note 61)', () => {
    const z = () => new Array(16).fill(0);
    const legacy: DrumMachine = { kitId: 'trap', bars: 1, swing: 0, rows: [
      { id: 'kick', name: 'Kick', sound: 'synth:kick-punch', steps: [110, ...z().slice(1)], ratchet: z().map(() => 1), volume: 0.85, pan: 0 },
      { id: '808', name: '808', sound: 'synth:808', steps: [0, 0, 0, 0, 0, 0, 0, 110, ...z().slice(8)], ratchet: z().map(() => 1), volume: 0.9, pan: 0, choke: 2 },
    ] };
    expect(drumPadsFor(legacy)[1]).toMatchObject({ id: 2, midiNote: 61, sampleName: 'synth:808' });
    const notes = (drumClipFor(legacy, 120, 0, 2, 'c') as any).notes as { pitch: number; start: number }[];
    expect(notes.filter(x => x.pitch === 61).map(x => x.start)).toEqual([7 * 0.125]);
  });
});
