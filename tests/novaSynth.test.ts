import { describe, expect, it } from 'vitest';
import {
  normalizeSynth, defaultSynth, unisonVoices, ampEnvAt, STEAL_FADE, velocityGain, cutoffFor, mixNorm, envValue, noteFreq,
  glideSource, voicesToCut, voiceToRelease, nextMonoStart, stepIndex, toggleFavorite, settingsKey, VoiceSlot, MAX_VOICES,
} from '../utils/novaSynth';
import { SYNTH_PRESETS, PRESET_CATEGORIES, presetSettings, presetById, previewNotesFor, DEFAULT_PRESET_ID } from '../utils/novaSynthPresets';
import { contentOf } from '../services/Collab';
import { Track } from '../types';

describe('Synthé NOVA : réglages', () => {
  it('normalise n\'importe quoi en réglages complets et bornés', () => {
    const s = normalizeSynth({ osc: [{ on: true, wave: 'bizarre', unison: 99, detune: -5 }], filter: { cutoff: 1e9, type: 'notch' }, ampEnv: { a: -1 }, level: 'fort' });
    expect(s.osc).toHaveLength(3);
    expect(s.osc[0].wave).toBe('sawtooth');
    expect(s.osc[0].unison).toBe(7);
    expect(s.osc[0].detune).toBe(0);
    expect(s.osc[1].on).toBe(false);
    expect(s.filter.cutoff).toBe(20000);
    expect(s.filter.type).toBe('lowpass');
    expect(s.ampEnv.a).toBe(0);
    expect(s.level).toBe(defaultSynth().level);
    expect(normalizeSynth(null).osc[0].on).toBe(true);
  });

  it('est stable : normaliser deux fois ne change rien', () => {
    for (const p of SYNTH_PRESETS) {
      const a = presetSettings(p.id);
      expect(normalizeSynth(a)).toEqual(a);
    }
  });

  it('ignore les champs inconnus (version plus récente) sans planter', () => {
    const s = normalizeSynth({ ...defaultSynth(), wavetable: 'x', osc: [{ on: true, wave: 'sine', futur: 1 }] });
    expect((s as any).wavetable).toBeUndefined();
    expect((s.osc[0] as any).futur).toBeUndefined();
  });
});

describe('Synthé NOVA : calculs du son', () => {
  it('unisson symétrique, étalé en stéréo', () => {
    expect(unisonVoices(1, 30, 1)).toEqual([{ cents: 0, pan: 0 }]);
    const v = unisonVoices(5, 40, 0.8);
    expect(v.map(x => x.cents)).toEqual([-20, -10, 0, 10, 20]);
    expect(v[0].pan).toBeCloseTo(-0.8);
    expect(v[4].pan).toBeCloseTo(0.8);
    expect(v.reduce((a, x) => a + x.cents, 0)).toBeCloseTo(0);
  });

  it('vélocité vers le volume', () => {
    expect(velocityGain(1, 0.7)).toBeCloseTo(1);
    expect(velocityGain(0, 0)).toBe(1);
    expect(velocityGain(0.5, 1)).toBeCloseTo(0.25);
    expect(velocityGain(2, 1)).toBe(1);
  });

  it('coupure : suivi du clavier et vélocité, bornée', () => {
    const s = normalizeSynth({ filter: { cutoff: 1000, keytrack: 1, velAmount: 1 } });
    expect(cutoffFor(s, 60, 1)).toBeCloseTo(1000);
    expect(cutoffFor(s, 72, 1)).toBeCloseTo(2000);
    expect(cutoffFor(s, 60, 0)).toBeCloseTo(500);
    expect(cutoffFor(normalizeSynth({ filter: { cutoff: 19000, keytrack: 1 } }), 127, 1)).toBe(20000);
  });

  it('niveau : l\'unisson et les oscillateurs ajoutés ne font pas exploser le volume', () => {
    const one = normalizeSynth({ osc: [{ on: true, level: 1, unison: 1 }] });
    const wide = normalizeSynth({ osc: [{ on: true, level: 1, unison: 7 }, { on: true, level: 1, unison: 7 }] });
    expect(mixNorm(one)).toBe(1);
    // Puissance totale (somme level² × voix × norm²) bornée à 1.
    const p = (s: typeof wide) => s.osc.filter(o => o.on).reduce((a, o) => a + o.level ** 2 * o.unison, 0) * mixNorm(s) ** 2;
    expect(p(wide)).toBeCloseTo(1);
  });

  it('enveloppe : 0 au départ, crête à la fin de l\'attaque, tend vers le maintien', () => {
    const e = { a: 0.1, d: 0.4, s: 0.5, r: 0.3 };
    expect(envValue(e, 0)).toBe(0);
    expect(envValue(e, 0.05)).toBeCloseTo(0.5);
    expect(envValue(e, 0.1)).toBeCloseTo(1);
    expect(envValue(e, 5)).toBeCloseTo(0.5);
    expect(noteFreq(69)).toBe(440);
  });
});

