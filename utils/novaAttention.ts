/**
 * Comment Nova attire l'attention (audit G1 / G27) : elle ne s'ouvre JAMAIS
 * seule sur la zone de travail. Un conseil (bilan de prise, étape de session)
 * allume une pastille « 1 conseil » sur son bouton ; une annonce courte
 * (« Mix appliqué ») passe en bandeau. Rien ne s'affiche pendant une prise :
 * le message attend dans le fil de Nova.
 */
export type NovaAttention = 'none' | 'pill' | 'toast';

export function novaAttention(kind: 'tip' | 'notice', o: { isOpen: boolean; isRecording: boolean; isMobile: boolean }): NovaAttention {
  if (o.isOpen) return 'none';
  if (kind === 'tip') return o.isMobile ? (o.isRecording ? 'none' : 'toast') : 'pill';
  return o.isRecording ? 'none' : 'toast';
}

/** Libellé de la pastille : « 1 conseil », « 3 conseils ». */
export const tipPillLabel = (n: number) => `${n} conseil${n > 1 ? 's' : ''}`;
