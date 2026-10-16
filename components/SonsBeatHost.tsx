import React, { useCallback, useEffect, useRef } from 'react';
import type { DAWState, MidiNote, Track } from '../types';
import { TrackType } from '../types';
import type { ChordEvent } from '../utils/chordDetect';
import type { DrumMachine } from '../utils/drumKits';
import { KIT_SOUND_DROP_EVENT, kitIndexIfLoaded, loadKitIndex, type KitIndex } from '../utils/drumKitLibrary';
import { requestSampler } from '../utils/samplerPanelStore';
import { playheadStore } from '../utils/playheadStore';
import { editSelectionStore } from '../utils/editSelection';
import { applyBeatSkeleton, BEAT_CHORDS_TRACK_ID, buildBeat, DRUM_TRACK_ID, hasLoadedBeat, type BeatSkeleton } from '../utils/beatStarter';
import { BASS808_TRACK_ID } from '../utils/bass808';
import { genreFromText, PROGRESSIONS, type BeatGenreId } from '../utils/beatRecipes';
import { loopBars, placeLoop, placeStudioSound, snapToBar, withDrumMachine } from '../utils/soundPlace';
import { parseLoopRef } from '../utils/soundSearch';
import { extendNotes, varyRuleOf, varyVariants, VARY_RULES, type VaryContext } from '../utils/patternVary';
import { projectInfoStore, SOUND_PLACE_EVENT, sonsBeatStore, useSonsBeatPanel, type SoundPlaceRequest } from '../utils/sonsBeatStore';
import SoundLibrary from './SoundLibrary';
import BeatStarterDialog from './BeatStarterDialog';
import PatternVaryDialog from './PatternVaryDialog';

/**
 * Lots 5 et 10 · Branchement unique (App.tsx) du navigateur de sons, de la Palette, de
 * « Démarrer un beat » et de « Prolonger / Varier » : fenêtres, poses (une étape d'annulation
 * chacune) et actions du chatbot (START_BEAT, VARY_MIDI).
 */

export interface SonsBeatHostProps {
  tracks: Track[];
  bpm: number;
  projectKey?: number;
  projectScale?: string;
  beatsPerBar: number;
  getState: () => DAWState;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  notify: (msg: string) => void;
  ensureEngine: () => Promise<unknown>;
  isMobile: boolean;
}

const kitIx = async (): Promise<KitIndex | null> => kitIndexIfLoaded() || loadKitIndex().catch(() => null);

/** Clip MIDI visé : celui demandé, sinon le clip sélectionné, sinon le 1er clip MIDI de la piste sélectionnée. */
export function midiTarget(st: DAWState, trackId?: string, clipId?: string): { track: Track; clip: NonNullable<Track['clips']>[number] } | null {
  const isMidi = (t: Track) => t.type === TrackType.MIDI && !t.drumMachine;
  const withNotes = (c: Track['clips'][number]) => c.type === TrackType.MIDI && !!c.notes?.length;
  if (trackId) {
    const t = st.tracks.find(x => x.id === trackId);
    const c = t && (clipId ? t.clips.find(x => x.id === clipId) : t.clips.find(withNotes));
    return t && c && isMidi(t) ? { track: t, clip: c } : null;
  }
  for (const id of editSelectionStore.get().clipIds) {
    for (const t of st.tracks) { const c = t.clips.find(x => x.id === id); if (c && isMidi(t) && withNotes(c)) return { track: t, clip: c }; }
  }
  const sel = st.tracks.find(t => t.id === st.selectedTrackId);
  const c = sel && isMidi(sel) ? sel.clips.find(withNotes) : undefined;
  return sel && c ? { track: sel, clip: c } : null;
}

const varyCtx = (st: DAWState, clipStart: number): VaryContext => ({
  bpm: st.bpm || 120, root: typeof st.projectKey === 'number' ? st.projectKey : null, scale: st.projectScale, chords: st.chords as ChordEvent[] | undefined, clipStart,
});

/** Remplace les notes (et la durée) d'un clip : état suivant. */
export function withClipNotes(st: DAWState, trackId: string, clipId: string, notes: MidiNote[], duration: number): DAWState {
  return {
    ...st,
    tracks: st.tracks.map(t => (t.id !== trackId ? t : { ...t, clips: t.clips.map(c => (c.id !== clipId ? c : { ...c, notes, duration })) })),
  };
}

