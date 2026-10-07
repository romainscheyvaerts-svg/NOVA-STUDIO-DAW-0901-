/**
 * Réglages des effets V21 (Harmoniseur, Voix grave / aiguë, Tape stop &
 * half-time, Filtre DJ, Lo-fi) : valeurs par défaut, bornes, noms français,
 * infobulles et préréglages. Données pures (aucun React, aucun nœud audio) :
 * le moteur, les fenêtres, l'automation et les tests s'en servent.
 *
 * Tous les réglages automatisables sont des nombres (l'automation des effets
 * envoie `{ clé: nombre }`). Les interrupteurs valent 0 ou 1 (≥ 0,5 = marche).
 */

export interface V21ParamSpec {
  id: string;
  /** Nom court affiché. */
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Infobulle : à quoi ça sert, avec l'équivalent dans les autres DAW. */
  hint: string;
}

export interface V21Preset { id: string; name: string; hint: string; params: Record<string, number | string> }

export type V21Type = 'HARMONIZER' | 'VOICESHIFT' | 'TIMEFX' | 'DJFILTER' | 'LOFI';

// ---------------------------------------------------------------------------
// Harmoniseur
// ---------------------------------------------------------------------------

/** Intervalles proposés (degrés de la gamme). */
export const HARMONY_INTERVALS: { deg: number; label: string; short: string }[] = [
  { deg: 7, label: 'Octave au-dessus', short: '8ve ↑' },
  { deg: 5, label: 'Sixte au-dessus', short: '6te ↑' },
  { deg: 4, label: 'Quinte au-dessus', short: '5te ↑' },
  { deg: 3, label: 'Quarte au-dessus', short: '4te ↑' },
  { deg: 2, label: 'Tierce au-dessus', short: '3ce ↑' },
  { deg: 1, label: 'Seconde au-dessus', short: '2de ↑' },
  { deg: 0, label: 'Unisson (doublage)', short: 'Unisson' },
  { deg: -2, label: 'Tierce en dessous', short: '3ce ↓' },
  { deg: -3, label: 'Quarte en dessous', short: '4te ↓' },
  { deg: -4, label: 'Quinte en dessous', short: '5te ↓' },
  { deg: -5, label: 'Sixte en dessous', short: '6te ↓' },
  { deg: -7, label: 'Octave en dessous', short: '8ve ↓' },
];

export const intervalLabel = (deg: number) => HARMONY_INTERVALS.find(i => i.deg === Math.round(deg))?.label || `${deg > 0 ? '+' : ''}${Math.round(deg)} degrés`;

export const HARMONIZER_SPECS: V21ParamSpec[] = [
  { id: 'voices', label: 'Nombre de voix', min: 1, max: 4, step: 1, unit: '', hint: "Nombre de voix d'harmonie ajoutées à la voix (1 à 4), comme les voix du Vocal Transformer / harmonies de Logic ou du Pitcher de FL Studio." },
  ...[1, 2, 3, 4].flatMap(i => [
    { id: `v${i}Deg`, label: `Voix ${i} : intervalle`, min: -7, max: 7, step: 1, unit: 'degrés', hint: `Intervalle de la voix ${i} dans la gamme du projet : +2 = tierce au-dessus, +4 = quinte, +7 = octave ; négatif = en dessous.` },
    { id: `v${i}Level`, label: `Voix ${i} : niveau`, min: -30, max: 6, step: 0.5, unit: 'dB', hint: `Volume de la voix ${i} (dB). Une harmonie se place souvent 4 à 8 dB sous la voix principale.` },
    { id: `v${i}Pan`, label: `Voix ${i} : panoramique`, min: -1, max: 1, step: 0.05, unit: 'pan', hint: `Place de la voix ${i} dans la stéréo : écarte les harmonies à gauche et à droite pour laisser la voix principale au centre.` },
  ]),
  { id: 'dry', label: 'Voix principale', min: -60, max: 6, step: 0.5, unit: 'dB', hint: "Niveau de la voix d'origine (−60 dB = coupée : on n'entend que les harmonies, pratique sur une piste d'harmonies séparée)." },
  { id: 'humanize', label: 'Humanisation', min: 0, max: 1, step: 0.01, unit: '%', hint: "Rend les voix plus naturelles : léger retard, légère différence de justesse et petite dérive, comme de vrais choristes (Humanize du Pitcher / doublage de Melodyne)." },
  { id: 'formant', label: 'Formant des voix', min: -12, max: 12, step: 0.5, unit: 'demi-tons', hint: 'Timbre des voix d\'harmonie : négatif = plus grosses / plus graves de timbre, positif = plus fines. Ne change pas les notes (Formant du Vocal Transformer).' },
  { id: 'preserve', label: 'Formants préservés', min: 0, max: 1, step: 1, unit: '', hint: "Activé : les voix gardent le timbre naturel de la voix. Désactivé : les voix aiguës sonnent « chipmunk » et les graves « monstre »." },
  { id: 'rootKey', label: 'Tonique', min: 0, max: 11, step: 1, unit: '', hint: 'Tonalité utilisée pour les harmonies (celle du projet par défaut).' },
];

