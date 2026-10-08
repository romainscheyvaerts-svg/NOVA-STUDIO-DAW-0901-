import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GRID_OPTIONS, gridLabel } from '../utils/grid';
import {
  chooseEditMode, EDIT_MODE_INFO, editModeMessage, EDIT_MODES, EditMode, editModeStore, GRID_KIND_LABEL, toggleShuffleLock, useEditMode,
} from '../utils/editModes';

/**
 * Sélecteur des modes d'édition (barre d'outils de l'arrangement), comme le
 * coin haut-gauche de la fenêtre Edit de Pro Tools : SHUF / SLIP / SPOT / GRID
 * + la valeur de grille. Remplace l'ancien aimant « Grille : oui / non ».
 */
export const notify = (msg: string) => {
  try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: msg })); } catch { /* hors navigateur */ }
};

const EditModeSelector: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const em = useEditMode();
  const [menu, setMenu] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Menu posé dans <body> (position fixe) : la barre d'outils est sous les en-têtes de pistes.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!menu || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const w = menuRef.current?.offsetWidth || 256, h = menuRef.current?.offsetHeight || 320;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const top = r.bottom + 4 + h <= window.innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - h - 4);
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const pick = (m: EditMode, e: React.MouseEvent) => {
    if (m === 'SHUFFLE' && (e.ctrlKey || e.metaKey)) { notify(toggleShuffleLock().message); return; }
    notify(chooseEditMode(m).message);
  };

  const gridRel = em.mode === 'GRID' && em.gridKind === 'RELATIVE';

  // Mode simple : juste Libre / Grille (Slip / Grid de Pro Tools), comme sur téléphone.
  if (compact) {
    const grid = em.mode === 'GRID';
    return (
      <div role="radiogroup" aria-label="Placement des clips" className="flex bg-black/40 rounded-lg p-0.5 border border-white/5 shrink-0" data-nova-target="edit-modes">
        {([false, true] as const).map(on => (
          <button key={String(on)} type="button" role="radio" aria-checked={grid === on}
            onClick={() => notify(chooseEditMode(on ? 'GRID' : 'SLIP').message)}
            title={on ? 'Grille : les clips se calent sur les temps (mode Grid de Pro Tools, F4)' : 'Libre : les clips vont exactement où tu les poses (mode Slip de Pro Tools, F2)'}
            className={`h-9 [@media(pointer:coarse)]:h-10 px-3 rounded-md text-[11px] font-bold transition-colors ${grid === on ? (on ? 'bg-blue-500/25 text-blue-200' : 'bg-green-500/20 text-green-300') : 'text-slate-400 hover:text-white'}`}>
            {on ? 'Grille' : 'Libre'}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative flex items-center gap-1 shrink-0" data-nova-target="edit-modes">
      <div role="radiogroup" aria-label="Mode d'édition (Pro Tools)" className="flex bg-black/40 rounded-lg p-0.5 border border-white/5">
        {EDIT_MODES.map(m => {
          const info = EDIT_MODE_INFO[m];
          const on = em.mode === m;
          const locked = m === 'SHUFFLE' && em.shuffleLock;
          const title = `${info.hint}\nRaccourci : ${info.keys}.${locked ? '\n🔒 Verrouillé (Shuffle Lock) : clic droit ou Ctrl+clic pour déverrouiller.' : ''}`;
          return (
            <button key={m} type="button" role="radio" aria-checked={on} aria-label={`Mode ${info.label}${m === 'GRID' && on ? ` ${GRID_KIND_LABEL[em.gridKind]}` : ''}${locked ? ' (verrouillé)' : ''}`}
              data-edit-mode={m} title={title}
              onClick={(e) => pick(m, e)}
              onContextMenu={m === 'SHUFFLE' ? (e) => { e.preventDefault(); notify(toggleShuffleLock().message); } : undefined}
              className={`relative h-9 [@media(pointer:coarse)]:h-10 min-w-[44px] px-2 rounded-md text-[10px] font-black tracking-wider transition-colors ${on ? 'text-black' : locked ? 'text-slate-600' : 'text-slate-400 hover:text-white'}`}
              style={on ? { background: info.color, boxShadow: `0 0 12px ${info.color}55` } : { borderBottom: `2px solid ${info.color}55` }}>
              {info.short}
              {m === 'GRID' && gridRel && <span className="ml-0.5 text-[8px] font-black opacity-80">REL</span>}
              {locked && <i className="fas fa-lock absolute -top-1 -right-1 text-[8px] text-orange-300" aria-hidden />}
            </button>
          );
        })}
      </div>
      <button ref={btnRef} type="button" onClick={() => setMenu(v => !v)} aria-haspopup="menu" aria-expanded={menu} aria-label={`Grille ${gridLabel(em.gridSize)} (valeur de grille)`}
        data-testid="grid-value"
        title="Valeur de la grille (Pro Tools : Grid value) : 1 mesure à 1/32, triolets, millisecondes et images ; grille absolue ou relative ; Tab to Transient."
        className={`h-9 [@media(pointer:coarse)]:h-10 px-2.5 rounded-lg border text-[11px] font-bold tabular-nums transition-colors ${em.mode === 'GRID' ? 'bg-blue-500/10 border-blue-500/40 text-blue-200' : 'bg-white/5 border-white/10 text-slate-400 hover:text-white'}`}>
        <i className="fas fa-th mr-1.5 text-[10px]" aria-hidden />{gridLabel(em.gridSize)}<i className="fas fa-chevron-down ml-1.5 text-[8px]" aria-hidden />
      </button>
      {menu && createPortal(
        <div ref={menuRef} role="menu" aria-label="Grille" style={{ left: pos.left, top: pos.top }}
          className="fixed z-[1000] w-64 rounded-xl border border-white/10 bg-[#14161a] p-2 shadow-[0_10px_40px_rgba(0,0,0,0.8)]">
          <div className="px-1 pb-1 text-[10px] font-bold text-slate-500">Valeur de grille</div>
          {([['musique', null], ['temps', 'En temps (min:s, images)']] as const).map(([kind, title]) => (
            <React.Fragment key={kind}>
              {title && <div className="px-1 pb-1 pt-2 text-[10px] font-bold text-slate-500" title="Pro Tools : grille en min:sec ou en timecode, indépendante du tempo (vidéo, podcast, son sans tempo)">{title}</div>}
              <div className="grid grid-cols-3 gap-0.5">
                {GRID_OPTIONS.filter(o => (o.kind || 'musique') === kind).map(o => (
                  <button key={o.value} type="button" role="menuitemradio" aria-checked={em.gridSize === o.value} title={o.title} data-grid-option={o.value}
                    onClick={() => { editModeStore.set({ gridSize: o.value }); setMenu(false); }}
                    className={`px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded-lg text-[10px] font-bold ${em.gridSize === o.value ? 'bg-blue-500/15 text-blue-300' : 'text-slate-300 hover:bg-white/5'}`}>{o.label}</button>
                ))}
              </div>
            </React.Fragment>
          ))}
          <div className="h-px bg-white/5 my-2" />
          <div className="px-1 pb-1 text-[10px] font-bold text-slate-500">Mode Grid</div>
          <div className="grid grid-cols-2 gap-1">
            {(['ABSOLUTE', 'RELATIVE'] as const).map(k => (
              <button key={k} type="button" role="menuitemradio" aria-checked={em.gridKind === k}
                title={k === 'ABSOLUTE' ? 'Grid absolu : le début du clip (ou son point de synchro) tombe pile sur la grille.' : 'Grid relatif : le clip avance par pas de grille en gardant son décalage (une prise un peu en avance reste en avance). Pro Tools : Relative Grid.'}
                onClick={() => { editModeStore.set({ mode: 'GRID', gridKind: k }); notify(editModeMessage()); setMenu(false); }}
                className={`px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded-lg text-[10px] font-bold capitalize ${em.gridKind === k ? 'bg-blue-500/15 text-blue-300' : 'text-slate-300 hover:bg-white/5'}`}>{GRID_KIND_LABEL[k]}</button>
            ))}
          </div>
          <div className="h-px bg-white/5 my-2" />
          <button type="button" role="menuitemcheckbox" aria-checked={em.tabToTransient}
            onClick={() => editModeStore.set({ tabToTransient: !em.tabToTransient })}
            title="Tab to Transient (Pro Tools) : Tab amène la tête de lecture à l'attaque suivante du clip sélectionné ; éteint, Tab va au bord de clip suivant. Maj+Tab : en arrière."
            className="w-full flex items-center justify-between px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded-lg text-[10px] font-bold text-slate-300 hover:bg-white/5">
            <span>Tab va aux attaques (Tab to Transient)</span>
            <span className={`w-8 h-4 rounded-full p-0.5 ${em.tabToTransient ? 'bg-green-500/30' : 'bg-white/10'}`}>
              <span className={`block w-3 h-3 rounded-full transition-transform ${em.tabToTransient ? 'translate-x-4 bg-green-400' : 'bg-slate-500'}`} />
            </span>
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={em.shuffleLock}
            onClick={() => notify(toggleShuffleLock().message)}
            title="Shuffle Lock (Pro Tools) : empêche d'entrer en Shuffle par erreur (F1, clic)."
            className="w-full flex items-center justify-between px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded-lg text-[10px] font-bold text-slate-300 hover:bg-white/5">
            <span><i className={`fas ${em.shuffleLock ? 'fa-lock text-orange-300' : 'fa-lock-open text-slate-500'} mr-1.5`} aria-hidden />Verrouiller Shuffle (Shuffle Lock)</span>
            <span className="text-slate-500">{em.shuffleLock ? 'oui' : 'non'}</span>
          </button>
          <p className="px-2 pt-2 text-[10px] leading-snug text-slate-500">Ctrl ou Maj pendant un glissement : Grid ⇄ Slip le temps du geste. Ctrl+, : point de synchro du clip.</p>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default EditModeSelector;
