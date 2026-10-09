import React from 'react';
import type { Track } from '../types';
import { runEditCommand } from '../utils/editCommands';
import { countLabel, soloMuteStatus } from '../utils/soloMute';

/**
 * Indicateurs globaux de solo et de muet (Pro Tools 2023.6 : « Solo / Mute
 * indicators ») : combien de pistes sont en solo ou muettes, un appui efface
 * tout. Invisibles quand rien n'est en solo ni muet. Au doigt (tablette, où
 * Alt+clic n'existe pas), c'est le chemin pour tout réentendre d'un geste.
 */
const SoloMuteIndicators: React.FC<{ tracks: Track[]; vertical?: boolean; className?: string }> = ({ tracks, vertical, className = '' }) => {
  const st = soloMuteStatus(tracks);
  if (!st.soloed.length && !st.muted.length) return null;
  const names = (l: Track[]) => l.slice(0, 6).map(t => t.name).join(', ') + (l.length > 6 ? '…' : '');
  const chip = 'nova-hit-tactile inline-flex items-center gap-1 h-6 [@media(pointer:coarse)]:h-8 px-2 rounded-md text-[10px] font-black border transition-colors whitespace-nowrap';
  return (
    <div className={`flex ${vertical ? 'flex-col items-stretch' : 'items-center'} gap-1 ${className}`} data-testid="solo-mute-indicators" role="group" aria-label="Solos et mutes en cours">
      {st.soloed.length > 0 && (
        <button type="button" data-testid="clear-solos" onClick={(e) => { e.stopPropagation(); runEditCommand('soloAll', { on: false }); }}
          title={`En solo : ${names(st.soloed)}. Appuie pour effacer tous les solos (Alt+Maj+S, ou Alt+clic sur un S).`}
          aria-label={`Effacer les solos : ${countLabel(st.soloed.length, 'piste', 'pistes')} en solo`}
          className={`${chip} bg-amber-400 text-black border-amber-300 hover:bg-amber-300`}>
          S<span className="tabular-nums">{st.soloed.length}</span><i className="fas fa-times text-[8px] opacity-70" aria-hidden="true" />
        </button>
      )}
      {st.muted.length > 0 && (
        <button type="button" data-testid="clear-mutes" onClick={(e) => { e.stopPropagation(); runEditCommand('muteAll', { on: false }); }}
          title={`Muettes : ${names(st.muted)}. Appuie pour rendre le son à toutes les pistes (Alt+Maj+M, ou Alt+clic sur un M).`}
          aria-label={`Effacer les mutes : ${countLabel(st.muted.length, 'piste muette', 'pistes muettes')}`}
          className={`${chip} bg-red-600 text-white border-red-500 hover:bg-red-500`}>
          M<span className="tabular-nums">{st.muted.length}</span><i className="fas fa-times text-[8px] opacity-70" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

export default SoloMuteIndicators;
