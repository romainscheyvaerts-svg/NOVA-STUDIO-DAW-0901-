import { describe, expect, it } from 'vitest';
import { parseLocalCommand } from '../utils/novaCommands';
import { DAWState } from '../types';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

/**
 * Commandes de Nova comprises sans l'IA. Chaque ligne du tableau fixe le
 * comportement actuel : une régression (« enregistre les backs » qui lance
 * l'enregistrement, « annule la boucle » qui fait Ctrl+Z…) fait échouer le test.
 */

function studio(over: Partial<DAWState> = {}): DAWState {
  const beat = makeTrack({ id: 'instrumental', name: 'Beat', instrumentId: 'cat-1', volume: 1 });
  const lead = makeTrack({
    id: 'track-rec-main', name: 'Voix', volume: 0.8,
    clips: [
      makeClip({ id: 'p1', name: 'Prise 1', takeNumber: 1, start: 10, duration: 8, isMuted: true, bufferId: 'buf-a' }),
      makeClip({ id: 'p2', name: 'Prise 2', takeNumber: 2, start: 10, duration: 8, bufferId: 'buf-b' }),
    ],
  });
  const backs = makeTrack({ id: 'track-backs', name: 'Backs', volume: 0.5 });
  const harmo = makeTrack({ id: 'track-harmo', name: 'Harmonies', volume: 0.5 });
  const adlib = makeTrack({ id: 'track-adlib', name: 'Ad-libs', volume: 0.5 });
  return makeState([beat, lead, backs, harmo, adlib], over);
}

const kinds = (raw: string, st = studio()) => parseLocalCommand(raw, st)?.actions.map(a => a.action) ?? null;
const first = (raw: string, st = studio()) => parseLocalCommand(raw, st)?.actions[0];

