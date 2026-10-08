import React, { useEffect } from 'react';
import type { FrozenStaleNotice as Notice } from '../hooks/useFrozenRefresh';

/**
 * Piste gelée dont un clip a changé de son (justesse, Melodyne, alignement…)
 * sans regel possible ici (effets VST sans le pont) : le rendu joue encore
 * l'ancien son. Un bouton pour dégeler ; elle part toute seule.
 */
const FrozenStaleNotice: React.FC<{ notice: Notice | null; onClose: () => void; onUnfreeze: (trackId: string) => void }> = ({ notice, onClose, onUnfreeze }) => {
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(onClose, 16000);
    return () => window.clearTimeout(t);
  }, [notice, onClose]);
  if (!notice) return null;
  return (
    <div key={notice.id} role="status" aria-live="polite" data-testid="frozen-stale-toast"
      className="fixed bottom-40 left-1/2 z-[719] flex w-[92vw] sm:w-auto sm:max-w-[600px] -translate-x-1/2 items-center gap-3 rounded-2xl border border-cyan-400/40 bg-[#0f1a20]/95 px-4 py-3 text-[12.5px] text-cyan-50 shadow-2xl">
      <span className="min-w-0 leading-snug">{notice.text}</span>
      <button type="button" data-testid="frozen-stale-unfreeze" onClick={() => { onUnfreeze(notice.trackId); onClose(); }}
        className="shrink-0 rounded-lg bg-cyan-500/20 px-3 py-2 text-[12px] font-black text-cyan-200 hover:bg-cyan-500/30">Dégeler</button>
      <button type="button" aria-label="Fermer" onClick={onClose}
        className="shrink-0 rounded-lg px-2 py-2 text-[12px] text-cyan-200/70 hover:text-cyan-100">
        <i className="fas fa-times" aria-hidden="true"></i>
      </button>
    </div>
  );
};

export default FrozenStaleNotice;
