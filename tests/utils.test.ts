import { describe, expect, it, vi } from 'vitest';
import { formatMesures, nomTonaliteCourt, TICKS_PAR_TEMPS } from '../utils/musicKey';
import { playheadStore } from '../utils/playheadStore';
import { findTrackForRole, getVocalRole, isVoiceTrack } from '../utils/vocalRoles';
import { dailyChallengeId, todayKey } from '../utils/dailyChallenge';
import { bornerFacteur, etirerCanaux, facteurPourTempo } from '../utils/timeStretch';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { TrackType } from '../types';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeTrack } from './helpers/fixtures';

describe('nomTonaliteCourt', () => {
  it('noms français, versions longue et courte', () => {
    expect(nomTonaliteCourt(0, 'MINOR')).toBe('Do mineur');
    expect(nomTonaliteCourt(0, 'MINOR', true)).toBe('Do min');
    expect(nomTonaliteCourt(9, 'MAJOR')).toBe('La majeur');
    expect(nomTonaliteCourt(3, 'major', true)).toBe('Mi♭ maj');
    expect(nomTonaliteCourt(10, 'MINOR_HARMONIC')).toBe('Si♭ mineur harm.');
  });
  it('gamme absente = mineur ; chromatique = note seule ; gamme inconnue = note seule', () => {
    expect(nomTonaliteCourt(7)).toBe('Sol mineur');
    expect(nomTonaliteCourt(7, 'CHROMATIC')).toBe('Sol');
    expect(nomTonaliteCourt(7, 'DORIAN')).toBe('Sol');
  });
  it('index hors 0–11 ramené dans l\'octave, inconnu = vide', () => {
    expect(nomTonaliteCourt(12, 'MAJOR')).toBe('Do majeur');
    expect(nomTonaliteCourt(-1, 'MAJOR')).toBe('Si majeur');
    expect(nomTonaliteCourt(1.4, 'MAJOR')).toBe('Do# majeur');
    expect(nomTonaliteCourt(undefined, 'MAJOR')).toBe('');
    expect(nomTonaliteCourt(NaN, 'MAJOR')).toBe('');
  });
});

describe('formatMesures', () => {
  it('mesure | temps | ticks, 1-indexés', () => {
    expect(formatMesures(0, 120)).toBe('001 | 1 | 000');
    expect(formatMesures(0.5, 120)).toBe('001 | 2 | 000');
    expect(formatMesures(2, 120)).toBe('002 | 1 | 000');
    expect(formatMesures(0.25, 120)).toBe(`001 | 1 | ${TICKS_PAR_TEMPS / 2}`);
    expect(formatMesures(60, 90)).toBe('023 | 3 | 000');
  });
  it('signature : en 6/8 un temps = une croche ; 3/4', () => {
    expect(formatMesures(1.5, 120, 6, 8)).toBe('002 | 1 | 000');
    expect(formatMesures(1.25, 120, 6, 8)).toBe('001 | 6 | 000');
    expect(formatMesures(1.5, 120, 3, 4)).toBe('002 | 1 | 000');
  });
  it('valeurs dégénérées : jamais de NaN', () => {
    expect(formatMesures(-3, 120)).toBe('001 | 1 | 000');
    expect(formatMesures(1, 0)).toBe(formatMesures(1, 120));
    expect(formatMesures(1, 120, 0, 0)).toBe(formatMesures(1, 120, 4, 4));
    // Pas d'arrondi flottant qui donnerait « 960 » ticks
    expect(formatMesures(0.4999999999, 120)).not.toMatch(/\| 960$/);
  });
});

describe('playheadStore', () => {
  it('notifie les abonnés seulement si la position change', () => {
    const l = vi.fn();
    const off = playheadStore.subscribe(l);
    playheadStore.set(12.5);
    expect(playheadStore.get()).toBe(12.5);
    playheadStore.set(12.5);
    playheadStore.set(NaN);
    playheadStore.set(Infinity);
    expect(playheadStore.get()).toBe(12.5);
    expect(l).toHaveBeenCalledTimes(1);
    off();
    playheadStore.set(3);
    expect(l).toHaveBeenCalledTimes(1);
    expect(playheadStore.get()).toBe(3);
  });
});