export const DEFAULT_HARMONIZER = {
  voices: 2, v1Deg: 2, v1Level: -4, v1Pan: -0.35, v2Deg: 4, v2Level: -5, v2Pan: 0.35,
  v3Deg: -3, v3Level: -6, v3Pan: -0.6, v4Deg: 7, v4Level: -8, v4Pan: 0.6,
  dry: 0, humanize: 0.35, formant: 0, preserve: 1, rootKey: 0, scale: 'CHROMATIC', isEnabled: true,
};

export const HARMONIZER_PRESETS: V21Preset[] = [
  { id: 'tierce-quinte', name: 'Harmonie tierce + quinte', hint: 'Le grand classique des refrains : tierce et quinte au-dessus, ouvertes à gauche et à droite.', params: { voices: 2, v1Deg: 2, v1Level: -4, v1Pan: -0.35, v2Deg: 4, v2Level: -5, v2Pan: 0.35, humanize: 0.35, dry: 0, formant: 0, preserve: 1 } },
  { id: 'tierce', name: 'Tierce au-dessus (R&B)', hint: 'Une seule voix, une tierce au-dessus : douce, très R&B.', params: { voices: 1, v1Deg: 2, v1Level: -3, v1Pan: 0.2, humanize: 0.3, dry: 0, formant: 0, preserve: 1 } },
  { id: 'tierce-dessous', name: 'Tierce en dessous', hint: 'Voix d\'harmonie sous la mélodie : plus sombre, soutient la voix.', params: { voices: 1, v1Deg: -2, v1Level: -4, v1Pan: -0.2, humanize: 0.3, dry: 0, formant: 0, preserve: 1 } },
  { id: 'octave-dessous', name: 'Octave en dessous (grosse voix)', hint: 'Double la voix une octave plus bas, au centre : donne du poids aux refrains et aux ad-libs.', params: { voices: 1, v1Deg: -7, v1Level: -6, v1Pan: 0, humanize: 0.1, dry: 0, formant: 0, preserve: 1 } },
  { id: 'quinte-octave', name: 'Quinte + octave (hymne)', hint: 'Quinte et octave au-dessus : son large, effet « hymne ».', params: { voices: 2, v1Deg: 4, v1Level: -5, v1Pan: -0.4, v2Deg: 7, v2Level: -8, v2Pan: 0.4, humanize: 0.4, dry: 0, formant: 0, preserve: 1 } },
  { id: 'choeur', name: 'Chœur 4 voix', hint: 'Quatre voix réparties dans la stéréo, très humanisées : un petit chœur.', params: { voices: 4, v1Deg: 2, v1Level: -6, v1Pan: -0.6, v2Deg: 4, v2Level: -7, v2Pan: 0.6, v3Deg: -3, v3Level: -8, v3Pan: -0.3, v4Deg: 7, v4Level: -10, v4Pan: 0.3, humanize: 0.6, dry: 0, formant: 0, preserve: 1 } },
  { id: 'unisson', name: 'Doublage serré (unisson)', hint: 'Deux copies de la voix à l\'unisson, légèrement décalées : épaissit comme un doublage.', params: { voices: 2, v1Deg: 0, v1Level: -6, v1Pan: -0.7, v2Deg: 0, v2Level: -6, v2Pan: 0.7, humanize: 0.8, dry: 0, formant: 0, preserve: 1 } },
  { id: 'harmonies-seules', name: 'Harmonies seules', hint: 'Coupe la voix principale : pour une piste d\'harmonies à part (dupliquer la voix, puis ce préréglage).', params: { voices: 2, v1Deg: 2, v1Level: 0, v1Pan: -0.3, v2Deg: 4, v2Level: -1, v2Pan: 0.3, humanize: 0.4, dry: -60, formant: 0, preserve: 1 } },
];

