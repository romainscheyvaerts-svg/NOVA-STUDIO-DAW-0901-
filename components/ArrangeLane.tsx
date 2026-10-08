import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Marker, Track } from '../types';
import { nearestDrop, newTimeOpId, Section, sectionsOf, songEnd } from '../utils/timeOps';
import { openR12Panel, runTimeOp } from '../utils/r12Bus';
import { editSelectionStore } from '../utils/editSelection';
import { makeSelection } from '../utils/timeSelection';
import { formatBarsBeats } from '../utils/tempoMap';
import { useTempoMap } from './TempoLane';
import { FloatingMenu } from './TrackStructure';

export const ARRANGE_LANE_H = 28;
const KEY = 'nova_arrange_lane';

/** Piste Arrangement affichée sous la règle (mémorisé sur l'appareil, affichée par défaut). */
let shown = (() => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } })();
const ls = new Set<() => void>();
export const arrangeLaneStore = {
  get: () => shown,
  set(on: boolean) { shown = on; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* stockage indisponible */ } ls.forEach(l => l()); },
  subscribe(l: () => void) { ls.add(l); return () => { ls.delete(l); }; },
};
export const useArrangeLaneShown = () => useSyncExternalStore(arrangeLaneStore.subscribe, arrangeLaneStore.get, arrangeLaneStore.get);

interface Props {
  zoomH: number;
  scrollLeft: number;
  headerWidth: number;
  width: number;
  markers: Marker[];
  tracks: Track[];
}

type Drag = { sec: Section; x0: number; t: number; moved: boolean; copy: boolean; pointerId: number };

/**
 * Piste Arrangement (Logic / Studio One : Arrangement Track ; Pro Tools : pas
 * d'équivalent direct, on enchaîne Copier / Insérer du temps à la main) : les
 * sections viennent des repères (Couplet, Refrain…). Glisser une section la
 * DÉPLACE (le morceau se réordonne) ; Alt ou Ctrl (ou « Copier » au doigt) la
 * DUPLIQUE. Clips, automation, accords, repères et tempo suivent, en une
 * seule annulation et une seule opération de collaboration.
 */