describe('rôles des voix', () => {
  const v = (name: string, over = {}) => makeTrack({ name, type: TrackType.AUDIO, ...over });
  it('getVocalRole d\'après le nom', () => {
    expect(getVocalRole(makeTrack({ id: 'instrumental' }))).toBe('beat');
    expect(getVocalRole(v('Voix'))).toBe('lead');
    expect(getVocalRole(v('Backs'))).toBe('back');
    expect(getVocalRole(v('Double refrain'))).toBe('back');
    expect(getVocalRole(v('Chœurs'))).toBe('back');
    expect(getVocalRole(v('Harmonies'))).toBe('harmony');
    expect(getVocalRole(v('Ad-libs'))).toBe('adlib');
    expect(getVocalRole(v('ADLIB'))).toBe('adlib');
    expect(getVocalRole(makeTrack({ name: 'Basse', type: TrackType.MIDI }))).toBe('other');
    expect(getVocalRole(v('Beat', { instrumentId: 'x' }))).toBe('other');
  });
  it('isVoiceTrack', () => {
    expect(isVoiceTrack(v('Voix'))).toBe(true);
    expect(isVoiceTrack(null)).toBe(false);
    expect(isVoiceTrack(makeTrack({ id: 'instrumental' }))).toBe(false);
  });
  it('findTrackForRole : lead = piste REC principale ; autre rôle = piste vide de préférence', () => {
    const tracks = [
      v('Voix 2', { id: 'other-lead' }),
      v('Voix', { id: 'track-rec-main' }),
      v('Backs', { id: 'backs-full', clips: [makeClip()] }),
      v('Backs 2', { id: 'backs-empty' }),
    ];
    expect(findTrackForRole(tracks, 'lead')?.id).toBe('track-rec-main');
    expect(findTrackForRole(tracks, 'back')?.id).toBe('backs-empty');
    expect(findTrackForRole(tracks.slice(0, 3), 'back')?.id).toBe('backs-full');
    expect(findTrackForRole(tracks, 'harmony')).toBeUndefined();
  });
});

describe('défi du jour', () => {
  it('même prod pour une date donnée, quel que soit l\'ordre de la liste', () => {
    const ids = ['b', 'a', 'd', 'c'];
    const x = dailyChallengeId(ids, '2026-10-03');
    expect(ids).toContain(x);
    expect(dailyChallengeId([...ids].reverse(), '2026-10-03')).toBe(x);
    expect(dailyChallengeId([], '2026-10-03')).toBeNull();
    expect(ids).toEqual(['b', 'a', 'd', 'c']); // liste d'origine non triée sur place
  });
  it('change selon les jours', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    expect(new Set(days.map(d => dailyChallengeId(ids, d))).size).toBeGreaterThan(1);
  });
  it('todayKey : AAAA-MM-JJ', () => {
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('time stretch : facteurs', () => {
  it('facteurPourTempo', () => {
    expect(facteurPourTempo(90, 180)).toBe(0.5);
    expect(facteurPourTempo(140, 70)).toBe(2);
    expect(facteurPourTempo(0, 120)).toBe(1);
    expect(facteurPourTempo(120, -1)).toBe(1);
  });
  it('bornerFacteur : 0,25–4', () => {
    expect(bornerFacteur(10)).toBe(4);
    expect(bornerFacteur(0.1)).toBe(0.25);
    expect(bornerFacteur(1.5)).toBe(1.5);
  });
  it('etirerCanaux : longueur = longueur × facteur, niveau conservé', () => {
    const src = makeBuffer(1, 22050, 44100, (_c, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100)).getChannelData(0);
    const [out] = etirerCanaux([src], 1.5);
    expect(out.length).toBe(Math.round(22050 * 1.5));
    const rms = (a: Float32Array, from: number, to: number) => Math.sqrt(a.subarray(from, to).reduce((s, x) => s + x * x, 0) / (to - from));
    const rIn = rms(src, 4096, 18000);
    const rOut = rms(out, 4096, 28000);
    expect(Math.abs(rOut - rIn) / rIn).toBeLessThan(0.2);
  });
});

describe('audioBufferRegistry', () => {
  it('register / get / has / remove / ids', () => {
    audioBufferRegistry.clear();
    const b = makeBuffer(1, 10);
    expect(audioBufferRegistry.register(b, 'x')).toBe('x');
    const auto = audioBufferRegistry.register(b);
    expect(auto).toMatch(/^buffer-/);
    expect(audioBufferRegistry.get('x')).toBe(b);
    expect(audioBufferRegistry.has(auto)).toBe(true);
    expect(audioBufferRegistry.ids().sort()).toEqual([auto, 'x'].sort());
    expect(audioBufferRegistry.remove('x')).toBe(true);
    expect(audioBufferRegistry.remove('x')).toBe(false);
    expect(audioBufferRegistry.size).toBe(1);
    audioBufferRegistry.clear();
    expect(audioBufferRegistry.size).toBe(0);
  });
});