// ---------------------------------------------------------------------------
// Voix grave / aiguë
// ---------------------------------------------------------------------------

export const VOICESHIFT_SPECS: V21ParamSpec[] = [
  { id: 'pitch', label: 'Hauteur', min: -24, max: 24, step: 0.1, unit: 'demi-tons', hint: 'Transpose la voix sans changer son tempo (Pitch du Vocal Transformer de Logic, Little AlterBoy). −12 = une octave plus grave.' },
  { id: 'formant', label: 'Formant', min: -12, max: 12, step: 0.1, unit: 'demi-tons', hint: 'Timbre de la voix, sans changer la hauteur (Formant du Vocal Transformer) : négatif = plus gros, plus « monstre » ; positif = plus fin, plus « enfant ».' },
  { id: 'link', label: 'Formant lié à la hauteur', min: 0, max: 1, step: 1, unit: '', hint: 'Activé : le timbre suit la hauteur, comme une bande accélérée (effet chipmunk / ralenti). Désactivé : la voix garde son timbre naturel.' },
  { id: 'mix', label: 'Dosage', min: 0, max: 1, step: 0.01, unit: '%', hint: 'Part de la voix transformée. 50 % = la voix d\'origine + sa copie transformée (layer, octaver).' },
  { id: 'output', label: 'Sortie', min: -24, max: 12, step: 0.5, unit: 'dB', hint: 'Volume après l\'effet (dB), pour comparer à volume égal.' },
];

export const DEFAULT_VOICESHIFT = { pitch: -5, formant: -2, link: 0, mix: 1, output: 0, isEnabled: true };

export const VOICESHIFT_PRESETS: V21Preset[] = [
  { id: 'demon', name: 'Voix démon', hint: 'Une octave plus bas, timbre très gros : voix de démon / de méchant (ad-libs trap, intros).', params: { pitch: -12, formant: -4, link: 0, mix: 1, output: 2 } },
  { id: 'grave', name: 'Voix grave', hint: 'Quelques demi-tons plus bas, timbre un peu plus gros : voix posée, plus sombre.', params: { pitch: -5, formant: -2, link: 0, mix: 1, output: 0 } },
  { id: 'chipmunk', name: 'Voix de chipmunk', hint: 'Une octave plus haut, timbre lié : la voix « accélérée » des samples soul (Kanye, chipmunk soul).', params: { pitch: 12, formant: 0, link: 1, mix: 1, output: -2 } },
  { id: 'aigue', name: 'Voix aiguë naturelle', hint: 'Plus haut mais le timbre reste naturel.', params: { pitch: 5, formant: 0, link: 0, mix: 1, output: 0 } },
  { id: 'formant-gros', name: 'Formant seul : plus gros', hint: 'Même notes, timbre plus gros et plus grave.', params: { pitch: 0, formant: -4, link: 0, mix: 1, output: 0 } },
  { id: 'formant-fin', name: 'Formant seul : plus fin', hint: 'Même notes, timbre plus fin et plus jeune.', params: { pitch: 0, formant: 4, link: 0, mix: 1, output: 0 } },
  { id: 'octaver', name: 'Octave dessous mélangée', hint: 'La voix + sa copie une octave plus bas : épaisseur pour les refrains et les ad-libs.', params: { pitch: -12, formant: 0, link: 0, mix: 0.5, output: 0 } },
  { id: 'ralenti', name: 'Ralenti (slowed)', hint: 'Voix ralentie façon « slowed » : plus grave, timbre lié.', params: { pitch: -3, formant: 0, link: 1, mix: 1, output: 0 } },
];

// ---------------------------------------------------------------------------
// Tape stop / half-time / stutter
// ---------------------------------------------------------------------------