const SonsBeatHost: React.FC<SonsBeatHostProps> = p => {
  const panel = useSonsBeatPanel();
  const pRef = useRef(p);
  pRef.current = p;
  useEffect(() => {
    sonsBeatStore.setHelpers({ ensureEngine: () => pRef.current.ensureEngine(), notify: m => pRef.current.notify(m) });
    return () => sonsBeatStore.setHelpers({});
  }, []);

  // Tempo / tonalité du projet pour le navigateur du panneau de gauche.
  useEffect(() => {
    projectInfoStore.set({
      bpm: p.bpm || 120, root: typeof p.projectKey === 'number' ? ((p.projectKey % 12) + 12) % 12 : null, scale: p.projectScale || null,
      hasBeat: hasLoadedBeat({ tracks: p.tracks }), beatsPerBar: p.beatsPerBar || 4,
    });
  }, [p.bpm, p.projectKey, p.projectScale, p.tracks, p.beatsPerBar]);

  const applyBeat = useCallback(async (sk: BeatSkeleton) => {
    const { getState, setState, notify, ensureEngine } = pRef.current;
    const ix = await kitIx();
    const r = applyBeatSkeleton(getState(), sk, ix);
    setState(prev => applyBeatSkeleton(prev, sk, ix).state);
    sonsBeatStore.close();
    notify(r.message);
    void ensureEngine().catch(() => {});
  }, []);

  // Poses demandées par le navigateur (bouton « Poser », glisser sur la timeline, Palette).
  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<SoundPlaceRequest>).detail;
      if (!r?.ref) return;
      const { getState, setState, notify, ensureEngine } = pRef.current;
      const refs = r.refs?.length ? r.refs : [r.ref];
      if (r.ref.startsWith('kit:') && refs.length === 1) {
        window.dispatchEvent(new CustomEvent(KIT_SOUND_DROP_EVENT, { detail: { id: r.ref.slice(4) } }));
        return;
      }
      if (r.ref.startsWith('inst:')) { requestSampler({ kind: 'new', instrument: r.ref.slice(5) }); return; }
      if (r.ref.startsWith('lib:')) {
        const cur = getState().tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine | undefined;
        const res = placeStudioSound(cur, r.ref.slice(4));
        if (!res) { notify('30 pads au plus : retire un pad de la batterie pour en ajouter un.'); return; }
        setState(prev => withDrumMachine(prev, placeStudioSound(prev.tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine | undefined, r.ref.slice(4))!.dm));
        notify(`🥁 « ${res.dm.rows[res.rowIndex].name} » ajouté sur un nouveau pad de la batterie : allume ses pas dans la grille (Ctrl+K : « batterie »).`);
        void ensureEngine().catch(() => {});
        return;
      }
      void (async () => {
        const ix = await kitIx();
        const at = typeof r.at === 'number' ? r.at : playheadStore.get();
        // Toutes les boucles d'un coup : une seule étape d'annulation.
        const run = (st: DAWState) => {
          const msgs: string[] = [];
          let s = st;
          // Palette : une 2e suite d'accords (autre progression) se pose APRÈS la première (refrain / pont).
          let firstProg: string | null = null, nextAt = at;
          for (const ref of refs) {
            const lr = parseLoopRef(ref);
            let when = at;
            if (lr && lr.t === 'chords') {
              if (firstProg === null) { firstProg = lr.prog; const p = PROGRESSIONS.find(x => x.id === lr.prog); nextAt = snapToBar(at, st.bpm || 120) + (p ? loopBars(p) : 4) * (60 / (st.bpm || 120)) * (st.timeSignature?.numerator || 4); }
              else if (lr.prog !== firstProg) when = nextAt;
            }
            const x = placeLoop(s, ref, when, ix);
            if (x) { s = x.state; msgs.push(x.message); }
          }
          return { s, msgs };
        };
        const pre = run(getState());
        if (!pre.msgs.length) { notify('Cette boucle n’est plus disponible : recharge NOVA ou choisis-en une autre.'); return; }
        setState(prev => run(prev).s);
        notify(refs.length > 1 ? `🎨 Palette posée : ${pre.msgs.length} boucles calées sur la mesure. Ctrl+Z pour tout annuler.` : pre.msgs[0]);
        void ensureEngine().catch(() => {});
      })();
    };
    window.addEventListener(SOUND_PLACE_EVENT, on);
    return () => window.removeEventListener(SOUND_PLACE_EVENT, on);
  }, []);

  // Actions du chatbot ingé son.
  useEffect(() => {
    sonsBeatStore.setRunner((action, payload) => {
      const { getState, setState, notify } = pRef.current;
      const st = getState();
      if (action === 'START_BEAT') {
        const genre = (genreFromText(String(payload.genre || '')) || 'trap') as BeatGenreId;
        const keep = hasLoadedBeat(st);
        const root = keep && typeof st.projectKey === 'number' ? st.projectKey : typeof payload.root === 'number' ? payload.root : null;
        const mode = payload.mode === 'major' || payload.mode === 'minor' ? payload.mode : null;
        const sk = buildBeat({ genre, root, mode, bpm: keep ? st.bpm : (typeof payload.bpm === 'number' ? payload.bpm : null), variant: Number(payload.variant) || 0 });
        void applyBeat(sk);
        return;
      }
      if (action === 'VARY_MIDI') {
        const tgt = midiTarget(st, payload.trackId as string | undefined, payload.clipId as string | undefined);
        if (!tgt) { notify('Sélectionne d’abord un clip MIDI qui a des notes (clic dessus), puis redemande.'); return; }
        const ctx = varyCtx(st, tgt.clip.start);
        const rule = varyRuleOf(String(payload.rule || '')) || 'rythme';
        if (payload.mode === 'prolonger') {
          const bars = [1, 2, 4, 8].includes(Number(payload.bars)) ? Number(payload.bars) : 4;
          const r = extendNotes(tgt.clip.notes || [], { bars, clipLen: tgt.clip.duration, ctx, beatsPerBar: st.timeSignature?.numerator || 4, mode: payload.repeat ? 'repeter' : 'varier', rule });
          setState(prev => withClipNotes(prev, tgt.track.id, tgt.clip.id, r.notes, r.duration));
          notify(`➕ ${tgt.clip.name || 'Clip'} prolongé de ${bars} mesure${bars > 1 ? 's' : ''} (${VARY_RULES.find(x => x.id === rule)?.label.toLowerCase()} une reprise sur deux). Ctrl+Z pour annuler.`);
          return;
        }
        const vs = varyVariants(tgt.clip.notes || [], rule, ctx, tgt.clip.duration, Number(payload.seed) || 1);
        const v = vs[Math.max(0, Math.min(vs.length - 1, Number(payload.variant) || 0))];
        if (!v) { notify('Cette règle ne change presque rien sur ce clip : essaie « rythme », « inversion », « déplacement » ou « transposition ».'); return; }
        setState(prev => withClipNotes(prev, tgt.track.id, tgt.clip.id, v, tgt.clip.duration));
        notify(`🔀 Variation « ${VARY_RULES.find(x => x.id === rule)?.label} » sur ${tgt.clip.name || 'le clip'} (notes dans la gamme). Ctrl+Z pour revenir.`);
      }
    });
    return () => sonsBeatStore.setRunner(null);
  }, [applyBeat]);

  if (!panel) return null;
  const close = () => sonsBeatStore.close();
  const st = p.getState();

  if (panel.kind === 'sons') {
    return <SoundLibrary key={panel.tab || 'sons'} variant="dialog" initialTab={panel.tab} narrow={p.isMobile} onClose={close} ensureEngine={p.ensureEngine} notify={p.notify} />;
  }
  if (panel.kind === 'beat') {
    const replaces = [
      st.tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine ? 'la batterie' : null,
      st.tracks.some(t => t.id === BASS808_TRACK_ID && t.clips.length) ? 'la 808' : null,
      st.tracks.some(t => t.id === BEAT_CHORDS_TRACK_ID) ? 'la piste d’accords du squelette' : null,
    ].filter(Boolean) as string[];
    return (
      <BeatStarterDialog bpm={p.bpm} root={typeof p.projectKey === 'number' ? p.projectKey : null} scale={p.projectScale || null} hasBeat={hasLoadedBeat(st)}
        replaces={replaces} isMobile={p.isMobile} ensureEngine={p.ensureEngine} notify={p.notify} onApply={sk => { void applyBeat(sk); }} onClose={close} />
    );
  }
  const tgt = midiTarget(st, panel.trackId, panel.clipId);
  const next = tgt ? tgt.track.clips.filter(c => c.start > tgt.clip.start + 1e-6).reduce<number | null>((m, c) => (m === null || c.start < m ? c.start : m), null) : null;
  return (
    <PatternVaryDialog mode={panel.mode} track={tgt?.track || null} clip={tgt?.clip || null} ctx={varyCtx(st, tgt?.clip.start || 0)}
      beatsPerBar={p.beatsPerBar || 4} nextClipStart={next} isMobile={p.isMobile} ensureEngine={p.ensureEngine} notify={p.notify}
      onApply={(notes, duration, label) => {
        if (!tgt) return;
        p.setState(prev => withClipNotes(prev, tgt.track.id, tgt.clip.id, notes, duration));
        close();
        p.notify(`🔀 ${label} sur ${tgt.clip.name || tgt.track.name}. Ctrl+Z pour revenir.`);
      }}
      onClose={close} />
  );
};

export default SonsBeatHost;
