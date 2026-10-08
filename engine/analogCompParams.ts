/**
 * Réglages des compresseurs « analogiques » de NOVA : bornes, valeurs par
 * défaut, noms français (tutoiement dans les infobulles), préréglages et
 * cible du calage « Caler sur ma voix ». Données pures (aucun React, aucun
 * nœud audio) : moteur, fenêtres, automation, Mix auto et tests s'en servent.
 *
 * Modèles « boîte noire » mesurés au labo NOVA (tools/labo) ; les noms sont
 * des noms NOVA, sans marque. Les réglages automatisables sont des nombres.
 */
import type { AnalogKind } from './analogCompMaps';

export interface AnalogParamSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
  /** Automatisable (AudioParam du worklet). */
  auto: boolean;
  /** Choix discrets (boutons) au lieu d'un curseur. */
  choices?: { v: number; label: string; hint?: string }[];
}

export interface AnalogPreset { id: string; name: string; hint: string; params: Record<string, number> }

export interface AnalogKindSpec {
  kind: AnalogKind;
  name: string;
  /** Réglage qui pousse dans la compression (calage « Caler sur ma voix »). */
  driveParam: string;
  /** Sens : +1 si augmenter `driveParam` comprime plus, −1 si c'est le contraire. */
  driveSense: 1 | -1;
  /** Réduction max au VU visée par le calage (dB) — règles de mix de Romain. */
  targetGrDb: number;
  specs: AnalogParamSpec[];
  defaults: Record<string, number>;
  presets: AnalogPreset[];
}

const ATT_HINT_OPTO = "Vitesse à laquelle la cellule optique attrape le son (0 = très rapide, ~1 ms ; 10 = lent, ~300 ms). Lent laisse passer l'attaque des consonnes.";
const REL_HINT_OPTO = "Vitesse de retour après une phrase (0 = ~25 ms, 5 = ~0,6 s, 10 = ~5 s). Lent = compression « collée », rapide = plus vivante.";

export const OPTO_VINTAGE: AnalogKindSpec = {
  kind: 'OPTO_VINTAGE',
  name: 'Opto Vintage',
  driveParam: 'threshold',
  driveSense: -1,
  targetGrDb: 5,
  specs: [
    { id: 'threshold', label: 'Seuil', min: -60, max: 20, step: 0.1, unit: 'dBFS', auto: true,
      hint: "Niveau où la compression atteint 1 dB (définition de l'appareil d'origine). Plus bas = plus de compression. « Caler sur ma voix » le règle pour toi." },
    { id: 'ratio', label: 'Taux', min: 2, max: 10, step: 0.1, unit: ':1', auto: true,
      hint: "Force de la compression. Sur la voix, reste à 2:1 (deux étages à 2:1 sonnent plus naturel qu'un seul fort). Au-delà, la cellule sature doucement vers 30 dB." },
    { id: 'attack', label: 'Attaque', min: 0, max: 10, step: 0.1, unit: 'pos', auto: true, hint: ATT_HINT_OPTO },
    { id: 'release', label: 'Relâchement', min: 0, max: 10, step: 0.1, unit: 'pos', auto: true, hint: REL_HINT_OPTO },
    { id: 'mode', label: 'Temps', min: 0, max: 2, step: 1, unit: '', auto: false,
      hint: "Fixe : 1 ms / très court, pour les attaques. Fixe/Manuel : réaction rapide puis relâchement réglable (idéal bus et voix). Manuel : les deux boutons.",
      choices: [{ v: 0, label: 'Fixe' }, { v: 1, label: 'Fixe/Manuel' }, { v: 2, label: 'Manuel' }] },
    { id: 'output', label: 'Gain de sortie', min: -18, max: 28, step: 0.1, unit: 'dB', auto: true,
      hint: 'Rattrape le volume perdu par la compression (gain réel, en dB).' },
    { id: 'mix', label: 'Mélange (parallèle)', min: 0, max: 100, step: 1, unit: '%', auto: true,
      hint: "100 % = tout compressé ; moins = compression parallèle (garde les attaques du son d'origine)." },
    { id: 'scLowCut', label: 'Détection : coupe-bas', min: 0, max: 220, step: 1, unit: 'Hz', auto: false,
      hint: "Le compresseur réagit moins aux graves (respirations, plosives, basse qui traverse) : la voix est comprimée sur son corps, pas sur ses « pop ».",
      choices: [{ v: 0, label: 'Non' }, { v: 80, label: '80 Hz' }, { v: 220, label: '220 Hz' }] },
    { id: 'vintage', label: 'Génération', min: 0, max: 1, step: 1, unit: '', auto: false,
      hint: "Moderne : transparent. Vintage : un peu plus sombre et léger roll-off dans l'extrême grave et l'extrême aigu.",
      choices: [{ v: 0, label: 'Moderne' }, { v: 1, label: 'Vintage' }] },
  ],
  defaults: { threshold: -30, ratio: 2, attack: 3, release: 3, mode: 1, output: 0, mix: 100, scLowCut: 0, vintage: 0 },
  presets: [
    { id: 'voix', name: 'Voix (règle maison)', hint: '2:1, Fixe/Manuel, attaque et relâchement à 3 : la voix posée devant sans pomper. Clique ensuite « Caler sur ma voix » (5 dB au VU).', params: { ratio: 2, attack: 3, release: 3, mode: 1, mix: 100 } },
    { id: 'voix-lente', name: 'Voix douce', hint: 'Attaque plus lente (les consonnes passent) et relâchement long : nivelle sans se faire entendre.', params: { ratio: 2, attack: 5, release: 5, mode: 2, mix: 100 } },
    { id: 'bus', name: 'Bus / mix', hint: 'Recette du constructeur pour un mix : 3 à 4 dB de réduction, Fixe/Manuel, taux bas.', params: { ratio: 2.5, attack: 6, release: 2, mode: 1, mix: 100 } },
    { id: 'basse', name: 'Basse', hint: 'Taux moyen, attaque moyenne : la basse tient sa place sans perdre son attaque.', params: { ratio: 4, attack: 6, release: 2.5, mode: 2, mix: 100, scLowCut: 0 } },
    { id: 'parallele', name: 'Écrasé en parallèle', hint: 'Compression forte mélangée à 50 % : de la densité sans perdre les attaques.', params: { ratio: 8, attack: 2, release: 4, mode: 2, mix: 50 } },
  ],
};