export const TIMEFX_SPECS: V21ParamSpec[] = [
  { id: 'stop', label: 'Tape stop', min: 0, max: 1, step: 1, unit: '', hint: 'Déclenche l\'arrêt de bande : le son ralentit et descend jusqu\'à l\'arrêt (Tape stop de Gross Beat / FL Studio). Automatise-le pour le placer pile avant un drop.' },
  { id: 'stopBeats', label: 'Durée de l\'arrêt', min: 0.125, max: 8, step: 0.125, unit: 'temps', hint: 'Durée du ralentissement, en temps (1 = une noire au tempo du projet).' },
  { id: 'stopCurve', label: 'Courbe', min: -1, max: 1, step: 0.05, unit: '', hint: '0 = vinyle freiné (ralentit régulièrement) ; à droite = la bande tient puis s\'écroule ; à gauche = chute rapide puis longue traîne.' },
  { id: 'startBeats', label: 'Redémarrage', min: 0, max: 4, step: 0.125, unit: 'temps', hint: 'Durée du redémarrage quand on relâche (tape start). 0 = reprise immédiate. Le redémarrage retombe pile sur le temps.' },
  { id: 'half', label: 'Half-time', min: 0, max: 1, step: 1, unit: '', hint: 'Joue au ralenti, une octave plus bas, en se recalant à chaque cycle (Half-time de Gross Beat, effet trap). Automatise-le sur une zone.' },
  { id: 'halfBeats', label: 'Cycle du half-time', min: 1, max: 8, step: 1, unit: 'temps', hint: 'Longueur d\'un cycle : 4 temps = une mesure rejoue sa première moitié au ralenti.' },
  { id: 'stutter', label: 'Stutter', min: 0, max: 1, step: 1, unit: '', hint: 'Répète la tranche qui commence au déclenchement (Beat Repeat de Live, stutter de Gross Beat).' },
  { id: 'stutterDiv', label: 'Taille de la répétition', min: 0.0625, max: 2, step: 0.0625, unit: 'temps', hint: '0,25 temps = une double croche (1/16) ; 0,5 = une croche (1/8) ; 1 = une noire.' },
];

export const DEFAULT_TIMEFX = { stop: 0, stopBeats: 1, stopCurve: 0, startBeats: 0, half: 0, halfBeats: 4, stutter: 0, stutterDiv: 0.25, isEnabled: true };

export const TIMEFX_PRESETS: V21Preset[] = [
  { id: 'stop-1', name: 'Tape stop 1 temps', hint: 'L\'arrêt classique avant un drop : une noire.', params: { stopBeats: 1, stopCurve: 0, startBeats: 0 } },
  { id: 'stop-2', name: 'Tape stop 2 temps (lent)', hint: 'Arrêt plus long, la bande tient un peu puis s\'écroule.', params: { stopBeats: 2, stopCurve: 0.4, startBeats: 0 } },
  { id: 'stop-demi', name: 'Vinyle freiné ½ temps', hint: 'Arrêt très court et sec, comme une main sur le vinyle.', params: { stopBeats: 0.5, stopCurve: -0.5, startBeats: 0 } },
  { id: 'stop-start', name: 'Tape stop + redémarrage', hint: 'S\'arrête en 1 temps, puis redémarre en 1 temps quand on relâche.', params: { stopBeats: 1, stopCurve: 0, startBeats: 1 } },
  { id: 'half-mesure', name: 'Half-time 1 mesure', hint: 'Chaque mesure rejoue sa première moitié au ralenti.', params: { halfBeats: 4 } },
  { id: 'half-2', name: 'Half-time 2 temps', hint: 'Cycle plus court : le ralenti suit mieux le rythme.', params: { halfBeats: 2 } },
  { id: 'stutter-16', name: 'Stutter 1/16', hint: 'Répétition en doubles croches : roulement rapide.', params: { stutterDiv: 0.25 } },
  { id: 'stutter-8', name: 'Stutter 1/8', hint: 'Répétition en croches.', params: { stutterDiv: 0.5 } },
  { id: 'stutter-32', name: 'Stutter 1/32', hint: 'Répétition très rapide (effet « glitch »).', params: { stutterDiv: 0.125 } },
];

// ---------------------------------------------------------------------------
// Filtre DJ
// ---------------------------------------------------------------------------

