import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip } from '../types';
import { syncOffsetOf } from '../utils/editModes';
import { useSimpleMode } from '../utils/simpleMode';
import {
  anchorTime, formatSpot, originalStartOf, readSpotField, SPOT_FORMATS, SpotAnchor, spotField, SpotFormat, spotStart,
  switchSpotFormat, typeSpotField,
} from '../utils/spotTime';

/**
 * « Position exacte » (Pro Tools : Spot Dialog) : place un clip au tick, à la
 * milliseconde ou à l'échantillon près, par son début, sa fin ou son point de
 * synchro ; « Reprendre la position d'origine » le remet là où il a été
 * enregistré. Ouverte en mode Spot par un clic sur un clip (appui long au
 * doigt), ou par le menu du clip dans tous les modes.
 */
interface Props {
  clip: Clip;
  trackName?: string;
  bpm: number;
  sampleRate: number;
  onApply: (start: number) => void;
  onClose: () => void;
}

const FORMAT_KEY = 'nova_spot_format';
const readFormat = (): SpotFormat => {
  try { const v = localStorage.getItem(FORMAT_KEY); if (v === 'BARS' || v === 'MINSEC' || v === 'SAMPLES') return v; } catch { /* rien */ }
  return 'BARS';
};

const ANCHORS: { id: SpotAnchor; label: string; hint: string }[] = [
  { id: 'START', label: 'Début', hint: 'Le début du clip va à la position tapée.' },
  { id: 'SYNC', label: 'Point de synchro', hint: 'Le point de synchro (Ctrl+, sur le clip) va à la position tapée : idéal pour caler une attaque.' },
  { id: 'END', label: 'Fin', hint: 'La fin du clip va à la position tapée.' },
];

