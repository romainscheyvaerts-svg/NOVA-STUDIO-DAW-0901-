import React, { useEffect, useMemo, useState } from 'react';
import { Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { cpuTooltip, trackCpuView } from '../utils/cpuLoadView';

/**
 * Charge processeur d'une tranche de la console (« System Usage » de Pro Tools, piste par
 * piste) : pastille « CPU 4 % » dans l'en-tête des effets, détail par effet dans l'infobulle,
 * « veille » quand les effets dorment (engine/effectSleep). Piste lourde et gelable : un clic
 * la gèle (événement « nova:freeze-track », traité par l'appli).
 *
 * Une seule minuterie pour toute la console (1 lecture par seconde de l'état de veille), et
 * aucun rendu tant que rien ne change : pas de travail par image, même à 128 pistes.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let asleep = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

function poll() {
  let next: Set<string>;
  try { next = new Set(audioEngine.getSleepStats()?.asleepIds || []); } catch { next = new Set(); }
  if (next.size === asleep.size && [...next].every(id => asleep.has(id))) return;
  asleep = next;
  listeners.forEach(l => l());
}

function useAsleep(trackId: string): boolean {
  const [v, setV] = useState(() => asleep.has(trackId));
  useEffect(() => {
    const l = () => setV(asleep.has(trackId));
    listeners.add(l);
    if (!timer) timer = setInterval(poll, 1000);
    l();
    return () => {
      listeners.delete(l);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, [trackId]);
  return v;
}

const COLORS = {
  faible: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10',
  moyenne: 'text-amber-300 border-amber-400/40 bg-amber-500/10',
  forte: 'text-red-300 border-red-400/50 bg-red-500/15',
} as const;

const TrackCpuBadge: React.FC<{ track: Track }> = ({ track }) => {
  const isAsleep = useAsleep(track.id);
  const view = useMemo(() => trackCpuView(track, isAsleep), [track.plugins, track.clips, track.isFrozen, track.frozenClip, track.isTrackArmed, track.isInactive, track.type, isAsleep]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = cpuTooltip(track, view) + (view.level === 'forte' && view.canFreeze && !view.asleep ? '\nClic : geler la piste.' : '');
  const actionable = view.level === 'forte' && view.canFreeze && !view.asleep;
  const label = view.asleep ? 'veille' : `CPU ${view.pct < 1 ? '<1' : Math.round(view.pct)} %`;
  return (
    <button type="button" data-testid={`strip-cpu-${track.id}`} data-cpu-level={view.level} data-cpu-asleep={view.asleep ? '1' : undefined}
      title={title} aria-label={title.split('\n')[0] + (view.advice ? `. ${view.advice}` : '')}
      onClick={(e) => {
        e.stopPropagation();
        if (actionable) { try { window.dispatchEvent(new CustomEvent('nova:freeze-track', { detail: { trackId: track.id } })); } catch { /* */ } }
      }}
      className={`h-3 px-1 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:px-2 [@media(pointer:coarse)]:leading-[22px] [@media(pointer:coarse)]:text-[10px] rounded border text-[7px] leading-[10px] font-bold tabular-nums whitespace-nowrap ${view.asleep ? 'text-slate-400 border-white/10 bg-white/5' : COLORS[view.level]} ${actionable ? 'cursor-pointer hover:brightness-125' : 'cursor-default'}`}>
      {view.asleep && <i className="fas fa-moon mr-0.5 text-[6px]" aria-hidden="true" />}{label}
    </button>
  );
};

export default React.memo(TrackCpuBadge);
