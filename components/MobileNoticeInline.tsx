import React, { useEffect, useState } from 'react';

/**
 * Téléphone : les messages importants du studio (micro bloqué, aucun micro, sauvegarde ou
 * chargement impossible, « connecte-toi d'abord »…) posés DANS la page Morceau, au-dessus des
 * pistes. Avant, au téléphone, ces messages n'allaient que dans le fil de Nova (onglet fermé) :
 * on touchait REC, rien ne se passait, et rien ne disait pourquoi.
 *
 * Pas de carte flottante (règle du téléphone) : une bande dans le flux, qui se ferme d'un toucher
 * et s'efface toute seule. Les annonces de routine (« Mix appliqué ») restent dans le fil de Nova.
 */

/** Le message demande l'attention de l'artiste (erreur, blocage, chose à faire avant). */
export function isImportantNotice(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (/^(❌|⚠️|⚠|🎤|🔒|⛔|🚫|⏺️|🎙️❌)/u.test(t)) return true;
  return /(impossible|bloqué|introuvable|refusé|échoué|aucun micro|d’abord|d'abord|connecte-toi|n’a pas pu|n'a pas pu)/i.test(t);
}

export interface MobileNoticeInlineProps {
  notice: { text: string; id: number } | null;
  /** Pendant une prise ou un décompte : rien ne s'affiche (le message reste dans le fil de Nova). */
  blocked?: boolean;
  /** Durée d'affichage (ms). */
  ttl?: number;
}

const MobileNoticeInline: React.FC<MobileNoticeInlineProps> = ({ notice, blocked, ttl = 9000 }) => {
  const [shown, setShown] = useState<{ text: string; id: number } | null>(null);
  useEffect(() => {
    if (!notice || blocked || !isImportantNotice(notice.text)) return;
    setShown(notice);
    const id = window.setTimeout(() => setShown(s => (s && s.id === notice.id ? null : s)), ttl);
    return () => window.clearTimeout(id);
  }, [notice, blocked, ttl]);
  if (!shown || blocked) return null;
  return (
    <div role="alert" data-testid="mobile-notice"
      className="shrink-0 mx-2 my-1.5 flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2">
      <p className="flex-1 min-w-0 text-[13px] leading-snug font-semibold text-nv-ink">{shown.text}</p>
      <button type="button" onClick={() => setShown(null)} aria-label="Fermer le message" title="Fermer"
        className="-mr-1 -my-1 shrink-0 w-10 h-10 rounded-lg text-nv-muted hover:text-nv-ink flex items-center justify-center">
        <i className="fas fa-times" aria-hidden="true"></i>
      </button>
    </div>
  );
};

export default MobileNoticeInline;
