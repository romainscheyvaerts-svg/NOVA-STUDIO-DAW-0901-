import type { Track } from '../types';

/**
 * Pistes d'un NOUVEAU projet (16/10/2026, décision de Romain).
 *
 * Mode simple : BEAT (l'instru) et UNE piste REC. Le parcours est instru → REC → écouter → exporter :
 * quatre pistes vides de plus (LEAD COUPLET, LEAD REFRAIN, BACK 1, BACK 2) ne servaient qu'à perdre
 * le débutant (où enregistrer ? pourquoi 5 pistes ?). Une piste de plus : « + Piste voix », « Faire les
 * backs » (Nova crée la piste BACKS) ou le chat.
 *
 * Mode avancé (appli Windows, ingé son) : le gabarit de séance voix reste complet, comme avant.
 *
 * Seul un projet NEUF passe par ici : un projet ouvert (fichier, version, séance en ligne, modèle)
 * garde toutes ses pistes.
 */
export const ADVANCED_ONLY_VOICE_IDS: readonly string[] = ['lead-couplet', 'lead-refrain', 'back-1', 'back-2'];

/** Gabarit complet → pistes du nouveau projet selon le mode (simple : sans les 4 voix du gabarit avancé). */
export function starterTracks<T extends Pick<Track, 'id'>>(template: T[], simple: boolean): T[] {
  return simple ? template.filter(t => !ADVANCED_ONLY_VOICE_IDS.includes(t.id)) : template;
}
