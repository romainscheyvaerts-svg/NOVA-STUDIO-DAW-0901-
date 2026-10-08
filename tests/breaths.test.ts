import { describe, expect, it, vi } from 'vitest';
import { analyzeBreaths, applyBreathPlan, breathEditsFor, breathGainFor, DEFAULT_BREATH_SETTINGS, detectBreaths, guessBreathKind, planBreaths, summarizeBreathPlan, withBreaths } from '../utils/breaths';
import { breathGainAt, BREATH_REMOVE_DB, breathRampsInClip } from '../utils/breathEnvelope';
import { clipGainAt, clipGainEvents } from '../utils/fades';
import { rapPhrases, scoreDetection, synthVoice } from './helpers/breathSignals';
import { FakeAudioBuffer } from './helpers/audio';
import { makeClip, makeTrack } from './helpers/fixtures';
import { TrackType } from '../types';

vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

const SR = 44100;
const bufferOf = (x: Float32Array) => {
  const b = new FakeAudioBuffer({ numberOfChannels: 1, length: x.length, sampleRate: SR });
  b.getChannelData(0).set(x);
  return b as unknown as AudioBuffer;
};

// Analyses de plusieurs secondes de signal : marge large quand la machine est chargée.
describe('détection des respirations (signaux synthétiques)', { timeout: 30000 }, () => {
  it('trouve les respirations entre les phrases, sans toucher un mot ni un « s »', () => {
    let breaths = 0, hits = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const v = rapPhrases(seed);
      const s = scoreDetection(v, analyzeBreaths(v.x, v.sr).regions);
      expect(s.wordsTouched).toBe(0);
      expect(s.sibilantsTouched).toBe(0);
      expect(s.falseAlarms).toBe(0);
      breaths += s.breaths; hits += s.recall * s.breaths;
    }
    expect(hits / breaths).toBeGreaterThanOrEqual(0.9);
  });

  it('prudente ne prend que des respirations sûres ; forte en prend plus ; jamais un mot', () => {
    const v = rapPhrases(5);
    const prud = scoreDetection(v, analyzeBreaths(v.x, v.sr, { sensitivity: 'prudente' }).regions);
    const forte = scoreDetection(v, analyzeBreaths(v.x, v.sr, { sensitivity: 'forte' }).regions);
    expect(prud.wordsTouched + forte.wordsTouched).toBe(0);
    expect(prud.falseAlarms).toBe(0);
    expect(forte.recall).toBeGreaterThanOrEqual(prud.recall);
  });

  it('un « s » ou un « ch » isolés, aussi faibles qu’une respiration, ne sont pas pris', () => {
    const v = synthVoice([
      { k: 'word', dur: 0.4 }, { k: 'gap', dur: 0.4 },
      { k: 's', dur: 0.15, db: -20 }, { k: 'gap', dur: 0.4 },
      { k: 'word', dur: 0.4 }, { k: 'gap', dur: 0.3 },
      { k: 'breath', dur: 0.35 }, { k: 'gap', dur: 0.15 },
      { k: 'word', dur: 0.4 }, { k: 's', dur: 0.14 }, { k: 'gap', dur: 0.4 },
      { k: 'word', dur: 0.4 },
    ], SR, 11);
    const a = analyzeBreaths(v.x, v.sr);
    const s = scoreDetection(v, a.regions);
    expect(s.recall).toBe(1);
    expect(s.sibilantsTouched).toBe(0);
    expect(s.falseAlarms).toBe(0);
  });

  it('la fin d’un mot qui s’éteint lentement n’est jamais prise pour une respiration', () => {
    const v = synthVoice([
      { k: 'word', dur: 0.5, release: 0.6 }, { k: 'gap', dur: 0.6 },
      { k: 'word', dur: 0.5, release: 0.5 }, { k: 'gap', dur: 0.5 },
      { k: 'word', dur: 0.3 },
    ], SR, 5);
    const a = analyzeBreaths(v.x, v.sr, { sensitivity: 'forte' });
    expect(scoreDetection(v, a.regions).wordsTouched).toBe(0);
    expect(a.regions).toHaveLength(0);
  });

  it('marges : une respiration collée au mot suivant s’arrête avant son attaque', () => {
    const v = synthVoice([{ k: 'word', dur: 0.4 }, { k: 'gap', dur: 0.2 }, { k: 'breath', dur: 0.4 }, { k: 'word', dur: 0.4 }], SR, 9);
    const [r] = analyzeBreaths(v.x, v.sr).regions;
    expect(r).toBeDefined();
    const nextWord = v.words[1][0];
    expect(nextWord - r.end).toBeGreaterThanOrEqual(0.03);
  });

  it('detectBreaths : temps en secondes de l’audio source, limités à la fenêtre du clip', () => {
    const v = rapPhrases(2);
    const all = analyzeBreaths(v.x, v.sr).regions;
    const buf = bufferOf(v.x);
    const from = all[1].start - 0.5, to = all[3].end + 0.5;
    const part = detectBreaths(buf, from, to);
    expect(part.length).toBeGreaterThanOrEqual(2);
    part.forEach(r => { expect(r.start).toBeGreaterThanOrEqual(from); expect(r.end).toBeLessThanOrEqual(to); });
    // Même respiration trouvée (le contexte d'analyse change un peu les bords).
    expect(part.some(r => r.start < all[2].end && r.end > all[2].start)).toBe(true);
  });
});

