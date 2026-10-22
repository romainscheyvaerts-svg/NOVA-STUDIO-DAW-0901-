import { frameTime } from './fades';

/**
 * Instants des notes MIDI posés sur l'échantillon : une seule règle pour la lecture, l'export et
 * tous les rendus hors ligne (gel, rendu de bus, « lecture = export »).
 *
 * Pourquoi : la position d'une note en secondes dépend de son histoire. Écrite directement à
 * 140 BPM, la double-croche n° 1 est à 0,10714285714285715 s ; passée de 90 à 140 BPM par le
 * changement de tempo « musical » (utils/tempoFollow : secondes → noires → secondes, arrondi à la
 * nanoseconde), elle est à 0,107142857 s. Chrome programme l'oscillateur et l'enveloppe à
 * l'instant EXACT, entre deux échantillons : les deux projets, identiques à l'oreille et sur la
 * grille, ne rendaient pas le même son (3,1e-6 mesuré, qa/tempo_musical). Arrondi canonique :
 * l'échantillon le plus proche (utils/fades frameTime), comme les départs de clips audio. Écart
 * de justesse : au plus une demi-période d'échantillonnage (10 µs à 48 kHz).
 *
 * Module pur : tests/noteTiming.test.ts.
 */

/** Instant du contexte audio (s) d'un événement de note, posé sur l'échantillon. */
export const noteFrameTime = (t: number, sampleRate: number): number => frameTime(t, sampleRate);

export interface NoteRenderTimes {
  /** Début / fin de la note dans le rendu (s), avant arrondi et bornage. */
  noteStart: number;
  noteEnd: number;
  /** Attaque et relâchement programmés (bornés au rendu, posés sur l'échantillon). */
  attackAt: number;
  releaseAt: number;
}

/**
 * Note d'un clip MIDI dans un rendu hors ligne qui commence à `startOffset` (s, temps projet),
 * avancée de la latence `lat` (PDC) et bornée à `[0, totalDuration]`.
 */
export function noteRenderTimes(clipStart: number, note: { start: number; duration: number }, startOffset: number, lat: number, totalDuration: number, sampleRate: number): NoteRenderTimes {
  const noteStart = clipStart + note.start - startOffset - lat;
  const noteEnd = noteStart + note.duration;
  return {
    noteStart, noteEnd,
    attackAt: noteFrameTime(Math.max(0, noteStart), sampleRate),
    releaseAt: noteFrameTime(Math.min(totalDuration, noteEnd), sampleRate),
  };
}
