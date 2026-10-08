import React, { useState } from 'react';
import { applyLayout, listLayouts, renameLayout, resetLayout, saveLayout, useLayoutsVersion, layoutsStore, type WindowLayout } from '../utils/windowLayouts';
import { shortcutHint } from '../utils/keymap';

/**
 * Dispositions de fenêtres (Pro Tools : Window Configuration List, Ctrl+Alt+J).
 * Rappeler, enregistrer la vue actuelle, renommer, remettre la disposition livrée.
 */
const VIEW_LABEL: Record<string, string> = { ARRANGEMENT: 'arrangement', MIXER: 'console', AUTOMATION: 'automation' };
const TOOL_LABEL: Record<string, string> = { SMART: 'Smart Tool', RANGE: 'sélecteur', SELECT: 'main', SPLIT: 'ciseaux', ERASE: 'gomme', DRAW: 'crayon', ZOOM: 'zoom', SCRUB: 'scrubber' };

const describe = (l: WindowLayout): string => {
  const p = l.parts || {};
  const bits: string[] = [];
  if (p.view) bits.push(VIEW_LABEL[p.view] || String(p.view).toLowerCase());
  if (p.sidebar !== undefined) bits.push(p.sidebar ? `navigateur ouvert${p.sideTab === 'FX' ? ' (effets)' : ''}` : 'navigateur fermé');
  if (p.panel) bits.push(p.panel === 'tracks' ? 'liste des pistes' : String(p.panel));
  if (p.zoom?.h) bits.push(`zoom ${Math.round(p.zoom.h)} px/s, pistes ${Math.round(p.zoom.v || 120)} px`);
  if (p.tool) bits.push(`outil ${TOOL_LABEL[p.tool] || String(p.tool).toLowerCase()}`);
  return bits.join(' · ');
};

const WindowLayoutsPanel: React.FC<{ onClose: () => void; notify: (m: string) => void }> = ({ onClose, notify }) => {
  useLayoutsVersion();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const last = layoutsStore.lastRecalled();

  return (
    <div className="fixed inset-0 z-[710] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="layouts-title" data-testid="layouts-panel">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2">
          <h2 id="layouts-title" className="mr-auto text-lg font-black">🪟 Dispositions de fenêtres</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-nv-well text-nv-muted hover:text-nv-ink">✕</button>
        </div>
        <p className="mb-3 text-[12px] text-nv-muted">
          Une disposition retient la vue, les panneaux ouverts et le zoom. Rappel : Ctrl+Maj+1 à 5, ou au pavé « . » N « * » comme Pro Tools ;
          pavé « . » N « / » enregistre la vue actuelle.
        </p>
        <ul className="space-y-2">
          {listLayouts().map(({ slot, layout, custom }) => (
            <li key={slot} data-layout-slot={slot} className={`rounded-xl border p-3 ${last === slot ? 'border-nv-accent bg-nv-accent/10' : 'border-nv-line bg-nv-surface'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nv-well font-mono text-[13px] font-black">{slot}</span>
                <div className="min-w-0 flex-1">
                  {editing === slot ? (
                    <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} aria-label={`Nom de la disposition ${slot}`}
                      onKeyDown={e => { if (e.key === 'Enter') { renameLayout(slot, draft); setEditing(null); } if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}
                      onBlur={() => { renameLayout(slot, draft); setEditing(null); }}
                      className="w-full rounded-md border border-nv-accent bg-nv-well px-2 py-1 text-[13px] outline-none" />
                  ) : (
                    <p className="text-[14px] font-bold">{layout ? layout.name : <span className="font-normal text-nv-muted">Vide</span>}
                      {layout && !custom && <span className="ml-2 rounded bg-nv-well px-1.5 py-0.5 text-[10px] font-bold text-nv-muted">livrée</span>}
                      <span className="ml-2 text-[11px] font-normal text-nv-muted">{shortcutHint(`layout.${slot}`)}</span>
                    </p>
                  )}
                  <p className="truncate text-[11px] text-nv-muted">{layout ? describe(layout) : 'Enregistre ici la vue actuelle pour la retrouver d’un geste.'}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" disabled={!layout} data-testid={`layout-recall-${slot}`}
                  onClick={() => { const l = applyLayout(slot); if (l) notify(`🪟 Disposition ${slot} : ${l.name}`); onClose(); }}
                  className="h-9 rounded-lg bg-cyan-500 px-3 text-[12px] font-black text-black disabled:opacity-40">Rappeler</button>
                <button type="button" data-testid={`layout-save-${slot}`}
                  onClick={() => { if (layout && !window.confirm(`Remplacer « ${layout.name} » par la vue actuelle ?`)) return; const l = saveLayout(slot); notify(`🪟 Vue enregistrée dans « ${l.name} » (${slot}).`); }}
                  className="h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold">Enregistrer la vue actuelle</button>
                {layout && (
                  <button type="button" onClick={() => { setEditing(slot); setDraft(layout.name); }} className="h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold">Renommer</button>
                )}
                {custom && (
                  <button type="button" onClick={() => resetLayout(slot)} className="h-9 rounded-lg px-3 text-[12px] font-bold text-nv-muted hover:text-nv-ink">
                    {slot <= 3 ? 'Remettre la livrée' : 'Vider'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default WindowLayoutsPanel;
