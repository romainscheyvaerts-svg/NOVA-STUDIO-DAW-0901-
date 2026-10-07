import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KEYMAP, SHORTCUT_CATEGORIES, searchShortcuts, shortcutKeysLabel } from '../utils/keymap';
import { setKeyboardFocus, useKeyboardFocus } from '../utils/keyboardFocus';

/**
 * Aide-mémoire des raccourcis (touche « ? ») : TOUS les raccourcis de la table
 * utils/keymap, avec leur équivalent Pro Tools et une recherche.
 */
const ShortcutsHelp: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [query, setQuery] = useState('');
  const focus = useKeyboardFocus();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30); else setQuery(''); }, [open]);
  const found = useMemo(() => searchShortcuts(query, KEYMAP), [query]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-white/10 bg-[#121418] p-5 shadow-2xl sm:p-6" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <h2 id="shortcuts-title" className="mr-auto text-lg font-black text-white">⌨️ Raccourcis clavier</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Chercher : « séparer », « zoom », « Ctrl+E », « pavé »…"
            aria-label="Chercher un raccourci" data-testid="shortcuts-search"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white outline-none focus:border-cyan-500/60" />
          <button type="button" onClick={() => setKeyboardFocus(!focus)} aria-pressed={focus}
            title="Pro Tools : Commands Keyboard Focus (Ctrl+Alt+1). Une touche = une commande : A, S, D, G, B, R, T…"
            className={`shrink-0 rounded-lg border px-3 py-2 text-[12px] font-black ${focus ? 'border-amber-400/60 bg-amber-400/15 text-amber-300' : 'border-white/10 bg-white/5 text-slate-300'}`}>
            a–z Keyboard Focus : {focus ? 'actif' : 'arrêté'}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scroll">
          {found.length === 0 && <p className="py-6 text-center text-[13px] text-slate-400">Aucun raccourci pour « {query} ».</p>}
          <div className="grid gap-5 sm:grid-cols-2">
            {SHORTCUT_CATEGORIES.map(cat => {
              const list = found.filter(s => s.category === cat);
              if (!list.length) return null;
              return (
                <div key={cat}>
                  <p className="mb-2 text-[11px] font-black uppercase tracking-widest text-cyan-400">
                    {cat}{cat === 'Keyboard Focus' && <span className={`ml-2 normal-case tracking-normal ${focus ? 'text-amber-300' : 'text-slate-500'}`}>{focus ? '(actif)' : '(Ctrl+Alt+1 pour l’activer)'}</span>}
                  </p>
                  <ul className="space-y-1.5">
                    {list.map(s => (
                      <li key={s.id} className="flex items-start justify-between gap-3 text-[13px]" title={s.pt ? `Pro Tools : ${s.pt}` : undefined}>
                        <span className="min-w-0">
                          <span className="text-slate-200">{s.label}</span>
                          {s.pt && <span className="block text-[10px] text-slate-500">Pro Tools : {s.pt}</span>}
                        </span>
                        <kbd className="shrink-0 rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-right font-mono text-[11px] text-white">{shortcutKeysLabel(s)}</kbd>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">Les combinaisons Ctrl s’écrivent Cmd sur Mac. Le pavé numérique suit le mode « Transport » de Pro Tools.</p>
      </div>
    </div>
  );
};

export default ShortcutsHelp;
