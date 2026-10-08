import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Marker } from '../types';
import { barsBeats, markerNumbers, minSec } from '../utils/memoryLocations';

const COLORS = ['#00f2ff', '#f97316', '#22c55e', '#a855f7', '#ef4444', '#eab308', '#ec4899', '#3b82f6'];

interface Props {
  open: boolean;
  onClose: () => void;
  markers: Marker[];
  bpm: number;
  onGoTo: (time: number) => void;
  onAdd: () => void;
  onUpdate: (m: Marker) => void;
  onDelete: (id: string) => void;
}

/**
 * Liste des repères (Pro Tools : Memory Locations, Ctrl+5). Fenêtre flottante :
 * la lecture continue de répondre à la barre d'espace pendant qu'elle est ouverte.
 */
const MemoryLocations: React.FC<Props> = ({ open, onClose, markers, bpm, onGoTo, onAdd, onUpdate, onDelete }) => {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const nums = useMemo(() => markerNumbers(markers), [markers]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing && panelRef.current?.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, editing, onClose]);

  if (!open) return null;

  const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const list = [...markers]
    .sort((a, b) => (nums.get(a.id) || 0) - (nums.get(b.id) || 0))
    .filter(m => !query.trim() || norm(`${nums.get(m.id)} ${m.name}`).includes(norm(query.trim())));

  const commitName = (m: Marker) => {
    const name = draft.trim();
    if (name && name !== m.name) onUpdate({ ...m, name });
    setEditing(null);
  };

  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label="Repères (Memory Locations)"
      data-testid="memory-locations"
      data-nova-window=""
      className="fixed right-3 top-20 z-[640] flex max-h-[70vh] w-[min(420px,calc(100vw-24px))] flex-col rounded-2xl border border-white/10 bg-nv-surface/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
        <i className="fas fa-map-marker-alt text-cyan-400 text-[12px]" />
        <h2 className="mr-auto text-[13px] font-black text-white" title="Pro Tools : Memory Locations (Ctrl+5)">Repères</h2>
        <button type="button" onClick={onAdd} title="Nouveau repère à la tête de lecture (Pro Tools : Entrée du pavé ; ici aussi K)"
          className="nova-hit-tactile rounded-lg bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-bold text-cyan-300 hover:bg-cyan-500/25">
          <i className="fas fa-plus mr-1 text-[9px]" />Nouveau
        </button>
        <button type="button" onClick={onClose} aria-label="Fermer les repères" className="nova-hit-tactile h-8 w-8 rounded-lg bg-white/5 text-slate-300 hover:text-white">✕</button>
      </div>
      <div className="px-4 pt-3">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Chercher un repère (nom ou numéro)"
          aria-label="Chercher un repère"
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[12px] text-white outline-none focus:border-cyan-500/50" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 custom-scroll">
        {markers.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-slate-400">
            Aucun repère pour l’instant. Appuie sur <kbd className="rounded border border-white/15 px-1">K</kbd> ou sur
            <kbd className="mx-1 rounded border border-white/15 px-1">Entrée</kbd>du pavé pendant la lecture pour marquer un couplet, un refrain…
          </p>
        )}
        {markers.length > 0 && list.length === 0 && <p className="px-3 py-4 text-center text-[12px] text-slate-400">Aucun repère ne correspond à « {query} ».</p>}
        <ul className="space-y-1">
          {list.map(m => (
            <li key={m.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <span className="w-7 shrink-0 text-right font-mono text-[11px] font-bold text-slate-400" title={`Rappel au pavé : . ${nums.get(m.id)} .`}>{nums.get(m.id)}</span>
              <button type="button" title="Changer la couleur" aria-label={`Couleur du repère ${m.name}`}
                onClick={() => onUpdate({ ...m, color: COLORS[(COLORS.indexOf(m.color) + 1) % COLORS.length] })}
                className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-white/20" style={{ backgroundColor: m.color }} />
              {editing === m.id ? (
                <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} aria-label="Nom du repère"
                  onBlur={() => commitName(m)}
                  onKeyDown={e => { if (e.key === 'Enter') commitName(m); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}
                  className="min-w-0 flex-1 rounded border border-cyan-500/50 bg-black/60 px-1.5 py-0.5 text-[12px] text-white outline-none" />
              ) : (
                <button type="button" onClick={() => onGoTo(m.time)} onDoubleClick={() => { setEditing(m.id); setDraft(m.name); }}
                  title="Clic : aller au repère · double-clic : renommer"
                  className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-white">
                  {m.name}{m.type === 'REGION' && <span className="ml-1 text-[10px] font-normal text-slate-500">(partie)</span>}
                </button>
              )}
              <span className="shrink-0 font-mono text-[10px] text-slate-400" title={minSec(m.time)}>{barsBeats(m.time, bpm)}</span>
              <button type="button" onClick={() => { setEditing(m.id); setDraft(m.name); }} aria-label={`Renommer ${m.name}`} title="Renommer"
                className="nova-hit-tactile h-7 w-7 shrink-0 rounded text-slate-500 opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 hover:text-white"><i className="fas fa-pen text-[9px]" /></button>
              <button type="button" onClick={() => onDelete(m.id)} aria-label={`Supprimer ${m.name}`} title="Supprimer le repère (Ctrl+Z pour revenir)"
                className="nova-hit-tactile h-7 w-7 shrink-0 rounded text-slate-500 opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 hover:text-red-400"><i className="fas fa-trash text-[9px]" /></button>
            </li>
          ))}
        </ul>
      </div>
      <p className="border-t border-white/5 px-4 py-2 text-[10px] text-slate-500">Pavé numérique : « . 3 . » va au repère 3 · Entrée du pavé en crée un.</p>
    </div>
  );
};

export default MemoryLocations;
