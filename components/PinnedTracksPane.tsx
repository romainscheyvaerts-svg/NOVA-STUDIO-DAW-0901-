import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Track, TrackType } from '../types';
import { setPinsProject, togglePin, usePinnedIds } from '../utils/trackPins';
import { applyTracks } from '../utils/structureBus';
import { useArrangementView, type ArrangementViewport as View } from '../hooks/useArrangementView';
import { playheadStore } from '../utils/playheadStore';
import { useSimpleMode } from '../utils/simpleMode';

/**
 * Pistes épinglées (écart 25) : un bandeau au-dessus de l'arrangement, hors de son
 * défilement vertical. Chaque piste épinglée y garde son nom, M / S, et ses clips
 * calés sur le zoom et le défilement horizontal de l'arrangement (lus dans la
 * disposition « zoom », sans toucher à ArrangementView). Un clic sur le couloir
 * sélectionne la piste et place la tête de lecture. Rien ne change dans le son.
 *
 * Aucune épingle : rien n'est rendu (léger).
 */
const ROW_H = 36;
const fmt = (t: Track) => (t.type === TrackType.AUDIO ? 'fa-wave-square' : t.type === TrackType.BUS || t.type === TrackType.SEND ? 'fa-random' : 'fa-music');

const Playhead: React.FC<{ view: View }> = ({ view }) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => { const x = playheadStore.get() * view.h - view.scroll; if (ref.current) { ref.current.style.transform = `translateX(${x}px)`; ref.current.style.opacity = x < 0 ? '0' : '1'; } };
    place();
    return playheadStore.subscribe(place);
  }, [view.h, view.scroll]);
  return <div ref={ref} className="pointer-events-none absolute inset-y-0 left-0 w-px bg-cyan-400" aria-hidden="true" />;
};

const PinnedRow: React.FC<{ t: Track; view: View; width: number; selected: boolean; onSelect: (id: string) => void; onSeek?: (t: number) => void }> = ({ t, view, width, selected, onSelect, onSeek }) => {
  const t0 = view.scroll / view.h, t1 = (view.scroll + width) / view.h;
  const clips = t.clips.filter(c => !c.isFreezeSlice && c.start + c.duration >= t0 && c.start <= t1).slice(0, 200);
  return (
    <div role="listitem" data-testid={`pinned-row-${t.id}`} className={`flex border-b border-nv-line/60 ${selected ? 'bg-nv-accent/10' : ''}`} style={{ height: ROW_H }}>
      <div className="flex shrink-0 items-center gap-1 border-r border-nv-line bg-nv-panel px-1.5" style={{ width: view.header }}>
        <button type="button" onClick={() => togglePin(t.id, false)} data-testid={`pinned-unpin-${t.id}`} aria-label={`Désépingler ${t.name}`} title="Désépingler"
          className="nova-hit-tactile flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-amber-400 hover:bg-amber-500/15"><i className="fas fa-thumbtack text-[11px]" /></button>
        <span className="h-5 w-1.5 shrink-0 rounded-sm" style={{ backgroundColor: t.color }} aria-hidden="true" />
        <button type="button" onClick={() => onSelect(t.id)} title={`${t.name} (épinglée)`}
          className={`min-w-0 flex-1 truncate text-left text-[12px] font-bold ${t.isHidden ? 'italic text-nv-muted' : 'text-nv-ink'}`}>
          <i className={`fas ${fmt(t)} mr-1 text-[10px] text-nv-muted`} aria-hidden="true" />{t.name}
        </button>
        <button type="button" aria-pressed={t.isMuted} aria-label={`Couper ${t.name}`} title="Couper (M)" data-testid={`pinned-mute-${t.id}`}
          onClick={() => applyTracks(ts => ts.map(x => (x.id === t.id ? { ...x, isMuted: !x.isMuted } : x)))}
          className={`nova-hit-tactile h-7 w-7 shrink-0 rounded-md text-[11px] font-black ${t.isMuted ? 'bg-amber-500 text-black' : 'bg-nv-well text-nv-muted hover:text-nv-ink'}`}>M</button>
        <button type="button" aria-pressed={t.isSolo} aria-label={`Solo ${t.name}`} title="Solo (S)" data-testid={`pinned-solo-${t.id}`}
          onClick={() => applyTracks(ts => ts.map(x => (x.id === t.id ? { ...x, isSolo: !x.isSolo } : x)))}
          className={`nova-hit-tactile h-7 w-7 shrink-0 rounded-md text-[11px] font-black ${t.isSolo ? 'bg-emerald-400 text-black' : 'bg-nv-well text-nv-muted hover:text-nv-ink'}`}>S</button>
      </div>
      <div className="relative min-w-0 flex-1 cursor-pointer overflow-hidden bg-nv-well/30" data-testid={`pinned-lane-${t.id}`}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSelect(t.id); onSeek?.(Math.max(0, (e.clientX - r.left + view.scroll) / view.h)); }}>
        {clips.map(c => (
          <div key={c.id} data-pinned-clip={c.id} className={`absolute top-1 bottom-1 overflow-hidden rounded-[4px] border px-1 text-[10px] font-bold leading-[26px] ${c.isMuted ? 'opacity-40' : ''}`}
            style={{ left: c.start * view.h - view.scroll, width: Math.max(2, c.duration * view.h), backgroundColor: `${c.color || t.color}55`, borderColor: c.color || t.color, color: 'var(--nv-ink, inherit)' }}
            title={c.name}>
            <span className="block truncate">{c.name}</span>
          </div>
        ))}
        {!t.clips.length && <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-nv-muted">Aucun clip</span>}
      </div>
    </div>
  );
};

const PinnedTracksPane: React.FC<{ visible: boolean; tracks: Track[]; projectId: string; selectedTrackId: string | null; onSelectTrack: (id: string) => void; onSeek?: (t: number) => void }> = ({ visible, tracks, projectId, selectedTrackId, onSelectTrack, onSeek }) => {
  useEffect(() => { setPinsProject(projectId); }, [projectId]);
  const ids = usePinnedIds();
  const byId = useMemo(() => new Map(tracks.map(t => [t.id, t])), [tracks]);
  // Pistes supprimées : simplement ignorées (au chargement d'un projet, les pistes changent avant le projet).
  const { simple } = useSimpleMode();
  const pinned = simple || !visible ? [] : ids.map(id => byId.get(id)).filter((t): t is Track => !!t && t.id !== 'master');
  const view = useArrangementView(pinned.length > 0);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(Math.max(0, el.clientWidth - view.header)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view.header, pinned.length > 0]);
  if (!pinned.length) return null;
  return (
    <section ref={boxRef} aria-label="Pistes épinglées" data-testid="pinned-tracks" data-pinned-count={pinned.length}
      className="relative z-[5] shrink-0 border-b-2 border-amber-400/50 bg-nv-panel shadow-md">
      <div role="list" className="relative max-h-[148px] overflow-y-auto">
        {pinned.map(t => <PinnedRow key={t.id} t={t} view={view} width={width} selected={t.id === selectedTrackId} onSelect={onSelectTrack} onSeek={onSeek} />)}
        <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: view.header }}><Playhead view={view} /></div>
      </div>
    </section>
  );
};

export default React.memo(PinnedTracksPane);
