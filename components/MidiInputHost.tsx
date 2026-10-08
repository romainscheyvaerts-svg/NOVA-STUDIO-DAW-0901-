import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Track, TrackType } from '../types';
import { midiManager, ALL_INPUTS } from '../services/MidiManager';
import { midiInput } from '../services/MidiInput';
import { computerKeyboardStore, isComputerKeyboardCode } from '../utils/computerKeyboard';
import { chordFromEvent } from '../utils/keymap';
import { MODE_LABELS, MidiRecMode, isMidiRecordTrack } from '../utils/midiRecord';
import { midiLearn, LearnTarget, LearnKind } from '../utils/midiLearn';
import { getRegisteredPlugin } from '../engine/pluginRegistry';
import { noteNameFr } from '../utils/scales';

/**
 * Hôte MIDI (R16), monté une fois dans App :
 * - clavier de l'ordinateur sur la piste armée ou sélectionnée, sans ouvrir le
 *   piano roll (Ctrl+Maj+K, comme le Computer MIDI Keyboard de Live) ;
 * - fenêtre « MIDI » : clavier branché, mode de prise (remplacer / fusionner /
 *   boucle), quantification à l'entrée, Thru, décalage, MIDI Learn.
 * Ouverte par l'événement « nova:midi-panel » (barre de transport, menu ☰).
 */

export const openMidiPanel = () => window.dispatchEvent(new Event('nova:midi-panel'));

/** État du clavier de l'ordinateur (abonnement React). */
export function useComputerKeyboard() {
  return useSyncExternalStore(
    f => computerKeyboardStore.subscribe(f),
    () => `${computerKeyboardStore.on ? 1 : 0}|${computerKeyboardStore.state.octave}|${computerKeyboardStore.state.velocity}|${computerKeyboardStore.held.join(',')}`,
  );
}

/** Préférences de prise (abonnement React). */
export function useMidiRecPrefs() {
  useSyncExternalStore(f => midiInput.onPrefs(f), () => JSON.stringify(midiInput.prefs));
  return midiInput.prefs;
}

const typing = (el: EventTarget | null) => {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  const tag = n.tagName.toLowerCase();
  if (tag === 'input') return !['range', 'button', 'checkbox', 'radio'].includes((n as HTMLInputElement).type);
  return tag === 'textarea' || tag === 'select' || n.isContentEditable;
};

const GRID_CHOICES = [
  { beats: 1, label: '1/4' }, { beats: 0.5, label: '1/8' }, { beats: 0.25, label: '1/16' }, { beats: 0.125, label: '1/32' },
  { beats: 1 / 3, label: '1/8T' }, { beats: 1 / 6, label: '1/16T' },
];

interface Props {
  tracks: Track[];
  selectedTrackId: string | null;
  isRecording: boolean;
  onArm: (trackId: string) => void;
  onToggleRecord: () => void;
}

