import React, { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { produce } from 'immer';
import { Clip, DAWState, MidiNote, Track, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { clipRegionChannels } from '../utils/drumSamples';
import { loadPadBuffer } from '../utils/padBuffers';
import type { DrumMachine } from '../utils/drumKits';
import { DEFAULT_SAMPLER, MelodicSamplerSettings, newSamplerSampleId, normalizeSampler, noteName, samplerBufferKey } from '../utils/melodicSampler';
import { detectRoot } from '../utils/samplerRoot';
import { instrumentPreset, settingsForInstrument } from '../utils/instrumentPresets';
import { closeSamplerPanel, openSamplerPanel, SAMPLER_EVENT, SamplerRequest, useSamplerPanelTrack } from '../utils/samplerPanelStore';
import { playheadStore } from '../utils/playheadStore';
import { UI_CONFIG } from '../utils/constants';
import { clearInstrumentRender } from '../services/VstInstrument';
import PanelBoundary from './PanelBoundary';

const SamplerPanel = lazy(() => import('./SamplerPanel'));
const ChopClipDialog = lazy(() => import('./ChopClipDialog'));

/**
 * R18 · Tout le sampler mélodique côté interface : créer une piste
 * « Sampler » (vide ou avec un instrument R20), « Convertir en sampler »
 * depuis le menu d'un clip audio ou d'un pad, l'écran du sampler et la
 * découpe (chop) d'un clip de l'arrangement. Monté une fois dans App.
 */

interface Props {
  tracks: Track[];
  bpm: number;
  isMobile: boolean;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  getState: () => DAWState;
  notify: (msg: string) => void;
  ensureEngine: () => Promise<unknown>;
  /** Ouvre le piano roll sur un clip. */
  openPianoRoll?: (trackId: string, clipId: string) => void;
}

const DRUM_TRACK_ID = 'track-drums';
const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

/** Range un son comme sample de sampler et trouve sa note racine. */
export function registerSamplerSound(buffer: AudioBuffer, name: string): Partial<MelodicSamplerSettings> {
  const id = newSamplerSampleId();
  audioBufferRegistry.register(buffer, samplerBufferKey(id));
  const root = detectRoot(channelsOf(buffer), buffer.sampleRate);
  return {
    sampleId: id, sampleName: (name || 'Sample').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 40), duration: buffer.duration,
    instrument: undefined, slices: undefined, sliceBase: undefined,
    ...(root && root.voiced > 0.35 ? { rootKey: root.midi, fineTune: root.fineTune, rootAuto: true } : { rootKey: 60, fineTune: 0, rootAuto: false }),
  };
}

const SamplerHost: React.FC<Props> = ({ tracks, bpm, isMobile, setState, getState, notify, ensureEngine, openPianoRoll }) => {
  const openId = useSamplerPanelTrack();
  const [chop, setChop] = React.useState<{ trackId: string; clipId: string } | null>(null);
  const busy = useRef(false);

  /** Nouvelle piste MIDI jouée par le sampler, avec un clip (vide ou les notes données). */
  const createSamplerTrack = useCallback((o: {
    name: string; settings: MelodicSamplerSettings; notes?: MidiNote[]; start?: number; duration?: number; afterTrackId?: string;
  }) => {
    const st = getState();
    const stamp = Date.now().toString(36);
    const trackId = `track-sampler-${stamp}`;
    const clipId = `clip-sampler-${stamp}`;
    const bar = (60 / (st.bpm || 120)) * 4;
    const start = o.start ?? Math.floor(playheadStore.get() / bar) * bar;
    const duration = Math.max(bar, o.duration ?? bar * 4);
    const color = UI_CONFIG.TRACK_COLORS[(st.tracks.length + 3) % UI_CONFIG.TRACK_COLORS.length];
    setState(produce((d: DAWState) => {
      const clip: Clip = { id: clipId, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: o.name, color, type: TrackType.MIDI, notes: o.notes || [], isMuted: false, gain: 1 };
      const track: Track = {
        id: trackId, name: o.name.toUpperCase().slice(0, 28), type: TrackType.MIDI, color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
        volume: 0.85, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
        melodicSampler: o.settings, clips: [clip],
      };
      const after = o.afterTrackId ? d.tracks.findIndex(t => t.id === o.afterTrackId) : -1;
      const rec = d.tracks.findIndex(t => t.id === 'track-rec-main');
      d.tracks.splice(after >= 0 ? after + 1 : rec >= 0 ? rec : d.tracks.length, 0, track);
      d.selectedTrackId = trackId;
    }) as (s: DAWState) => DAWState);
    return { trackId, clipId };
  }, [getState, setState]);

  const nextName = (base: string) => {
    const n = getState().tracks.filter(t => t.melodicSampler).length + 1;
    return n > 1 ? `${base} ${n}` : base;
  };

  const handle = useCallback(async (r: SamplerRequest) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await ensureEngine();
      const ctx = audioEngine.ctx;
      if (r.kind === 'new') {
        const p = r.instrument ? instrumentPreset(r.instrument) : undefined;
        const settings = normalizeSampler({ ...DEFAULT_SAMPLER, ...(p ? settingsForInstrument(p.id) : {}) });
        const { trackId, clipId } = createSamplerTrack({ name: p ? p.name : nextName('Sampler'), settings });
        openSamplerPanel(trackId);
        notify(p
          ? `${p.emoji} ${p.name} posé sur une nouvelle piste : joue-le au clavier ou dessine tes notes au piano roll.`
          : '🎛️ Sampler créé : charge un son (fichier, micro ou clip) ou choisis un instrument, il se joue sur tout le clavier.');
        void clipId;
        return;
      }
      if (r.kind === 'assign') {
        const p = r.instrument ? instrumentPreset(r.instrument) : undefined;
        setState(produce((d: DAWState) => {
          const t = d.tracks.find(x => x.id === r.trackId);
          if (!t || t.type !== TrackType.MIDI) return;
          if (t.vstInstrument) { clearInstrumentRender(t); delete t.vstInstrument; }
          delete t.bass808;
          const keep = !p && t.melodicSampler ? t.melodicSampler : {};
          t.melodicSampler = normalizeSampler({ ...DEFAULT_SAMPLER, ...keep, ...(p ? settingsForInstrument(p.id) : {}) });
        }) as (s: DAWState) => DAWState);
        if (!p) openSamplerPanel(r.trackId);
        notify(p ? `${p.emoji} ${p.name} sur ta piste : tes notes le jouent tout de suite.` : '🎛️ Sampler sur ta piste : charge un son (fichier, micro ou clip).');
        return;
      }
      if (!ctx) return;
      if (r.kind === 'from-clip') {
        const st = getState();
        const t = st.tracks.find(x => x.id === r.trackId);
        const c = t?.clips.find(x => x.id === r.clipId);
        const src = c?.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined;
        if (!t || !c || !src) { notify('Ce clip n’a pas de son chargé : attends la fin du chargement, puis réessaie.'); return; }
        const chans = clipRegionChannels(channelsOf(src), src.sampleRate, c);
        const b = ctx.createBuffer(chans.length, Math.max(1, chans[0].length), src.sampleRate);
        chans.forEach((ch, i) => b.getChannelData(i).set(ch));
        const sound = registerSamplerSound(b, c.name || 'Clip');
        const settings = normalizeSampler({ ...DEFAULT_SAMPLER, ...sound });
        // Une note sur la racine, à la place du clip : le sampler rejoue l'original à l'identique.
        const note: MidiNote = { id: `n-${Date.now().toString(36)}`, pitch: settings.rootKey, start: 0, duration: c.duration, velocity: 1 };
        const { trackId } = createSamplerTrack({ name: `Sampler ${c.name || ''}`.trim(), settings: { ...settings, velSens: 0 }, notes: [note], start: c.start, duration: c.duration, afterTrackId: t.id });
        setState(produce((d: DAWState) => {
          const cc = d.tracks.find(x => x.id === r.trackId)?.clips.find(x => x.id === r.clipId);
          if (cc) cc.isMuted = true;
        }) as (s: DAWState) => DAWState);
        openSamplerPanel(trackId);
        notify(`🎛️ « ${c.name || 'Clip'} » est dans un sampler${sound.rootAuto ? ` (note racine trouvée : ${noteName(settings.rootKey)}${Math.abs(settings.fineTune) >= 1 ? `, ${settings.fineTune > 0 ? '+' : ''}${Math.round(settings.fineTune)} cents` : ''})` : ''} : joue-le au clavier. Le clip d’origine est coupé (M pour le rallumer, Ctrl+Z pour tout annuler).`);
        return;
      }
      if (r.kind === 'from-pad') {
        const st = getState();
        const dm = st.tracks.find(x => x.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine | undefined;
        const row = dm?.rows[r.rowIndex];
        if (!row) return;
        const root = typeof st.projectKey === 'number' ? st.projectKey : 0;
        const b = await loadPadBuffer(row, ctx, root);
        const sound = registerSamplerSound(b, row.name);
        const settings = normalizeSampler({ ...DEFAULT_SAMPLER, ...sound });
        const { trackId } = createSamplerTrack({ name: `Sampler ${row.name}`, settings, afterTrackId: DRUM_TRACK_ID });
        openSamplerPanel(trackId);
        notify(`🎛️ Le son du pad « ${row.name} » est dans un sampler : il se joue sur tout le clavier (808 mélodique, perc accordée…).`);
        return;
      }
      if (r.kind === 'chop-clip') setChop({ trackId: r.trackId, clipId: r.clipId });
    } catch (e) {
      notify(`Impossible de préparer le sampler : ${e instanceof Error ? e.message : 'son illisible'}.`);
    } finally {
      busy.current = false;
    }
  }, [createSamplerTrack, ensureEngine, getState, notify, setState]);

  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<SamplerRequest>).detail; if (d && typeof d === 'object' && 'kind' in d) void handle(d); };
    window.addEventListener(SAMPLER_EVENT, on);
    return () => window.removeEventListener(SAMPLER_EVENT, on);
  }, [handle]);

  const track = openId ? tracks.find(t => t.id === openId && t.melodicSampler) : undefined;
  // Piste supprimée ou devenue synthé : l'écran se ferme.
  useEffect(() => { if (openId && !track) closeSamplerPanel(); }, [openId, track]);

  const onChange = useCallback((trackId: string, patch: Partial<MelodicSamplerSettings>) => {
    setState(produce((d: DAWState) => {
      const t = d.tracks.find(x => x.id === trackId);
      if (!t?.melodicSampler) return;
      t.melodicSampler = normalizeSampler({ ...t.melodicSampler, ...patch });
    }) as (s: DAWState) => DAWState);
  }, [setState]);

  const onBackToSynth = useCallback((trackId: string) => {
    setState(produce((d: DAWState) => {
      const t = d.tracks.find(x => x.id === trackId);
      if (t) delete t.melodicSampler;
    }) as (s: DAWState) => DAWState);
    closeSamplerPanel();
    notify('La piste rejoue le synthé (Ctrl+Z pour revenir au sampler).');
  }, [setState, notify]);

  return (
    <>
      {track && (
        <PanelBoundary name="le sampler" overlay onClose={closeSamplerPanel}>
          <Suspense fallback={null}>
            <SamplerPanel track={track} isMobile={isMobile} bpm={bpm}
              onChange={patch => onChange(track.id, patch)}
              onClose={closeSamplerPanel}
              onBackToSynth={() => onBackToSynth(track.id)}
              onOpenPianoRoll={openPianoRoll ? () => { const c = track.clips.find(x => x.type === TrackType.MIDI); if (c) { closeSamplerPanel(); openPianoRoll(track.id, c.id); } } : undefined}
              ensureEngine={ensureEngine} notify={notify}
              sessionClips={tracks.filter(t => t.type === TrackType.AUDIO).flatMap(t => t.clips.filter(c => c.bufferId && !c.isMuted).map(c => ({ trackId: t.id, clip: c, trackName: t.name })))} />
          </Suspense>
        </PanelBoundary>
      )}
      {chop && (
        <PanelBoundary name="la découpe" overlay onClose={() => setChop(null)}>
          <Suspense fallback={null}>
            <ChopClipDialog target={chop} tracks={tracks} bpm={bpm} isMobile={isMobile} setState={setState} getState={getState}
              createSamplerTrack={createSamplerTrack} notify={notify} onClose={() => setChop(null)} />
          </Suspense>
        </PanelBoundary>
      )}
    </>
  );
};

export default SamplerHost;
