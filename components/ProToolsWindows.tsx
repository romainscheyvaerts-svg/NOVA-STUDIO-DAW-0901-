import React, { useCallback, useEffect, useState } from 'react';
import { produce } from 'immer';
import type { Clip, DAWState, Marker, Track } from '../types';
import { NOVA_WINDOW_EVENT, NovaWindowDetail } from '../utils/novaWindows';
import { setKeyboardFocus, useKeyboardFocus } from '../utils/keyboardFocus';
import MemoryLocations from './MemoryLocations';
import StripSilenceDialog from './StripSilenceDialog';
import ClipPropsDialog from './ClipPropsDialog';
import PitchEditor from './PitchEditor';
import AudioToMidiDialog, { AudioToMidiRequest } from './AudioToMidiDialog';
import AraDialog, { AraApply } from './AraDialog';

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
  /** Tonalité du projet (justesse note par note). */
  projectKey?: number;
  projectScale?: string;
  /** Temps par mesure (audio → MIDI, V20). */
  beatsPerBar?: number;
}

/**
 * Fenêtres « façon Pro Tools » ouvertes par événement (utils/novaWindows) :
 * repères (Memory Locations), Strip Silence, renommer / couleur de clip,
 * couleur de piste ; plus le témoin Commands Keyboard Focus.
 * App.tsx ne fait que monter ce composant.
 */
const ProToolsWindows: React.FC<Props> = ({ tracks, markers, bpm, setState, onEditClip, onSeek, onAddMarker, onUpdateMarker, onDeleteMarker, getPlayhead, onOpenShortcuts, projectKey, projectScale, beatsPerBar }) => {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [strip, setStrip] = useState<NovaWindowDetail | null>(null);
  const [props, setProps] = useState<NovaWindowDetail | null>(null);
  const [pitch, setPitch] = useState<NovaWindowDetail | null>(null);
  const [convert, setConvert] = useState<AudioToMidiRequest | null>(null);
  const [ara, setAra] = useState<NovaWindowDetail | null>(null);
  const focus = useKeyboardFocus();

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<NovaWindowDetail>).detail;
      if (!d) return;
      if (d.name === 'memory-locations') setMemoryOpen(v => !v);
      else if (d.name === 'strip-silence') setStrip(d);
      else if (d.name === 'clip-props' || d.name === 'track-color') setProps(d);
      else if (d.name === 'shortcuts') onOpenShortcuts();
      else if (d.name === 'pitch-editor' && d.targets?.length) setPitch(d);
      // Audio → MIDI (V20) : mélodie, batterie, harmonie.
      else if (d.name === 'audio-to-midi' && d.convert) setConvert({ ...d.convert, trackId: d.targets?.[0]?.trackId, clipId: d.targets?.[0]?.clipId });
      else if ((d.name === 'ara-melodyne' || d.name === 'ara-vocalign') && d.targets?.length) setAra(d);
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

  // Justesse note par note (V19) : une seule étape d'annulation par correction.
  const applyPitch = useCallback((trackId: string, clipId: string, patch: Partial<Clip>, message: string) => {
    setState(prev => produce(prev, (draft: DAWState) => {
      const c = draft.tracks.find(x => x.id === trackId)?.clips.find(x => x.id === clipId);
      if (!c) return;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (c as any)[k]; else (c as any)[k] = v;
      }
    }));
    try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: message })); } catch { /* hors navigateur */ }
  }, [setState]);

  // Melodyne / VocAlign (ARA) : tous les clips changés en une seule étape d'annulation.
  const applyAra = useCallback((changes: AraApply[], message: string) => {
    setState(prev => produce(prev, (draft: DAWState) => {
      for (const ch of changes) {
        const c = draft.tracks.find(x => x.id === ch.trackId)?.clips.find(x => x.id === ch.clipId);
        if (!c) continue;
        for (const [k, v] of Object.entries(ch.patch)) {
          if (v === undefined) delete (c as any)[k]; else (c as any)[k] = v;
        }
      }
    }));
    try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: message })); } catch { /* hors navigateur */ }
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
      <PitchEditor open={!!pitch} trackId={pitch?.targets?.[0]?.trackId} clipId={pitch?.targets?.[0]?.clipId} tracks={tracks}
        projectKey={projectKey} projectScale={projectScale} onApply={applyPitch} onClose={() => setPitch(null)} />
      <AudioToMidiDialog request={convert} tracks={tracks} bpm={bpm} beatsPerBar={beatsPerBar} projectKey={projectKey} projectScale={projectScale}
        setState={setState} onClose={() => setConvert(null)} />
      <AraDialog open={!!ara} plugin={ara?.name === 'ara-vocalign' ? 'vocalign' : 'melodyne'} trackId={ara?.targets?.[0]?.trackId}
        clipId={ara?.targets?.[0]?.clipId} tracks={tracks} bpm={bpm} onApply={applyAra} onClose={() => setAra(null)} />
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
