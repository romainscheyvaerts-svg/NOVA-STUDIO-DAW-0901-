import React, { useEffect, useRef, useState } from 'react';
import { automationRecorder } from '../services/AutomationManager';
import { OWN_LONG_PRESS_ATTR, swallowReleaseClick } from '../utils/touchGestures';
import { dragSendLevel, sendDbText, sendPos } from '../utils/sendFader';

/**
 * Envoi réglé au doigt comme un fader (utils/sendFader) : barre horizontale,
 * glisser relatif (la valeur ne saute pas sous le doigt), aimant sur 0 dB,
 * deux doigts = réglage fin, double toucher = 0 dB, appui long = menu.
 * Pendant la lecture en Touch / Latch, l'appui et le relâchement bornent
 * l'écriture d'automation, comme les potards (services/AutomationManager).
 */
export const SendFader: React.FC<{
  trackId: string;
  sendId: string;
  label: string;
  level: number;
  color?: string;
  muted?: boolean;
  /** Hauteur (px) : 32 sur tablette, 44 sur téléphone. */
  height?: number;
  onChange: (level: number) => void;
  onMenu?: (x: number, y: number) => void;
  testId?: string;
}> = ({ trackId, sendId, label, level, color = '#22d3ee', muted, height = 32, onChange, onMenu, testId }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(level);
  const [held, setHeld] = useState(false);
  const drag = useRef<{ id: number; x0: number; l0: number; moved: boolean; t0: number } | null>(null);
  const fingers = useRef(new Set<number>());
  const longTimer = useRef<number | null>(null);
  const lastTap = useRef(0);
  useEffect(() => { if (!drag.current) setShown(level); }, [level]);
  useEffect(() => () => { if (longTimer.current) window.clearTimeout(longTimer.current); }, []);

  const param = `send::${sendId}`;
  const set = (v: number) => { setShown(v); onChange(v); };
  const end = () => {
    if (longTimer.current) { window.clearTimeout(longTimer.current); longTimer.current = null; }
    if (drag.current) { drag.current = null; setHeld(false); automationRecorder.release(trackId, param); }
  };
  const pos = sendPos(shown);
  const unity = sendPos(1);

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1.5}
      aria-valuenow={Number(shown.toFixed(4))}
      aria-valuetext={sendDbText(shown)}
      data-testid={testId}
      data-send-fader={sendId}
      {...{ [OWN_LONG_PRESS_ATTR]: '' }}
      data-no-longpress
      title="Glisser pour régler l’envoi (comme un fader) · deux doigts : réglage fin · double toucher : 0 dB · appui long : copier / déplacer"
      className={`relative w-full select-none touch-none rounded-lg border border-white/10 bg-black/50 [[data-theme=light]_&]:bg-nv-surface overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${held ? 'ring-1 ring-cyan-300/70' : ''} ${muted ? 'opacity-50' : ''}`}
      style={{ height }}
      onPointerDown={(e) => {
        fingers.current.add(e.pointerId);
        if (drag.current) return; // 2e doigt : il sert au réglage fin
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
        const now = Date.now();
        if (now - lastTap.current < 320) { lastTap.current = 0; set(1); return; }
        lastTap.current = now;
        drag.current = { id: e.pointerId, x0: e.clientX, l0: shown, moved: false, t0: now };
        setHeld(true);
        automationRecorder.touch(trackId, param);
        if (onMenu) {
          const x = e.clientX, y = e.clientY;
          longTimer.current = window.setTimeout(() => {
            longTimer.current = null;
            if (drag.current && !drag.current.moved) { end(); onMenu(x, y); swallowReleaseClick(x, y); }
          }, 520);
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.x0;
        if (!d.moved && Math.abs(dx) < 4) return;
        if (!d.moved) { d.moved = true; if (longTimer.current) { window.clearTimeout(longTimer.current); longTimer.current = null; } }
        const w = ref.current?.getBoundingClientRect().width || 120;
        set(dragSendLevel(d.l0, dx, w, fingers.current.size > 1 || e.shiftKey));
      }}
      onPointerUp={(e) => { fingers.current.delete(e.pointerId); if (drag.current?.id === e.pointerId) end(); }}
      onPointerCancel={(e) => { fingers.current.delete(e.pointerId); if (drag.current?.id === e.pointerId) end(); }}
      onContextMenu={(e) => { if (onMenu) { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); } }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.005 : 0.03;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); set(dragSendLevel(shown, step * 100, 100)); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); set(dragSendLevel(shown, -step * 100, 100)); }
        if (e.key === 'Home' || e.key === '0') { e.preventDefault(); set(1); }
      }}
    >
      <div className="absolute inset-y-0 left-0 pointer-events-none opacity-40" style={{ width: `${pos * 100}%`, backgroundColor: color }} />
      <div className="absolute inset-y-1 w-px bg-white/40 pointer-events-none" style={{ left: `${unity * 100}%` }} aria-hidden="true" />
      <div className="absolute inset-y-0.5 w-2 -ml-1 rounded bg-slate-100 shadow pointer-events-none" style={{ left: `${pos * 100}%` }} aria-hidden="true" />
      <div className="absolute inset-0 flex items-center justify-between gap-1 px-2 pointer-events-none">
        <span className="truncate text-[10px] font-bold text-white [[data-theme=light]_&]:text-nv-ink">{label.replace(/^Envoi vers /, '')}</span>
        <span className="shrink-0 font-mono text-[10px] text-cyan-200 [[data-theme=light]_&]:text-cyan-800">{sendDbText(shown)}</span>
      </div>
    </div>
  );
};

export default SendFader;
