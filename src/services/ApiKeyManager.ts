/**
 * Service de gestion de la clé API Google AI
 * Permet à l'admin de modifier la clé sans éditer le fichier .env
 */

const API_KEY_STORAGE_KEY = 'nova_admin_api_key';

/**
 * Récupère la clé API active
 * Priorité: 1. Clé admin (localStorage) 2. Clé .env
 */
export const getActiveApiKey = (): string | undefined => {
  // D'abord vérifier s'il y a une clé admin
  const adminKey = localStorage.getItem(API_KEY_STORAGE_KEY);
  if (adminKey && adminKey.trim()) {
    console.log('[API_KEY] Using admin override key');
    return adminKey;
  }

  // Sinon utiliser la clé .env
  const envKey = import.meta.env.VITE_GOOGLE_AI_API_KEY;
  if (envKey) {
    console.log('[API_KEY] Using .env key');
    return envKey;
  }

  console.warn('[API_KEY] No API key found');
  return undefined;
};

/**
 * Sauvegarde une clé API admin (override)
 */
export const setAdminApiKey = (apiKey: string): void => {
  if (apiKey && apiKey.trim()) {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey.trim());
    console.log('[API_KEY] Admin key saved');
  }
};

/**
 * Supprime la clé API admin (revient à la clé .env)
 */
export const clearAdminApiKey = (): void => {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  console.log('[API_KEY] Admin key cleared, reverting to .env');
};

/**
 * Vérifie si une clé admin est définie
 */
export const hasAdminApiKey = (): boolean => {
  const key = localStorage.getItem(API_KEY_STORAGE_KEY);
  return !!(key && key.trim());
};

/**
 * Récupère la clé admin actuelle (pour l'afficher)
 */
export const getAdminApiKey = (): string | null => {
  return localStorage.getItem(API_KEY_STORAGE_KEY);
};
