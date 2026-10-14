import { describe, expect, it } from 'vitest';
import { describeSound, applyDescribedSound, decrireTonSon, LEXICON } from '../utils/describeSound';
import { findVoicePreset, applyVoicePreset, EQ_BAND, VOICE_PRESETS } from '../utils/voicePresets';
import { ONE_KNOB_MACROS } from '../utils/oneKnob';
import { TrackType, type Track } from '../types';

const blank = (over: Partial<Track> = {}): Track => ({
  id: 'v1', name: 'Voix lead', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...over,
} as Track);
const returns = ['send-delay', 'send-verb-short', 'send-verb-long'].map(id => blank({ id, name: id, type: TrackType.SEND }));

describe('Décris ton son (lot 8b) : table de correspondance déterministe', () => {
  it('la phrase d’exemple : plus brillante, plus en avant, un peu d’écho', () => {
    const d = describeSound('voix plus brillante et plus en avant avec un peu d\'écho');
    expect(d.macros).toEqual({ brillance: 0.6, presence: 0.6 });
    expect(d.echo).toBeCloseTo(0.09, 3);
    expect(d.ignored).toEqual([]);
    expect(d.presetId).toBe('trap-lead');
    expect(d.summary).toBe('preset « Trap lead » · Brillance 60 % · Présence 60 % · écho +0,09');
  });

  it('même phrase = même résultat (aucun hasard, aucune IA)', () => {
    const s = 'Une voix R&B très chaude, large, avec beaucoup de réverbe';
    expect(describeSound(s)).toEqual(describeSound(s));
  });

  it('intensités : un peu 30 %, sans modificateur 50 %, plus 60 %, très 90 %', () => {
    expect(describeSound('un peu saturée').macros.saturation).toBe(0.3);
    expect(describeSound('saturée').macros.saturation).toBe(0.5);
    expect(describeSound('plus saturée').macros.saturation).toBe(0.6);
    expect(describeSound('très saturée').macros.saturation).toBe(0.9);
    expect(describeSound('à fond compressée').macros.compression).toBe(0.9);
  });

  it('négations : « moins brillante » = brillance 0 et chaleur ; « sans réverbe » ; « sèche »', () => {
    const d = describeSound('moins brillante');
    expect(d.macros.brillance).toBe(0);
    expect(d.macros.chaleur).toBeCloseTo(0.3, 3);
    expect(d.matched[0].negated).toBe(true);
    expect(describeSound('pas trop de réverbe').macros).toMatchObject({ espace: 0, presence: 0.3 });
    expect(describeSound('voix sèche').dry).toBe(true);
    expect(describeSound('sans écho').echo).toBe(-1);
  });

  it('styles et rôles choisissent le preset ; mots de presets précis', () => {
    expect(describeSound('drill sombre et agressive').presetId).toBe('drill-lead');
    expect(describeSound('backs R&B doux').presetId).toBe('back-rnb');
    expect(describeSound('ad-libs trap').presetId).toBe('adlib-trap');
    expect(describeSound('effet téléphone').presetId).toBe('telephone-lead');
    expect(describeSound('ad-libs au téléphone').presetId).toBe('adlib-telephone');
    expect(describeSound('autotune robot à la T-Pain').presetId).toBe('autotune-robot');
    expect(describeSound('baby voice comme Carti').presetId).toBe('rage-lead');
    expect(describeSound('voix off de podcast, claire').presetId).toBe('podcast-voix');
    expect(describeSound('afrobeat').presetId).toBe('afro-lead');
    expect(describeSound('boom bap old school').presetId).toBe('conscient-lead');
    expect(describeSound('lo-fi cassette').presetId).toBe('lofi-lead');
  });

  it('sans style : la chaîne de la piste est gardée, seules les macros bougent', () => {
    const d = describeSound('plus chaude', { currentPresetId: 'rnb-doux-lead', role: 'lead' });
    expect(d.presetId).toBeNull();
    expect(d.summary).toBe('chaîne actuelle (« R&B doux ») · Chaleur 60 %');
  });

  it('mots compris montrés tels qu’écrits (accents, expressions)', () => {
    const d = describeSound("plus en avant avec de l'écho");
    expect(d.matched.map(m => m.word)).toEqual(['en avant', 'écho']);
  });

  it('mots non compris rendus (rien n’est inventé)', () => {
    const d = describeSound('voix brillante façon licorne');
    expect(d.ignored).toEqual(['façon', 'licorne']);
    expect(describeSound('bonjour').matched).toEqual([]);
  });

  it('la table couvre les 8 macros et tous ses presets existent', () => {
    const macros = new Set(Object.values(LEXICON).filter(e => e.kind === 'macro').map(e => (e as any).macro));
    for (const m of ONE_KNOB_MACROS) expect(macros.has(m.id), m.id).toBe(true);
    for (const e of Object.values(LEXICON)) if (e.kind === 'preset') expect(findVoicePreset(e.preset), e.preset).toBeTruthy();
    expect(VOICE_PRESETS.length).toBeGreaterThan(28);
  });

  it('appliquer : preset, macros (One Knob) et écho en une seule piste', () => {
    const d = describeSound('voix plus brillante et plus en avant avec un peu d\'écho');
    const r = applyDescribedSound(blank(), d, { allTracks: returns, inputLufs: -22 });
    const p = findVoicePreset('trap-lead')!;
    expect(r.track.voiceChain?.presetId).toBe('trap-lead');
    expect(r.track.voiceChain?.amounts).toEqual({ brillance: 0.6, presence: 0.6 });
    const b = r.track.plugins.find(x => x.type === 'PROEQ12')!.params.bands;
    expect(b[EQ_BAND.presence].gain).toBeCloseTo((p.eq!.presence![1]) + 3, 3);
    // écho : envoi du preset + 0,09
    expect(r.track.sends.find(s => s.id === 'send-delay')!.level).toBeCloseTo(p.sends.delay + 0.09, 3);
    expect(r.track.inputTrimDb).toBe(2);
  });

  it('decrireTonSon (chat) : compte rendu en une phrase, piste modifiée', () => {
    const tr = applyVoicePreset(blank({ name: 'BACK 1' }), findVoicePreset('back-trap')!, { allTracks: returns }).track;
    const r = decrireTonSon('plus large et un peu saturée', tr, { allTracks: returns });
    expect(r.track?.plugins.some(p => p.type === 'DOUBLER')).toBe(true);
    expect(r.compteRendu).toMatch(/^BACK 1 \(backs\) : chaîne actuelle \(« Backs trap »\) · Largeur 60 % · Saturation 30 %\.$/);
    expect(decrireTonSon('bonjour').compteRendu).toMatch(/aucun mot de son/);
  });
});
