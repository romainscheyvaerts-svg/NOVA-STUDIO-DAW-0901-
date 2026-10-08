import React, { useCallback, useEffect, useState } from 'react';
import { produce } from 'immer';
import type { Clip, DAWState, Marker, Track } from '../types';
import { NOVA_WINDOW_EVENT, NovaWindowDetail } from '../utils/novaWindows';
import { setKeyboardFocus, useKeyboardFocus } from '../utils/keyboardFocus';
import MemoryLocations from './MemoryLocations';
import ClipPropsDialog from './ClipPropsDialog';
import type { AudioToMidiRequest } from './AudioToMidiDialog';
import AraDialog, { AraApply } from './AraDialog';
import { lazyWithPreload, MountWhenOpened } from '../utils/lazyPreload';

// Fenêtres d'édition chargées à la demande (paquet principal plus léger), préchargées quand
// le navigateur est libre (App : preloadWhenIdle) : elles s'ouvrent dans la même image que le clic.
const StripSilenceDialog = lazyWithPreload(() => import('./StripSilenceDialog'));
const PitchEditor = lazyWithPreload(() => import('./PitchEditor'));
const PitchBatchDialog = lazyWithPreload(() => import('./PitchBatchDialog'));
const AudioToMidiDialog = lazyWithPreload(() => import('./AudioToMidiDialog'));
const TrackPresetDialog = lazyWithPreload(() => import('./TrackPresetDialog'));
const BounceDialog = lazyWithPreload(() => import('./BounceDialog'));
const AudioSuiteDialog = lazyWithPreload(() => import('./AudioSuiteDialog'));
const TransposeDialog = lazyWithPreload(() => import('./TransposeDialog'));
const WarpMarkers = lazyWithPreload(() => import('./WarpMarkers'));
export const PRO_TOOLS_WINDOWS_PRELOAD = [PitchEditor, TrackPresetDialog, StripSilenceDialog, AudioSuiteDialog, TransposeDialog, PitchBatchDialog, AudioToMidiDialog, BounceDialog, WarpMarkers];
import { editingElastic, elasticBlock, elasticRevertPatch, withDuration, withTempo } from '../utils/clipTranspose';
import { applyClipPatches, doneMessage, renderElasticClip } from '../services/elasticRender';
import { audioSuiteRevertPatch, patchClip } from '../utils/clipProcess';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

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
  const [pitchBatch, setPitchBatch] = useState<NovaWindowDetail | null>(null);
  const [convert, setConvert] = useState<AudioToMidiRequest | null>(null);
  const [ara, setAra] = useState<NovaWindowDetail | null>(null);
  const [trackPreset, setTrackPreset] = useState<NovaWindowDetail | null>(null);
  const [bounce, setBounce] = useState<NovaWindowDetail | null>(null);
  const [suite, setSuite] = useState<NovaWindowDetail | null>(null);
  const [transpose, setTranspose] = useState<NovaWindowDetail | null>(null);
  const [warp, setWarp] = useState<NovaWindowDetail | null>(null);
  const tracksRef = React.useRef(tracks);
  tracksRef.current = tracks;
  const say = (detail: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail })); } catch { /* hors navigateur */ } };
  // Transposition / warp : « Revenir à l'original » depuis le menu du clip (une étape d'annulation).
  const revertElastic = useCallback((targets: { trackId: string; clipId: string }[]) => {
    const has = (id: string) => !!audioBufferRegistry.get(id);
    const patches = targets.map(t => {
      const c = tracksRef.current.find(x => x.id === t.trackId)?.clips.find(x => x.id === t.clipId);
      const p = c?.elastic ? elasticRevertPatch(c, has) : null;
      return p ? { ...t, patch: p } : null;
    }).filter(Boolean) as { trackId: string; clipId: string; patch: Partial<Clip> }[];
    if (!patches.length) { say("L'original n'est pas sur cet appareil (projet reçu en collaboration) : rouvre « Transposer » et remets 0."); return; }
    applyClipPatches(setState, patches);
    say("↩️ Clip revenu à l'original (tonalité et durée d'avant). Ctrl+Z pour retrouver le rendu.");
  }, [setState]);
  // Trim TCE (Pro Tools) / Alt + bord (Logic) : le clip est étiré à sa nouvelle durée, hauteur inchangée.
  const tceRender = useCallback(async (trackId: string, clipId: string, tce: { start: number; duration: number }) => {
    const has = (id: string) => !!audioBufferRegistry.get(id);
    const c = tracksRef.current.find(x => x.id === trackId)?.clips.find(x => x.id === clipId);
    if (!c) return;
    const block = elasticBlock(c);
    if (block) { say(block); return; }
    const info = withDuration(editingElastic(c, has).info, tce.duration);
    say(`⏳ Étirement de « ${c.name} »…`);
    try {
      const { patch } = await renderElasticClip(c, info);
      // Bord gauche tiré : la fin du clip reste en place (durée éventuellement bornée à 25-400 %).
      const fromLeft = Math.abs(tce.start - c.start) > 1e-9;
      const start = fromLeft ? c.start + c.duration - (patch.duration ?? tce.duration) : c.start;
      applyClipPatches(setState, [{ trackId, clipId, patch: { ...patch, start: Math.max(0, start) } }]);
      say(doneMessage(info));
    } catch (e: any) { say(`❌ Étirement impossible : ${e?.message || e}`); }
  }, [setState]);
  // « Revenir à l'original » (AudioSuite) depuis le menu du clip : une seule étape d'annulation.
  const revertSuite = useCallback((targets: { trackId: string; clipId: string }[]) => {
    const ids = new Set(targets.map(t => t.clipId));
    setState(prev => ({
      ...prev,
      tracks: prev.tracks.map(t => (t.clips.some(c => ids.has(c.id) && c.audioSuite) ? {
        ...t,
        clips: t.clips.map(c => {
          if (!ids.has(c.id) || !c.audioSuite) return c;
          const p = audioSuiteRevertPatch(c, id => !!audioBufferRegistry.get(id));
          return p ? patchClip(c, p) : c;
        }),
      } : t)),
    }));
    try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: "↩️ Clip revenu à l'original (AudioSuite). Ctrl+Z pour retrouver le son traité." })); } catch { /* hors navigateur */ }
  }, [setState]);
  // Calage au tempo (R13, warp d'Ableton) : un clip calé suit le tempo du projet (rendu refait
  // depuis l'original, une fois le geste fini).
  useEffect(() => {
    const has = (id: string) => !!audioBufferRegistry.get(id);
    const timer = window.setTimeout(async () => {
      const todo = tracksRef.current.flatMap(t => t.clips.filter(c => c.elastic?.tempo && Math.abs(c.elastic.tempo.bpm - bpm) > 0.01).map(c => ({ trackId: t.id, clip: c })));
      if (!todo.length) return;
      const patches: { trackId: string; clipId: string; patch: Partial<Clip> }[] = [];
      for (const { trackId, clip } of todo) {
        try {
          const ed = editingElastic(clip, has);
          if (!ed.fromOriginal) continue;
          const { patch } = await renderElasticClip(clip, withTempo(ed.info, clip.elastic!.tempo!.sourceBpm, bpm));
          patches.push({ trackId, clipId: clip.id, patch });
        } catch (e) { console.warn('[R13] calage au tempo', e); }
      }
      if (patches.length) { applyClipPatches(setState, patches); say(`⏱️ ${patches.length > 1 ? `${patches.length} samples recalés` : 'Sample recalé'} sur ${Math.round(bpm * 100) / 100} BPM (hauteur gardée).`); }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [bpm, setState]); // eslint-disable-line react-hooks/exhaustive-deps
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
      else if (d.name === 'pitch-batch' && d.targets?.length) setPitchBatch(d);
      // Audio → MIDI (V20) : mélodie, batterie, harmonie.
      else if (d.name === 'audio-to-midi' && d.convert) setConvert({ ...d.convert, trackId: d.targets?.[0]?.trackId, clipId: d.targets?.[0]?.clipId });
      else if ((d.name === 'ara-melodyne' || d.name === 'ara-vocalign') && d.targets?.length) setAra(d);
      else if (d.name === 'track-preset') setTrackPreset(d);
      else if (d.name === 'bounce' || d.name === 'print-bus') setBounce(d);
      else if (d.name === 'audiosuite') { if (d.revert && d.targets?.length) revertSuite(d.targets); else if (d.targets?.length || d.range) setSuite(d); }
      // R13 : transposer / étirer, marqueurs de warp, Trim TCE.
      else if (d.name === 'transpose' && d.targets?.length) { if (d.revert) revertElastic(d.targets); else setTranspose(d); }
      else if (d.name === 'warp' && d.targets?.length) setWarp(d);
      else if (d.name === 'elastic-tce' && d.targets?.length && d.tce) void tceRender(d.targets[0].trackId, d.targets[0].clipId, d.tce);
    };
    window.addEventListener(NOVA_WINDOW_EVENT, onOpen);
    return () => window.removeEventListener(NOVA_WINDOW_EVENT, onOpen);
  }, [onOpenShortcuts, revertSuite, revertElastic, tceRender]);

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

  // Justesse sur plusieurs clips : tous les changements en UN setState (une seule annulation).
  const applyPitchMany = useCallback((patches: { trackId: string; clipId: string; patch: Partial<Clip> }[], message: string) => {
    setState(prev => produce(prev, (draft: DAWState) => {
      for (const { trackId, clipId, patch } of patches) {
        const c = draft.tracks.find(x => x.id === trackId)?.clips.find(x => x.id === clipId);
        if (!c) continue;
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete (c as any)[k]; else (c as any)[k] = v;
        }
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
      <MountWhenOpened when={!!strip}><StripSilenceDialog open={!!strip} tracks={tracks} targets={strip?.targets || []} onApply={applyStrip} onClose={() => setStrip(null)} /></MountWhenOpened>
      {propsView}
      <MountWhenOpened when={!!pitch}><PitchEditor open={!!pitch} trackId={pitch?.targets?.[0]?.trackId} clipId={pitch?.targets?.[0]?.clipId} tracks={tracks}
        projectKey={projectKey} projectScale={projectScale} onApply={applyPitch} onClose={() => setPitch(null)} /></MountWhenOpened>
      <MountWhenOpened when={!!pitchBatch}><PitchBatchDialog open={!!pitchBatch} targets={pitchBatch?.targets || []} tracks={tracks}
        projectKey={projectKey} projectScale={projectScale} onApply={applyPitchMany} onClose={() => setPitchBatch(null)} /></MountWhenOpened>
      <MountWhenOpened when={!!convert}><AudioToMidiDialog request={convert} tracks={tracks} bpm={bpm} beatsPerBar={beatsPerBar} projectKey={projectKey} projectScale={projectScale}
        setState={setState} onClose={() => setConvert(null)} /></MountWhenOpened>
      <AraDialog open={!!ara} plugin={ara?.name === 'ara-vocalign' ? 'vocalign' : 'melodyne'} trackId={ara?.targets?.[0]?.trackId}
        clipId={ara?.targets?.[0]?.clipId} tracks={tracks} bpm={bpm} onApply={applyAra} onClose={() => setAra(null)} />
      <MountWhenOpened when={!!trackPreset}><TrackPresetDialog open={!!trackPreset} trackId={trackPreset?.trackId} tracks={tracks} setState={setState} onClose={() => setTrackPreset(null)} /></MountWhenOpened>
      <MountWhenOpened when={!!bounce}><BounceDialog open={!!bounce} mode={bounce?.name === 'print-bus' ? 'bus' : bounce?.bounce?.mode === 'range' ? 'range' : 'commit'} trackId={bounce?.trackId}
        range={bounce?.range} tracks={tracks} setState={setState} onClose={() => setBounce(null)} /></MountWhenOpened>
      <MountWhenOpened when={!!suite}><AudioSuiteDialog open={!!suite} targets={suite?.targets} range={suite?.range} tracks={tracks} setState={setState} onClose={() => setSuite(null)} /></MountWhenOpened>
      <MountWhenOpened when={!!transpose}><TransposeDialog open={!!transpose} targets={transpose?.targets || []} tracks={tracks} bpm={bpm} simple={!!transpose?.simple} setState={setState} onClose={() => setTranspose(null)} /></MountWhenOpened>
      <MountWhenOpened when={!!warp}><WarpMarkers open={!!warp} trackId={warp?.targets?.[0]?.trackId} clipId={warp?.targets?.[0]?.clipId} tracks={tracks} bpm={bpm} setState={setState} onClose={() => setWarp(null)} /></MountWhenOpened>
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
