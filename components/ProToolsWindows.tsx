import React, { useCallback, useEffect, useState } from 'react';
import { produce } from 'immer';
import type { Clip, DAWState, Marker, Track } from '../types';
import { NOVA_WINDOW_EVENT, NovaWindowDetail } from '../utils/novaWindows';
import { setKeyboardFocus, useKeyboardFocus } from '../utils/keyboardFocus';
import MemoryLocations from './MemoryLocations';
import StripSilenceDialog from './StripSilenceDialog';
import ClipPropsDialog from './ClipPropsDialog';

interface Props {
  tracks: Track[];
  markers: Marker[];
  bpm: number;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onEditClip: (trackId: string, clipId: string, action: string, payload?: any) => void;
  onSeek: (time: number) => void;
  onAddMarker: (time: number) => void;
  onUpdateMarker: (m: Marker) => void;
  onDeleteMarker: (id: string) => void;
  getPlayhead: () => number;
  onOpenShortcuts: () => void;
}

/**
 * Fenêtres « façon Pro Tools » ouvertes par événement (utils/novaWindows) :
 * repères (Memory Locations), Strip Silence, renommer / couleur de clip,
 * couleur de piste ; plus le témoin Commands Keyboard Focus.
 * App.tsx ne fait que monter ce composant.
 */
const ProToolsWindows: React.FC<Props> = ({ tracks, markers, bpm, setState, onEditClip, onSeek, onAddMarker, onUpdateMarker, onDeleteMarker, getPlayhead, onOpenShortcuts }) => {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [strip, setStrip] = useState<NovaWindowDetail | null>(null);
  const [props, setProps] = useState<NovaWindowDetail | null>(null);
  const focus = useKeyboardFocus();

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<NovaWindowDetail>).detail;
      if (!d) return;
      if (d.name === 'memory-locations') setMemoryOpen(v => !v);
      else if (d.name === 'strip-silence') setStrip(d);
      else if (d.name === 'clip-props' || d.name === 'track-color') setProps(d);
      else if (d.name === 'shortcuts') onOpenShortcuts();
    };
    window.addEventListener(NOVA_WINDOW_EVENT, onOpen);
    return () => window.removeEventListener(NOVA_WINDOW_EVENT, onOpen);
  }, [onOpenShortcuts]);

  const applyStrip = useCallback((results: { trackId: string; clipId: string; clips: Clip[] }[]) => {
    if (!results.length) return;
    setState(prev => produce(prev, (draft: DAWState) => {
      for (const r of results) {
        const t = draft.tracks.find(x => x.id === r.trackId);
        const i = t ? t.clips.findIndex(c => c.id === r.clipId) : -1;
        if (t && i > -1) t.clips.splice(i, 1, ...(r.clips as any));
      }
    }));
  }, [setState]);

  // Fenêtre renommer / couleur
  let propsView: React.ReactNode = null;
  if (props?.name === 'clip-props' && props.targets?.length) {
    const first = props.targets[0];
    const clip = tracks.find(t => t.id === first.trackId)?.clips.find(c => c.id === first.clipId);
    const track = tracks.find(t => t.id === first.trackId);
    if (clip) propsView = (
      <ClipPropsDialog open title={props.focus === 'color' ? 'Couleur du clip' : 'Renommer le clip'}
        ptHint={props.focus === 'color' ? 'Pro Tools : Clip Color' : 'Pro Tools : Rename Clip (Ctrl+Maj+R, ou double-clic)'}
        name={clip.name} color={clip.color || track?.color || '#00f2ff'} focus={props.focus}
        countLabel={props.targets.length > 1 ? `${props.targets.length} clips : la couleur s'applique à tous, le nom au premier.` : undefined}
        onSave={({ name, color }) => {
          props.targets!.forEach((t, i) => {
            const patch: Partial<Clip> = {};
            if (color) patch.color = color;
            if (name && i === 0) patch.name = name;
            if (Object.keys(patch).length) onEditClip(t.trackId, t.clipId, 'UPDATE_PROPS', patch);
          });
        }}
        onClose={() => setProps(null)} />
    );
  } else if (props?.name === 'track-color' && props.trackId) {
    const track = tracks.find(t => t.id === props.trackId);
    if (track) propsView = (
      <ClipPropsDialog open title={`Couleur de la piste ${track.name}`} ptHint="Pro Tools : Track Color" color={track.color} focus="color"
        onSave={({ color }) => color && setState(prev => produce(prev, (draft: DAWState) => {
          const t = draft.tracks.find(x => x.id === props.trackId);
          if (t) t.color = color;
        }))}
        onClose={() => setProps(null)} />
    );
  }

  return (
    <>
      <MemoryLocations open={memoryOpen} onClose={() => setMemoryOpen(false)} markers={markers} bpm={bpm}
        onGoTo={onSeek} onAdd={() => onAddMarker(getPlayhead())} onUpdate={onUpdateMarker} onDelete={onDeleteMarker} />
      <StripSilenceDialog open={!!strip} tracks={tracks} targets={strip?.targets || []} onApply={applyStrip} onClose={() => setStrip(null)} />
      {propsView}
      {focus && (
        <button type="button" onClick={() => setKeyboardFocus(false)} data-testid="keyboard-focus-badge"
          title="Commands Keyboard Focus actif : une touche = une commande (A, S, D, G, R, T…). Clic ou Ctrl+Alt+1 pour l'arrêter. Ctrl+Espace enregistre."
          className="fixed bottom-24 left-3 z-[600] rounded-lg border border-amber-400/60 bg-amber-400/15 px-2.5 py-1.5 text-[11px] font-black text-amber-300 shadow-lg [@media(max-width:640px)]:hidden">
          a–z <span className="font-semibold text-amber-200/80">Keyboard Focus</span>
        </button>
      )}
    </>
  );
};

export default ProToolsWindows;
