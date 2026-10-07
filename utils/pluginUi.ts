/**
 * Fenêtres des effets NOVA en français clair (audit G16 / G17).
 *
 * - Les gains s'affichent en dB (« +4,8 dB »), jamais en multiplicateur (« 1.74x »).
 * - Les termes de studio usuels restent (Seuil, Ratio, Attack, Release…), avec
 *   une infobulle qui dit à quoi sert le réglage.
 * - Un seul bouton marche / arrêt par fenêtre : celui de la barre du haut.
 *   L'ancien bouton interne (params.isEnabled) est replié sur le bypass de la barre.
 */

/** Gain linéaire → « +4,8 dB » (virgule française, signe explicite, « −∞ dB » pour le silence). */
export function gainDbFr(linear: number, digits = 1): string {
  if (!(linear > 0.00001)) return '−∞ dB';
  const db = 20 * Math.log10(linear);
  const r = Number(db.toFixed(digits));
  const txt = Math.abs(r).toFixed(digits).replace('.', ',');
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${txt} dB`;
}

/** Nombre → texte français (« 1,5 »). */
export const numFr = (v: number, digits = 1) => v.toFixed(digits).replace('.', ',');

/** Explications courtes des réglages (infobulles). */
export const TERM_HELP: Record<string, string> = {
  Seuil: "Seuil (threshold) : niveau à partir duquel l'effet agit. Plus bas = il agit plus souvent.",
  Ratio: 'Ratio : force de la compression. 2:1 = doux, 4:1 = voix rap, 10:1 et plus = limiteur.',
  Genou: "Genou (knee) : transition douce (grand) ou nette (petit) autour du seuil.",
  Attack: "Attack : vitesse à laquelle l'effet réagit. Court = attrape les attaques, long = laisse passer le punch.",
  Release: "Release : temps pour relâcher après le son fort. Court = nerveux, long = plus naturel.",
  'Gain de sortie': 'Gain de compensation : remonte le volume perdu par la compression (en dB).',
  Mélange: 'Mélange (mix) : part du son traité. 100 % = tout traité, 50 % = compression parallèle.',
  Anticipation: "Anticipation (lookahead) : l'effet « voit » le son un peu en avance pour ne rien rater (ajoute un léger retard).",
  Plage: "Plage (range) : de combien le son est baissé quand la porte est fermée.",
  Maintien: 'Maintien (hold) : temps pendant lequel la porte reste ouverte après la voix.',
  'Filtre de détection': 'Filtre de détection : ignore les graves (souffle, pas, clim) pour décider quand ouvrir.',
  Fréquence: 'Fréquence : la zone du son visée (grave à gauche, aigu à droite).',
  Gain: 'Gain : monte ou baisse cette zone du son (en dB).',
  Largeur: 'Largeur (Q) : petite valeur = zone large et douce, grande valeur = zone étroite et précise.',
  Réduction: 'Réduction : de combien les « s » trop forts sont baissés au maximum.',
  Chaleur: 'Saturation (drive) : quantité de chaleur / grain ajoutée à la voix.',
  Couleur: 'Couleur (tone) : plus sombre à gauche, plus brillant à droite.',
  Sortie: 'Sortie : volume après l’effet, pour comparer à volume égal.',
  Désaccord: 'Désaccord : écart de justesse entre les deux voix doublées (en cents).',
  'Écart G/D': 'Écart gauche / droite : ouvre la voix doublée dans la stéréo.',
};

/** Infobulle d'un réglage (vide si on n'a rien d'utile à dire). */
export const termHelp = (label: string) => TERM_HELP[label] || '';

/**
 * Ancien bouton marche / arrêt interne coupé (params.isEnabled === false) :
 * on le replie sur le bypass de la barre pour qu'il n'existe qu'un seul
 * interrupteur. Renvoie les réglages à écrire et s'il faut basculer le bypass.
 */
export function foldInternalPower(params: Record<string, any> | undefined, pluginEnabled: boolean):
  { params: Record<string, any>; toggleBypass: boolean } | null {
  if (!params || params.isEnabled !== false) return null;
  return { params: { ...params, isEnabled: true }, toggleBypass: pluginEnabled };
}