describe("Synthé NOVA : niveau exact d'une voix (coupure sans clic)", () => {
  const e = { a: 0.1, d: 0.4, s: 0.5, r: 0.4 };
  it("suit l'attaque, le déclin et le relâchement", () => {
    expect(ampEnvAt(e, 1, 1, 1)).toBe(0);
    expect(ampEnvAt(e, 1, 1, 1.05)).toBeCloseTo(0.5);
    expect(ampEnvAt(e, 1, 1, 1.1)).toBeCloseTo(1);
    expect(ampEnvAt(e, 1, 1, 9)).toBeCloseTo(0.5);
    // Relâchée à 2 s : décroissance exponentielle de constante r/4.
    expect(ampEnvAt(e, 1, 1, 2.1, null, 2)).toBeCloseTo(0.5 * Math.exp(-0.1 / 0.1));
  });
  it('voix legato : fondu court vers le niveau repris, puis déclin', () => {
    expect(ampEnvAt(e, 1, 0, STEAL_FADE / 2, 0.8)).toBeCloseTo(0.4);
    expect(ampEnvAt(e, 1, 0, STEAL_FADE, 0.8)).toBeCloseTo(0.8);
    expect(ampEnvAt(e, 1, 0, 10, 0.8)).toBeCloseTo(0.5);
  });
});

describe('Synthé NOVA : voix dans le temps (lecture = export)', () => {
  const v = (id: number, pitch: number, start: number, release = Infinity, end = Infinity): VoiceSlot => ({ id, pitch, start, release, end });

  it('poly : même touche coupée, les autres gardées', () => {
    const vs = [v(1, 60, 0), v(2, 64, 0)];
    expect(voicesToCut(vs, 1, 60, false).map(x => x.id)).toEqual([1]);
  });

  it('poly : au-delà de la polyphonie, les voix relâchées partent d\'abord, puis les plus anciennes', () => {
    const vs = Array.from({ length: MAX_VOICES }, (_, i) => v(i + 1, 40 + i, i * 0.1));
    vs[5].release = 1; vs[5].end = 10;
    const cut = voicesToCut(vs, 2, 100, false);
    expect(cut.map(x => x.id)).toEqual([6]);
  });

  it('mono : toutes les voix qui sonnent sont coupées', () => {
    const vs = [v(1, 60, 0), v(2, 62, 0.5, 0.6, 0.8), v(3, 64, 0, 0.2, 0.3)];
    expect(voicesToCut(vs, 0.7, 65, true).map(x => x.id).sort()).toEqual([1, 2]);
  });

  it('relâchement : la plus ancienne voix tenue de la touche, commencée avant', () => {
    const vs = [v(1, 60, 0, 0.5, 1), v(2, 60, 1), v(3, 60, 2)];
    expect(voiceToRelease(vs, 60, 1.5)!.id).toBe(2);
    expect(voiceToRelease(vs, 61, 1.5)).toBeNull();
    expect(voiceToRelease([v(4, 60, 3)], 60, 1)).toBeNull();
  });

  it('glissé : depuis la dernière note jouée (poly) ou tenue (mono)', () => {
    const vs = [v(1, 48, 0, 0.5, 0.6), v(2, 55, 1, 1.2, 1.3)];
    expect(glideSource(vs, 2, true)!.pitch).toBe(55);
    expect(glideSource(vs, 2, false)).toBeNull();
    expect(glideSource(vs, 1.1, false)!.pitch).toBe(55);
  });

  it('mono : l\'ordre de programmation ne change rien (note plus tardive déjà connue)', () => {
    const later = v(2, 64, 1);
    const self = v(1, 60, 0);
    expect(nextMonoStart([later, self], self, Infinity)).toBe(1);
    expect(nextMonoStart([self], self, Infinity)).toBeNull();
  });
});

