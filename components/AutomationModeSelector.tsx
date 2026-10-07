import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Track } from '../types';
import { automationRecorder } from '../services/AutomationManager';
import {
  AUTOMATION_MODES, AutomationMode, automationModeInfo, automationModeOf, clearTrackAutomation, hasAutomation, laneDisplayName,
} from '../utils/automationWrite';

/** Vrai pendant qu'un fader de cette piste écrit de l'automation. */
export const useAutomationWriting = (trackId: string): boolean => {
  const sub = useCallback((fn: () => void) => automationRecorder.subscribe(fn), []);
  return useSyncExternalStore(sub, () => automationRecorder.isCapturing(trackId), () => false);
};

interface Props {
  track: Track;
  onUpdate: (track: Track) => void;
  /** Console : bouton pleine largeur ; en-tête de piste : pastille. */
  variant?: 'header' | 'mixer';
}

/**
 * Sélecteur du mode d'automation d'une piste, façon Pro Tools :
 * Off · Read (vert) · Touch / Latch (jaune) · Write (rouge) · Trim.
 * Le menu propose aussi « Effacer l'automation » (annulable).
 */
const AutomationModeSelector: React.FC<Props> = ({ track, onUpdate, variant = 'header' }) => {
  const mode = automationModeOf(track);
  const info = automationModeInfo(mode);
  const writing = useAutomationWriting(track.id);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); } };
    window.addEventListener('mousedown', close);
    window.addEventListener('touchstart', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('touchstart', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const choose = (m: AutomationMode) => {
    setOpen(false);
    if (m === mode) return;
    automationRecorder.stopTrack(track.id);
    onUpdate({ ...track, automationMode: m });
  };

  const written = (track.automationLanes || []).filter(l => l.points.length > 0);
  const clearAll = () => {
    setOpen(false);
    automationRecorder.stopTrack(track.id);
    onUpdate(clearTrackAutomation(track));
  };

  const rect = btnRef.current?.getBoundingClientRect();
  const menuStyle: React.CSSProperties = rect
    ? { top: Math.min(rect.bottom + 4, window.innerHeight - 340), left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)) }
    : {};

  const label = variant === 'mixer' ? info.label.toUpperCase() : info.short;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={`automation-mode-${track.id}`}
        data-automation-mode={mode}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        onMouseDown={(e) => e.stopPropagation()}
        title={`Automation : ${info.title}`}
        aria-label={`Mode d'automation de ${track.name} : ${info.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`nova-hit-tactile relative shrink-0 rounded-md border font-black tracking-wide transition-colors ${variant === 'mixer' ? 'w-full h-7 text-[9px]' : 'h-7 px-1.5 min-w-[2.6rem] text-[8px]'}`}
        style={{
          color: mode === 'off' ? '#94a3b8' : info.color,
          borderColor: `${info.color}${mode === 'off' ? '55' : '99'}`,
          backgroundColor: `${info.color}${mode === 'read' || mode === 'off' ? '14' : '26'}`,
        }}
      >
        {label}
        {writing && (
          <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-black/70 animate-pulse" role="status" aria-label="Écriture d'automation en cours" />
        )}
        {!writing && hasAutomation(track) && mode !== 'off' && (
          <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 h-0.5 w-3 rounded-full" style={{ backgroundColor: info.color }} aria-hidden />
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Automation de ${track.name}`}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[650] w-64 rounded-xl border border-white/10 bg-[#14161c] p-1.5 shadow-2xl"
          style={menuStyle}
        >
          <p className="px-2 pb-1 pt-0.5 text-[10px] font-black uppercase tracking-widest text-slate-500">Automation · {track.name}</p>
          {AUTOMATION_MODES.map(m => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === mode}
              title={m.title}
              onClick={() => choose(m.id)}
              className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 [@media(pointer:coarse)]:py-3 text-left hover:bg-white/5 ${m.id === mode ? 'bg-white/[0.06]' : ''}`}
            >
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
              <span className="min-w-0">
                <span className="block text-[12px] font-bold" style={{ color: m.id === mode ? m.color : '#e2e8f0' }}>{m.label}</span>
                <span className="block text-[10px] leading-snug text-slate-400">{m.title.replace(/\s*\(Pro Tools : [^)]*\)\.?$/, '.')}</span>
              </span>
            </button>
          ))}
          <div className="my-1 h-px bg-white/10" />
          <button
            type="button"
            role="menuitem"
            disabled={!written.length}
            onClick={clearAll}
            title={written.length ? `Vide : ${written.map(l => laneDisplayName(l.parameterName, track)).join(', ')} (Ctrl+Z pour revenir)` : "Aucune automation écrite sur cette piste"}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 [@media(pointer:coarse)]:py-3 text-left text-[12px] font-bold text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent"
          >
            <i className="fas fa-eraser text-[10px]" /> Effacer l'automation
            {written.length > 0 && <span className="ml-auto text-[10px] font-normal text-slate-500">{written.reduce((n, l) => n + l.points.length, 0)} pts</span>}
          </button>
        </div>
      )}
    </>
  );
};

export default AutomationModeSelector;