describe('parseLocalCommand : tableau des phrases', () => {
  // [phrase, types d'actions attendus (null = pas compris localement : part à l'IA)]
  const table: [string, string[] | null][] = [
    // Enregistrement vs préparation d'une partie
    ['enregistre les backs', ['PREPARE_PART']],
    ['on enregistre les backs', ['PREPARE_PART']],
    ['enregistre les ad-libs', ['PREPARE_PART']],
    ['enregistre les adlibs', ['PREPARE_PART']],
    ['enregistre les harmonies', ['PREPARE_PART']],
    ['fais les doubles', ['PREPARE_PART']],
    ['on enregistre', ['RECORD']],
    ['Enregistre !', ['RECORD']],
    ['rec', ['RECORD']],
    ['je suis prêt', ['RECORD']],
    ["lance l'enregistrement", ['RECORD']],
    // Annuler
    ['annule', ['UNDO']],
    ['Annule !', ['UNDO']],
    ['annule ça', ['UNDO']],
    ['ctrl z', ['UNDO']],
    ['reviens en arrière', ['UNDO']],
    ['défais', ['UNDO']],
    ['annule la dernière modif', ['UNDO']],
    // Transport
    ['stop', ['STOP']],
    ['Stop.', ['STOP']],
    ['arrête', ['STOP']],
    ['pause', ['STOP']],
    ['coupe', ['STOP']],
    ['arrête la musique', ['STOP']],
    ['lance', ['PLAY']],
    ['joue', ['PLAY']],
    ['vas y', ['PLAY']],
    ['reviens au début', ['SEEK']],
    // Structure
    ['va au refrain', ['GOTO_SECTION']],
    ['boucle le refrain', ['GOTO_SECTION']],
    ['va à la partie 2', ['GOTO_SECTION']],
    ["va à l'outro", ['GOTO_SECTION']],
    // Punch / reprise à un temps précis
    ['punch de 0:45 à 0:52', ['SET_PUNCH']],
    ['refais juste de 1:10 à 1:16', ['SET_PUNCH']],
    ['punch', ['SET_PUNCH']],
    ['reprends à 0:45', ['SEEK', 'RECORD']],
    ['enregistre à partir de 1:10', ['SEEK', 'RECORD']],
    ['refais la prise', ['SEEK', 'RECORD']],
    // Prises
    ['garde la prise 1', ['MUTE_CLIP', 'MUTE_CLIP']],
    ['écoute la prise 1', ['MUTE_CLIP', 'MUTE_CLIP', 'SEEK', 'PLAY']],
    ['garde la prise 2 sur le refrain', ['COMP_TAKE']],
    ['supprime la dernière prise', ['DELETE_CLIP']],
    ['enlève les blancs', ['CLEAN_SILENCE']],
    // Session à emporter
    ['emporte la session', ['OPEN_TAKE_HOME']],
    ['je veux continuer chez moi', ['OPEN_TAKE_HOME']],
    ['je finis sur mon iPad', ['OPEN_TAKE_HOME']],
    // Volumes / effets
    ['monte ma voix', ['SET_VOLUME', 'HIGHLIGHT']],
    ['baisse le beat', ['SET_VOLUME', 'HIGHLIGHT']],
    ['plus de réverb', ['SET_SEND_LEVEL', 'SET_SEND_LEVEL', 'SET_SEND_LEVEL', 'SET_SEND_LEVEL']],
    ['coupe la reverb', ['SET_SEND_LEVEL', 'SET_SEND_LEVEL', 'SET_SEND_LEVEL', 'SET_SEND_LEVEL']],
    ["mets de l'autotune", ['UPDATE_PLUGIN', 'UPDATE_PLUGIN', 'UPDATE_PLUGIN', 'UPDATE_PLUGIN']],
    ["enlève l'autotune", ['REMOVE_PLUGIN']],
    // Batterie / styles / session
    ['ajoute une batterie trap', ['ADD_DRUMS']],
    ['enlève la batterie', ['REMOVE_DRUMS']],
    ['style trap', ['APPLY_MIX_STYLE']],
    ['fais un tiktok', ['OPEN_SHARE']],
    ['ouvre les paroles', ['OPEN_LYRICS']],
    ['analyse mon mix', ['ANALYZE_MIX']],
    ['défi du jour', ['LOAD_DAILY_CHALLENGE']],
    // Tempo / métronome / boucle
    ['140 bpm', ['SET_BPM']],
    ['mets le tempo à 95', ['SET_BPM']],
    ['active le métronome', ['SET_METRONOME']],
    ['coupe le métronome', ['SET_METRONOME']],
    ['boucle', ['TOGGLE_LOOP']],
    // Offres du studio
    ["je veux acheter l'instru", ['OPEN_STUDIO_OFFER']],
    ['je veux réserver une session', ['OPEN_STUDIO_OFFER']],
    // Pour l'IA
    ['pourquoi ma voix sonne faible', null],
    ['comment je monte ma voix ?', null],
    ['annule ?', null],
    ['300 bpm', null],
    ['', null],
    ['x'.repeat(91), null],
  ];

  it.each(table)('« %s »', (phrase, expected) => {
    expect(kinds(phrase)).toEqual(expected);
  });
});

