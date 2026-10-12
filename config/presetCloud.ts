/**
 * Presets synchronisés entre postes (services/PresetCloud) : interrupteur.
 *
 * `enabled: false` tant que la table `nova_presets` n'est pas en ligne
 * (supabase/migrations/20261012200000_nova_presets.sql, attend le GO de Romain) :
 * le client affiche « synchronisation bientôt disponible » SANS envoyer de
 * requête (pas de 404 dans la console, zéro egress). Avec le GO : appliquer la
 * migration, puis passer `enabled` à true et publier NOVA.
 *
 * Sert aussi de coupe-circuit : en cas d'egress anormal, repasser à false.
 *
 * Tests (QA hors production) : localStorage « nova_presets_cloud_test » = « 1 »
 * l'active sur un navigateur de test.
 */
export const PRESET_CLOUD = { enabled: false };

export const presetCloudEnabled = (): boolean => {
  if (PRESET_CLOUD.enabled) return true;
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('nova_presets_cloud_test') === '1'; } catch { return false; }
};
