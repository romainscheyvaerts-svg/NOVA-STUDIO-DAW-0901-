import type { Track } from '../types';
import { isVoiceTrack } from './vocalRoles';
import { takeNumberOf } from './takes';

/**
 * Piste que REC arme toute seule quand aucune piste n'est armée (module pur :
 * tests/recordTarget.test.ts).
 *
 * Avant : la piste sélectionnée si c'était une piste audio, sinon la 1re piste
 * audio du projet. Sur le modèle de Romain (78 pistes, dossier BEAT inactif en
 * tête), la piste sélectionnée à l'ouverture était KICK (inactive) : le 1er REC
 * finissait sur « Piste indisponible pour l'enregistrement. » Et une piste qui
 * porte le beat (INSTRU, un stem) sélectionnée pour régler son volume aurait
 * reçu la prise, qui coupe ce qu'elle recouvre : le beat disparaissait.
 *
 * Règle d'ingé : la piste sélectionnée si on peut y poser une voix ; sinon la
 * piste d'enregistrement du projet (« track-rec-main », sinon REC / Voix lead…) ;
 * sinon la 1re piste voix utilisable. Jamais une piste inactive, masquée, guide,
 * ni une piste de beat ou de batterie s'il existe une vraie piste voix.
 */

/** Nom d'une piste d'enregistrement voix (REC, Voix lead, Lead…), comme utils/keptTakes. */
export const REC_TRACK_NAME = /^\s*(rec|voix lead|lead|voix|vocal|vox lead)\b/i;

/** Nom d'une piste qui n'est pas une voix : beat, batterie, instruments, talkback, référence. */
const NOT_VOICE_NAME = /\b(kick|snare|clap|hh|hats?|hi-?hats?|808|perc\w*|drums?|beat|instrus?|instrumental|keys?|piano|synth\w*|guitare?|basse?|bass|talk ?back|sample|loop|fx|reverb|delay)\b/i;

type T = Pick<Track, 'id' | 'name' | 'type' | 'clips' | 'isInactive' | 'isHidden' | 'isGuide' | 'instrumentId'>;

/** On peut y enregistrer une voix (piste audio active, visible, pas la guide). */
export const canRecordOn = (t: T | null | undefined): t is T =>
  !!t && isVoiceTrack(t as Track) && !t.isInactive && !t.isHidden && !t.isGuide;

/** Piste audio qui porte du son importé (beat, stem) et aucune prise : pas une piste voix. */
const holdsImportedAudio = (t: T) => {
  const clips = t.clips || [];
  return clips.length > 0 && clips.every(c => takeNumberOf(c) === null && !c.notes);
};

/** Piste où une voix a sa place (pas un beat, une batterie, un talkback…). */
export const looksLikeVoiceTrack = (t: T): boolean =>
  canRecordOn(t) && (t.id === 'track-rec-main' || REC_TRACK_NAME.test(t.name || '') || (!NOT_VOICE_NAME.test(t.name || '') && !holdsImportedAudio(t)));

/** Piste d'enregistrement du projet : « track-rec-main », sinon la 1re piste REC / Voix lead… utilisable. */
export function recTrackOf<X extends T>(tracks: X[]): X | null {
  const main = tracks.find(t => t.id === 'track-rec-main');
  if (main && canRecordOn(main)) return main;
  return tracks.find(t => canRecordOn(t) && REC_TRACK_NAME.test(t.name || '')) || null;
}

/** Piste que REC arme quand aucune ne l'est (null : aucune piste voix utilisable). */
export function autoRecordTarget<X extends T>(tracks: X[], selectedId: string | null | undefined): X | null {
  const sel = tracks.find(t => t.id === selectedId);
  if (sel && looksLikeVoiceTrack(sel)) return sel;
  return recTrackOf(tracks)
    || tracks.find(t => looksLikeVoiceTrack(t))
    // Projet sans piste voix reconnue : la sélectionnée si elle est utilisable, puis la 1re utilisable.
    || (sel && canRecordOn(sel) ? sel : null)
    || tracks.find(t => canRecordOn(t))
    || null;
}