describe('parseLocalCommand : détails des actions', () => {
  it('« enregistre les backs / harmonies / ad-libs » prépare la bonne partie, jamais RECORD', () => {
    expect(first('enregistre les backs')?.payload).toEqual({ part: 'back' });
    expect(first('enregistre les harmonies')?.payload).toEqual({ part: 'harmony' });
    expect(first('enregistre les ad-libs')?.payload).toEqual({ part: 'adlib' });
    for (const p of ['enregistre les backs', 'enregistre les harmonies', 'enregistre les ad-libs']) {
      expect(kinds(p)).not.toContain('RECORD');
    }
  });

  it('« annule la boucle » / « annule l\'autotune » ne déclenchent jamais Ctrl+Z', () => {
    for (const p of ['annule la boucle', "annule l'autotune", 'annule la reverb', 'annule le métronome']) {
      expect(kinds(p) ?? []).not.toContain('UNDO');
    }
    expect(kinds('annule la boucle')).toEqual(['TOGGLE_LOOP']);
  });

  it("« annule l'autotune » retire l'Auto-Tune (REMOVE_PLUGIN)", () => {
    expect(kinds("annule l'autotune")).toEqual(['REMOVE_PLUGIN']);
    expect(kinds("désactive l'autotune")).toEqual(['REMOVE_PLUGIN']);
  });
  it('« vas-y » lance la lecture comme « vas y »', () => {
    expect(kinds('vas-y')).toEqual(['PLAY']);
    expect(kinds('vas y')).toEqual(['PLAY']);
  });

  it('tempo : SET_BPM avec la valeur, bornes 50–220', () => {
    expect(first('140 bpm')?.payload).toEqual({ bpm: 140 });
    expect(first('tempo 95')?.payload).toEqual({ bpm: 95 });
    expect(first('50 bpm')?.payload).toEqual({ bpm: 50 });
    expect(first('220 bpm')?.payload).toEqual({ bpm: 220 });
    expect(kinds('49 bpm')).toBeNull();
    expect(kinds('221 bpm')).toBeNull();
  });

  it('punch : bornes en secondes ; zone à l\'envers = simple bascule du mode', () => {
    expect(first('punch de 0:45 à 0:52')?.payload).toEqual({ start: 45, end: 52 });
    expect(first('refais juste de 1:10 à 1:16')?.payload).toEqual({ start: 70, end: 76 });
    expect(first('punch de 0:52 à 0:45')?.payload).toEqual({});
  });

  it('reprise à un temps : SEEK au bon temps puis RECORD', () => {
    const r = parseLocalCommand('reprends à 0:45', studio())!;
    expect(r.actions).toEqual([{ action: 'SEEK', payload: { time: 45 } }, { action: 'RECORD', payload: {} }]);
    expect(first('enregistre à partir de 1:10')?.payload).toEqual({ time: 70 });
  });

  it('« refais la prise » se cale au début de la dernière prise audible', () => {
    const r = parseLocalCommand('refais la prise', studio())!;
    expect(r.actions[0]).toEqual({ action: 'SEEK', payload: { time: 10 } });
  });

  it('structure : refrain = partie la plus pleine, boucle si demandé', () => {
    expect(first('va au refrain')?.payload).toEqual({ target: 'full', loop: false });
    expect(first('boucle le refrain')?.payload).toEqual({ target: 'full', loop: true });
    expect(first('va à la partie 2')?.payload).toEqual({ target: 'partie 2', loop: false });
    expect(first('boucle la partie 3')?.payload).toEqual({ target: 'partie 3', loop: true });
    expect(first("va à l'outro")?.payload).toEqual({ target: 'outro', loop: false });
  });

  it('« garde la prise 1 » réactive la prise 1 et coupe la prise 2 qui la recouvre', () => {
    const r = parseLocalCommand('garde la prise 1', studio())!;
    expect(r.actions).toEqual([
      { action: 'MUTE_CLIP', payload: { trackId: 'track-rec-main', clipId: 'p1', isMuted: false } },
      { action: 'MUTE_CLIP', payload: { trackId: 'track-rec-main', clipId: 'p2', isMuted: true } },
    ]);
  });

  it('« écoute la prise 1 » ajoute SEEK au début de la prise puis PLAY', () => {
    const r = parseLocalCommand('écoute la prise 1', studio())!;
    expect(r.actions.slice(2)).toEqual([{ action: 'SEEK', payload: { time: 10 } }, { action: 'PLAY', payload: {} }]);
  });

  it('prise inconnue : message, aucune action', () => {
    const r = parseLocalCommand('garde la prise 9', studio())!;
    expect(r.actions).toEqual([]);
    expect(r.text).toMatch(/prise 9/);
  });

  it('comping par zone : COMP_TAKE sur la piste voix, sauf « tout le morceau »', () => {
    expect(first('garde la prise 2 sur le refrain')).toEqual({ action: 'COMP_TAKE', payload: { take: 2, zone: 'refrain', trackId: 'track-rec-main' } });
    expect(kinds('garde la prise 1 sur tout le morceau')).not.toContain('COMP_TAKE');
  });

  it('« supprime la dernière prise » supprime les clips de la dernière prise audible', () => {
    expect(first('supprime la dernière prise')).toEqual({ action: 'DELETE_CLIP', payload: { trackId: 'track-rec-main', clipId: 'p2' } });
  });

  it('volumes : ×1,22 pour monter, ×0,8 pour baisser, sur la bonne piste', () => {
    expect(first('monte ma voix')?.payload).toEqual({ trackId: 'track-rec-main', volume: 0.98 });
    expect(first('baisse le beat')?.payload).toEqual({ trackId: 'instrumental', volume: 0.8 });
    expect(first('monte les backs')?.payload).toEqual({ trackId: 'track-backs', volume: 0.61 });
  });

  it('volume plafonné à 150 %', () => {
    const st = studio();
    st.tracks[1].volume = 1.45;
    expect(first('monte ma voix', st)?.payload.volume).toBe(1.5);
  });

  it('la piste voix sélectionnée est visée en priorité', () => {
    const st = studio({ selectedTrackId: 'track-harmo' });
    expect(first('baisse ma voix', st)?.payload.trackId).toBe('track-harmo');
  });

  it('réverb : +0,08 sur toutes les voix (jamais le beat), coupée à 0', () => {
    const plus = parseLocalCommand('plus de réverb', studio())!.actions;
    expect(plus.map(a => a.payload.trackId)).toEqual(['track-rec-main', 'track-backs', 'track-harmo', 'track-adlib']);
    expect(plus.every(a => a.payload.sendId === 'send-verb-short' && a.payload.level === 0.18)).toBe(true);
    const off = parseLocalCommand('coupe la reverb', studio())!.actions;
    expect(off.every(a => a.payload.level === 0)).toBe(true);
    expect(first('plus de delay')?.payload.sendId).toBe('send-delay');
  });

  it('métronome : activé / coupé', () => {
    expect(first('active le métronome')?.payload).toEqual({ enabled: true });
    expect(first('coupe le métronome')?.payload).toEqual({ enabled: false });
  });

  it('batterie : kit reconnu dans la phrase', () => {
    expect(first('ajoute une batterie trap')?.payload).toEqual({ kit: 'trap' });
    expect(first('mets des drums drill')?.payload).toEqual({ kit: 'drill' });
    expect(first('ajoute une batterie')?.payload).toEqual({});
  });

  it('offres : battle, achat, réservation, mixage pro', () => {
    expect(first('je veux faire la battle')?.payload).toEqual({ offer: 'battle' });
    expect(first("je veux acheter l'instru")?.payload).toEqual({ offer: 'beat' });
    expect(first('je veux réserver une session')?.payload).toEqual({ offer: 'session' });
    expect(first('je veux faire mixer mon son')?.payload).toEqual({ offer: 'mix' });
  });

  it('sans piste voix : les commandes de prise ne plantent pas', () => {
    const st = makeState([makeTrack({ id: 'instrumental', name: 'Beat', instrumentId: 'x' })]);
    expect(() => parseLocalCommand('garde la prise 1', st)).not.toThrow();
    expect(() => parseLocalCommand('refais la prise', st)).not.toThrow();
    expect(() => parseLocalCommand('monte ma voix', st)).not.toThrow();
    expect(kinds('stop', st)).toEqual(['STOP']);
  });
});

describe('parseLocalCommand : demandes naturelles de mix (G25)', () => {
  it('« fais-moi un mix propre pour ma voix » marche sans serveur', () => {
    expect(first('fais-moi un mix propre pour ma voix')).toMatchObject({ action: 'APPLY_MIX_STYLE', payload: { style: 'rap-clair' } });
  });
  it('« mets de l’autotune » : compris sans serveur', () => {
    expect(parseLocalCommand("mets de l'autotune sur ma voix", studio())).not.toBeNull();
  });
  it('« mixe ma voix » sans style → ouvre les styles', () => {
    expect(first('mix ma voix stp')?.action).toBe('OPEN_MIX_STYLES');
  });
  it('« faire mixer par un pro » reste l’offre de mixage', () => {
    expect(first('je veux faire mixer mon son')?.payload).toEqual({ offer: 'mix' });
    expect(first('fais mixer ma voix par un pro')?.action).toBe('OPEN_STUDIO_OFFER');
  });
});