describe('gain des respirations et fondus', () => {
  const e = { start: 1, end: 1.4, gainDb: -15, fade: 0.01 };
  it('gain 1 aux bords, −15 dB au creux, fondus en cosinus de 10 ms dans la zone', () => {
    expect(breathGainAt([e], 0.99)).toBe(1);
    expect(breathGainAt([e], 1)).toBe(1);
    expect(breathGainAt([e], 1.2)).toBeCloseTo(Math.pow(10, -15 / 20), 6);
    expect(breathGainAt([e], 1.005)).toBeGreaterThan(Math.pow(10, -15 / 20));
    expect(breathGainAt([e], 1.005)).toBeLessThan(1);
    expect(breathGainAt([e], 1.4)).toBe(1);
    expect(breathGainAt([{ ...e, gainDb: BREATH_REMOVE_DB * 1.2 }], 1.2)).toBe(0);
  });

  it('pas de saut de gain (pas de clic) : variation bornée d’un échantillon à l’autre', () => {
    let maxStep = 0, prev = breathGainAt([e], 0.98);
    for (let t = 0.98; t < 1.42; t += 1 / 48000) { const g = breathGainAt([e], t); maxStep = Math.max(maxStep, Math.abs(g - prev)); prev = g; }
    // Fondu de 10 ms en cosinus à 48 kHz : pas plus de ~0,3 % par échantillon.
    expect(maxStep).toBeLessThan(0.003);
  });

  it('plan de gain du clip : même gain que clipGainAt, courbes seulement sur les fondus, rien de superposé', () => {
    const clip = makeClip({ offset: 0.5, duration: 2, fadeIn: 0.01, fadeOut: 0.02, gain: 0.8, breaths: [e] });
    const ev = clipGainEvents(clip, 0);
    for (let i = 1; i < ev.length; i++) {
      const p = ev[i - 1], end = p.kind === 'curve' ? p.t + p.d : p.t;
      expect(ev[i].t).toBeGreaterThanOrEqual(end - 1e-9);
    }
    // Rampes de la respiration : 2 zones de 10 ms (clip time = source − offset).
    breathRampsInClip(clip.breaths, 0.5, 2).flat().forEach((v, i) => expect(v).toBeCloseTo([0.5, 0.51, 0.89, 0.9][i], 9));
    expect(clipGainAt(clip, 0.7)).toBeCloseTo(0.8 * Math.pow(10, -15 / 20), 6);
    expect(clipGainAt(clip, 1.5)).toBeCloseTo(0.8, 6);
    // Démarrage au milieu d'une respiration (lecture lancée là) : valeur juste.
    const mid = clipGainEvents(clip, 0.7);
    expect(mid[0]).toMatchObject({ kind: 'set', t: 0.7 });
    expect((mid[0] as any).v).toBeCloseTo(0.8 * Math.pow(10, -15 / 20), 6);
  });

  it('sans respiration, le plan de gain est exactement celui d’avant (rétrocompatible)', () => {
    const c = makeClip({ duration: 2, fadeIn: 0.1, fadeOut: 0.1, gain: 0.5 });
    expect(clipGainEvents({ ...c, breaths: [] }, 0)).toEqual(clipGainEvents(c, 0));
    // Respiration hors de la fenêtre du clip : ignorée.
    expect(clipGainEvents({ ...c, offset: 5, breaths: [e] }, 0)).toEqual(clipGainEvents(c, 0));
  });

  it('réappliquer remplace les zones du clip : les baisses ne se cumulent jamais', () => {
    const c = makeClip({ offset: 0, duration: 3 });
    const once = withBreaths(c, breathEditsFor([{ start: 1, end: 1.4 }], -15));
    const twice = withBreaths(once, breathEditsFor([{ start: 1, end: 1.4 }], -20));
    expect(twice.breaths).toHaveLength(1);
    expect(twice.breaths![0].gainDb).toBe(-20);
    expect(clipGainAt(twice, 1.2)).toBeCloseTo(Math.pow(10, -20 / 20), 6);
    // Zone cachée par une découpe (hors fenêtre) : gardée.
    const cut = withBreaths({ ...once, offset: 2, duration: 1 }, []);
    expect(cut.breaths).toHaveLength(1);
    expect(withBreaths(once, []).breaths).toBeUndefined();
  });

  it('fondus bornés entre 5 et 15 ms', () => {
    expect(breathEditsFor([{ start: 0, end: 1 }], -15, 2)[0].fade).toBe(0.005);
    expect(breathEditsFor([{ start: 0, end: 1 }], -15, 40)[0].fade).toBe(0.015);
  });
});

