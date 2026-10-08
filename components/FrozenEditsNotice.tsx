import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Track } from '../types';
import { isTrackFrozen } from '../utils/freeze';
import { countPreFxEdits, preFxOps } from '../utils/preFxEdits';

/**
 * Tablette / chez l'artiste (sans les plugins de l'ingé) : les pistes gelées
 * au studio se lisent depuis leur rendu ; ce qu'on y édite est gardé comme
 * opérations sur l'audio sec, rejouées AVANT les effets chez l'ingé.
 *
 * Sous la barre d'outils, au-dessus des pistes ; il se replie après quelques
 * secondes en une pastille rangée à droite de la ligne des outils / de la règle
 * (jamais sur la barre d'édition du clip ni sur les boutons du bas).
 */
const FrozenEditsNotice: React.FC<{ tracks: Track[]; bridgeConnected: boolean; projectId: string; compact?: boolean }> = ({ tracks, bridgeConnected, projectId, compact }) => {
  const key = `nova_frozen_notice_${projectId}`;
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } });
  const [collapsed, setCollapsed] = useState(false);
  const [more, setMore] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const frozen = useMemo(() => tracks.filter(t => isTrackFrozen(t) && t.frozenAuto), [tracks]);
  const edits = useMemo(() => tracks.reduce((n, t) => n + (t.freezeBase ? countPreFxEdits(preFxOps(t)) : 0), 0), [tracks]);
  const show = !bridgeConnected && frozen.length > 0 && !hidden;
  useEffect(() => {
    if (!show || more || collapsed) return;
    const t = window.setTimeout(() => setCollapsed(true), 9000);
    // Le premier geste ailleurs (toucher un clip, un outil) le replie : il ne gêne jamais l'édition.
    const onDown = (e: PointerEvent) => { if (!cardRef.current?.contains(e.target as Node)) setCollapsed(true); };
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.clearTimeout(t); window.removeEventListener('pointerdown', onDown, true); };
  }, [show, more, collapsed]);
  if (!show) return null;
  const plural = frozen.length > 1;
  const names = frozen.map(t => t.name).slice(0, 3).join(', ') + (frozen.length > 3 ? '…' : '');
  const editsText = edits > 0 ? `${edits} édition${edits > 1 ? 's' : ''} gardée${edits > 1 ? 's' : ''}` : null;
  const pos: React.CSSProperties = { top: compact ? 150 : 112 };
  const chipPos: React.CSSProperties = { top: compact ? 116 : 117, right: compact ? 8 : 12 };

  if (collapsed) {
    return (
      <button type="button" data-testid="frozen-notice" onClick={() => setCollapsed(false)} style={chipPos}
        aria-label={`Piste${plural ? 's' : ''} gelée${plural ? 's' : ''} par l'ingé : tes éditions seront rejouées avant ses effets. Afficher les détails.`}
        className="fixed z-[95] flex h-8 max-w-[min(340px,calc(100vw-150px))] items-center gap-2 rounded-full border border-cyan-400/40 bg-nv-surface/95 px-3 text-[11px] font-bold text-cyan-100 shadow-xl backdrop-blur">
        <i className="fas fa-snowflake text-cyan-300" aria-hidden="true"></i>
        <span className="truncate">Gelée{plural ? 's' : ''} chez l'ingé · {editsText || 'tes éditions passent avant ses effets'}</span>
      </button>
    );
  }
  return (
    <div ref={cardRef} role="status" data-testid="frozen-notice" style={pos}
      className="fixed left-1/2 z-[95] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl border border-cyan-400/30 bg-nv-surface/95 px-3 py-2 shadow-xl backdrop-blur">
      <div className="flex items-start gap-2">
        <i className="fas fa-snowflake mt-0.5 text-[13px] text-cyan-300" aria-hidden="true"></i>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold leading-snug text-white">
            Piste{plural ? 's' : ''} gelée{plural ? 's' : ''} : tes éditions seront rejouées avant les effets chez l'ingé.
          </p>
          <p className="text-[11px] leading-snug text-slate-400">
            {editsText || 'Tu peux couper, enlever, faire des fondus et des volumes'} · {names}
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
        <button type="button" className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-slate-400" aria-label="Réduire ce message"
          onClick={() => { setMore(false); setCollapsed(true); }}>
          <i className="fas fa-chevron-down" aria-hidden="true"></i>
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
