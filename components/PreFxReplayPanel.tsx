import React, { useEffect, useRef, useState } from 'react';
import { PreFxOp } from '../types';
import { fmtTime } from '../utils/preFxEdits';
import { PreFxPanelData } from '../hooks/usePreFxReplay';
import { SessionConflict } from '../utils/preFxMerge';

/**
 * Retour sur le PC de l'ingé : résumé des éditions faites ailleurs (tablette,
 * chez l'artiste) et rejouées AVANT les effets, plugins manquants, retour
 * possible à la version d'avant, ou regel.
 */

const KIND_ICON: Record<PreFxOp['kind'], string> = {
  split: 'fa-cut', remove: 'fa-eraser', delete: 'fa-trash', move: 'fa-arrows-alt-h', gain: 'fa-volume-up',
  fade: 'fa-signal', mute: 'fa-volume-mute', unmute: 'fa-volume-up', volume: 'fa-wave-square', add: 'fa-plus',
};
const KIND_TEXT: Record<PreFxOp['kind'], string> = {
  split: 'Coupé', remove: 'Passage enlevé', delete: 'Clip supprimé', move: 'Déplacé', gain: 'Volume du clip',
  fade: 'Fondu', mute: 'Clip coupé (mute)', unmute: 'Clip réactivé', volume: 'Volume avant effets', add: 'Nouvelle prise',
};

interface Props {
  data: PreFxPanelData;
  onClose: () => void;
  onRefreeze: () => void;
  onRevert: (trackId: string) => void;
  onRestore: (trackId: string) => void;
  onRetry: () => void;
  onTakeTheirs?: (c: SessionConflict) => void;
}