describe('lead −15 dB, voix additionnelles supprimées', { timeout: 30000 }, () => {
  const v = rapPhrases(1);
  const buf = bufferOf(v.x);
  const clipOf = (id: string) => makeClip({ id, bufferId: id, buffer: buf, duration: buf.duration, type: TrackType.AUDIO });
  const tracks = [
    makeTrack({ id: 'lead', name: 'LEAD', clips: [clipOf('c1')] }),
    makeTrack({ id: 'back', name: 'BACK 1', clips: [clipOf('c2')] }),
    makeTrack({ id: 'ad', name: 'Ad-libs', clips: [clipOf('c3')] }),
  ];
  const plans = planBreaths(tracks, c => c.buffer, DEFAULT_BREATH_SETTINGS);

  it('chaque piste est reconnue et dosée', () => {
    expect(plans.map(p => [p.name, p.kind, p.gainDb])).toEqual([['LEAD', 'lead', -15], ['BACK 1', 'extra', BREATH_REMOVE_DB * 1.2], ['Ad-libs', 'extra', BREATH_REMOVE_DB * 1.2]]);
    expect(plans[0].count).toBeGreaterThanOrEqual(5);
  });

  it('appliqué : creux à −15 dB sur la lead, silence sur les backs, mots intacts', () => {
    const next = applyBreathPlan(tracks, plans);
    const lead = next[0].clips[0], back = next[1].clips[0];
    const r = plans[0].clips[0].regions[0];
    const mid = (r.start + r.end) / 2;
    expect(20 * Math.log10(clipGainAt(lead, mid))).toBeCloseTo(-15, 3);
    expect(clipGainAt(back, mid)).toBe(0);
    // Tous les mots : gain 1 partout (échantillonné tous les 5 ms).
    for (const [a, b] of v.words) for (let t = a; t < b; t += 0.005) {
      expect(clipGainAt(lead, t)).toBe(1);
      expect(clipGainAt(back, t)).toBe(1);
    }
    expect(summarizeBreathPlan(plans)).toMatch(/^LEAD : \d+ respirations −15 dB ; BACK 1 : \d+ respirations supprimées ; Ad-libs : \d+ respirations supprimées$/);
  });

  it('réglable : lead à −25 dB ou supprimée, backs baissés au lieu de supprimés', () => {
    expect(breathGainFor('lead', { ...DEFAULT_BREATH_SETTINGS, leadDb: 25 })).toBe(-25);
    expect(breathGainFor('lead', { ...DEFAULT_BREATH_SETTINGS, leadRemove: true })).toBeLessThanOrEqual(BREATH_REMOVE_DB);
    expect(breathGainFor('extra', { ...DEFAULT_BREATH_SETTINGS, extraRemove: false, extraDb: 18 })).toBe(-18);
    expect(breathGainFor('skip', DEFAULT_BREATH_SETTINGS)).toBeNull();
    expect(breathGainFor('lead', { ...DEFAULT_BREATH_SETTINGS, leadDb: 60 })).toBe(-40);
  });

  it('« Ne pas toucher » retire un traitement précédent ; type choisi à la main respecté', () => {
    const treated = applyBreathPlan(tracks, plans);
    const undo = planBreaths(treated, c => c.buffer, DEFAULT_BREATH_SETTINGS, { kinds: { lead: 'skip' }, trackIds: ['lead'] });
    expect(applyBreathPlan(treated, undo)[0].clips[0].breaths).toBeUndefined();
    const asExtra = planBreaths(tracks, c => c.buffer, DEFAULT_BREATH_SETTINGS, { kinds: { lead: 'extra' } });
    expect(asExtra[0].gainDb).toBeLessThanOrEqual(BREATH_REMOVE_DB);
  });

  it('exclure une respiration ou en ajouter une à la main', () => {
    const r0 = plans[0].clips[0].regions[0];
    const p = planBreaths(tracks, c => c.buffer, DEFAULT_BREATH_SETTINGS, {
      trackIds: ['lead'], excluded: { c1: [{ start: r0.start, end: r0.end }] }, added: { c1: [{ start: 0.05, end: 0.2 }] },
    });
    expect(p[0].clips[0].regions.some(r => r.start === r0.start)).toBe(false);
    expect(p[0].clips[0].regions[0].start).toBe(0.05);
    expect(p[0].count).toBe(plans[0].count);
  });

  it('seulement la nouvelle prise (clipIds) ; clips muets ignorés sauf demande', () => {
    const t = [makeTrack({ id: 'lead', name: 'LEAD', clips: [clipOf('old'), { ...clipOf('muted'), isMuted: true }, clipOf('new')] })];
    const p = planBreaths(t, c => c.buffer, DEFAULT_BREATH_SETTINGS, { clipIds: ['new'] });
    expect(p[0].clips.map(c => c.clipId)).toEqual(['new']);
    const all = planBreaths(t, c => c.buffer, DEFAULT_BREATH_SETTINGS);
    expect(all[0].clips.map(c => c.clipId)).toEqual(['old', 'new']);
  });
});