const ArrangeLane: React.FC<Props> = ({ zoomH, scrollLeft, headerWidth, width, markers, tracks }) => {
  const map = useTempoMap();
  const sections = useMemo(() => sectionsOf({ tracks, markers }), [tracks, markers]);
  const end = useMemo(() => songEnd({ tracks, markers }), [tracks, markers]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [copyMode, setCopyMode] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; sec: Section } | null>(null);
  const longRef = useRef<number | null>(null);
  const x = (t: number) => t * zoomH - scrollLeft;

  const target = drag && drag.moved ? nearestDrop(sections, drag.t, end) : null;
  const valid = (d: Drag, to: number) => !(to > d.sec.start + 1e-6 && to < d.sec.end - 1e-6) && (d.copy || (Math.abs(to - d.sec.start) > 1e-6 && Math.abs(to - d.sec.end) > 1e-6));

  const act = (sec: Section, mode: 'move' | 'copy', to: number) => runTimeOp({ kind: 'section', id: newTimeOpId(), mode, start: sec.start, end: sec.end, to });
  const selectSection = (sec: Section) => {
    const ids = tracks.filter(t => t.id !== 'master' && !t.isHidden).map(t => t.id);
    editSelectionStore.set({ time: makeSelection(sec.start, sec.end, ids), clipIds: [] });
  };
  const items = (sec: Section) => [
    { label: `Dupliquer « ${sec.name} » à la suite`, onClick: () => act(sec, 'copy', sec.end), title: 'Logic : Arrangement › Dupliquer' },
    { label: 'Sélectionner la section (toutes les pistes)', onClick: () => selectSection(sec) },
    { label: 'Insérer du temps avant…', onClick: () => openR12Panel('time', { preset: { mode: 'insert', at: sec.start } }), title: 'Pro Tools : Insert Time' },
    'separator' as const,
    { label: `Supprimer la section (le temps se referme)`, danger: true, onClick: () => runTimeOp({ kind: 'delete', id: newTimeOpId(), start: sec.start, end: sec.end, tracks: 'all', rulers: true }), title: 'Pro Tools : Cut Time' },
  ];

  const onDown = (e: React.PointerEvent, sec: Section) => {
    if (e.button === 2) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ sec, x0: e.clientX, t: sec.start, moved: false, copy: copyMode || e.altKey || e.ctrlKey || e.metaKey, pointerId: e.pointerId });
    if (e.pointerType !== 'mouse') {
      const px = e.clientX, py = e.clientY;
      longRef.current = window.setTimeout(() => { longRef.current = null; setDrag(null); setMenu({ x: px, y: py, sec }); }, 550);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (longRef.current) { window.clearTimeout(longRef.current); longRef.current = null; }
    setDrag({ ...drag, moved: true, t: Math.max(0, drag.sec.start + dx / Math.max(1e-6, zoomH)), copy: copyMode || e.altKey || e.ctrlKey || e.metaKey });
  };
  const onUp = (e: React.PointerEvent) => {
    if (longRef.current) { window.clearTimeout(longRef.current); longRef.current = null; }
    const d = drag;
    setDrag(null);
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) { selectSection(d.sec); return; }
    const to = nearestDrop(sections, d.t, end);
    if (valid(d, to)) act(d.sec, d.copy ? 'copy' : 'move', to);
  };

  return (
    <div className="shrink-0 flex border-b relative z-30 select-none" data-testid="arrange-lane"
      style={{ height: ARRANGE_LANE_H, borderColor: 'var(--border-dim)', backgroundColor: 'var(--bg-surface)' }}>
      <div className="shrink-0 flex items-center gap-1.5 px-2 border-r" style={{ width: headerWidth, borderColor: 'var(--border-dim)' }}
        title="Piste Arrangement : glisse une section (Couplet, Refrain…) pour la déplacer, Alt / Ctrl pour la dupliquer (Logic, Studio One). Clips, automation, accords, repères et tempo suivent.">
        <i className="fas fa-layer-group text-[10px] text-fuchsia-300" aria-hidden />
        <span className="text-[11px] font-black truncate" style={{ color: 'var(--text-primary)' }}>Arrangement</span>
        <button type="button" aria-pressed={copyMode} onClick={() => setCopyMode(c => !c)} data-testid="arrange-copy-mode"
          title="Glisser = dupliquer (au doigt ; à la souris, tiens Alt ou Ctrl)"
          className={`nova-hit-tactile ml-auto h-6 rounded-md px-1.5 text-[10px] font-bold ${copyMode ? 'bg-fuchsia-500 text-black' : 'text-slate-400 hover:text-white hover:bg-white/10'}`}>Copier</button>
        <button type="button" onClick={() => openR12Panel('time', { preset: { mode: 'insert', at: 0 } })} aria-label="Insérer ou supprimer du temps"
          title="Insérer / supprimer du temps (Pro Tools : Insert Silence, Cut Time)" className="nova-hit-tactile w-6 h-6 rounded-md text-slate-400 hover:text-white hover:bg-white/10 shrink-0"><i className="fas fa-arrows-alt-h text-[10px]" /></button>
        <button type="button" onClick={() => arrangeLaneStore.set(false)} aria-label="Masquer la piste Arrangement" title="Masquer la piste Arrangement (fenêtre Temps → « Afficher la piste Arrangement » pour la remettre)"
          className="nova-hit-tactile w-6 h-6 rounded-md text-slate-500 hover:text-white hover:bg-white/10 shrink-0"><i className="fas fa-eye-slash text-[10px]" /></button>
      </div>
      <div className="relative flex-1 overflow-hidden" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        {sections.length === 0 && (
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">Pose des repères (K) « Couplet », « Refrain »… : ils deviennent des sections à glisser.</span>
        )}
        {sections.map(sec => {
          const left = x(sec.start), w = Math.max(6, (sec.end - sec.start) * zoomH);
          if (left > width + 10 || left + w < -10) return null;
          const dragging = drag?.sec.id === sec.id && drag.moved;
          return (
            <div key={sec.id} role="button" tabIndex={0} data-testid={`arrange-section-${sec.id}`} data-start={sec.start} data-end={sec.end}
              aria-label={`Section ${sec.name}, ${formatBarsBeats(map, sec.start)} à ${formatBarsBeats(map, sec.end)}. Glisser pour déplacer, Alt pour dupliquer.`}
              title={`${sec.name} · ${formatBarsBeats(map, sec.start)} → ${formatBarsBeats(map, sec.end)}\nGlisser : déplacer · Alt / Ctrl + glisser : dupliquer · clic : sélectionner · clic droit : menu`}
              onPointerDown={e => onDown(e, sec)}
              onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, sec }); }}
              onKeyDown={e => { if (e.key === 'Enter') selectSection(sec); if (e.key === 'ContextMenu') { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom, sec }); } }}
              className={`absolute top-[3px] bottom-[3px] rounded-md border px-1.5 flex items-center overflow-hidden cursor-grab active:cursor-grabbing touch-none ${dragging ? 'opacity-40' : ''}`}
              style={{ left, width: w, backgroundColor: `${sec.color}33`, borderColor: `${sec.color}aa` }}>
              <span className="truncate text-[10px] font-black" style={{ color: 'var(--text-primary)' }}>{sec.name}</span>
            </div>
          );
        })}
        {drag?.moved && (
          <>
            <div className="absolute top-[2px] bottom-[2px] rounded-md border-2 border-dashed pointer-events-none flex items-center px-1.5"
              style={{ left: x(drag.t), width: Math.max(6, (drag.sec.end - drag.sec.start) * zoomH), borderColor: drag.sec.color, backgroundColor: `${drag.sec.color}22` }}>
              <span className="truncate text-[10px] font-black" style={{ color: 'var(--text-primary)' }}>{drag.copy ? '+ ' : ''}{drag.sec.name}</span>
            </div>
            {target !== null && (
              <div data-testid="arrange-drop" className={`absolute top-0 bottom-0 w-[3px] pointer-events-none ${valid(drag, target) ? 'bg-fuchsia-400' : 'bg-red-500/70'}`}
                style={{ left: x(target) - 1 }} />
            )}
          </>
        )}
      </div>
      {drag?.moved && target !== null && (
        <div data-testid="arrange-drop-tip" className="absolute z-[60] pointer-events-none whitespace-nowrap rounded-lg bg-black/85 px-2 py-1 text-[11px] font-bold text-white shadow-lg" style={{ left: headerWidth + x(target) + 8, top: ARRANGE_LANE_H + 2 }}>
          {valid(drag, target) ? `${drag.copy ? 'Dupliquer' : 'Déplacer'} « ${drag.sec.name} » à ${formatBarsBeats(map, target)}` : 'Pas ici'}
        </div>
      )}
      {menu && <FloatingMenu x={menu.x} y={menu.y} title={menu.sec.name} onClose={() => setMenu(null)} items={items(menu.sec)} />}
    </div>
  );
};

export default ArrangeLane;
