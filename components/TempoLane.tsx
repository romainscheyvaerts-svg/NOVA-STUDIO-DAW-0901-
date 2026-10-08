import React, { useSyncExternalStore } from 'react';
import { barsInRange, timeToPosition, tempoMapStore, type TempoEvent, type TempoMap } from '../utils/tempoMap';

export const TEMPO_LANE_H = 26;
const LANE_KEY = 'nova_tempo_lane';

/** Piste tempo affichée sous la règle (mémorisé sur l'appareil). */
let laneOn = (() => { try { return localStorage.getItem(LANE_KEY) === '1'; } catch { return false; } })();
const laneListeners = new Set<() => void>();
export const tempoLaneStore = {
  get: () => laneOn,
  set(on: boolean) { laneOn = on; try { localStorage.setItem(LANE_KEY, on ? '1' : '0'); } catch { /* stockage indisponible */ } laneListeners.forEach(l => l()); },
  subscribe(l: () => void) { laneListeners.add(l); return () => { laneListeners.delete(l); }; },
};
export const useTempoLaneShown = () => useSyncExternalStore(tempoLaneStore.subscribe, tempoLaneStore.get, tempoLaneStore.get);

/** Carte courante (re-rendu quand elle change). */
export const useTempoMap = (): TempoMap => useSyncExternalStore(tempoMapStore.subscribe, tempoMapStore.get, tempoMapStore.get);

interface Props {
  zoomH: number;
  scrollLeft: number;
  headerWidth: number;
  width: number;
  events: TempoEvent[];
  /** Ouvre la fenêtre Tempo sur la mesure (0 = la 1re) : changement existant ou nouveau. */
  onPick: (bar: number) => void;
}

/**
 * Piste tempo et mesure (R2), sous la règle : un repère par changement
 * (« ♩ 140 · 6/8 »), comme les règles Tempo et Meter de Pro Tools ou la piste
 * Tempo globale de Logic. Clic sur un repère : le modifier ; ailleurs : poser
 * un changement à cette mesure.
 */
const TempoLane: React.FC<Props> = ({ zoomH, scrollLeft, headerWidth, width, events, onPick }) => {
  const map = useTempoMap();
  const t0 = scrollLeft / Math.max(1e-6, zoomH);
  const t1 = (scrollLeft + width) / Math.max(1e-6, zoomH);
  const changes = map.segments.filter(s => s.bar > 0 || events.some(e => e.bar === 0));
  const bars = barsInRange(map, t0, t1);
  const step = bars.length > 1 ? (bars[1].time - bars[0].time) * zoomH : 999;
  const start = map.segments[0];
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const t = (e.clientX - r.left + scrollLeft) / Math.max(1e-6, zoomH);
    const p = timeToPosition(map, t);
    // Plus près du début de la mesure suivante : on vise celle-là.
    const inBar = (p.beat + p.frac) / p.seg.num;
    onPick(Math.max(1, inBar > 0.5 ? p.bar + 1 : p.bar));
  };
  return (
    <div className="shrink-0 flex border-b relative z-30" data-testid="tempo-lane" style={{ height: TEMPO_LANE_H, borderColor: 'var(--border-dim)', backgroundColor: 'var(--bg-surface)' }}>
      <div className="shrink-0 flex items-center gap-1.5 px-2 border-r" style={{ width: headerWidth, borderColor: 'var(--border-dim)' }}
        title="Piste tempo : changements de tempo et de mesure (Pro Tools : règles Tempo et Meter ; Logic : piste Tempo globale)">
        <i className="fas fa-tachometer-alt text-[10px] text-amber-300" aria-hidden />
        <span className="text-[11px] font-black truncate" style={{ color: 'var(--text-primary)' }}>Tempo</span>
        <span className="text-[10px] font-mono text-slate-400 truncate">{start.bpm} · {start.num}/{start.den}</span>
        <button type="button" onClick={() => tempoLaneStore.set(false)} aria-label="Masquer la piste tempo" title="Masquer la piste tempo (Tempo et mesure → « Afficher la piste tempo » pour la remettre)"
          className="ml-auto w-6 h-6 rounded-md text-slate-500 hover:text-white hover:bg-white/10 shrink-0"><i className="fas fa-eye-slash text-[10px]" /></button>
      </div>
      <div className="relative flex-1 overflow-hidden cursor-pointer" onClick={onClick} title="Clique pour poser un changement de tempo ou de mesure à cette mesure">
        {step >= 10 && bars.map(b => (
          <div key={b.bar} className="absolute top-0 bottom-0 border-l pointer-events-none" style={{ left: b.time * zoomH - scrollLeft, borderColor: 'var(--grid-line)' }} />
        ))}
        {changes.map(s => {
          const left = s.time * zoomH - scrollLeft;
          if (left < -120 || left > width + 10) return null;
          const prev = map.segments[map.segments.indexOf(s) - 1];
          const label = [prev && prev.bpm === s.bpm ? null : `♩ ${s.bpm}`, prev && prev.num === s.num && prev.den === s.den ? null : `${s.num}/${s.den}`].filter(Boolean).join(' · ') || `♩ ${s.bpm}`;
          return (
            <button key={s.bar} type="button" data-testid={`tempo-badge-${s.bar}`}
              onClick={e => { e.stopPropagation(); onPick(s.bar); }}
              title={`Mesure ${s.bar + 1} : ${s.bpm} BPM, ${s.num}/${s.den}. Clic pour modifier ou supprimer.`}
              className="absolute top-[3px] h-5 px-1.5 rounded-md border text-[10px] font-black whitespace-nowrap bg-amber-500/15 border-amber-500/50 text-amber-300 hover:bg-amber-500/30"
              style={{ left: Math.max(0, left) }}>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default TempoLane;