export const FET76: AnalogKindSpec = {
  kind: 'FET76',
  name: 'FET 76',
  driveParam: 'input',
  driveSense: 1,
  targetGrDb: 5,
  specs: [
    { id: 'input', label: 'Entrée', min: -60, max: 0, step: 0.1, unit: 'pos', auto: true,
      hint: "Le seuil est fixe : tourne l'entrée pour pousser le son dans la compression (et dans la couleur des transistors). « Caler sur ma voix » la règle pour toi." },
    { id: 'output', label: 'Sortie', min: -60, max: 0, step: 0.1, unit: 'pos', auto: true,
      hint: 'Volume de sortie après la compression : remonte-le pour rattraper ce que la compression a enlevé.' },
    { id: 'attack', label: 'Attaque', min: 1, max: 7, step: 0.1, unit: 'pos', auto: true,
      hint: "7 = la plus rapide (~0,1 ms, écrase les attaques), 1 = la plus lente (~2,5 ms, laisse passer le claquant)." },
    { id: 'release', label: 'Relâchement', min: 1, max: 7, step: 0.1, unit: 'pos', auto: true,
      hint: "7 = le plus rapide (~80 ms, son plus fort et plus agressif), 1 = le plus lent (~1 s, plus doux)." },
    { id: 'ratio', label: 'Taux', min: 0, max: 24, step: 1, unit: '', auto: false,
      hint: "Plus le taux est haut, plus le seuil monte et plus la compression est ferme. « Écrasé » (4+20) : le son de bus agressif.",
      choices: [{ v: 2, label: '2:1' }, { v: 4, label: '4:1' }, { v: 8, label: '8:1' }, { v: 20, label: '20:1' }, { v: 24, label: 'Écrasé', hint: '4:1 + 20:1 enfoncés ensemble' }] },
    { id: 'slo', label: 'Attaque lente (SLO)', min: 0, max: 1, step: 1, unit: '', auto: false,
      hint: "Attaque d'environ 10 ms : laisse passer les transitoires (batterie, consonnes) tout en tenant le niveau.",
      choices: [{ v: 0, label: 'Non' }, { v: 1, label: 'Oui' }] },
    { id: 'mix', label: 'Mélange (parallèle)', min: 0, max: 100, step: 1, unit: '%', auto: true,
      hint: "100 % = tout compressé ; moins = compression parallèle (« New York »)." },
  ],
  defaults: { input: -28, output: -15, attack: 5, release: 6, ratio: 4, slo: 0, mix: 100 },
  presets: [
    { id: 'bus-voix', name: 'Bus voix (règle maison)', hint: '4:1, attaque 5, relâchement 6 : le réglage de ta session. Clique ensuite « Caler sur ma voix » (5 dB max au VU).', params: { ratio: 4, attack: 5, release: 6, slo: 0, mix: 100 } },
    { id: 'voix-devant', name: 'Voix devant', hint: '4:1, attaque moyenne, relâchement rapide : la voix colle au haut-parleur.', params: { ratio: 4, attack: 3, release: 7, slo: 0, mix: 100 } },
    { id: 'batterie-ecrasee', name: 'Batterie écrasée', hint: 'Mode écrasé en parallèle : énorme et vivant.', params: { ratio: 24, attack: 7, release: 7, slo: 0, mix: 40 } },
    { id: 'basse', name: 'Basse', hint: '8:1, attaque lente : la basse reste ronde et régulière.', params: { ratio: 8, attack: 2, release: 4, slo: 0, mix: 100 } },
  ],
};

