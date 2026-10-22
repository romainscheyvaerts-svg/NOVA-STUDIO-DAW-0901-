import React from 'react';

/**
 * Fenêtre dont le code se charge à la demande (React.lazy) : un voile s'affiche TOUT DE SUITE,
 * avec « Chargement… » et une croix. Échap (App.tsx : la fenêtre du dessus qui a un bouton
 * « Fermer »), la croix ou un clic à côté annulent l'ouverture.
 *
 * Avant, rien ne s'affichait tant que le code n'était pas arrivé (fallback vide) : sur un PC
 * chargé, la fenêtre surgissait une seconde plus tard, APRÈS les Échap de l'utilisateur, et
 * restait par-dessus le studio (voile qui prend les clics).
 */
const WindowLoading: React.FC<{ label: string; closeLabel: string; onClose: () => void }> = ({ label, closeLabel, onClose }) => (
  <div className="fixed inset-0 z-[710] bg-black/70 flex items-center justify-center p-3" onClick={onClose}
    role="dialog" aria-modal="true" aria-label={label} aria-busy="true" data-testid="window-loading">
    <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-nv-surface px-4 py-3 text-[12px] font-bold text-slate-300 shadow-2xl"
      onClick={e => e.stopPropagation()}>
      <i className="fas fa-circle-notch fa-spin text-cyan-300" aria-hidden="true" />
      <span role="status">{label} : chargement…</span>
      <button type="button" onClick={onClose} aria-label={closeLabel} title="Annuler (Échap)"
        className="nova-hit w-8 h-8 rounded-full hover:bg-white/10 text-slate-400 hover:text-white">
        <i className="fas fa-times" aria-hidden="true" />
      </button>
    </div>
  </div>
);

export default WindowLoading;
