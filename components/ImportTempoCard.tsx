import React from 'react';
import { ImportTempoProposal } from '../utils/importTempo';

/**
 * Beat importé du PC : « 140 BPM détectés (projet à 120) » → régler le projet en
 * un geste, avec ou sans la tonalité, ou garder le tempo actuel. Rien d'imposé.
 */
const ImportTempoCard: React.FC<{
  proposal: ImportTempoProposal | null;
  detecting?: string | null;
  keyName: (rootKey: number, scale: string) => string;
  onAccept: (withKey: boolean) => void;
  onDismiss: () => void;
}> = ({ proposal, detecting, keyName, onAccept, onDismiss }) => {
  if (!proposal) {
    if (!detecting) return null;
    return (
      <div role="status" data-testid="import-tempo-detecting"
        className="fixed z-[560] left-1/2 -translate-x-1/2 bottom-24 rounded-full border border-white/10 bg-nv-surface/95 backdrop-blur shadow-xl px-4 h-9 flex items-center text-[12px] font-bold text-slate-300">
        🥁 J'écoute « {detecting} » pour trouver son tempo…
      </div>
    );
  }
  const k = proposal.key ? keyName(proposal.key.rootKey, proposal.key.scale) : null;
  return (
    <div data-testid="import-tempo-card" role="dialog" aria-label="Tempo du beat importé"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDismiss(); } }}
      className="fixed z-[560] left-1/2 -translate-x-1/2 bottom-24 w-[min(520px,calc(100vw-24px))] rounded-2xl border border-amber-300/40 bg-nv-surface/95 backdrop-blur shadow-2xl p-4">
      <p className="text-[14px] font-black text-white">
        🥁 « {proposal.name} »{proposal.bpm != null ? <> : <span data-testid="import-tempo-bpm" className="text-amber-300">{proposal.bpm} BPM</span></> : null}
        {k && <> · <span data-testid="import-tempo-key" className="text-amber-200">{k}</span></>}
      </p>
      <p className="text-[11.5px] text-slate-400 mt-0.5">
        {proposal.bpm != null
          ? <>Détecté à l'écoute. Ton projet est à {proposal.projectBpm} BPM : la grille, le métronome et la boucle suivront le beat si tu règles le tempo (le son du beat ne bouge pas).</>
          : <>Le tempo du projet est déjà le bon. Tonalité détectée à l'écoute : l'Auto-Tune peut s'y caler.</>}
      </p>
      <div className="mt-3 flex flex-col sm:flex-row gap-2">
        {proposal.bpm != null && (
          <button type="button" data-testid="import-tempo-apply" onClick={() => onAccept(false)}
            className="h-11 sm:flex-1 rounded-xl bg-amber-400 text-black text-[13px] font-black">Régler le projet à {proposal.bpm} BPM</button>
        )}
        {k && (
          <button type="button" data-testid="import-tempo-apply-key" onClick={() => onAccept(true)}
            className={`h-11 sm:flex-1 rounded-xl text-[13px] font-black ${proposal.bpm == null ? 'bg-amber-400 text-black' : 'border border-amber-300/40 text-amber-100 hover:bg-amber-300/10'}`}>
            {proposal.bpm != null ? `${proposal.bpm} BPM + ${k}` : `Régler la tonalité : ${k}`}
          </button>
        )}
        <button type="button" data-testid="import-tempo-dismiss" onClick={onDismiss}
          className="h-11 sm:w-auto px-4 rounded-xl border border-white/15 text-white text-[13px] font-bold hover:bg-white/10">
          {proposal.bpm != null ? `Garder ${proposal.projectBpm} BPM` : 'Plus tard'}
        </button>
      </div>
    </div>
  );
};

export default ImportTempoCard;
