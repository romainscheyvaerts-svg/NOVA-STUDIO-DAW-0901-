import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clip, DAWState, Track, TrackType } from '../types';
import { midiBus, isMidiFile, MidiBusEvent } from '../utils/midiBus';
import { parseMidi, writeMidi, midiFileName, hasTempoChanges, initialBpm, noteCount, MidiFileData, DRUM_CHANNEL } from '../utils/midiFile';
import { planMidiImport, partClip, partTrack, exportSources, novaToMidi, TempoMode, DRUM_ROW_IDS, hasMidi } from '../utils/midiImport';
import { midiCapture, buildCapture, placeCapture } from '../utils/midiCapture';
import { saveBlob } from '../utils/saveBlob';
import { playheadStore } from '../utils/playheadStore';
import { isShortcut } from '../utils/keymap';
import { makeDrumMachine, drumPadsFor, DrumMachine } from '../utils/drumKits';
import { loadPadBuffer } from '../utils/padBuffers';
import { padLoadKey } from '../utils/drumSamples';
import { audioEngine } from '../engine/AudioEngine';
import GroovePanel from './GroovePanel';
import { tempoMapStore } from '../utils/tempoMap';

/**
 * Hôte des fonctions MIDI (V25), monté une fois dans App : import et export
 * .mid, fenêtre Groove et swing, Capture MIDI (tampon permanent + Ctrl+Maj+C).
 * Les menus et le glisser-déposer lui parlent par utils/midiBus. Chaque action
 * écrit le projet en UNE fois : une étape d'annulation, une opération de
 * collaboration.
 */

type SetState = (u: DAWState | ((prev: DAWState) => DAWState)) => void;

interface Props {
  state: DAWState;
  getState: () => DAWState;
  setState: SetState;
  /** Clip ouvert dans le piano roll (cible par défaut du groove et de la capture). */
  pianoRoll?: { trackId: string; clipId: string } | null;
}

const notify = (msg: string) => window.dispatchEvent(new CustomEvent('nova:notify', { detail: msg }));
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;
const DRUM_TRACK_ID = 'track-drums';

/** Boîte à rythmes vide (sons de NOVA) pour une batterie importée. */
function importedDrums(): { drumMachine: DrumMachine; drumPads: any[] } {
  const base = makeDrumMachine('trap');
  const rows = DRUM_ROW_IDS.map(id => base.rows.find(r => r.id === id)).filter(Boolean).map(r => ({ ...r!, steps: r!.steps.map(() => 0), ratchet: r!.ratchet.map(() => 1) }));
  const dm: DrumMachine = { ...base, swing: 0, rows };
  return { drumMachine: dm, drumPads: drumPadsFor(dm) };
}

const hasContent = (st: DAWState) => st.tracks.some(t => t.clips.some(c => (c.notes && c.notes.length) || c.bufferId || (c as any).buffer || c.audioRef));

interface PendingImport { data: MidiFileData; name: string; trackId?: string | null; time?: number }

