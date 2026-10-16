import { useEffect, useState } from 'react';
import { catalogSupabase } from '../services/supabase';
import type { MakeMusicAccount } from '../utils/accountDisplay';

/**
 * Compte Make Music connecté (catalogSupabase : paiements, collaboration, séances en ligne,
 * appli Windows), suivi en direct : connexion par n'importe quelle fenêtre, session reprise
 * au chargement, déconnexion. null sans compte.
 */
export function useMakeMusicAccount(): MakeMusicAccount | null {
  const [acc, setAcc] = useState<MakeMusicAccount | null>(null);
  useEffect(() => {
    let live = true;
    const set = (u: { id: string; email?: string | null } | null | undefined) => {
      if (!live) return;
      setAcc(prev => {
        if (!u) return null;
        if (prev && prev.id === u.id && prev.email === (u.email || '')) return prev;
        return { id: u.id, email: u.email || '' };
      });
    };
    catalogSupabase.auth.getSession().then(({ data }) => set(data?.session?.user)).catch(() => {});
    const { data } = catalogSupabase.auth.onAuthStateChange((_event: string, session: any) => set(session?.user));
    return () => { live = false; data?.subscription?.unsubscribe(); };
  }, []);
  return acc;
}
