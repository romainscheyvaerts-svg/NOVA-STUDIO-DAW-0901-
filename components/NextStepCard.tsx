import React from 'react';

export type NextStepAction = 'buy_beat' | 'pro_mix' | 'studio' | 'share';

const LABELS: Record<NextStepAction, { emoji: string; label: string }> = {
  buy_beat: { emoji: '🛒', label: "Acheter l'instru" },
  pro_mix: { emoji: '🎚️', label: 'Faire mixer par un pro' },
  studio: { emoji: '🎙️', label: 'Enregistrer au studio' },
  share: { emoji: '📲', label: 'Partager un extrait' },
};

interface NextStepCardProps {
  open: boolean;
  /** Ce qui vient de se passer (bonne prise, export) : change la phrase d'accroche. */
  trigger: 'take' | 'export';
  actions: NextStepAction[];
  beatTitle?: string | null;
  isMobile?: boolean;
  /** Ordinateur : navigateur latéral ouvert (la carte se place à sa droite). */
  besideSidebar?: boolean;
  onAction: (a: NextStepAction) => void;
  onClose: () => void;
}

/**
 * Carte « Et maintenant ? » après la première bonne prise ou un export.
 * Pas une fenêtre bloquante : le studio reste utilisable, elle se ferme d'un
 * tap et ne recouvre ni REC ni le transport (en bas, au-dessus des boutons ;
 * sur ordinateur à droite, au-dessus du bouton Nova : Nova ne s'ouvre plus
 * seule, la carte ne couvre plus les en-têtes de pistes).
 */
const NextStepCard: React.FC<NextStepCardProps> = ({ open, trigger, actions, beatTitle, isMobile, besideSidebar, onAction, onClose }) => {
  if (!open || actions.length === 0) return null;
  const sub = trigger === 'export'
    ? 'Ton fichier est prêt. Pour aller plus loin :'
    : beatTitle ? `Ta voix sur « ${beatTitle} » est posée. Pour aller plus loin :` : 'Ta voix est posée. Pour aller plus loin :';
  return (
    <div
      role="region"
      aria-label="Et maintenant ?"
      className={`fixed z-[160] ${isMobile
        ? 'inset-x-3 bottom-[calc(8.75rem+env(safe-area-inset-bottom))]'
        : 'right-6 bottom-[13.5rem] w-[340px]'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
    >
      <div className="rounded-2xl border border-cyan-400/30 bg-nv-surface/95 backdrop-blur-xl shadow-2xl p-3">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-black text-white leading-tight">Ça sonne bien ! Et maintenant ?</p>
            <p className="mt-0.5 text-[12px] text-slate-300 leading-snug">{sub}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer"
            className="shrink-0 w-10 h-10 -mt-1 -mr-1 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className={`mt-2 grid gap-2 ${actions.length >= 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {actions.map((a, i) => (
            <button
              key={a}
              type="button"
              onClick={() => onAction(a)}
              className={`min-h-10 px-3 py-2 rounded-xl text-[12px] font-black leading-tight text-left flex items-center gap-2 transition-all active:scale-[0.98] ${
                i === 0 ? 'bg-cyan-500 text-black hover:bg-cyan-400' : 'bg-white/10 text-white hover:bg-white/15'
              } ${actions.length === 3 && i === 0 ? 'col-span-2' : ''}`}
            >
              <span className="text-base leading-none">{LABELS[a].emoji}</span>
              <span>{LABELS[a].label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default NextStepCard;
