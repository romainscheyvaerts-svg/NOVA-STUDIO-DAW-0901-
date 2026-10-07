/**
 * Accès aux modèles de session « privés » (phase de tests).
 *
 * UN SEUL ENDROIT à modifier pour ouvrir un modèle privé à d'autres comptes :
 * ajoute l'e-mail dans la liste du groupe voulu, ou crée un nouveau groupe.
 *
 * Un modèle porte `privateTo: "<groupe>"` (affiché « privé : romain ») : il n'est
 * visible et chargeable que si le compte connecté a un e-mail de ce groupe. Un
 * invité (pas de compte) ne voit jamais un modèle privé. Un groupe inconnu ici
 * ferme le modèle à tout le monde (prudence).
 *
 * Attention : c'est une restriction d'affichage côté appli, pour les tests ; ce
 * n'est pas un coffre-fort (un modèle ne contient que des réglages de mix).
 */
export const TEMPLATE_ACCESS_GROUPS: Record<string, string[]> = {
  romain: ['romain.scheyvaerts@gmail.com'],
};

/** Libellé d'un groupe pour l'affichage (« privé : romain »). */
export const privateLabel = (group: string) => `privé : ${group}`;