const PreFxReplayPanel: React.FC<Props> = ({ data, onClose, onRefreeze, onRevert, onRestore, onRetry, onTakeTheirs }) => {
  const { summary, missing, thawed, reverted, merge } = data;
  const [open, setOpen] = useState<string | null>(summary.tracks.length === 1 ? summary.tracks[0].trackId : null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { okRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[680] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="prefx-title" data-testid="prefx-panel">
      <div className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-3xl border border-cyan-500/30 bg-[#121418] p-5 sm:p-6 shadow-2xl space-y-4">
        <div className="space-y-1">
          <h2 id="prefx-title" className="text-lg font-black text-white">
            {merge ? '🔀 Les deux versions sont fusionnées' : summary.total > 0 ? '🔥 Éditions rejouées avant tes effets' : '⚠️ Plugins manquants sur ce PC'}
          </h2>
          {merge && (
            <p className="text-[12px] leading-snug text-slate-400">
              Ta version est gardée, et les éditions faites ailleurs sur les pistes gelées y sont ajoutées
              {merge.added > 0 ? ` (+ ${merge.added} piste${merge.added > 1 ? 's' : ''} ajoutée${merge.added > 1 ? 's' : ''})` : ''}.
            </p>
          )}
          {summary.total > 0 && (
            <>
              <p className="text-[15px] font-bold text-cyan-300" data-testid="prefx-summary">{summary.line}</p>
              <p className="text-[12px] leading-snug text-slate-400">
                Coupes, passages enlevés, fondus et volumes sont rejoués sur l'audio sec, puis passent dans tes plugins
                (compresseur, reverb…) : pas de queue de reverb orpheline, et un fondu attaque bien la chaîne.
              </p>
            </>
          )}
        </div>

        {summary.tracks.length > 0 && (
          <ul className="space-y-2">
            {summary.tracks.map(t => {
              const isReverted = !!reverted[t.trackId];
              const expanded = open === t.trackId;
              return (
                <li key={t.trackId} className="rounded-2xl border border-white/10 bg-white/[0.03]">
                  <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left" aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : t.trackId)}>
                    <i className={`fas fa-chevron-${expanded ? 'down' : 'right'} text-[10px] text-slate-500`} aria-hidden="true"></i>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold text-white">{t.trackName}</span>
                      <span className="block text-[11px] text-slate-400">{isReverted ? 'Revenue à ta version (éditions mises de côté)' : `${t.count} · ${t.text}`}</span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="space-y-2 px-3 pb-3">
                      <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
                        {t.ops.map((o, i) => (
                          <li key={i} className="flex items-center gap-2 text-[11px] text-slate-300">
                            <i className={`fas ${KIND_ICON[o.kind]} w-4 text-center text-cyan-400/80`} aria-hidden="true"></i>
                            <span className="w-12 shrink-0 font-mono text-slate-500">{fmtTime(o.at)}</span>
                            <span className="min-w-0 flex-1 truncate">{KIND_TEXT[o.kind]}{o.detail ? ` · ${o.detail}` : ''}</span>
                            {o.by && <span className="shrink-0 text-[10px] text-slate-500">{o.by}</span>}
                          </li>
                        ))}
                      </ul>
                      {isReverted ? (
                        <button type="button" className="h-9 w-full rounded-xl bg-cyan-500/15 text-[12px] font-bold text-cyan-200" onClick={() => onRestore(t.trackId)}>
                          Rétablir ses éditions
                        </button>
                      ) : (
                        <button type="button" className="h-9 w-full rounded-xl bg-white/5 text-[12px] font-bold text-slate-200" onClick={() => onRevert(t.trackId)}
                          title="Remet les clips comme au moment du gel. Rien n'est perdu : « Rétablir » ou Ctrl+Z les ramène.">
                          Revenir à ma version (avant ces éditions)
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {merge && merge.conflicts.length > 0 && (
          <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3" data-testid="prefx-conflicts">
            <p className="text-[12px] font-bold text-amber-200">
              {merge.conflicts.length} passage{merge.conflicts.length > 1 ? 's' : ''} modifié{merge.conflicts.length > 1 ? 's' : ''} des deux côtés : ta version est gardée.
            </p>
            <ul className="space-y-2">
              {merge.conflicts.map(c => {
                const key = `${c.trackId}:${c.baseClipId}`;
                const done = merge.resolved.includes(key);
                return (
                  <li key={key} className="rounded-xl bg-black/20 p-2 text-[11px] text-amber-50/90">
                    <p><b>{c.trackName}</b> · {c.name} ({fmtTime(c.at)} → {fmtTime(c.end)})</p>
                    <p className="text-slate-400">Toi : {c.mine} · L'autre version : {c.theirs}</p>
                    {onTakeTheirs && (
                      <button type="button" disabled={done} onClick={() => onTakeTheirs(c)}
                        className="mt-1 h-8 w-full rounded-lg bg-amber-500/20 text-[11px] font-bold text-amber-100 disabled:opacity-50">
                        {done ? "Version de l'autre prise (Ctrl+Z pour revenir)" : "Prendre plutôt la version de l'autre"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {missing.length > 0 && (
          <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3" data-testid="prefx-missing">
            <p className="text-[12px] font-bold text-amber-200">Ces pistes restent gelées : tu entends le rendu fait au studio.</p>
            <ul className="space-y-1">
              {missing.map(m => (
                <li key={m.trackId} className="text-[11px] text-amber-100/90">
                  <b>{m.trackName}</b> : plugin absent de ce PC ({m.plugins.join(', ')})
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-slate-400">Installe le plugin (ou ouvre la session sur le PC du studio), puis :</p>
            <button type="button" className="h-9 w-full rounded-xl bg-amber-500/20 text-[12px] font-bold text-amber-100" onClick={onRetry}>
              Réessayer
            </button>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <button ref={okRef} type="button" className="h-11 flex-1 rounded-xl bg-cyan-500 text-[13px] font-black text-black" onClick={onClose}>
            C'est noté
          </button>
          {thawed.length > 0 && (
            <button type="button" className="h-11 flex-1 rounded-xl bg-white/10 text-[12px] font-bold text-white" onClick={onRefreeze}
              title="Reprend le son rendu au studio (avant les éditions rejouées). Tu pourras dégeler plus tard.">
              Annuler le dégel
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PreFxReplayPanel;
