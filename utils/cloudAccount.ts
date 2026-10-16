import type { User } from '../types';
import type { MakeMusicAccount } from './accountDisplay';

/**
 * « Sauvegarder dans le cloud » avec un seul compte Make Music (16/10/2026).
 *
 * L'ancien système (SupabaseManager, projet sqduhf…) ne connaît que les comptes de l'ancien projet. Depuis
 * que « Créer un compte » crée le compte Make Music, beaucoup d'utilisateurs n'ont QUE celui-là : on ne
 * leur dit plus « Connecte-toi » (ils le sont déjà), on utilise le stockage en ligne déjà en place côté
 * Make Music : les séances en ligne (« Emporter la session », SessionCloud / daw-session), audio compris,
 * retrouvables dans « Ouvrir un projet » et sur studiomakemusic.com.
 *
 *  - 'legacy'    : compte de l'ancien projet → l'ancien « Sauvegarder dans le cloud », inchangé ;
 *  - 'makemusic' : compte Make Music seulement → séance en ligne Make Music ;
 *  - 'login'     : aucun compte → se connecter (ou créer son compte Make Music).
 */
export type CloudRoute = 'legacy' | 'makemusic' | 'login';

export function cloudRoute(main: Pick<User, 'id'> | null | undefined, mm: MakeMusicAccount | null | undefined): CloudRoute {
  if (main && main.id !== 'guest') return 'legacy';
  if (mm) return 'makemusic';
  return 'login';
}

export const MM_CLOUD_NOTICE =
  '☁️ Ton compte Make Music garde tes projets en ligne avec « Emporter la session » (audio compris) : appuie sur « Mettre la session en ligne ». Tu le retrouves ensuite dans « Ouvrir un projet ».';
export const LOGIN_CLOUD_NOTICE =
  '⚠️ Pour sauvegarder en ligne, connecte-toi ou crée ton compte Make Music (gratuit) : bouton « Connexion » en haut. Sinon, « Fichier sur cet appareil (.zip) » garde ton projet.';

/** Une séance en ligne du compte (action list_mine de daw-session). */
export interface OnlineSession {
  id: string; link: string | null; name: string; updated_at?: string | null; updated_from?: string | null;
  expires_at?: string | null; days_left?: number | null; unlimited?: boolean; expired?: boolean;
}

/** Ligne d'info sous le nom : « modifiée le 16 oct. · gardée jusqu'au 21 octobre » / « effacée ». */
export function onlineSessionInfo(s: OnlineSession, now = Date.now()): string {
  const parts: string[] = [];
  const t = s.updated_at ? Date.parse(s.updated_at) : NaN;
  if (Number.isFinite(t)) parts.push(`modifiée le ${new Date(t).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' })}${s.updated_from ? ` sur ${s.updated_from}` : ''}`);
  if (s.expired || (s.expires_at && Date.parse(s.expires_at) <= now)) parts.push('plus gardée en ligne');
  else if (s.expires_at) parts.push(`gardée jusqu'au ${new Date(Date.parse(s.expires_at)).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long' })}`);
  else if (s.unlimited) parts.push('gardée sans limite');
  return parts.join(' · ');
}
