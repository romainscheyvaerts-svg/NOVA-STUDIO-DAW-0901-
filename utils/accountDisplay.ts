import type { User } from '../types';

/**
 * Un seul compte affiché partout (barre du haut, accueil).
 *
 * NOVA parle à deux projets Supabase :
 *  - le projet « principal » (services/supabase.ts → `supabase`) : ancienne connexion de la fenêtre
 *    « Se connecter » (AuthScreen) et anciens projets cloud (SupabaseManager) ;
 *  - le compte Make Music (`catalogSupabase`) : celui de studiomakemusic.com, des paiements (Nova Pro),
 *    de la collaboration, des séances en ligne et de l'appli Windows.
 * Avant, la barre ne montrait que le premier : connecté par la fenêtre Nova Pro, la collaboration,
 * le site ou l'appli Windows, on lisait toujours « Se connecter ».
 *
 * Ici, rien n'est copié d'un projet à l'autre (aucun jeton) : on AFFICHE le compte principal s'il
 * existe, sinon le compte Make Music. Les fonctions de l'ancien projet gardent leur propre test.
 */
export const MM_PREFIX = 'mm:';

export interface MakeMusicAccount { id: string; email: string }

export const isMakeMusicDisplay = (u: Pick<User, 'id'> | null | undefined) => !!u && u.id.startsWith(MM_PREFIX);

export function accountForBar(main: User | null, mm: MakeMusicAccount | null): User | null {
  if (main && main.id !== 'guest') return main;
  if (mm) {
    const email = mm.email || '';
    return {
      id: MM_PREFIX + mm.id, email, username: email.split('@')[0] || 'Compte Make Music',
      isVerified: true, plan: 'FREE', owned_instruments: main?.owned_instruments || [],
    };
  }
  return main;
}