export const DJFILTER_SPECS: V21ParamSpec[] = [
  { id: 'filter', label: 'Filtre', min: -1, max: 1, step: 0.01, unit: '', hint: 'Un seul bouton : à gauche passe-bas (le son s\'étouffe), à droite passe-haut (les basses disparaissent), au centre rien. Comme le filtre d\'une table de mixage DJ, l\'Auto Filter de Live ou le DJ Filter de Logic.' },
  { id: 'resonance', label: 'Résonance', min: 0, max: 1, step: 0.01, unit: '%', hint: 'Accentue la fréquence de coupure : le balayage « siffle » davantage.' },
  { id: 'slope', label: 'Pente', min: 12, max: 24, step: 12, unit: 'dB/oct', hint: '12 dB/octave = doux ; 24 dB/octave = net, comme un filtre DJ.' },
  { id: 'output', label: 'Sortie', min: -24, max: 12, step: 0.5, unit: 'dB', hint: 'Volume après le filtre (dB).' },
];

export const DEFAULT_DJFILTER = { filter: 0, resonance: 0.25, slope: 24, output: 0, isEnabled: true };

export const DJFILTER_PRESETS: V21Preset[] = [
  { id: 'neutre', name: 'Ouvert (neutre)', hint: 'Filtre au centre : aucun effet. Point de départ d\'une automation.', params: { filter: 0, resonance: 0.25, slope: 24, output: 0 } },
  { id: 'intro', name: 'Intro étouffée', hint: 'Passe-bas : le beat sonne « dans la pièce d\'à côté » avant le drop.', params: { filter: -0.62, resonance: 0.3, slope: 24, output: 0 } },
  { id: 'montee', name: 'Montée (passe-haut)', hint: 'Passe-haut : retire les basses pour faire monter la tension.', params: { filter: 0.5, resonance: 0.45, slope: 24, output: 0 } },
  { id: 'sans-basse', name: 'Basses coupées avant le drop', hint: 'Passe-haut léger : enlève la 808 et le kick une mesure avant le drop.', params: { filter: 0.3, resonance: 0.2, slope: 24, output: 0 } },
  { id: 'radio-filtre', name: 'Balayage résonant', hint: 'Passe-bas très résonant, à automatiser pour un balayage qui siffle.', params: { filter: -0.4, resonance: 0.8, slope: 12, output: -2 } },
];

// ---------------------------------------------------------------------------
// Lo-fi / téléphone / radio
// ---------------------------------------------------------------------------

export const LOFI_SPECS: V21ParamSpec[] = [
  { id: 'lowCut', label: 'Coupe-bas', min: 20, max: 2000, step: 1, unit: 'Hz', hint: 'Retire les graves : 300 à 600 Hz pour un téléphone ou un talkie-walkie.' },
  { id: 'highCut', label: 'Coupe-haut', min: 1000, max: 20000, step: 10, unit: 'Hz', hint: 'Retire les aigus : 3 400 Hz = téléphone, 5 000 Hz = radio AM, 9 000 Hz = cassette.' },
  { id: 'drive', label: 'Saturation', min: 0, max: 1, step: 0.01, unit: '%', hint: 'Grain léger d\'un petit haut-parleur. Pour une vraie saturation, utilise plutôt « Saturation ».' },
  { id: 'bits', label: 'Résolution', min: 2, max: 16, step: 1, unit: 'bits', hint: 'Bitcrush : moins de bits = son granuleux (Bitcrusher de Logic, Redux de Live). 16 = intact.' },
  { id: 'rate', label: 'Échantillonnage', min: 1000, max: 48000, step: 50, unit: 'Hz', hint: 'Réduction de fréquence d\'échantillonnage : son métallique de vieux sampler (SP-1200 ≈ 26 kHz, téléphone 8 kHz). 48 000 = intact.' },
  { id: 'noise', label: 'Souffle', min: 0, max: 1, step: 0.01, unit: '%', hint: 'Ajoute un souffle de bande / de ligne.' },
  { id: 'mix', label: 'Dosage', min: 0, max: 1, step: 0.01, unit: '%', hint: 'Part du son traité (100 % = effet complet).' },
  { id: 'output', label: 'Sortie', min: -24, max: 12, step: 0.5, unit: 'dB', hint: 'Volume après l\'effet (dB) : un son filtré paraît moins fort.' },
];

export const DEFAULT_LOFI = { bits: 10, rate: 8000, lowCut: 400, highCut: 3400, drive: 0.3, noise: 0.05, mix: 1, output: 3, isEnabled: true };

