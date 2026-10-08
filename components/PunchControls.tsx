import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PunchSettings } from '../types';
import { DEFAULT_POST_ROLL_BARS, DEFAULT_PRE_ROLL_BARS, DEFAULT_PUNCH_XFADE_MS, ROLL_CHOICES_BARS, ROLL_CHOICES_SEC, hasPunchZone, rollBars, rollLabel } from '../utils/punch';

/**
 * Boutons de punch de la barre de transport : PUNCH, pré-roll, post-roll et
 * QuickPunch, comme la fenêtre Transport de Pro Tools. Le menu ▾ règle les
 * durées (en mesures) et le crossfade aux bords du punch.
 */
interface Props {
  punch?: PunchSettings;
  bpm: number;
  isPunchActive: boolean;
  onTogglePunch: () => void;
  onUpdatePunch?: (patch: Partial<PunchSettings>) => void;
  onToggleQuickPunch?: () => void;
}

const fmtSec = (s: number) => `${s.toFixed(2).replace('.', ',')} s`;

const PunchControls: React.FC<Props> = ({ punch, bpm, isPunchActive, onTogglePunch, onUpdatePunch, onToggleQuickPunch }) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const preBars = rollBars(punch, 'pre', bpm);
  const postBars = rollBars(punch, 'post', bpm);
  // Réglé en secondes (R2) : prioritaire sur les mesures.
  const preSec = typeof punch?.preRollSec === 'number' ? punch.preRollSec : null;
  const postSec = typeof punch?.postRollSec === 'number' ? punch.postRollSec : null;
  const label = (bars: number, sec: number | null, on: boolean) => (sec !== null ? (on && sec > 0 ? `${String(sec).replace('.', ',')}s` : 'off') : rollLabel(bars, on));
  const howLong = (bars: number, sec: number | null) => (sec !== null ? `${String(sec).replace('.', ',')} s` : `${bars} mesure${bars > 1 ? 's' : ''}`);
  // Pré-roll non réglé : actif en punch seulement (comportement d'avant).
  const preOn = punch?.preRollOn ?? isPunchActive;
  const postOn = punch?.postRollOn ?? true;
  const quick = !!punch?.quickPunch;
  const xfMs = punch?.crossfadeMs ?? DEFAULT_PUNCH_XFADE_MS;
  const zone = hasPunchZone(punch) ? `${fmtSec(punch!.punchIn)} → ${fmtSec(punch!.punchOut)}` : 'pas encore posée';

  useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(window.innerWidth - 300, Math.max(8, r.left - 120)), y: r.bottom + 8 });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const chip = (on: boolean) => `px-1.5 h-6 rounded-md text-[9px] font-black tracking-wider transition-all border ${on ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'text-slate-500 border-white/10 hover:text-white'}`;

  return (
    <div className="hidden md:flex items-center gap-1" data-nova-target="punch">
      <button onClick={onTogglePunch} aria-pressed={isPunchActive}
        title={`Punch-in / punch-out (comme dans Pro Tools) : REC ne remplace que la zone rouge de la règle (${zone}), avec un crossfade aux bords. La zone vient de ta sélection, sinon de la boucle.`}
        className={`nova-hit-tactile h-8 px-2 rounded-lg flex items-center justify-center text-[9px] font-black tracking-wider transition-all ${isPunchActive ? 'bg-red-500/25 text-red-300 border border-red-500/50' : 'text-slate-500 hover:text-white border border-transparent'}`}>
        PUNCH
      </button>
      {onUpdatePunch && (
        <>
          <button onClick={() => onUpdatePunch({ preRollOn: !preOn })} aria-pressed={preOn}
            title={`Pré-roll (comme dans Pro Tools) : la lecture repart ${howLong(preBars, preSec)} avant le point d'entrée pour te caler ; seul ce qui suit est gardé. Clic : activer / couper. Durée (mesures ou secondes) dans le menu ▾.`}
            className={`hidden xl:flex items-center ${chip(preOn)}`}>PRÉ {label(preBars, preSec, preOn)}</button>
          <button onClick={() => onUpdatePunch({ postRollOn: !postOn })} aria-pressed={postOn}
            title={`Post-roll (comme dans Pro Tools) : la lecture continue ${howLong(postBars, postSec)} après le point de sortie, puis s'arrête. Clic : activer / couper.`}
            className={`hidden xl:flex items-center ${chip(postOn)}`}>POST {label(postBars, postSec, postOn)}</button>
          {onToggleQuickPunch && (
            <button onClick={onToggleQuickPunch} aria-pressed={quick}
              title="QuickPunch (comme dans Pro Tools) : pendant la lecture, REC (ou R) entre dans l'enregistrement sur la piste armée, un 2e appui en sort, sans arrêter la musique. Idéal pour refaire une fin de phrase."
              className={`nova-hit-tactile h-6 px-1.5 rounded-md text-[9px] font-black tracking-wider border transition-all ${quick ? 'bg-red-500/25 text-red-300 border-red-500/50' : 'text-slate-500 border-white/10 hover:text-white'}`}>
              QP
            </button>
          )}
          <button ref={btnRef} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Réglages du punch, du pré-roll et du post-roll"
            title="Réglages du punch : pré-roll, post-roll, crossfade"
            className="nova-hit-tactile h-6 w-5 rounded-md text-slate-500 hover:text-white flex items-center justify-center">
            <i className="fas fa-caret-down text-[10px]"></i>
          </button>
        </>
      )}
      {open && onUpdatePunch && createPortal(
        <>
          <div className="fixed inset-0 z-[400]" onMouseDown={() => setOpen(false)} />
          <div role="dialog" aria-label="Réglages du punch" className="fixed z-[401] w-[290px] rounded-xl border border-white/10 bg-[#14161a] p-3 shadow-2xl text-[11px] text-slate-300"
            style={{ left: pos.x, top: pos.y }}>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Punch (Pro Tools)</div>
            <p className="text-[10px] text-slate-500 mb-2">Zone : <span className="text-red-300 font-mono">{zone}</span>. Glisse ses poignées rouges dans la règle, ou clic droit dans la règle.</p>
            {(['pre', 'post'] as const).map(which => {
              const on = which === 'pre' ? preOn : postOn;
              const bars = which === 'pre' ? preBars : postBars;
              const sec = which === 'pre' ? preSec : postSec;
              return (
                <div key={which} className="mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold">{which === 'pre' ? 'Pré-roll' : 'Post-roll'}</span>
                    <label className="flex items-center gap-1 text-[10px]">
                      <input type="checkbox" checked={on} onChange={e => onUpdatePunch(which === 'pre' ? { preRollOn: e.target.checked } : { postRollOn: e.target.checked })} />
                      actif
                    </label>
                  </div>
                  <div className="flex gap-1">
                    {ROLL_CHOICES_BARS.filter(b => b > 0).map(b => (
                      <button key={b} onClick={() => onUpdatePunch(which === 'pre' ? { preRollBars: b, preRollSec: undefined, preRollOn: true } : { postRollBars: b, postRollSec: undefined, postRollOn: true })}
                        className={`flex-1 h-7 rounded-md border text-[10px] font-bold ${on && sec === null && bars === b ? 'bg-amber-500/20 border-amber-500/50 text-amber-200' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                        {b === 0.5 ? '½' : b} mes.
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1 mt-1" title="En secondes, comme le pré-roll min:sec de Pro Tools : utile sur un son sans tempo (podcast, voix libre)">
                    {ROLL_CHOICES_SEC.map(sv => (
                      <button key={sv} onClick={() => onUpdatePunch(which === 'pre' ? { preRollSec: sv, preRollOn: true } : { postRollSec: sv, postRollOn: true })}
                        className={`flex-1 h-7 rounded-md border text-[10px] font-bold ${on && sec === sv ? 'bg-amber-500/20 border-amber-500/50 text-amber-200' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                        {sv} s
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center justify-between mt-2">
              <span className="font-bold" title="Longueur des fondus enchaînés posés aux points d'entrée et de sortie (« QuickPunch Crossfade Length » dans Pro Tools)">Crossfade aux bords</span>
              <select value={xfMs} onChange={e => onUpdatePunch({ crossfadeMs: Number(e.target.value) })}
                className="bg-black/40 border border-white/10 rounded px-1 h-7 text-[11px]">
                {[0, 5, 10, 20, 50, 100].map(v => <option key={v} value={v}>{v} ms</option>)}
              </select>
            </div>
            <button onClick={() => onUpdatePunch({ preRollBars: DEFAULT_PRE_ROLL_BARS, postRollBars: DEFAULT_POST_ROLL_BARS, preRollSec: undefined, postRollSec: undefined, preRollOn: undefined, postRollOn: undefined, crossfadeMs: DEFAULT_PUNCH_XFADE_MS })}
              className="mt-3 w-full h-7 rounded-md border border-white/10 text-[10px] text-slate-400 hover:text-white">
              Réglages d'origine (2 mesures avant, 1 après, 10 ms)
            </button>
          </div>
        </>, document.body)}
    </div>
  );
};

export default PunchControls;
