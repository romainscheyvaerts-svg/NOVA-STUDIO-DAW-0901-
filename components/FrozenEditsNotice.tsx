import React, { useMemo, useState } from 'react';
import { Track } from '../types';
import { isTrackFrozen } from '../utils/freeze';
import { countPreFxEdits, preFxOps } from '../utils/preFxEdits';

/**
 * Tablette / chez l'artiste (sans les plugins de l'ingé) : les pistes gelées
 * au studio se lisent depuis leur rendu ; ce qu'on y édite est gardé comme
 * opérations sur l'audio sec, rejouées AVANT les effets chez l'ingé.
 */
const FrozenEditsNotice: React.FC<{ tracks: Track[]; bridgeConnected: boolean; projectId: string; compact?: boolean }> = ({ tracks, bridgeConnected, projectId, compact }) => {
  const key = `nova_frozen_notice_${projectId}`;
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } });
  const [more, setMore] = useState(false);
  const frozen = useMemo(() => tracks.filter(t => isTrackFrozen(t) && t.frozenAuto), [tracks]);
  const edits = useMemo(() => tracks.reduce((n, t) => n + (t.freezeBase ? countPreFxEdits(preFxOps(t)) : 0), 0), [tracks]);
  if (bridgeConnected || frozen.length === 0 || hidden) return null;
  const names = frozen.map(t => t.name).slice(0, 3).join(', ') + (frozen.length > 3 ? '…' : '');
  return (
    <div role="status" data-testid="frozen-notice"
      className={`pointer-events-auto fixed left-1/2 z-[95] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl border border-cyan-400/30 bg-[#0d1117]/95 px-3 py-2 shadow-xl backdrop-blur ${compact ? 'top-[52px]' : 'top-[60px]'}`}>
      <div className="flex items-start gap-2">
        <i className="fas fa-snowflake mt-0.5 text-[13px] text-cyan-300" aria-hidden="true"></i>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold leading-snug text-white">
            Piste{frozen.length > 1 ? 's' : ''} gelée{frozen.length > 1 ? 's' : ''} : tes éditions seront rejouées avant les effets chez l'ingé.
          </p>
          <p className="text-[11px] leading-snug text-slate-400">
            {edits > 0 ? `${edits} édition${edits > 1 ? 's' : ''} gardée${edits > 1 ? 's' : ''}` : 'Tu peux couper, enlever, faire des fondus et des volumes'} · {names}
          </p>
          {more && (
            <p className="mt-1 text-[11px] leading-snug text-slate-300">
              Ici tu entends le son rendu au studio, avec ses plugins. Coupes, passages enlevés, fondus, volumes de clip et
              « volume avant effets » sont gardés sur la voix d'origine (sans effet) : sur le PC de l'ingé, ils passent avant
              son compresseur et sa reverb, comme s'ils avaient été faits là-bas. Rien n'est perdu, tout s'annule.
            </p>
          )}
        </div>
        <button type="button" className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold text-cyan-300" onClick={() => setMore(m => !m)} aria-expanded={more}>
          {more ? 'Moins' : 'Comment ?'}
        </button>
        <button type="button" className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-slate-400" aria-label="Masquer ce message"
          onClick={() => { setHidden(true); try { sessionStorage.setItem(key, '1'); } catch { /* */ } }}>
          <i className="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  );
};

export default FrozenEditsNotice;