const SpotDialog: React.FC<Props> = ({ clip, trackName, bpm, sampleRate, onApply, onClose }) => {
  const ctx = useMemo(() => ({ bpm, sr: sampleRate }), [bpm, sampleRate]);
  const { simple } = useSimpleMode();
  const hasSync = syncOffsetOf(clip) !== null;
  const origin = originalStartOf(clip);
  const [anchor, setAnchor] = useState<SpotAnchor>(hasSync ? 'SYNC' : 'START');
  // Le champ garde l'instant exact affiché (pas d'arrondi au tick ni à la ms) tant qu'on ne le retape pas.
  const [field, setField] = useState(() => spotField(anchorTime(clip, hasSync ? 'SYNC' : 'START'), readFormat(), ctx));
  const { text, format } = field;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const parsed = readSpotField(field, ctx);
  const newStart = parsed ? spotStart(clip, anchor, parsed.time) : null;
  const error = !text.trim() ? 'Tape une position.'
    : !parsed ? `Format attendu : ${SPOT_FORMATS.find(f => f.id === format)!.example}`
    : newStart === null ? 'Le clip commencerait avant le début du morceau.' : null;

  const changeFormat = (f: SpotFormat) => {
    // On garde la valeur tapée, convertie dans le nouveau format.
    setField(switchSpotFormat(field, f, ctx, anchorTime(clip, anchor)));
    try { localStorage.setItem(FORMAT_KEY, f); } catch { /* rien */ }
  };
  const changeAnchor = (a: SpotAnchor) => { setAnchor(a); setField(spotField(anchorTime(clip, a), format, ctx)); };
  const apply = () => { if (newStart === null || error) return; onApply(newStart); onClose(); };

  const fmtAll = (t: number) => SPOT_FORMATS.map(f => formatSpot(t, f.id, ctx)).join(' · ');

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose} role="dialog" aria-modal="true" aria-labelledby="spot-title" data-testid="spot-dialog">
      <div className="w-full max-w-md rounded-2xl border border-yellow-500/30 bg-nv-surface p-5 shadow-2xl" onMouseDown={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center">
          <h2 id="spot-title" className="mr-auto text-[15px] font-black text-white" title="Position exacte : place le clip au tick, à la milliseconde ou à l’échantillon près (Pro Tools : Spot Dialog, mode Spot, F3)">
            {!simple && <span className="mr-2 rounded px-1.5 py-0.5 text-[10px] font-black text-black" style={{ background: '#eab308' }}>SPOT</span>}Position exacte
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        <p className="mb-3 truncate text-[11px] text-slate-400">« {clip.name} »{trackName ? ` · piste ${trackName}` : ''} · durée {formatSpot(clip.duration, 'MINSEC', ctx)}</p>

        <div className="mb-3" role="radiogroup" aria-label="Format de la position">
          <span className="text-[11px] font-bold text-slate-300">Format</span>
          <div className="mt-1 grid grid-cols-3 gap-1">
            {SPOT_FORMATS.map(f => (
              <button key={f.id} type="button" role="radio" aria-checked={format === f.id} onClick={() => changeFormat(f.id)}
                className={`rounded-lg border px-2 py-2 text-[11px] font-bold ${format === f.id ? 'border-yellow-500/60 bg-yellow-500/15 text-yellow-200' : 'border-white/10 text-slate-300 hover:text-white'}`}>{f.label}</button>
            ))}
          </div>
        </div>

        <div className="mb-3" role="radiogroup" aria-label="Point du clip à placer">
          <span className="text-[11px] font-bold text-slate-300">Placer</span>
          <div className="mt-1 grid grid-cols-3 gap-1">
            {ANCHORS.map(a => {
              const disabled = a.id === 'SYNC' && !hasSync;
              return (
                <button key={a.id} type="button" role="radio" aria-checked={anchor === a.id} disabled={disabled} onClick={() => changeAnchor(a.id)}
                  title={disabled ? 'Ce clip n’a pas de point de synchro : place la tête de lecture sur l’attaque, Ctrl+, puis rouvre cette fenêtre.' : a.hint}
                  className={`rounded-lg border px-2 py-2 text-[11px] font-bold disabled:opacity-35 ${anchor === a.id ? 'border-yellow-500/60 bg-yellow-500/15 text-yellow-200' : 'border-white/10 text-slate-300 hover:text-white'}`}>{a.label}</button>
              );
            })}
          </div>
        </div>

        <label className="block">
          <span className="text-[11px] font-bold text-slate-300">Nouvelle position ({ANCHORS.find(a => a.id === anchor)!.label.toLowerCase()})</span>
          <input ref={inputRef} value={text} onChange={e => setField(typeSpotField(field, e.target.value))} aria-label="Nouvelle position" data-testid="spot-input"
            inputMode={format === 'SAMPLES' ? 'numeric' : 'text'} spellCheck={false}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
            className={`mt-1 w-full rounded-lg border bg-black/40 px-3 py-2 font-mono text-[16px] tabular-nums text-white outline-none ${error && text.trim() ? 'border-red-500/60' : 'border-white/10 focus:border-yellow-500/60'}`} />
        </label>
        <p className={`mt-1 min-h-[16px] text-[11px] ${error ? 'text-red-300' : 'text-slate-400'}`} role="status">
          {error || (newStart !== null ? `Le clip commencera à ${fmtAll(newStart)}` : '')}
        </p>

        <div className="mt-2 rounded-lg bg-white/[0.03] p-2 text-[10px] leading-relaxed text-slate-500">
          <div>Début actuel : <span className="font-mono text-slate-300">{fmtAll(clip.start)}</span></div>
          {hasSync && <div>Point de synchro : <span className="font-mono text-slate-300">{fmtAll(anchorTime(clip, 'SYNC'))}</span></div>}
          {origin !== null && <div>Position d’origine : <span className="font-mono text-slate-300">{fmtAll(origin)}</span></div>}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" disabled={origin === null} data-testid="spot-origin"
            onClick={() => { if (origin === null) return; setAnchor('START'); setField(spotField(origin, format, ctx)); }}
            title={origin === null ? 'Position d’origine inconnue : ce clip n’a pas été enregistré dans NOVA (import, ancien projet).' : 'Remet le clip là où il a été enregistré (Pro Tools : Original Time Stamp).'}
            className="mr-auto rounded-lg border border-white/10 px-3 py-2 text-[11px] font-bold text-slate-300 hover:text-white disabled:opacity-35">
            <i className="fas fa-clock-rotate-left mr-1.5" aria-hidden />Reprendre la position d’origine
          </button>
          <button type="button" onClick={onClose} className="rounded-lg bg-white/5 px-3 py-2 text-[12px] font-bold text-slate-300">Annuler</button>
          <button type="button" onClick={apply} disabled={!!error} data-testid="spot-apply"
            className="rounded-lg px-4 py-2 text-[12px] font-black text-black disabled:opacity-40" style={{ background: '#eab308' }}>Placer</button>
        </div>
      </div>
    </div>
  );
};

export default SpotDialog;