describe('Synthé NOVA : banque de sons', () => {
  it('au moins 40 sons, identifiants uniques, toutes les catégories remplies', () => {
    expect(SYNTH_PRESETS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(SYNTH_PRESETS.map(p => p.id)).size).toBe(SYNTH_PRESETS.length);
    for (const c of PRESET_CATEGORIES) expect(SYNTH_PRESETS.some(p => p.cat === c)).toBe(true);
    for (const c of ['Pianos & Rhodes', 'Nappes', 'Plucks', 'Leads', 'Cloches & mallets', 'Cordes', 'Flûtes & vents', 'Chœurs', 'Basses', 'Arpèges'])
      expect(SYNTH_PRESETS.filter(p => p.cat === c).length).toBeGreaterThanOrEqual(3);
  });

  it('chaque son a au moins une source, un nom et une aide en français', () => {
    for (const p of SYNTH_PRESETS) {
      const s = presetSettings(p.id);
      expect(s.presetId).toBe(p.id);
      expect(s.name).toBe(p.name);
      expect(s.osc.some(o => o.on && o.level > 0) || s.noise.level > 0).toBe(true);
      expect(p.tip.length).toBeGreaterThan(10);
      expect(s.ampEnv.a + s.ampEnv.d + s.ampEnv.r).toBeGreaterThan(0);
    }
  });

  it('pas de 808 dans la banque (elle a son propre moteur)', () => {
    expect(SYNTH_PRESETS.some(p => /808/.test(p.id + p.name))).toBe(false);
  });

  it('préréglage inconnu : son par défaut ; aperçu adapté', () => {
    expect(presetSettings('nexiste-pas').presetId).toBe(DEFAULT_PRESET_ID);
    expect(previewNotesFor('basse-reese')).toEqual([36]);
    expect(previewNotesFor('lead-sifflet')).toHaveLength(1);
    expect(previewNotesFor('nappe-chaude').length).toBeGreaterThanOrEqual(4);
    expect(presetById('rhodes-soul')?.cat).toBe('Pianos & Rhodes');
  });

  it('navigation et favoris', () => {
    expect(stepIndex(5, 4, 1)).toBe(0);
    expect(stepIndex(5, 0, -1)).toBe(4);
    expect(stepIndex(5, -1, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(-1);
    expect(toggleFavorite(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleFavorite(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('un son retouché se distingue de son préréglage', () => {
    const a = presetSettings('pluck-trap');
    const b = { ...a, filter: { ...a.filter, cutoff: 700 } };
    expect(settingsKey(a)).toBe(settingsKey(presetSettings('pluck-trap')));
    expect(settingsKey(a)).not.toBe(settingsKey(b));
  });
});

describe('Synthé NOVA : collaboration', () => {
  const track = (over: Partial<Track>): Track => ({
    id: 't', name: 'Synth', type: 'MIDI' as any, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...over,
  } as Track);

  it('les réglages voyagent avec la piste MIDI (null = ancien synthé)', () => {
    const s = presetSettings('rhodes-soul');
    expect(contentOf(track({ novaSynth: s })).novaSynth).toEqual(s);
    expect(contentOf(track({})).novaSynth).toBeNull();
    // Pas de champ pour les autres pistes.
    expect('novaSynth' in contentOf(track({ type: 'AUDIO' as any }))).toBe(false);
  });

  it('un message JSON reçu redonne les mêmes réglages', () => {
    const s = presetSettings('cloche-trap');
    const wire = JSON.parse(JSON.stringify(contentOf(track({ novaSynth: s }))));
    expect(normalizeSynth(wire.novaSynth)).toEqual(s);
  });
});
