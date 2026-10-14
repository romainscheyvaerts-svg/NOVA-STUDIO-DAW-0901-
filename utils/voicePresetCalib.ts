/**
 * Calage des presets voix (lot 8a), ÉCRIT PAR LE LABO :
 *   python tools/labo/presets_voix_mesures.py --caler
 * (3 vraies prises rap sèches du studio, rendu par le moteur de NOVA dans Chrome).
 * Ne pas retoucher à la main : relancer le labo.
 */
export interface VoicePresetCalib {
  /** Étage 1 : seuil du Compresseur NOVA (dBFS) ; bus : entrée du FET 76. */
  thr1: number;
  /** Étage 2 : seuil de l'Opto Vintage (dBFS) ou « Compression » du Vox Strip (0-10) ; bus : réduction du Leveler 2A. */
  thr2: number;
  /** Gain de sortie de l'étage 2 (dB) : tous les presets sortent au même niveau. */
  levelDb: number;
  /** Réduction max au VU mesurée (dB), pire des 3 prises : étage 1, étage 2. */
  gr1: number;
  gr2: number;
  /** Marge du réglage de l'étage 2 jusqu'à 5 dB de réduction (macro « Compression » du One Knob). */
  head2: number;
  /** Niveau de sortie moyen (LUFS), écart entre prises (dB), crête vraie max (dBTP). */
  outLufs: number | null;
  spreadDb: number | null;
  truePeakDb: number | null;
  /** Bus : position de la sortie du FET 76 qui garde le niveau du bus (sortie = entrée, LUFS). */
  busOut?: number;
  /** Bus : gain du Leveler 2A (0-100) qui ramène le bus au niveau d'entrée. */
  busGain?: number;
}