export const LEVELER2A: AnalogKindSpec = {
  kind: 'LEVELER2A',
  name: 'Leveler 2A',
  driveParam: 'peakReduction',
  driveSense: 1,
  targetGrDb: 2,
  specs: [
    { id: 'peakReduction', label: 'Réduction (Peak Reduction)', min: 0, max: 100, step: 0.5, unit: '', auto: true,
      hint: "Un seul bouton pour la compression : plus haut = plus de réduction. Sur un bus, vise 2 dB max au VU (« Caler sur ma voix » le fait pour toi)." },
    { id: 'gain', label: 'Gain', min: 0, max: 100, step: 0.5, unit: 'gain', auto: true,
      hint: "Gain de sortie à lampes (0 = coupé, 50 ≈ +14,5 dB). Poussé fort, l'étage de sortie sature doucement (H2 puis H3)." },
    { id: 'limit', label: 'Mode', min: 0, max: 1, step: 1, unit: '', auto: false,
      hint: 'Compress : taux doux (~3:1 à 4:1). Limit : taux élevé, la cellule tient plus fermement les crêtes.',
      choices: [{ v: 0, label: 'Compress' }, { v: 1, label: 'Limit' }] },
    { id: 'emphasis', label: 'Accentuation des aigus (détection)', min: 0, max: 100, step: 1, unit: '%', auto: false,
      hint: "Rend la détection plus sensible aux aigus (sifflantes, cymbales) et moins aux graves : la voix est tenue sur sa brillance plutôt que sur son corps." },
    { id: 'mix', label: 'Mélange (parallèle)', min: 0, max: 100, step: 1, unit: '%', auto: true,
      hint: '100 % = tout compressé ; moins = compression parallèle.' },
  ],
  defaults: { peakReduction: 20, gain: 25, limit: 0, emphasis: 0, mix: 100 },
  presets: [
    { id: 'bus', name: 'Bus voix (règle maison)', hint: 'Compress, réduction douce : clique « Caler sur ma voix » pour 2 dB max au VU.', params: { limit: 0, emphasis: 0, mix: 100 } },
    { id: 'voix-lead', name: 'Voix lead', hint: 'Plus de réduction, accentuation légère des aigus : la voix reste stable et brillante.', params: { peakReduction: 45, gain: 40, limit: 0, emphasis: 20, mix: 100 } },
    { id: 'basse', name: 'Basse', hint: 'Limit : la basse ne dépasse plus, sans perdre sa rondeur.', params: { peakReduction: 50, gain: 45, limit: 1, emphasis: 0, mix: 100 } },
    { id: 'chaleur', name: 'Chaleur à lampes', hint: 'Peu de compression, gain poussé : la couleur de l\'étage à lampes.', params: { peakReduction: 15, gain: 60, limit: 0, emphasis: 0, mix: 100 } },
  ],
};

export const ANALOG_SPECS: Record<string, AnalogKindSpec> = {
  OPTO_VINTAGE,
  FET76,
  LEVELER2A,
};

export const analogSpec = (kind: string): AnalogKindSpec | undefined => ANALOG_SPECS[kind];

export const analogDefaults = (kind: string) => () => ({ ...(ANALOG_SPECS[kind]?.defaults || {}), isEnabled: true });

/** Réglages automatisables (éditeur d'automation, registre des effets). */
export const analogAutomatable = (kind: string) => (ANALOG_SPECS[kind]?.specs || [])
  .filter(s => s.auto)
  .map(s => ({ id: s.id, label: s.label, min: s.min, max: s.max, unit: s.unit === 'pos' ? '' : s.unit }));

export const analogParamLabel = (kind: string, key: string): string | null =>
  ANALOG_SPECS[kind]?.specs.find(s => s.id === key)?.label || null;

/** Bornes et types : un réglage hors bornes ou illisible est ignoré. */
export function sanitizeAnalog(kind: string, p: Record<string, any>): Record<string, number | boolean> {
  const spec = ANALOG_SPECS[kind];
  const out: Record<string, number | boolean> = {};
  if (!spec || !p) return out;
  for (const s of spec.specs) {
    if (p[s.id] === undefined || p[s.id] === null) continue;
    const v = +p[s.id];
    if (!Number.isFinite(v)) continue;
    let x = Math.max(s.min, Math.min(s.max, v));
    if (s.choices) x = s.choices.reduce((best, c) => (Math.abs(c.v - x) < Math.abs(best - x) ? c.v : best), s.choices[0].v);
    out[s.id] = x;
  }
  if (p.isEnabled !== undefined) out.isEnabled = !!p.isEnabled;
  return out;
}
