import type { DAWState } from '../types';

/**
 * Sauvegarde automatique et fermeture de la séance : rien ne doit se perdre.
 *
 * Deux trous bouchés (qa/robustesse_pro.py) :
 *  1. Plantage pendant une prise : les éditions et le mix faits dans les secondes
 *     avant REC étaient perdus (pas de version pendant l'enregistrement, et la
 *     dernière datait jusqu'à 15 s plus tôt). Le projet en mémoire ne contient pas
 *     la prise en cours (elle est dans le moteur et son journal) : on peut donc
 *     l'écrire PENDANT la prise, dès qu'il a changé (au départ de la prise, toutes
 *     les 15 s, quand l'onglet passe en arrière-plan). Inchangé : rien n'est écrit.
 *  2. Onglet fermé en pleine prise (ou juste après une édition pas encore écrite) :
 *     « pagehide » retirait le drapeau de séance ouverte, la réouverture ne proposait
 *     rien, la prise en cours et les dernières éditions étaient perdues. Le drapeau
 *     reste maintenant posé tant qu'il reste du travail non écrit : la réouverture
 *     propose « Récupérer la session » (dernière version + prise du journal).
 */

/** Ce qui fait une nouvelle version : si rien de ceci n'a changé, rien à écrire. */
export function projectSignature(st: DAWState): unknown[] {
  const s = st as any;
  return [st.tracks, s.lyrics, st.bpm, st.name, st.markers, s.chords, st.timeSignature, s.projectNotes, s.arrangements, s.clipBin];
}

export function sameSignature(a: unknown[] | null | undefined, b: unknown[] | null | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Projet qui vaut d'être gardé (pas un projet vierge ni un beat seul). */
export function hasWorthKeeping(st: DAWState): boolean {
  return st.tracks.some(t => t.id !== 'instrumental' && !t.instrumentId && t.clips.length > 0) || !!(((st as any).lyrics || '') as string).trim();
}

/**
 * À la fermeture de l'onglet : faut-il GARDER le drapeau « séance ouverte » (la
 * réouverture proposera de récupérer) ? Oui pendant une prise, ou s'il reste des
 * changements pas encore écrits dans une version.
 */
export function keepSessionFlagOnClose(st: DAWState, lastSavedSignature: unknown[] | null | undefined): boolean {
  if (st.isRecording) return true;
  if (!hasWorthKeeping(st)) return false;
  return !sameSignature(projectSignature(st), lastSavedSignature);
}
