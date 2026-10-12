import React, { useEffect, useMemo, useState } from 'react';
import type { Track } from '../types';
import { batchBlocker, type BatchKind } from '../utils/batchRender';
import { runEditCommand } from '../utils/editCommands';

/**
 * Commit / gel de plusieurs pistes d'un coup (Pro Tools : sélection de pistes,
 * puis Commit… / Freeze). On coche les pistes (celles de la sélection le sont
 * d'office), puis un bouton : les rendus se font l'un après l'autre, avec la
 * progression dans le bandeau. Au doigt : lignes de 48 px.
 */
interface Props {
  open: boolean;
  tracks: Track[];
  preselected: string[];
  onClose: () => void;
}

const KINDS: { kind: BatchKind; label: string; icon: string; title: string }[] = [
  { kind: 'freeze', label: 'Geler', icon: 'fa-snowflake', title: 'Pro Tools « Freeze » : les effets sont rendus, la piste ne coûte plus de processeur ; Dégeler pour retoucher' },
  { kind: 'unfreeze', label: 'Dégeler', icon: 'fa-fire', title: 'Les effets rejouent en direct (réglages modifiables)' },
  { kind: 'commit', label: 'Commit', icon: 'fa-check-double', title: 'Pro Tools « Commit » : chaque piste est remplacée par son rendu avec effets ; l’originale est gardée inactive et masquée' },
];

const BatchRenderDialog: React.FC<Props> = ({ open, tracks, preselected, onClose }) => {
  const candidates = useMemo(() => tracks.filter(t => t.id !== 'master' && !t.isVca && !t.folder && !t.isHidden), [tracks]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => { if (open) setChecked(new Set(preselected.filter(id => candidates.some(t => t.id === id)))); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;

  const toggle = (id: string) => setChecked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...checked];
  const count = (k: BatchKind) => ids.filter(id => { const t = tracks.find(x => x.id === id); return t && !batchBlocker(t, k); }).length;
  const run = (kind: BatchKind) => { runEditCommand('batchRender', { kind, trackIds: ids }); onClose(); };
  const btn = 'min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] px-3 rounded-xl text-[13px] font-bold transition-colors disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Commit / geler plusieurs pistes" data-testid="batch-render-dialog" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[90vh] flex flex-col gap-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-black">Commit / geler plusieurs pistes</h2>
            <p className="text-[12px] text-nv-muted">Coche les pistes, puis choisis. Les rendus se font l’un après l’autre ; Ctrl+Z annule chacun.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>
        <div className="flex items-center justify-between text-[11px] text-nv-muted">
          <span>{ids.length} piste{ids.length > 1 ? 's' : ''} cochée{ids.length > 1 ? 's' : ''}</span>
          <span className="flex gap-2">
            <button type="button" className="underline hover:text-nv-ink" onClick={() => setChecked(new Set(candidates.filter(t => (t.clips || []).length).map(t => t.id)))}>Toutes</button>
            <button type="button" className="underline hover:text-nv-ink" onClick={() => setChecked(new Set())}>Aucune</button>
          </span>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-nv-line divide-y divide-nv-line" role="list">
          {candidates.map(t => (
            <li key={t.id}>
              <label className="flex min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] cursor-pointer items-center gap-3 px-3 text-[13px] hover:bg-nv-accent/5" data-testid={`batch-row-${t.id}`}>
                <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} className="h-4 w-4 accent-cyan-500" aria-label={t.name} />
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
                <span className="flex-1 truncate font-semibold">{t.name}</span>
                <span className="text-[10px] text-nv-muted">{t.isFrozen ? '❄️ gelée' : `${(t.plugins || []).filter(p => p.isEnabled && !p.isInactive).length} effet${(t.plugins || []).length > 1 ? 's' : ''}`}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-3 gap-2">
          {KINDS.map(k => {
            const n = count(k.kind);
            return (
              <button key={k.kind} type="button" disabled={!n} onClick={() => run(k.kind)} title={k.title} data-testid={`batch-${k.kind}`}
                className={`${btn} ${k.kind === 'commit' ? 'bg-cyan-500 text-black hover:bg-cyan-400' : 'border border-nv-line hover:bg-nv-accent/10'}`}>
                <i className={`fas ${k.icon} mr-1.5`} />{k.label}{n ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default BatchRenderDialog;