const MidiInputHost: React.FC<Props> = ({ tracks, selectedTrackId, isRecording, onArm, onToggleRecord }) => {
  const kbKey = useComputerKeyboard();
  const kbOn = computerKeyboardStore.on;
  const prefs = useMidiRecPrefs();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState(midiManager.getInputs());
  const [inputId, setInputId] = useState(midiManager.getSelectedInputId());
  const [ready, setReady] = useState(midiManager.isReady);
  const [learnTick, setLearnTick] = useState(0);
  const [lastNote, setLastNote] = useState<string | null>(null);
  void kbKey;

  // --- Clavier de l'ordinateur -------------------------------------------------
  useEffect(() => {
    try { if (localStorage.getItem('nova.computerKeyboard') === '1') computerKeyboardStore.setOn(true); } catch { /* */ }
  }, []);

  useEffect(() => {
    const onToggleKey = (e: KeyboardEvent) => {
      if (chordFromEvent(e) !== 'ctrl+shift+k' || typing(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      computerKeyboardStore.toggle();
      window.dispatchEvent(new CustomEvent('nova:notify', { detail: computerKeyboardStore.on
        ? "⌨️ Clavier de l'ordinateur ACTIF : Q S D F G H J K L M = Do Ré Mi… (AZERTY), W / X octave, C / V vélocité. R enregistre, Espace lit. Ctrl+Maj+K pour le couper."
        : "⌨️ Clavier de l'ordinateur coupé : les lettres retrouvent leurs raccourcis." }));
    };
    window.addEventListener('keydown', onToggleKey, true);
    return () => window.removeEventListener('keydown', onToggleKey, true);
  }, []);

  useEffect(() => {
    if (!kbOn) return;
    const kb = computerKeyboardStore.kb;
    const release = (pitch: number, ts?: number) => midiInput.noteOff(pitch, { source: 'kb', timeStamp: ts, trackId: computerKeyboardStore.forcedTrackId });
    const onDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !isComputerKeyboardCode(e.code)) return;
      // Touche du clavier musical : elle ne déclenche aucun autre raccourci.
      e.preventDefault();
      e.stopImmediatePropagation();
      const a = kb.keyDown(e.code, e.repeat);
      if (a.type === 'state') computerKeyboardStore.touch();
      if (a.type === 'noteOn') {
        midiInput.noteOn(a.pitch, a.velocity, { source: 'kb', timeStamp: e.timeStamp, trackId: computerKeyboardStore.forcedTrackId });
        computerKeyboardStore.setHeld(kb.heldPitches());
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isComputerKeyboardCode(e.code)) return;
      const a = kb.keyUp(e.code);
      if (a.type === 'noteOff') { e.stopImmediatePropagation(); release(a.pitch, e.timeStamp); computerKeyboardStore.setHeld(kb.heldPitches()); }
    };
    const onBlur = () => { kb.releaseAll().forEach(p => release(p)); computerKeyboardStore.setHeld([]); };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, [kbOn]);

  // --- Fenêtre MIDI ----------------------------------------------------------------
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('nova:midi-panel', onOpen);
    return () => window.removeEventListener('nova:midi-panel', onOpen);
  }, []);
  useEffect(() => midiManager.onDevicesChange(() => { setDevices(midiManager.getInputs()); setReady(midiManager.isReady); }), []);
  useEffect(() => midiLearn.subscribe(() => setLearnTick(t => t + 1)), []);
  useEffect(() => {
    if (!open) return;
    return midiInput.subscribe(e => { if (e.type === 'on' && e.pitch !== undefined) setLastNote(`${noteNameFr(e.pitch)} · vélocité ${e.velocity}`); });
  }, [open]);

  const connect = useCallback(async () => {
    const ok = await midiManager.init();
    setReady(ok);
    setDevices(midiManager.getInputs());
  }, []);
  useEffect(() => { if (open) void connect(); }, [open, connect]);

  const midiTracks = useMemo(() => tracks.filter(t => isMidiRecordTrack(t)), [tracks]);
  const armed = tracks.find(t => t.isTrackArmed && isMidiRecordTrack(t));
  const target = armed || tracks.find(t => t.id === selectedTrackId && isMidiRecordTrack(t)) || null;

  // MIDI Learn : piste + réglage.
  const [learnTrackId, setLearnTrackId] = useState<string>('');
  const [learnWhat, setLearnWhat] = useState<string>('volume');
  const learnTrack = tracks.find(t => t.id === (learnTrackId || selectedTrackId || '')) || tracks.find(t => t.type !== TrackType.SEND) || null;
  const learnChoices = useMemo(() => {
    if (!learnTrack) return [] as { id: string; label: string; target: LearnTarget }[];
    const out: { id: string; label: string; target: LearnTarget }[] = [
      { id: 'volume', label: 'Volume', target: { kind: 'volume' as LearnKind, trackId: learnTrack.id, label: `${learnTrack.name} · Volume` } },
      { id: 'pan', label: 'Pan', target: { kind: 'pan' as LearnKind, trackId: learnTrack.id, label: `${learnTrack.name} · Pan` } },
    ];
    for (const p of learnTrack.plugins || []) {
      const reg = getRegisteredPlugin(p.type as string);
      for (const a of reg?.automatable || []) {
        out.push({ id: `${p.id}:${a.id}`, label: `${p.name} · ${a.label}`, target: { kind: 'param', trackId: learnTrack.id, pluginId: p.id, paramId: a.id, min: a.min, max: a.max, label: `${learnTrack.name} · ${p.name} · ${a.label}` } });
      }
    }
    return out;
  }, [learnTrack]);
  const learnChoice = learnChoices.find(c => c.id === learnWhat) || learnChoices[0];
  void learnTick;

  const setMode = (mode: MidiRecMode) => midiInput.setPrefs({ mode });
  const chip = (on: boolean) => `min-h-9 [@media(pointer:coarse)]:min-h-11 px-3 rounded-lg border text-[12px] font-bold ${on ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`;

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[430] flex items-end sm:items-center justify-center bg-black/50" onPointerDown={() => { setOpen(false); midiLearn.cancelLearn(); }}>
      <div role="dialog" aria-label="MIDI : clavier, prise et MIDI Learn" data-nova-midi-panel=""
        className="w-full sm:w-[520px] max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel text-nv-ink p-4 shadow-2xl space-y-4"
        onPointerDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-black uppercase tracking-widest"><i className="fas fa-keyboard mr-2 text-nv-accent"></i>MIDI</h3>
          <button type="button" aria-label="Fermer" onClick={() => { setOpen(false); midiLearn.cancelLearn(); }} className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10"><i className="fas fa-times"></i></button>
        </div>

        {/* Clavier branché */}
        <section className="space-y-2">
          <div className="text-[11px] font-black uppercase tracking-widest text-nv-muted">Ton clavier</div>
          {!midiManager.isSupported ? (
            <p className="text-[12px] text-amber-300">Ce navigateur ne lit pas le MIDI (Safari sur iPhone). Utilise l’appli Nova Studio sur PC, Chrome sur Android, ou le clavier de l’ordinateur.</p>
          ) : !ready ? (
            <button type="button" onClick={() => void connect()} className={chip(false)}>Autoriser le MIDI</button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Clavier MIDI écouté" value={inputId} onChange={e => { setInputId(e.target.value); midiManager.selectInput(e.target.value); }}
                className="h-10 rounded-lg bg-nv-well border border-nv-line px-2 text-[12px] text-nv-ink min-w-0 flex-1">
                <option value={ALL_INPUTS}>Tous les claviers branchés ({devices.length})</option>
                {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <span className={`text-[11px] ${devices.length ? 'text-emerald-300' : 'text-slate-400'}`} role="status">{devices.length ? (lastNote ? `Reçu : ${lastNote}` : 'Joue une note pour tester') : 'Aucun clavier branché'}</span>
            </div>
          )}
          <label className="flex items-center gap-2 text-[12px] min-h-10">
            <input type="checkbox" className="w-5 h-5 accent-cyan-400" checked={kbOn} onChange={e => computerKeyboardStore.setOn(e.target.checked)} />
            <span><b>Clavier de l’ordinateur</b> <span className="text-nv-muted">(Ctrl+Maj+K) : les lettres jouent sur la piste {target ? `« ${target.name} »` : 'MIDI sélectionnée'}, sans ouvrir le piano roll (Computer MIDI Keyboard de Live, Typing keyboard de FL)</span></span>
          </label>
          <label className="flex items-center gap-2 text-[12px] min-h-10" title="Pro Tools : MIDI Thru. La piste armée (sinon la piste MIDI sélectionnée) joue ce que tu joues, tout de suite.">
            <input type="checkbox" className="w-5 h-5 accent-cyan-400" checked={prefs.thru} onChange={e => midiInput.setPrefs({ thru: e.target.checked })} />
            <span><b>Entendre ce que je joue</b> <span className="text-nv-muted">(Thru : la piste armée joue tes notes en direct)</span></span>
          </label>
        </section>

        {/* Prise */}
        <section className="space-y-2">
          <div className="text-[11px] font-black uppercase tracking-widest text-nv-muted">Enregistrement</div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Mode de prise MIDI">
            {(['replace', 'merge', 'loop'] as MidiRecMode[]).map(m => (
              <button key={m} type="button" role="radio" aria-checked={prefs.mode === m} data-nova-midi-mode={m} onClick={() => setMode(m)} title={MODE_LABELS[m].hint} className={chip(prefs.mode === m)}>{MODE_LABELS[m].label}</button>
            ))}
          </div>
          <p className="text-[11px] text-nv-muted">{MODE_LABELS[prefs.mode].hint}</p>
          {prefs.mode === 'loop' && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="En boucle">
              <button type="button" role="radio" aria-checked={prefs.loopStyle === 'takes'} data-nova-loop-style="takes" onClick={() => midiInput.setPrefs({ loopStyle: 'takes' })} className={chip(prefs.loopStyle === 'takes')}
                title="Chaque tour devient une prise ; la dernière complète joue, les autres restent muettes en dessous pour comparer (Pro Tools : Loop Record)">Une prise par tour</button>
              <button type="button" role="radio" aria-checked={prefs.loopStyle === 'merge'} data-nova-loop-style="merge" onClick={() => midiInput.setPrefs({ loopStyle: 'merge' })} className={chip(prefs.loopStyle === 'merge')}
                title="Chaque tour s’ajoute au précédent : kick au 1er tour, snare au 2e, charley au 3e (FL : Overdub en boucle, Live : MIDI Overdub)">Tout fusionner</button>
            </div>
          )}
          <label className="flex items-center gap-2 text-[12px] min-h-10" title="Pro Tools : Input Quantize. Les débuts de notes vont sur la grille pendant l’enregistrement.">
            <input type="checkbox" className="w-5 h-5 accent-cyan-400" checked={prefs.quantizeOnInput} onChange={e => midiInput.setPrefs({ quantizeOnInput: e.target.checked })} />
            <span><b>Quantifier à l’entrée</b></span>
          </label>
          {prefs.quantizeOnInput && (
            <div className="flex flex-wrap items-center gap-2 pl-7">
              {GRID_CHOICES.map(g => (
                <button key={g.label} type="button" onClick={() => midiInput.setPrefs({ quantizeGrid: g.beats })} className={chip(Math.abs(prefs.quantizeGrid - g.beats) < 1e-6)}>{g.label}</button>
              ))}
              <label className="flex items-center gap-2 text-[12px]">Force
                <input type="range" min={10} max={100} step={5} value={Math.round(prefs.quantizeStrength * 100)} aria-label="Force de la quantification"
                  onChange={e => midiInput.setPrefs({ quantizeStrength: Number(e.target.value) / 100 })} className="w-24" />
                <b>{Math.round(prefs.quantizeStrength * 100)} %</b>
              </label>
            </div>
          )}
          <label className="flex items-center gap-2 text-[12px] min-h-10" title="Pro Tools : MIDI Input Offset. Si tes notes tombent toujours un peu en retard, avance-les de quelques millisecondes.">
            <span className="shrink-0"><b>Décalage</b></span>
            <input type="range" min={-50} max={50} step={1} value={prefs.offsetMs} aria-label="Décalage MIDI en millisecondes" onChange={e => midiInput.setPrefs({ offsetMs: Number(e.target.value) })} className="flex-1" />
            <span className="w-24 text-right">{prefs.offsetMs === 0 ? '0 ms' : `${prefs.offsetMs > 0 ? 'avance ' : 'recule '}${Math.abs(prefs.offsetMs)} ms`}</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Piste qui enregistre" value={armed?.id || ''} onChange={e => e.target.value && onArm(e.target.value)}
              className="h-11 rounded-lg bg-nv-well border border-nv-line px-2 text-[12px] text-nv-ink flex-1 min-w-0">
              <option value="">{midiTracks.length ? 'Choisis la piste à armer…' : 'Aucune piste MIDI : crée un synthé ou une 808'}</option>
              {midiTracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button type="button" data-nova-midi-rec="" onClick={() => { onToggleRecord(); if (!isRecording) setOpen(false); }} disabled={!midiTracks.length}
              className={`h-11 px-4 rounded-xl font-black text-[12px] flex items-center gap-2 ${isRecording ? 'bg-red-600 text-white' : 'bg-red-500/15 border border-red-400/50 text-red-200 hover:bg-red-500/25'} disabled:opacity-40`}>
              <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-white animate-pulse' : 'bg-red-500'}`}></span>{isRecording ? 'Arrêter la prise' : 'Enregistrer'}
            </button>
          </div>
        </section>

        {/* MIDI Learn */}
        <section className="space-y-2">
          <div className="text-[11px] font-black uppercase tracking-widest text-nv-muted">MIDI Learn <span className="normal-case font-normal">· un bouton de ton clavier pilote un réglage (FL : Link to controller, Live : MIDI Map)</span></div>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Piste du réglage" value={learnTrack?.id || ''} onChange={e => { setLearnTrackId(e.target.value); setLearnWhat('volume'); }}
              className="h-10 rounded-lg bg-nv-well border border-nv-line px-2 text-[12px] text-nv-ink flex-1 min-w-[8rem]">
              {tracks.filter(t => t.type !== TrackType.SEND).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select aria-label="Réglage à piloter" value={learnChoice?.id || ''} onChange={e => setLearnWhat(e.target.value)}
              className="h-10 rounded-lg bg-nv-well border border-nv-line px-2 text-[12px] text-nv-ink flex-1 min-w-[8rem]">
              {learnChoices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <button type="button" data-nova-midi-learn="" disabled={!learnChoice} onClick={() => { void connect(); if (learnChoice) midiLearn.startLearn(learnChoice.target); }}
              className={`h-10 px-3 rounded-lg font-bold text-[12px] ${midiLearn.learning ? 'bg-amber-400 text-black animate-pulse' : 'bg-white/5 border border-white/10 hover:bg-white/10'}`}>
              {midiLearn.learning ? 'Bouge un bouton…' : 'Apprendre'}
            </button>
          </div>
          {midiLearn.learning && <p className="text-[12px] text-amber-200" role="status">Tourne un bouton ou pousse un fader de ton clavier : il pilotera « {midiLearn.learning.label} ». Échap ou clic hors de la fenêtre pour annuler.</p>}
          {midiLearn.mappings.length > 0 && (
            <ul className="space-y-1" aria-label="Boutons reliés">
              {midiLearn.mappings.map(m => (
                <li key={m.id} className="flex items-center gap-2 text-[12px] rounded-lg bg-white/5 px-2 min-h-10">
                  <span className="font-mono text-nv-accent shrink-0">CC{m.cc}{m.channel ? ` · c${m.channel}` : ''}</span>
                  <span className="flex-1 truncate">{m.target.label}</span>
                  <button type="button" aria-label={`Délier CC${m.cc}`} onClick={() => midiLearn.remove(m.id)} className="w-9 h-9 rounded-lg hover:bg-red-500/20 text-slate-400"><i className="fas fa-unlink"></i></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <button type="button" onClick={() => midiInput.panic()} className="w-full min-h-10 rounded-xl bg-white/5 border border-white/10 text-[12px] font-bold"
          title="Pro Tools : MIDI Panic (Ctrl+Maj+.) : arrête toutes les notes qui restent coincées">Couper toutes les notes (panique)</button>
      </div>
    </div>,
    document.body,
  );
};

export default MidiInputHost;