describe('devinette du type de piste', () => {
  const k = (name: string, over: any = {}) => guessBreathKind({ id: 'x', name, type: TrackType.AUDIO, ...over });
  it('lead : LEAD, VOIX, REC, Couplet…', () => {
    ['LEAD', 'Voix lead', 'VOIX', 'Vocals', 'REC', 'Couplet 1', 'Ma prise'].forEach(n => expect(k(n)).toBe('lead'));
  });
  it('additionnelles : BACK, DOUBLE, ADLIB, HARMO, CHŒUR, BV…', () => {
    ['BACK', 'Backs refrain', 'DOUBLE', 'Dbl gauche', 'ADLIB', 'Ad-libs', 'AD LIBS', 'Harmonies', 'HARMO 2', 'CHOEUR', 'Chœurs', 'BV', 'Voix BACK', 'Lead DOUBLE'].forEach(n => expect(k(n)).toBe('extra'));
  });
  it('pas une voix (beat, instrument, MIDI) : jamais touchée ; choix manuel prioritaire', () => {
    expect(k('Instru', { id: 'instrumental' })).toBe('skip');
    expect(k('Synthé', { type: TrackType.MIDI })).toBe('skip');
    expect(k('Piano', { instrumentId: 3 })).toBe('skip');
    expect(k('BACK', { breathKind: 'lead' })).toBe('lead');
  });
});