export const LOFI_PRESETS: V21Preset[] = [
  { id: 'telephone', name: 'Téléphone', hint: 'Bande 400–3 400 Hz, 8 kHz : la voix au bout du fil (intros, couplets parlés).', params: { bits: 10, rate: 8000, lowCut: 400, highCut: 3400, drive: 0.3, noise: 0.05, mix: 1, output: 3 } },
  { id: 'radio', name: 'Radio AM', hint: 'Bande étroite, souffle et grain : vieux poste de radio.', params: { bits: 12, rate: 16000, lowCut: 250, highCut: 4500, drive: 0.35, noise: 0.18, mix: 1, output: 3 } },
  { id: 'cassette', name: 'Cassette lo-fi', hint: 'Aigus adoucis, léger souffle : ambiance lo-fi / boom bap.', params: { bits: 12, rate: 32000, lowCut: 60, highCut: 9000, drive: 0.2, noise: 0.25, mix: 1, output: 0 } },
  { id: 'bitcrush', name: 'Bitcrush 8 bits', hint: '8 bits à 11 kHz : son de console rétro, granuleux.', params: { bits: 8, rate: 11025, lowCut: 20, highCut: 20000, drive: 0, noise: 0, mix: 1, output: 0 } },
  { id: 'talkie', name: 'Talkie-walkie', hint: 'Très étroit et saturé, avec du souffle.', params: { bits: 8, rate: 8000, lowCut: 700, highCut: 2800, drive: 0.6, noise: 0.2, mix: 1, output: 5 } },
  { id: 'megaphone', name: 'Mégaphone', hint: 'Médium agressif et saturé, sans bitcrush.', params: { bits: 16, rate: 48000, lowCut: 500, highCut: 4000, drive: 0.7, noise: 0, mix: 1, output: 3 } },
  { id: 'sp1200', name: 'Sampler 12 bits (SP-1200)', hint: '12 bits à 26 kHz : le grain des samplers hip-hop des années 90.', params: { bits: 12, rate: 26040, lowCut: 20, highCut: 13000, drive: 0.15, noise: 0, mix: 1, output: 0 } },
];

// ---------------------------------------------------------------------------

export const V21_SPECS: Record<V21Type, V21ParamSpec[]> = {
  HARMONIZER: HARMONIZER_SPECS, VOICESHIFT: VOICESHIFT_SPECS, TIMEFX: TIMEFX_SPECS, DJFILTER: DJFILTER_SPECS, LOFI: LOFI_SPECS,
};

export const V21_PRESETS: Record<V21Type, V21Preset[]> = {
  HARMONIZER: HARMONIZER_PRESETS, VOICESHIFT: VOICESHIFT_PRESETS, TIMEFX: TIMEFX_PRESETS, DJFILTER: DJFILTER_PRESETS, LOFI: LOFI_PRESETS,
};

export const V21_DEFAULTS: Record<V21Type, () => Record<string, any>> = {
  HARMONIZER: () => ({ ...DEFAULT_HARMONIZER }), VOICESHIFT: () => ({ ...DEFAULT_VOICESHIFT }), TIMEFX: () => ({ ...DEFAULT_TIMEFX }),
  DJFILTER: () => ({ ...DEFAULT_DJFILTER }), LOFI: () => ({ ...DEFAULT_LOFI }),
};

/** Ramène des réglages reçus (fenêtre, automation, projet ancien) dans leurs bornes. Les clés inconnues passent telles quelles. */
export function sanitizeV21(type: V21Type, p: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const specs = V21_SPECS[type] || [];
  for (const [k, v] of Object.entries(p || {})) {
    const s = specs.find(x => x.id === k);
    if (!s) { out[k] = v; continue; }
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : +v;
    if (!Number.isFinite(n)) continue;
    let c = Math.max(s.min, Math.min(s.max, n));
    if (s.step >= 1) c = Math.round(c);
    out[k] = c;
  }
  return out;
}

/** Paramètres automatisables (liste de l'éditeur d'automation). */
export const v21Automatable = (type: string) => (V21_SPECS[type as V21Type] || []).filter(s => s.id !== 'rootKey');

/** Nom lisible d'un réglage (« Voix 1 : niveau ») pour l'automation. */
export const v21ParamLabel = (type: string, key: string): string | null => (V21_SPECS[type as V21Type] || []).find(s => s.id === key)?.label || null;