export const VOICE_PRESET_CALIB: Record<string, VoicePresetCalib> = {
 "trap-lead": {
  "thr1": -15,
  "thr2": -19.4,
  "levelDb": 8,
  "gr1": 3.06,
  "gr2": 4.56,
  "head2": 0.8,
  "outLufs": -16.15,
  "spreadDb": 1.05,
  "truePeakDb": -5.86
 },
 "back-trap": {
  "thr1": -11,
  "thr2": -14.7,
  "levelDb": 4.5,
  "gr1": 1.89,
  "gr2": 3.96,
  "head2": 1.5,
  "outLufs": -15.96,
  "spreadDb": 1.26,
  "truePeakDb": -2.94
 },
 "autotune-robot": {
  "thr1": -14,
  "thr2": -18.4,
  "levelDb": 6.8,
  "gr1": 2.85,
  "gr2": 4.44,
  "head2": 1,
  "outLufs": -16,
  "spreadDb": 1.03,
  "truePeakDb": -4.17
 },
 "autotune-travis": {
  "thr1": -14.5,
  "thr2": -20.6,
  "levelDb": 6.7,
  "gr1": 3.04,
  "gr2": 4.46,
  "head2": 0.6,
  "outLufs": -16.03,
  "spreadDb": 0.81,
  "truePeakDb": -4.99
 },
 "drill-lead": {
  "thr1": -14.5,
  "thr2": -15.6,
  "levelDb": 5.1,
  "gr1": 3.55,
  "gr2": 4.55,
  "head2": 0.6,
  "outLufs": -16.07,
  "spreadDb": 0.99,
  "truePeakDb": -7.64
 },
 "conscient-lead": {
  "thr1": -10.5,
  "thr2": -15.9,
  "levelDb": 4.1,
  "gr1": 1.92,
  "gr2": 3.46,
  "head2": 2.5,
  "outLufs": -15.98,
  "spreadDb": 0.78,
  "truePeakDb": -6.08
 },
 "rnb-doux-lead": {
  "thr1": -12,
  "thr2": -21.2,
  "levelDb": 3.5,
  "gr1": 2.65,
  "gr2": 3.56,
  "head2": 2.1,
  "outLufs": -16.03,
  "spreadDb": 0.95,
  "truePeakDb": -2.85
 },
 "afro-lead": {
  "thr1": -14,
  "thr2": -19.1,
  "levelDb": 6.5,
  "gr1": 2.91,
  "gr2": 3.96,
  "head2": 1.5,
  "outLufs": -16.02,
  "spreadDb": 0.93,
  "truePeakDb": -5.66
 },
 "pop-lead": {
  "thr1": -14,
  "thr2": 4,
  "levelDb": -5.2,
  "gr1": 3.06,
  "gr2": 4.14,
  "head2": 0.3,
  "outLufs": -15.92,
  "spreadDb": 1.27,
  "truePeakDb": -2.87
 },
 "melodique-lead": {
  "thr1": -14,
  "thr2": -16.9,
  "levelDb": 7.1,
  "gr1": 2.86,
  "gr2": 4.43,
  "head2": 0.9,
  "outLufs": -16.14,
  "spreadDb": 0.88,
  "truePeakDb": -6.08
 },
 "rage-lead": {
  "thr1": -14,
  "thr2": -18.7,
  "levelDb": 7.9,
  "gr1": 2.82,
  "gr2": 4.41,
  "head2": 1,
  "outLufs": -16.24,
  "spreadDb": 1.3,
  "truePeakDb": -4.02
 },
 "lofi-lead": {
  "thr1": -11,
  "thr2": -17.2,
  "levelDb": 5.5,
  "gr1": 2.36,
  "gr2": 3.95,
  "head2": 1.5,
  "outLufs": -16.03,
  "spreadDb": 1,
  "truePeakDb": -7.68
 },
 "telephone-lead": {
  "thr1": -13.5,
  "thr2": -17.8,
  "levelDb": 7.8,
  "gr1": 3,
  "gr2": 4.43,
  "head2": 0.9,
  "outLufs": -16,
  "spreadDb": 0.38,
  "truePeakDb": -1.03
 },
 "radio-lead": {
  "thr1": -12,
  "thr2": -16.2,
  "levelDb": 8.2,
  "gr1": 2.97,
  "gr2": 4.46,
  "head2": 1,
  "outLufs": -16.3,
  "spreadDb": 0.84,
  "truePeakDb": -8.41
 },
 "podcast-voix": {
  "thr1": -11,
  "thr2": -13.1,
  "levelDb": 3.8,
  "gr1": 2,
  "gr2": 2.95,
  "head2": 3.1,
  "outLufs": -16.02,
  "spreadDb": 0.68,
  "truePeakDb": -1.78
 },
 "back-rnb": {
  "thr1": -11,
  "thr2": -20.3,
  "levelDb": 3.7,
  "gr1": 1.91,
  "gr2": 3.49,
  "head2": 2,
  "outLufs": -16.01,
  "spreadDb": 0.99,
  "truePeakDb": -2.3
 },
 "back-drill": {
  "thr1": -13.5,
  "thr2": -15,
  "levelDb": 3.8,
  "gr1": 2.92,
  "gr2": 4.45,
  "head2": 0.9,
  "outLufs": -16.02,
  "spreadDb": 1.12,
  "truePeakDb": -6.08
 },
 "back-afro": {
  "thr1": -12.5,
  "thr2": -18.1,
  "levelDb": 5.9,
  "gr1": 2.38,
  "gr2": 3.88,
  "head2": 1.6,
  "outLufs": -16.01,
  "spreadDb": 1.17,
  "truePeakDb": -5.68
 },
 "back-filtre": {
  "thr1": -10.5,
  "thr2": -15.3,
  "levelDb": 4.3,
  "gr1": 2.16,
  "gr2": 3.45,
  "head2": 2.5,
  "outLufs": -16.02,
  "spreadDb": 0.15,
  "truePeakDb": -5.51
 },
 "double-serre": {
  "thr1": -13.5,
  "thr2": -17.8,
  "levelDb": 5.7,
  "gr1": 2.98,
  "gr2": 4.56,
  "head2": 0.6,
  "outLufs": -15.96,
  "spreadDb": 1.02,
  "truePeakDb": -3.53
 },
 "double-large": {
  "thr1": -12.5,
  "thr2": -16.9,
  "levelDb": 5.3,
  "gr1": 2.83,
  "gr2": 4.58,
  "head2": 0.6,
  "outLufs": -16,
  "spreadDb": 1.27,
  "truePeakDb": -4.02
 },
 "double-sombre": {
  "thr1": -12.5,
  "thr2": -16.6,
  "levelDb": 5.3,
  "gr1": 3,
  "gr2": 4.56,
  "head2": 0.7,
  "outLufs": -16.04,
  "spreadDb": 1.13,
  "truePeakDb": -3.37
 },
 "double-autotune": {
  "thr1": -14,
  "thr2": -18.1,
  "levelDb": 5.7,
  "gr1": 3.02,
  "gr2": 4.43,
  "head2": 1,
  "outLufs": -16,
  "spreadDb": 1.1,
  "truePeakDb": -2.94
 },
 "double-octave": {
  "thr1": -10.5,
  "thr2": -15.9,
  "levelDb": 5.6,
  "gr1": 2.86,
  "gr2": 4.55,
  "head2": 0.7,
  "outLufs": -15.98,
  "spreadDb": 0.91,
  "truePeakDb": -1.15
 },
 "adlib-trap": {
  "thr1": -13.5,
  "thr2": -16.9,
  "levelDb": 5.9,
  "gr1": 2.91,
  "gr2": 4.09,
  "head2": 1.5,
  "outLufs": -15.97,
  "spreadDb": 1.22,
  "truePeakDb": -3.53
 },
 "adlib-lointain": {
  "thr1": -12.5,
  "thr2": -18.4,
  "levelDb": 5.1,
  "gr1": 3.03,
  "gr2": 4.45,
  "head2": 0.7,
  "outLufs": -16.03,
  "spreadDb": 0.64,
  "truePeakDb": -4.42
 },
 "adlib-telephone": {
  "thr1": -13.5,
  "thr2": -17.8,
  "levelDb": 8,
  "gr1": 2.98,
  "gr2": 4.44,
  "head2": 0.9,
  "outLufs": -15.98,
  "spreadDb": 0.24,
  "truePeakDb": -1.36
 },
 "adlib-grave": {
  "thr1": -12,
  "thr2": -16.6,
  "levelDb": 6.2,
  "gr1": 2.92,
  "gr2": 4.58,
  "head2": 0.7,
  "outLufs": -16.02,
  "spreadDb": 0.81,
  "truePeakDb": -4.06
 },
 "adlib-quinte": {
  "thr1": -15,
  "thr2": -19.1,
  "levelDb": 7.6,
  "gr1": 3.04,
  "gr2": 4.52,
  "head2": 0.9,
  "outLufs": -16,
  "spreadDb": 1.11,
  "truePeakDb": -3.07
 },
 "adlib-baby": {
  "thr1": -14,
  "thr2": -19.1,
  "levelDb": 8.4,
  "gr1": 2.86,
  "gr2": 4.57,
  "head2": 0.7,
  "outLufs": -16.17,
  "spreadDb": 1.56,
  "truePeakDb": -4.2
 },
 "harmonie-refrain": {
  "thr1": -13.5,
  "thr2": -16.2,
  "levelDb": 6.5,
  "gr1": 3.05,
  "gr2": 4.43,
  "head2": 1,
  "outLufs": -16.01,
  "spreadDb": 1.45,
  "truePeakDb": -4.65
 },
 "bus-voix-maison": {
  "thr1": -45.9,
  "thr2": 15,
  "levelDb": 0,
  "gr1": 4.55,
  "gr2": 1.82,
  "head2": 0,
  "busOut": -9,
  "busGain": 21,
  "outLufs": -16.15,
  "spreadDb": 1.72,
  "truePeakDb": -3.81
 },
 "bus-voix-punch": {
  "thr1": -40.8,
  "thr2": 0,
  "levelDb": 0,
  "gr1": 4.47,
  "gr2": 0,
  "head2": 0,
  "busOut": -9.8,
  "outLufs": -16.07,
  "spreadDb": 1.27,
  "truePeakDb": -3.69
 }
};
