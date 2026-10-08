import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  count: number;
  muted: boolean;
  level: number;
  onToggle: () => void;
  onLevel: (v: number) => void;
  compact?: boolean;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
const db = (v: number) => (v <= 0.0001 ? '−∞' : `${(20 * Math.log10(v)).toFixed(1).replace('.', ',').replace('-', '−')} dB`);

/**
 * Bouton GUIDE de la barre (R3) : la voix témoin (démo du topliner, yaourt,
 * ancienne prise) coupée ou rallumée d'un geste, et son niveau réglé à part.
 * Pro Tools : piste guide rendue inactive au bounce ; Logic : piste exclue du
 * Bounce ; ici elle n'est JAMAIS exportée, mixée ni masterisée.
 */
const GuideControl: React.FC<Props> = ({ count, muted, level, onToggle, onLevel, compact = false }) => {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!open) return;
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(window.innerWidth - 270, Math.max(8, r.left - 100)), y: r.bottom + 8 });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!count) return null;
  return (
    <div className="flex items-center" data-testid="guide-control">
      <button type="button" onClick={onToggle} aria-pressed={!muted} data-testid="guide-toggle"
        title={`Piste guide (${count}) : ${muted ? 'coupée' : `entendue à ${pct(level)}`}. Clic ou touche G : couper / rallumer. Jamais exportée ni mixée (Pro Tools : piste guide inactive au bounce).`}
        className={`nova-hit-tactile h-8 px-2 rounded-lg text-[9px] font-black tracking-wider border transition-all ${muted ? 'text-slate-500 border-white/10 line-through' : 'bg-amber-500/15 text-amber-300 border-amber-500/40'}`}>
        <i className="fas fa-headphones mr-1" aria-hidden="true"></i>{compact ? '' : 'GUIDE'}
      </button>
      <button ref={btn} type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Niveau de la piste guide" data-testid="guide-level-open"
        title="Niveau du guide, à part du mix"
        className="nova-hit-tactile h-8 w-4 rounded-md text-slate-500 hover:text-white flex items-center justify-center">
        <i className="fas fa-caret-down text-[10px]" aria-hidden="true"></i>
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[400]" onMouseDown={() => setOpen(false)} />
          <div role="dialog" aria-label="Niveau de la piste guide" className="fixed z-[401] w-[260px] rounded-xl border border-nv-line/15 bg-nv-raised p-3 shadow-2xl text-nv-ink"
            style={{ left: pos.x, top: pos.y }}>
            <div className="text-[10px] font-black uppercase tracking-widest text-nv-muted mb-1">Piste guide</div>
            <p className="text-[11px] text-nv-muted mb-2">La voix témoin s'entend pendant la prise. Elle n'est jamais exportée, ni mixée, ni masterisée.</p>
            <label className="block">
              <span className="flex justify-between text-[11px] font-bold"><span>Niveau</span><span className="font-mono">{db(level)}</span></span>
              <input type="range" min={0} max={1.5} step={0.01} value={level} onChange={e => onLevel(Number(e.target.value))} className="w-full h-8" aria-label="Niveau du guide" data-testid="guide-level" />
            </label>
            <button type="button" onClick={onToggle} className="mt-1 w-full min-h-9 rounded-lg border border-nv-line/15 text-[12px] font-bold hover:bg-nv-well/40">
              {muted ? 'Rallumer le guide' : 'Couper le guide'} <span className="font-normal text-nv-muted">(G)</span>
            </button>
          </div>
        </>, document.body)}
    </div>
  );
};

export default GuideControl;
