import React, { useEffect, useMemo, useRef, useState } from 'react';
import { keymapActions, rememberAction, recentActions, searchActions, type PaletteAction } from '../utils/commandPalette';
import { useKeymap } from '../utils/keymapStore';

/**
 * Palette de commandes (Ctrl+K, ou la loupe de la barre du haut) : une case de
 * recherche, toutes les actions du studio et tous les raccourcis, lancés au
 * clavier (↑ ↓ Entrée) ou au doigt. Les 8 dernières actions viennent en tête.
 */
const CommandPalette: React.FC<{ open: boolean; onClose: () => void; actions: PaletteAction[] }> = ({ open, onClose, actions }) => {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const keymap = useKeymap();
  const [recent, setRecent] = useState<string[]>([]);
  // Action grisée choisie : on dit pourquoi au lieu de ne rien faire.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(''); setIndex(0); setRecent(recentActions()); setNotice(null);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const all = useMemo(() => {
    if (!open) return [];
    const own = new Set(actions.map(a => a.id));
    return [...actions, ...keymapActions(own, keymap)];
  }, [open, actions, keymap]);
  const found = useMemo(() => searchActions(query, all, recent).slice(0, 60), [query, all, recent]);
  useEffect(() => { setIndex(0); setNotice(null); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const launch = (a: PaletteAction | undefined) => {
    if (!a) return;
    if (a.disabledReason) { setNotice(`${a.label} : ${a.disabledReason}`); return; }
    rememberAction(a.id);
    onClose();
    // Après la fermeture : la fenêtre ouverte (ou la touche rejouée) ne doit pas voir la palette.
    window.setTimeout(() => { try { a.run(); } catch (e) { console.warn('[palette]', a.id, e); } }, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(found.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); return; }
    if (e.key === 'PageDown') { e.preventDefault(); setIndex(i => Math.min(found.length - 1, i + 8)); return; }
    if (e.key === 'PageUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 8)); return; }
    if (e.key === 'Enter') { e.preventDefault(); launch(found[index]); return; }
    // Les raccourcis du studio ne partent pas pendant la saisie (Espace, R, S…).
    e.stopPropagation();
  };

  return (
    <div className="fixed inset-0 z-[760] flex items-start justify-center bg-black/50 px-3 pt-[10vh]" onMouseDown={onClose}
      role="dialog" aria-modal="true" aria-label="Palette de commandes" data-testid="command-palette">
      <div className="flex max-h-[76vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-nv-line/15 bg-nv-surface shadow-2xl"
        onMouseDown={e => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b border-nv-line/10 px-3">
          <i className="fas fa-search text-[13px] text-nv-muted" aria-hidden="true" />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Chercher une action : exporter, tempo, voix, séparer, Strip Silence…"
            aria-label="Chercher une action" data-testid="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list"
            aria-activedescendant={found[index] ? `palette-${found[index].id}` : undefined}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-nv-ink outline-none placeholder:text-nv-muted" />
          <button type="button" onClick={onClose} aria-label="Fermer la palette" title="Fermer (Échap)"
            className="h-9 w-9 shrink-0 rounded-lg text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">✕</button>
        </div>
        <ul ref={listRef} id="palette-list" role="listbox" aria-label="Actions" className="min-h-0 flex-1 overflow-y-auto p-1.5 custom-scroll">
          {!query && recent.length > 0 && <li className="px-3 pb-1 pt-1.5 text-[10px] font-black uppercase tracking-widest text-nv-muted" role="presentation">Récentes en tête</li>}
          {found.length === 0 && (
            <li className="px-4 py-8 text-center text-[13px] text-nv-muted" role="presentation">
              Aucune action pour « {query} ». Essaie un autre mot : « export », « tempo », « voix », « bus », « fondu »…
            </li>
          )}
          {found.map((a, i) => (
            <li key={a.id} id={`palette-${a.id}`} role="option" aria-selected={i === index} aria-disabled={!!a.disabledReason || undefined}
              data-palette-index={i} data-palette-id={a.id}
              onMouseMove={() => { if (i !== index) setIndex(i); }} onClick={() => launch(a)}
              title={a.disabledReason || (a.pt ? `Pro Tools : ${a.pt}` : undefined)}
              className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl px-3 py-1.5 ${i === index ? 'bg-nv-accent/15' : ''} ${a.disabledReason ? 'opacity-50' : ''}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-nv-ink">{a.label}</span>
                {a.disabledReason
                  ? <span className="block truncate text-[11px] text-amber-400">{a.disabledReason}</span>
                  : a.pt ? <span className="block truncate text-[11px] text-nv-muted">Pro Tools : {a.pt}</span> : null}
              </span>
              <span className="hidden shrink-0 text-[10px] font-bold uppercase tracking-wide text-nv-muted sm:inline">{a.group}</span>
              {a.keys && <kbd className="shrink-0 rounded-md border border-nv-line/20 bg-nv-line/5 px-2 py-0.5 font-mono text-[11px] text-nv-ink">{a.keys}</kbd>}
            </li>
          ))}
        </ul>
        {notice && <p role="status" data-testid="palette-notice" className="border-t border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] font-semibold text-amber-500">⚠️ {notice}</p>}
        <p className="border-t border-nv-line/10 px-3 py-2 text-[11px] text-nv-muted">
          <kbd className="font-mono">↑ ↓</kbd> choisir · <kbd className="font-mono">Entrée</kbd> lancer · <kbd className="font-mono">Échap</kbd> fermer · <kbd className="font-mono">Ctrl+K</kbd> partout dans le studio
        </p>
      </div>
    </div>
  );
};

export default CommandPalette;