describe('collaboration : les respirations voyagent avec le contenu de la piste', () => {
  it('contentOf porte Clip.breaths, l’empreinte change, et une ancienne version garde des clips valides', async () => {
    const { contentOf, sigOf } = await import('../services/Collab');
    const base = makeTrack({ id: 'v', name: 'LEAD', clips: [makeClip({ id: 'c', bufferId: 'b', duration: 4 })] });
    const treated = { ...base, clips: [withBreaths(base.clips[0], breathEditsFor([{ start: 1, end: 1.4 }], -15))] };
    const wire = JSON.parse(JSON.stringify(contentOf(treated)));
    expect(wire.clips[0].breaths).toEqual([{ start: 1, end: 1.4, gainDb: -15, fade: 0.01 }]);
    expect(sigOf(contentOf(treated))).not.toBe(sigOf(contentOf(base)));
    // Reçu tel quel : même plan de gain que chez l'expéditeur.
    expect(clipGainEvents(wire.clips[0], 0)).toEqual(clipGainEvents(treated.clips[0], 0));
    // Supprimée = -144 dB : JSON garde le nombre (pas d'Infinity → null).
    const removed = withBreaths(base.clips[0], breathEditsFor([{ start: 1, end: 1.4 }], BREATH_REMOVE_DB * 1.2));
    expect(JSON.parse(JSON.stringify(removed)).breaths[0].gainDb).toBe(BREATH_REMOVE_DB * 1.2);
  });
});

describe('commandes Nova', () => {
  it('« baisse les respirations », « enlève les respirations des backs », mode auto, fenêtre', async () => {
    const { parseLocalCommand } = await import('../utils/novaCommands');
    const { makeState } = await import('./helpers/fixtures');
    const st = makeState([makeTrack({ id: 'track-rec-main', name: 'LEAD' }), makeTrack({ id: 'b', name: 'BACK' })]);
    const act = (m: string) => parseLocalCommand(m, st)?.actions[0];
    expect(act('baisse les respirations')).toEqual({ action: 'BREATHS', payload: { only: undefined, remove: false } });
    expect(act('enlève les respirations des backs')).toEqual({ action: 'BREATHS', payload: { only: 'extra', remove: false } });
    expect(act('supprime les respirations de la lead')).toEqual({ action: 'BREATHS', payload: { only: 'lead', remove: true } });
    expect(act('vire les respis')).toEqual({ action: 'BREATHS', payload: { only: undefined, remove: true } });
    expect(act('traite les respirations automatiquement après chaque prise')).toEqual({ action: 'SET_BREATH_AUTO', payload: { enabled: true } });
    expect(act('désactive les respirations automatiques')).toEqual({ action: 'SET_BREATH_AUTO', payload: { enabled: false } });
    expect(act('ouvre les respirations')?.action).toBe('BREATHS');
    expect((act('ouvre les respirations') as any).payload.open).toBe(true);
    // « retire les blancs » reste le nettoyage des blancs.
    expect(act('retire les blancs')?.action).toBe('CLEAN_SILENCE');
  });
});

describe('comp, Loop Record, punch : même audio partagé entre plusieurs clips', { timeout: 30000 }, () => {
  it('les morceaux d’une même prise portent toute la liste ; seule la fenêtre visée change', () => {
    const v = rapPhrases(3);
    const buf = bufferOf(v.x);
    const mk = (id: string, offset: number, duration: number, extra: any = {}) => makeClip({ id, bufferId: 'take', buffer: buf, start: offset, offset, duration, ...extra });
    const t = makeTrack({ id: 'lead', name: 'LEAD', clips: [mk('a', 0, 6), mk('b', 6, buf.duration - 6), mk('muet', 0, buf.duration, { isMuted: true, bufferId: 'autre' })] });
    // Seulement le morceau « b » (comme une nouvelle prise / un punch).
    const plans = planBreaths([t], c => c.buffer, DEFAULT_BREATH_SETTINGS, { clipIds: ['b'] });
    const next = applyBreathPlan([t], plans)[0];
    const [a, b, muet] = next.clips;
    expect(b.breaths!.length).toBeGreaterThan(0);
    expect(b.breaths!.every(e => e.start >= 6)).toBe(true);
    // « a » (même audio) reçoit la liste : un comp rebâti depuis « a » la garde ; il ne joue rien de nouveau dans sa fenêtre.
    expect(a.breaths).toEqual(b.breaths);
    for (let x = 0; x < 6; x += 0.01) expect(clipGainAt(a, x)).toBe(clipGainAt(t.clips[0], x));
    expect(muet.breaths).toBeUndefined();
  });
});