const MidiHost: React.FC<Props> = ({ state, getState, setState, pianoRoll }) => {
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [drumsToRack, setDrumsToRack] = useState(true);
  const [groove, setGroove] = useState<{ trackId: string; clipId: string } | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<{ trackId?: string | null; time?: number }>({});
  const prRef = useRef(pianoRoll);
  prRef.current = pianoRoll;

  // ---------------- Import ----------------
  const applyImport = useCallback((p: PendingImport, mode: TempoMode, toRack: boolean) => {
    const st = getState();
    const plan = planMidiImport(p.data, { projectBpm: st.bpm, tempoMode: mode, drumsToRack: toRack });
    if (!plan.noteCount) { notify(`« ${p.name} » ne contient aucune note.`); return; }
    const bpm = plan.bpm;
    const beat = 60 / bpm;
    const bar = beat * (plan.timeSignature && mode === 'file' ? (plan.timeSignature.numerator * 4) / plan.timeSignature.denominator : (st.timeSignature?.numerator || 4));
    // Dépôt : calé sur le temps le plus proche ; menu : mesure de la tête de lecture.
    const at = typeof p.time === 'number' ? Math.max(0, Math.round(p.time / beat) * beat) : Math.max(0, Math.floor(playheadStore.get() / bar + 1e-6) * bar);
    const target = p.trackId ? st.tracks.find(t => t.id === p.trackId) : undefined;
    const base = p.name.replace(/\.(mid|midi|smf|kar)$/i, '');
    const newTracks: Track[] = [];
    const addTo: { trackId: string; clip: Clip }[] = [];
    plan.parts.forEach((part, i) => {
      const clip = partClip(part, at, plan.clipDuration, '#22d3ee', plan.parts.length > 1 ? `${base} · ${part.name}` : base);
      const drumOnRack = part.isDrums && toRack;
      const fits = target && plan.parts.length === 1 && (drumOnRack ? !!(target as any).drumMachine : (target.type === TrackType.MIDI || target.type === TrackType.SAMPLER) && !(target as any).drumMachine);
      if (fits) addTo.push({ trackId: target!.id, clip: { ...clip, color: target!.color } });
      else newTracks.push(partTrack(part, clip, st.tracks.length + i, drumOnRack ? importedDrums() : undefined));
    });
    setState(prev => {
      let tracks = prev.tracks.map(t => {
        const add = addTo.filter(a => a.trackId === t.id);
        return add.length ? { ...t, clips: [...t.clips, ...add.map(a => a.clip)] } : t;
      });
      if (newTracks.length) {
        const idx = tracks.findIndex(t => t.id === 'track-rec-main');
        const k = idx >= 0 ? idx : tracks.length;
        tracks = [...tracks.slice(0, k), ...newTracks, ...tracks.slice(k)];
      }
      return {
        ...prev, tracks,
        bpm: mode === 'file' ? Math.round(bpm * 100) / 100 : prev.bpm,
        timeSignature: mode === 'file' && plan.timeSignature ? plan.timeSignature : prev.timeSignature,
        selectedTrackId: addTo[0]?.trackId || newTracks[0]?.id || prev.selectedTrackId,
      };
    });
    if (mode === 'file' && Math.abs(bpm - st.bpm) > 0.001) audioEngine.setBpm(Math.round(bpm * 100) / 100);
    const where = addTo.length ? `sur « ${target!.name} »` : plural(newTracks.length, 'nouvelle piste').replace('nouvelle pistes', 'nouvelles pistes');
    notify(`🎹 « ${p.name} » importé : ${plural(plan.noteCount, 'note')}, ${where}, ${mode === 'file' ? `projet passé à ${Math.round(bpm * 10) / 10} BPM` : `au tempo du projet (${Math.round(st.bpm * 10) / 10} BPM)`}. Ctrl+Z pour annuler.`);
  }, [getState, setState]);

  const importFile = useCallback(async (file: File, trackId?: string | null, time?: number) => {
    if (!isMidiFile(file)) { notify(`« ${file.name} » n’est pas un fichier MIDI (.mid).`); return; }
    let data: MidiFileData;
    try { data = parseMidi(await file.arrayBuffer()); } catch (e) { notify(`Impossible de lire « ${file.name} » : ${(e as Error).message}.`); return; }
    if (!noteCount(data)) { notify(`« ${file.name} » ne contient aucune note.`); return; }
    const st = getState();
    const fileBpm = initialBpm(data);
    const p: PendingImport = { data, name: file.name, trackId, time };
    // Même tempo et pas de changement de tempo : rien à demander.
    const hasDrums = data.tracks.some(t => t.notes.some(n => n.channel === DRUM_CHANNEL));
    if (Math.abs(fileBpm - st.bpm) < 0.05 && !hasTempoChanges(data) && !hasDrums) { applyImport(p, 'project', true); return; }
    setDrumsToRack(true);
    setPending(p);
  }, [getState, applyImport]);

  // ---------------- Export ----------------
  const doExport = useCallback((scope: 'clip' | 'track' | 'all', trackId?: string, clipId?: string) => {
    const st = getState();
    const { sources, relativeTo, name } = exportSources(st.tracks, scope, trackId, clipId);
    const notes = sources.reduce((s, x) => s + x.clips.reduce((a, c) => a + (c.notes?.length || 0), 0), 0);
    if (!notes) { notify(scope === 'all' ? 'Aucune piste MIDI avec des notes à exporter.' : 'Pas de notes à exporter ici.'); return; }
    const data = novaToMidi(sources, { bpm: st.bpm, timeSignature: st.timeSignature, relativeTo, tempoMap: tempoMapStore.get() });
    const bytes = writeMidi(data, { title: st.name });
    const fname = midiFileName(scope === 'all' ? `${st.name || 'Nova'} - MIDI` : name);
    void saveBlob(new Blob([bytes], { type: 'audio/midi' }), fname);
    notify(`🎹 ${fname} : ${plural(notes, 'note')}, ${plural(sources.length, 'piste')}, ${Math.round(st.bpm * 10) / 10} BPM (format 1).`);
  }, [getState]);

  // ---------------- Groove ----------------
  const openGroove = useCallback((trackId?: string, clipId?: string) => {
    const st = getState();
    let t = trackId ? st.tracks.find(x => x.id === trackId) : undefined;
    let c = t && clipId ? t.clips.find(x => x.id === clipId) : undefined;
    if (!c) {
      const pr = prRef.current;
      const now = playheadStore.get();
      const midiClips = (tr?: Track) => (tr?.clips || []).filter(x => x.type === TrackType.MIDI && Array.isArray(x.notes));
      t = st.tracks.find(x => x.id === (pr?.trackId || st.selectedTrackId)) || st.tracks.find(x => midiClips(x).length > 0);
      const list = midiClips(t);
      c = (pr && list.find(x => x.id === pr.clipId)) || list.find(x => now >= x.start && now < x.start + x.duration) || list[0];
      if (!c) { t = st.tracks.find(x => midiClips(x).length > 0); c = midiClips(t)[0]; }
    }
    if (!t || !c) { notify('Pas encore de clip MIDI : crée un motif ou importe un .mid, puis règle son swing.'); return; }
    setGroove({ trackId: t.id, clipId: c.id });
  }, [getState]);

  const updateClip = useCallback((trackId: string, clipId: string, patch: Partial<Clip>) => {
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (t.id !== trackId ? t : { ...t, clips: t.clips.map(c => (c.id === clipId ? { ...c, ...patch } : c)) })) }));
  }, [setState]);

  // ---------------- Capture ----------------
  const doCapture = useCallback((trackId?: string | null) => {
    const phrase = midiCapture.lastPhrase();
    if (!phrase.length) { notify('Rien à capturer : joue d’abord quelques notes (clavier MIDI, ou clavier de l’ordinateur dans le piano roll). NOVA les garde même sans enregistrer.'); return; }
    const st = getState();
    const projectEmpty = !st.isPlaying && !hasContent(st);
    const res = buildCapture(phrase, { bpm: st.bpm, beatsPerBar: st.timeSignature?.numerator || 4, projectEmpty, at: playheadStore.get() });
    if (!res) return;
    const want = trackId || phrase[phrase.length - 1].trackId || prRef.current?.trackId || st.selectedTrackId;
    const target = st.tracks.find(t => t.id === want && (t.type === TrackType.MIDI || t.type === TrackType.DRUM_RACK || t.type === TrackType.SAMPLER));
    const end = res.start + res.duration;
    // Pendant la lecture : dans le clip qui couvre déjà ce passage. À l'arrêt : un clip à part (comme Ableton),
    // à la tête de lecture si la piste y est libre, sinon juste après ce qui occupe la place.
    const bar = (60 / (st.bpm || 120)) * (st.timeSignature?.numerator || 4);
    const place = target ? placeCapture(target.clips, res, bar) : { hostId: null, start: res.start };
    const host = place.hostId ? target!.clips.find(c => c.id === place.hostId) : undefined;
    const clipId = host?.id || `clip-cap-${Date.now().toString(36)}`;
    const newClip: Clip = { id: clipId, start: place.start, duration: res.duration, offset: 0, fadeIn: 0, fadeOut: 0, name: 'Capture', color: target?.color || '#f43f5e', type: TrackType.MIDI, notes: res.notes, isMuted: false, gain: 1 };
    const newTrackId = `track-cap-${Date.now().toString(36)}`;
    setState(prev => {
      let tracks: Track[];
      if (target) {
        tracks = prev.tracks.map(t => {
          if (t.id !== target.id) return t;
          if (host) {
            const shift = res.start - host.start;
            return { ...t, clips: t.clips.map(c => (c.id !== host.id ? c : { ...c, notes: [...(c.notes || []), ...res.notes.map(n => ({ ...n, start: n.start + shift }))], duration: Math.max(c.duration, end - c.start) })) };
          }
          return { ...t, clips: [...t.clips, newClip] };
        });
      } else {
        const n = prev.tracks.filter(t => t.type === TrackType.MIDI).length + 1;
        const track: Track = {
          id: newTrackId, name: `CAPTURE ${n}`, type: TrackType.MIDI, color: '#f43f5e', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
          volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0, clips: [newClip],
        };
        const idx = prev.tracks.findIndex(t => t.id === 'track-rec-main');
        const k = idx >= 0 ? idx : prev.tracks.length;
        tracks = [...prev.tracks.slice(0, k), track, ...prev.tracks.slice(k)];
      }
      return { ...prev, tracks, bpm: res.guessedBpm || prev.bpm, selectedTrackId: target?.id || newTrackId };
    });
    if (res.guessedBpm) audioEngine.setBpm(res.guessedBpm);
    midiCapture.clear();
    const moved = !host && target && Math.abs(place.start - res.start) > 1e-6;
    notify(`✋ Capturé : ${plural(res.notes.length, 'note')} ${host ? `ajoutée${res.notes.length > 1 ? 's' : ''} dans « ${host.name} »` : target ? `dans un nouveau clip sur « ${target.name} »${moved ? ' (posé juste après le clip déjà en place)' : ''}` : 'sur une nouvelle piste'}${res.guessedBpm ? `, tempo deviné : ${res.guessedBpm} BPM` : ''}. Ctrl+Z pour annuler.`);
  }, [getState, setState]);

  // ---------------- Bus, raccourci, clavier MIDI, transport ----------------
  const handlers = useRef({ importFile, doExport, openGroove, doCapture });
  handlers.current = { importFile, doExport, openGroove, doCapture };
  useEffect(() => midiBus.on((e: MidiBusEvent) => {
    const h = handlers.current;
    if (e.type === 'import-file') void h.importFile(e.file, e.trackId, e.time);
    else if (e.type === 'import-pick') { pickTarget.current = { trackId: e.trackId, time: e.time }; pickRef.current?.click(); }
    else if (e.type === 'export') h.doExport(e.scope, e.trackId, e.clipId);
    else if (e.type === 'groove') h.openGroove(e.trackId, e.clipId);
    else if (e.type === 'capture') h.doCapture(e.trackId);
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, 'nova.captureMidi')) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handlers.current.doCapture();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    // Les notes jouées arrivent par le routeur MIDI (services/MidiInput), qui les garde pour la capture.
    midiCapture.setTransport(() => ({ playing: !!getState().isPlaying, time: audioEngine.getCurrentTime() }));
  }, [getState]);
  useEffect(() => { midiCapture.setPlaying(!!state.isPlaying); }, [state.isPlaying]);

  // Diagnostic en lecture seule (console, tests de bout en bout), comme window.__novaCollab.
  useEffect(() => {
    (window as any).__novaMidi = {
      bpm: () => getState().bpm,
      /** Pistes complètes (lecture seule) : rendu d'export dans les scénarios R16. */
      rawTracks: () => getState().tracks,
      state: () => { const st = getState(); return { isRecording: st.isRecording, isPlaying: st.isPlaying, recStartTime: st.recStartTime, isLoopActive: st.isLoopActive, loopStart: st.loopStart, loopEnd: st.loopEnd, selectedTrackId: st.selectedTrackId, armed: st.tracks.filter(t => t.isTrackArmed).map(t => t.id), volumes: Object.fromEntries(st.tracks.map(t => [t.id, t.volume])) }; },
      captured: () => midiCapture.size,
      tracks: () => getState().tracks.map(t => ({
        id: t.id, name: t.name, type: t.type,
        clips: t.clips.filter(c => Array.isArray(c.notes)).map(c => ({ id: c.id, name: c.name, start: c.start, duration: c.duration, muted: !!c.isMuted, takeNumber: c.takeNumber ?? null, groove: c.groove ? c.groove.template.id : null, cc: c.cc || null, notes: (c.notes || []).map(n => ({ p: n.pitch, s: n.start, d: n.duration, v: n.velocity, ...(n.muted ? { m: 1 } : {}) })) })),
      })),
    };
    return () => { delete (window as any).__novaMidi; };
  }, [getState]);

  // Sons des batteries importées (la batterie principale est chargée par App).
  const loaded = useRef(new Map<string, string>());
  useEffect(() => {
    const ctx = audioEngine.ctx;
    if (!ctx) return;
    const drums = state.tracks.filter(t => t.id !== DRUM_TRACK_ID && t.type === TrackType.DRUM_RACK && (t as any).drumMachine);
    if (!drums.length) return;
    const root = typeof state.projectKey === 'number' ? state.projectKey : 0;
    const timer = window.setTimeout(() => {
      for (const t of drums) {
        ((t as any).drumMachine as DrumMachine).rows.forEach((r, i) => {
          const key = padLoadKey(r, root);
          const k = `${t.id}:${i + 1}`;
          if (loaded.current.get(k) === key && audioEngine.getDrumRackNode(t.id)?.getBuffers().has(i + 1)) return;
          loadPadBuffer(r, ctx, root).then(buf => { audioEngine.loadDrumRackSample(t.id, i + 1, buf); loaded.current.set(k, key); }).catch(() => { /* son indisponible */ });
        });
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [state.tracks, state.projectKey]);

  // ---------------- Rendu ----------------
  const gTrack = groove ? state.tracks.find(t => t.id === groove.trackId) : undefined;
  const gClip = gTrack?.clips.find(c => c.id === groove!.clipId);
  const fileBpm = pending ? initialBpm(pending.data) : 0;
  const changes = pending ? hasTempoChanges(pending.data) : false;
  const pendingDrums = pending ? pending.data.tracks.some(t => t.notes.some(n => n.channel === DRUM_CHANNEL)) : false;

  return (
    <>
      <input ref={pickRef} type="file" accept=".mid,.midi,audio/midi,audio/x-midi" className="hidden" data-testid="midi-file-input"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f, pickTarget.current.trackId, pickTarget.current.time); }} />

      {gTrack && gClip && (
        <GroovePanel track={gTrack} clip={gClip} bpm={state.bpm} notify={notify}
          onUpdateClip={patch => updateClip(gTrack.id, gClip.id, patch)} onClose={() => setGroove(null)} />
      )}

      {pending && (
        <div className="fixed inset-0 z-[420] flex items-end sm:items-center justify-center bg-black/50" onPointerDown={() => setPending(null)}>
          <div role="dialog" aria-label="Importer un fichier MIDI" data-nova-midi-import=""
            className="w-full sm:w-[460px] rounded-t-2xl sm:rounded-2xl border border-white/15 bg-[#16181d] p-4 shadow-2xl text-white space-y-3" onPointerDown={e => e.stopPropagation()}>
            <div className="relative pr-10">
              {/* Bouton Fermer : Échap ferme aussi cette fenêtre (règle commune du studio). */}
              <button type="button" onClick={() => setPending(null)} aria-label="Fermer" title="Fermer (Échap)"
                className="absolute right-0 top-0 h-8 w-8 rounded-lg bg-white/5 text-slate-300 hover:text-white">✕</button>
              <h3 className="text-[13px] font-black uppercase tracking-widest">Importer « {pending.name} »</h3>
              <p className="text-[12px] text-slate-400">
                {plural(noteCount(pending.data), 'note')} · {plural(pending.data.tracks.filter(t => t.notes.length).length, 'piste')} · format {pending.data.format}
                {' · '}tempo du fichier {Math.round(fileBpm * 10) / 10} BPM{changes ? ' (avec changements de tempo)' : ''}
              </p>
            </div>
            <button type="button" data-testid="midi-import-project" onClick={() => { const p = pending; setPending(null); applyImport(p, 'project', drumsToRack); }}
              className="w-full text-left rounded-xl border border-cyan-400/40 bg-cyan-500/10 hover:bg-cyan-500/15 p-3">
              <span className="block text-[13px] font-black">Garder le tempo du projet ({Math.round(state.bpm * 10) / 10} BPM)</span>
              <span className="block text-[11px] text-slate-300">Les notes restent sur leurs temps et leurs mesures, et suivent ton tempo (comme Live, FL et Logic par défaut).</span>
            </button>
            <button type="button" data-testid="midi-import-file" onClick={() => { const p = pending; setPending(null); applyImport(p, 'file', drumsToRack); }}
              className="w-full text-left rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 p-3">
              <span className="block text-[13px] font-black">Prendre le tempo du fichier ({Math.round(fileBpm * 10) / 10} BPM)</span>
              <span className="block text-[11px] text-slate-300">Le projet passe à {Math.round(fileBpm * 10) / 10} BPM{changes ? ' ; les changements de tempo du fichier sont respectés note par note' : ''} (comme « Importer le tempo » dans Logic).</span>
            </button>
            {pendingDrums && (
              <label className="flex items-start gap-2 text-[12px] text-slate-300 min-h-10">
                <input type="checkbox" className="mt-0.5 w-5 h-5 accent-orange-400" checked={drumsToRack} onChange={e => setDrumsToRack(e.target.checked)} />
                <span>Batterie (canal 10) sur la boîte à rythmes NOVA <span className="text-slate-500">(kick, snare, hi-hats… rangés sur les pads ; décoche pour garder les notes General MIDI brutes)</span></span>
              </label>
            )}
            <button type="button" onClick={() => setPending(null)} className="w-full min-h-10 rounded-xl bg-white/5 border border-white/10 text-[12px] font-bold">Annuler</button>
          </div>
        </div>
      )}
    </>
  );
};

export default MidiHost;

/** Pistes MIDI exportables (pour l'export du projet). */
export const midiTrackCount = (tracks: Track[]) => tracks.filter(hasMidi).length;
