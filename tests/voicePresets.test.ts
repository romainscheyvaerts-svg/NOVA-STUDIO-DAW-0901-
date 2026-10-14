import { describe, expect, it } from 'vitest';
import {
  VOICE_PRESETS, HOUSE_RULES, TIME_FX, TARGET_OUTPUT_LUFS, REF_INPUT_LUFS, presetChain, applyVoicePreset, trimFor, findVoicePreset,
  voicePresetsFor, roleFromTrackName, ROLE_NAMES, STYLE_NAMES, EQ_BAND, describeVoicePreset,
} from '../utils/voicePresets';
import { VOICE_PRESET_SOURCES } from '../utils/voicePresetSources';
import { ANALOG_SPECS } from '../engine/analogCompParams';
import { TrackType, type Track } from '../types';

const voice = VOICE_PRESETS.filter(p => p.role !== 'bus');
const bus = VOICE_PRESETS.filter(p => p.role === 'bus');

const track = (over: Partial<Track> = {}): Track => ({
  id: 'v1', name: 'Voix lead', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...over,
} as Track);
const returns = ['send-delay', 'send-verb-short', 'send-verb-long'].map(id => track({ id, name: id, type: TrackType.SEND }));

describe('bibliothèque de presets voix (lot 8a)', () => {
  it('environ 30 presets de voix, ids uniques, rangés par style et par rôle', () => {
    expect(voice.length).toBeGreaterThanOrEqual(28);
    expect(new Set(VOICE_PRESETS.map(p => p.id)).size).toBe(VOICE_PRESETS.length);
    for (const role of ['lead', 'back', 'double', 'adlib', 'harmony'] as const) expect(voicePresetsFor({ role }).length).toBeGreaterThan(0);
    for (const style of ['trap', 'drill', 'conscient', 'rnb', 'afro', 'pop', 'autotune', 'lofi', 'telephone', 'podcast', 'melodique'] as const) {
      expect(voicePresetsFor({ style }).length, style).toBeGreaterThan(0);
    }
    for (const p of VOICE_PRESETS) {
      expect(STYLE_NAMES[p.style]).toBeTruthy();
      expect(ROLE_NAMES[p.role]).toBeTruthy();
      expect(p.description.length).toBeGreaterThan(20);
      expect(describeVoicePreset(p).length).toBeGreaterThan(5);
    }
  });

  it('chaque preset cite au moins une recette documentée (RECETTES.md) en plus des règles maison', () => {
    for (const p of VOICE_PRESETS) {
      expect(p.sources.length, p.id).toBeGreaterThan(0);
      expect(p.sources.some(s => /^S\d+$/.test(s)), `${p.id} : aucune source externe`).toBe(true);
      for (const s of p.sources) expect(VOICE_PRESET_SOURCES[s], `${p.id} cite ${s}`).toBeTruthy();
    }
    for (const [id, src] of Object.entries(VOICE_PRESET_SOURCES)) if (/^S/.test(id)) expect(src.url, id).toMatch(/^https:\/\//);
  });

  it('règle maison : compresseurs voix en 2:1 sur DEUX étages de types différents, Opto Vintage OU Vox Strip', () => {
    for (const p of voice) {
      const chain = presetChain(p, p.calib);
      const types = chain.map(c => c.type);
      const i1 = types.indexOf('COMPRESSOR');
      const i2 = types.findIndex(t => t === 'OPTO_VINTAGE' || t === 'VOXSTRIP');
      expect(i1, p.id).toBeGreaterThanOrEqual(0);
      expect(i2, p.id).toBeGreaterThan(i1);
      expect(types.filter(t => t === 'COMPRESSOR').length).toBe(1);
      expect(types.includes('OPTO_VINTAGE') && types.includes('VOXSTRIP'), `${p.id} : jamais les deux`).toBe(false);
      expect(chain[i1].params.ratio, p.id).toBe(2);
      if (types[i2] === 'OPTO_VINTAGE') expect(chain[i2].params.ratio, p.id).toBe(2);
      expect(types.includes('FET76') || types.includes('LEVELER2A'), `${p.id} : FET 76 et Leveler 2A réservés au bus`).toBe(false);
    }
  });

  it('règle maison : effets temporels (réverbe, écho) en envoi, jamais en insert', () => {
    for (const p of VOICE_PRESETS) for (const c of presetChain(p, p.calib)) expect(TIME_FX.includes(c.type), `${p.id} : ${c.type}`).toBe(false);
  });

  it('règle maison : coupe-bas 80 Hz (au moins) sur les leads, 200 Hz + coupe-haut 15 kHz sur les autres voix', () => {
    for (const p of voice) {
      const eq = presetChain(p, p.calib).find(c => c.type === 'PROEQ12')!;
      const b = eq.params.bands;
      expect(b[EQ_BAND.hp].type).toBe('highpass');
      if (p.role === 'lead') expect(b[EQ_BAND.hp].frequency, p.id).toBeGreaterThanOrEqual(HOUSE_RULES.leadHighpassHz);
      else {
        expect(b[EQ_BAND.hp].frequency, p.id).toBeGreaterThanOrEqual(HOUSE_RULES.otherHighpassHz);
        expect(b[EQ_BAND.lp].isEnabled, p.id).toBe(true);
        expect(b[EQ_BAND.lp].frequency, p.id).toBeLessThanOrEqual(HOUSE_RULES.otherLowpassHz);
      }
    }
  });

  it('de-esser vers 8 kHz (6 à 9 kHz selon la recette) ; absent seulement sur une voix coupée sous 6,5 kHz', () => {
    for (const p of voice) {
      const ds = presetChain(p, p.calib).find(c => c.type === 'DEESSER');
      if (ds) { expect(ds.params.frequency, p.id).toBeGreaterThanOrEqual(6000); expect(ds.params.frequency, p.id).toBeLessThanOrEqual(9000); }
      else expect(p.eq?.lp, `${p.id} sans de-esser`).toBeLessThan(6500);
    }
  });

  it('calage du labo (3 vraies prises) : réduction ≤ 5 dB au VU par étage, sortie homogène, aucune saturation numérique', () => {
    for (const p of voice) {
      const c = p.calib;
      expect(c.outLufs, `${p.id} calé ?`).not.toBeNull();
      expect(c.gr1, p.id).toBeGreaterThan(0.5);
      expect(c.gr1, p.id).toBeLessThanOrEqual(HOUSE_RULES.stage1MaxGrDb);
      expect(c.gr2, p.id).toBeGreaterThan(0.5);
      expect(c.gr2, p.id).toBeLessThanOrEqual(HOUSE_RULES.stage2MaxGrDb);
      expect(Math.abs((c.outLufs as number) - TARGET_OUTPUT_LUFS), p.id).toBeLessThanOrEqual(1);
      expect(c.spreadDb, p.id).toBeLessThanOrEqual(2.5);
      expect(c.truePeakDb, p.id).toBeLessThanOrEqual(-1);
      expect(c.head2, p.id).toBeGreaterThanOrEqual(0);
      // seuils dans les bornes des effets
      const spec2 = ANALOG_SPECS[p.comp2!.kind];
      const ps = spec2.specs.find(s => s.id === spec2.driveParam)!;
      expect(c.thr2).toBeGreaterThanOrEqual(ps.min); expect(c.thr2).toBeLessThanOrEqual(ps.max);
    }
    for (const p of bus) {
      expect(p.calib.gr1, p.id).toBeLessThanOrEqual(HOUSE_RULES.busFetMaxGrDb);
      expect(p.calib.gr1, p.id).toBeGreaterThan(1);
      if (p.bus?.leveler) { expect(p.calib.gr2, p.id).toBeLessThanOrEqual(HOUSE_RULES.busLevelerMaxGrDb); expect(p.calib.gr2).toBeGreaterThan(0.5); }
      expect(p.calib.truePeakDb, p.id).toBeLessThanOrEqual(-1);
    }
  });
});

describe('poser un preset sur une piste', () => {
  it('trim d’entrée calé sur la prise (référence −20 LUFS), borné à ±24 dB', () => {
    expect(trimFor(REF_INPUT_LUFS)).toBe(0);
    expect(trimFor(-26)).toBe(6);
    expect(trimFor(-14)).toBe(-6);
    expect(trimFor(-60)).toBe(24);
    expect(trimFor(null)).toBe(0);
    expect(trimFor(-Infinity)).toBe(0);
  });

  it('chaîne, envois vers les retours existants, fader, trim et état « voiceChain » en une seule piste', () => {
    const p = findVoicePreset('trap-lead')!;
    const r = applyVoicePreset(track({ inputTrimDb: 3 }), p, { allTracks: returns, inputLufs: -26, projectKey: 6, projectScale: 'MINOR' });
    expect(r.track.plugins.map(x => x.type)).toEqual(presetChain(p, p.calib).map(c => c.type));
    expect(r.track.inputTrimDb).toBe(6);
    expect(r.track.voiceChain).toEqual({ presetId: 'trap-lead', trimDb: 6 });
    expect(r.track.sends.find(s => s.id === 'send-delay')?.level).toBe(p.sends.delay);
    const at = r.track.plugins.find(x => x.type === 'AUTOTUNE')!;
    expect(at.params.rootKey).toBe(6); expect(at.params.scale).toBe('MINOR');
    expect(new Set(r.track.plugins.map(x => x.id)).size).toBe(r.track.plugins.length);
    // prise inconnue : trim de la piste gardé
    expect(applyVoicePreset(track({ inputTrimDb: 3 }), p, { allTracks: returns }).track.inputTrimDb).toBe(3);
  });

  it('retours absents : aucun envoi fantôme, une remarque claire', () => {
    const r = applyVoicePreset(track(), findVoicePreset('trap-lead')!, { allTracks: [] });
    expect(r.track.sends).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/absent du projet/);
  });

  it('voix secondaires : plus basses et ouvertes de l’autre côté de la précédente', () => {
    const back = findVoicePreset('back-trap')!;
    const a = applyVoicePreset(track({ id: 'b1', name: 'BACK 1' }), back, { allTracks: returns }).track;
    expect(a.pan).toBeCloseTo(-back.pan);
    expect(20 * Math.log10(a.volume)).toBeCloseTo(back.volumeDb, 1);
    const b = applyVoicePreset(track({ id: 'b2', name: 'BACK 2' }), back, { allTracks: [...returns, a] }).track;
    expect(b.pan).toBeCloseTo(back.pan);
  });

  it('prise très faible : remarque « monte le gain du clip »', () => {
    const r = applyVoicePreset(track(), findVoicePreset('trap-lead')!, { allTracks: returns, inputLufs: -55 });
    expect(r.trimDb).toBe(24);
    expect(r.notes.join(' ')).toMatch(/gain du clip/);
  });

  it('rôle d’une piste d’après son nom', () => {
    expect(roleFromTrackName('Voix lead')).toBe('lead');
    expect(roleFromTrackName('BACK 2')).toBe('back');
    expect(roleFromTrackName('Double G')).toBe('double');
    expect(roleFromTrackName('ADLIB')).toBe('adlib');
    expect(roleFromTrackName('Harmo haute')).toBe('harmony');
  });
});

describe('Vox Strip à 44,1 kHz (correctif lot 8)', () => {
  it('le cœur DSP reste stable à 44,1 kHz (passe-bas mesuré à 23,5 kHz borné sous Nyquist)', async () => {
    const { createAnalogCompCore } = await import('../engine/analogCompCore');
    const { buildAnalogInternal } = await import('../engine/analogCompMaps');
    const { ANALOG_PROFILES } = await import('../engine/analogProfiles');
    for (const sr of [44100, 48000, 96000]) {
      const n = sr;
      const x = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr));
      const core = createAnalogCompCore(sr);
      core.setInternal(buildAnalogInternal('VOXSTRIP', ANALOG_SPECS.VOXSTRIP.defaults, ANALOG_PROFILES.VOXSTRIP, sr));
      const oL = new Float32Array(n), oR = new Float32Array(n);
      core.process(x, x, oL, oR, n);
      let pk = 0; for (const v of oL) pk = Math.max(pk, Math.abs(v));
      expect(Number.isFinite(pk), `${sr} Hz`).toBe(true);
      expect(pk, `${sr} Hz`).toBeLessThan(2);
      expect(pk, `${sr} Hz`).toBeGreaterThan(0.05);
    }
  });
});
