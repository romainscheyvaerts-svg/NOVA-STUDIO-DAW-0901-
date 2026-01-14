/**
 * Service de gestion de la clé API Google AI
 * Sauvegarde dans Supabase (pour les utilisateurs connectés) ou localStorage (invités)
 */

import { supabase } from './supabase';
import { User } from '../types';

const API_KEY_STORAGE_KEY = 'nova_guest_api_key';

/**
 * Récupère la clé API active
 * Priorité: 1. Supabase (si connecté) 2. localStorage (invité) 3. .env
 */
export const getActiveApiKey = (user?: User | null): string | undefined => {
  // 1. Utilisateur connecté : vérifier Supabase
  if (user?.google_ai_api_key) {
    console.log('[API_KEY] Using Supabase key for user:', user.email);
    return user.google_ai_api_key;
  }

  // 2. Invité : vérifier localStorage
  const guestKey = localStorage.getItem(API_KEY_STORAGE_KEY);
  if (guestKey && guestKey.trim()) {
    console.log('[API_KEY] Using localStorage key (guest mode)');
    return guestKey;
  }

  // 3. Fallback : clé .env
  const envKey = import.meta.env.VITE_GOOGLE_AI_API_KEY;
  if (envKey) {
    console.log('[API_KEY] Using .env key');
    return envKey;
  }

  console.warn('[API_KEY] No API key found');
  return undefined;
};

/**
 * Sauvegarde la clé API
 * - Si l'utilisateur est connecté : sauvegarde dans Supabase
 * - Sinon : sauvegarde dans localStorage
 */
export const setApiKey = async (apiKey: string, user?: User | null): Promise<boolean> => {
  if (!apiKey || !apiKey.trim()) {
    console.error('[API_KEY] Cannot save empty API key');
    return false;
  }

  const trimmedKey = apiKey.trim();

  // Utilisateur connecté : sauvegarder dans Supabase
  if (user && supabase) {
    try {
      const { error } = await supabase
        .from('users')
        .update({ google_ai_api_key: trimmedKey })
        .eq('id', user.id);

      if (error) {
        console.error('[API_KEY] Supabase save error:', error);
        // Fallback vers localStorage si Supabase échoue
        localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey);
        console.log('[API_KEY] Saved to localStorage (Supabase failed)');
        return true;
      }

      console.log('[API_KEY] Saved to Supabase for user:', user.email);
      return true;
    } catch (err) {
      console.error('[API_KEY] Exception during Supabase save:', err);
      // Fallback vers localStorage
      localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey);
      console.log('[API_KEY] Saved to localStorage (exception)');
      return true;
    }
  }

  // Invité : sauvegarder dans localStorage
  localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey);
  console.log('[API_KEY] Saved to localStorage (guest)');
  return true;
};

/**
 * Supprime la clé API
 */
export const clearApiKey = async (user?: User | null): Promise<boolean> => {
  // Utilisateur connecté : supprimer de Supabase
  if (user && supabase) {
    try {
      const { error } = await supabase
        .from('users')
        .update({ google_ai_api_key: null })
        .eq('id', user.id);

      if (error) {
        console.error('[API_KEY] Supabase clear error:', error);
      } else {
        console.log('[API_KEY] Cleared from Supabase');
      }
    } catch (err) {
      console.error('[API_KEY] Exception during Supabase clear:', err);
    }
  }

  // Toujours nettoyer localStorage aussi
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  console.log('[API_KEY] Cleared from localStorage');
  return true;
};

/**
 * Vérifie si une clé API est définie
 */
export const hasApiKey = (user?: User | null): boolean => {
  if (user?.google_ai_api_key) return true;
  const guestKey = localStorage.getItem(API_KEY_STORAGE_KEY);
  return !!(guestKey && guestKey.trim());
};

/**
 * Récupère la clé API actuelle (pour l'afficher)
 */
export const getCurrentApiKey = (user?: User | null): string | null => {
  if (user?.google_ai_api_key) return user.google_ai_api_key;
  return localStorage.getItem(API_KEY_STORAGE_KEY);
};

// ===== ANCIENS NOMS POUR COMPATIBILITÉ =====
export const setAdminApiKey = setApiKey;
export const clearAdminApiKey = clearApiKey;
export const hasAdminApiKey = hasApiKey;
export const getAdminApiKey = getCurrentApiKey;
