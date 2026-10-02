/**
 * Noms français des tonalités et position musicale (mesures | temps | ticks),
 * pour l'affichage dans la barre de transport.
 */
const NOMS_NOTES = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const GAMMES_LONGUES: Record<string, string> = { MAJOR: 'majeur', MINOR: 'mineur', MINOR_HARMONIC: 'mineur harm.', PENTATONIC: 'penta', CHROMATIC: '' };
const GAMMES_COURTES: Record<string, string> = { MAJOR: 'maj', MINOR: 'min', MINOR_HARMONIC: 'min harm.', PENTATONIC: 'penta', CHROMATIC: '' };

/** « Do mineur » (ou « Do min » en version courte) ; '' si la tonalité est inconnue. */
export const nomTonaliteCourt = (rootKey?: number, scale?: string, court = false): string => {
  if (typeof rootKey !== 'number' || !Number.isFinite(rootKey)) return '';
  const note = NOMS_NOTES[((Math.round(rootKey) % 12) + 12) % 12];
  const table = court ? GAMMES_COURTES : GAMMES_LONGUES;
  const gamme = table[(scale || 'MINOR').toUpperCase()] ?? '';
  return `${note} ${gamme}`.trim();
};

/** Résolution des ticks par temps (standard des DAW : 960 PPQ). */
export const TICKS_PAR_TEMPS = 960;

/**
 * Position en mesures | temps | ticks (1-indexés comme dans un DAW).
 * Le temps (beat) suit le dénominateur de la signature : en 6/8, un temps = une croche.
 */
export const formatMesures = (seconds: number, bpm: number, numerator = 4, denominator = 4): string => {
  const num = Math.max(1, Math.round(numerator) || 4);
  const den = Math.max(1, Math.round(denominator) || 4);
  const beatSec = (60 / Math.max(1, bpm || 120)) * (4 / den);
  const totalBeats = Math.max(0, seconds) / beatSec;
  const beatIdx = Math.floor(totalBeats + 1e-9);
  const bar = Math.floor(beatIdx / num) + 1;
  const beat = (beatIdx % num) + 1;
  const ticks = Math.min(TICKS_PAR_TEMPS - 1, Math.floor((totalBeats - beatIdx) * TICKS_PAR_TEMPS + 1e-6));
  return `${String(bar).padStart(3, '0')} | ${beat} | ${String(Math.max(0, ticks)).padStart(3, '0')}`;
};
