import { useEffect, useRef } from 'react';
import type { DAWState, Track } from '../types';
import {
  createGroup, editGroupsStore, expandEditTracks, GroupsState, mixLinkUpdates, setSuspended,
} from '../utils/editGroups';
import { editSelectionStore } from '../utils/editSelection';
import { registerEditCommands } from '../utils/editCommands';
import { playheadStore } from '../utils/playheadStore';
import { splitClipsAt } from '../utils/timeSelection';
import { applyTimeOp, newTimeOpId, opIdGen, TimeOp, TimeOpReport } from '../utils/timeOps';
import { openR12Panel, r12Bus, R12Panel, TimeDialogPreset } from '../utils/r12Bus';
import { takeGroupLinked, takeGroupTracksAt } from '../utils/takeGroups';

/**
 * R12 · Branchements de App (court) : groupes d'édition et de mix, opérations
 * sur le temps, sections. La logique est dans utils/editGroups et
 * utils/timeOps ; ici seulement :
 *  - le store des groupes lu par l'arrangement (pistes, groupes, réglages) ;
 *  - Maj+Ctrl tenues = groupes inversés pendant le geste ;
 *  - toute sélection de plage posée sur une piste groupée s'étend au groupe
 *    d'édition (Pro Tools : la sélection est commune au groupe) ;
 *  - commandes : séparer à la tête de lecture sur le groupe, créer un groupe
 *    (Ctrl+G), suspendre les groupes (Ctrl+Maj+G), insérer du temps ;
 *  - commandes du bus R12 (liste des groupes, fenêtre Temps, piste Arrangement).
 */
export interface R12Deps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  /** Panneau ouvert (liste des groupes, fenêtre Temps). */
  setPanel: (p: { panel: R12Panel; preset?: TimeDialogPreset; newGroup?: boolean } | null) => void;
  /** Opération sur le temps faite ici : la collaboration l'envoie (une seule opération). */
  onLocalTimeOp?: (op: TimeOp, next: DAWState) => void;
}

/** Pistes ciblées par « créer un groupe » : la plage, sinon les clips sélectionnés, sinon la piste active. */
export function selectedTrackIds(s: DAWState): string[] {
  const sel = editSelectionStore.get();
  if (sel.time?.trackIds.length) return [...sel.time.trackIds];
  if (sel.clipIds.length) {
    const ids = new Set(sel.clipIds);
    return s.tracks.filter(t => t.clips.some(c => ids.has(c.id))).map(t => t.id);
  }
  return s.selectedTrackId ? [s.selectedTrackId] : [];
}

export function useR12(state: DAWState, d: R12Deps) {
  const dRef = useRef(d);
  dRef.current = d;

  // Store lu par l'arrangement, la liste des groupes et les commandes.
  useEffect(() => {
    editGroupsStore.set({ groups: state.trackGroups || [], settings: state.groupSettings, tracks: state.tracks });
  }, [state.trackGroups, state.groupSettings, state.tracks]);

  // Maj+Ctrl tenues : inversion des groupes pendant le geste (souris, doigt, clavier).
  useEffect(() => {
    const on = (e: KeyboardEvent) => editGroupsStore.setInvertHeld(e.shiftKey && (e.ctrlKey || e.metaKey));
    const off = () => editGroupsStore.setInvertHeld(false);
    window.addEventListener('keydown', on, true);
    window.addEventListener('keyup', on, true);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('keydown', on, true); window.removeEventListener('keyup', on, true); window.removeEventListener('blur', off); };
  }, []);

  // Sélection de plage sur une piste groupée : tout le groupe d'édition (Pro Tools).
  useEffect(() => editSelectionStore.subscribe(() => {
    const t = editSelectionStore.get().time;
    if (!t) return;
    const ids = expandEditTracks(t.trackIds, editGroupsStore.get(), editGroupsStore.invertHeld());
    if (ids.length !== t.trackIds.length) editSelectionStore.set({ time: { ...t, trackIds: ids } });
  }), []);

  // Commandes (raccourcis Pro Tools) : avant les versions de base.
  useEffect(() => registerEditCommands({
    split: () => {
      const sel = editSelectionStore.get();
      if (sel.time || sel.clipIds.length) return false;
      const s = dRef.current.stateRef.current;
      const focus = sel.focusTrackId || s.selectedTrackId;
      if (!focus) return false;
      const inv = editGroupsStore.invertHeld();
      const at = playheadStore.get();
      let ids = expandEditTracks([focus], editGroupsStore.get(), inv);
      // R14 : les prises d'un même passage multipiste (take group) se coupent ensemble.
      if (takeGroupLinked({ suspended: s.groupSettings?.suspended, invert: inv })) {
        const mates = takeGroupTracksAt(s.tracks, focus, at);
        if (mates.length) ids = s.tracks.map(t => t.id).filter(id => ids.includes(id) || mates.includes(id));
      }
      if (ids.length < 2) return false;
      const gen = opIdGen(`gs${Date.now().toString(36)}`);
      let n = 0;
      dRef.current.setState(prev => ({
        ...prev,
        tracks: prev.tracks.map(t => {
          if (!ids.includes(t.id)) return t;
          const clips = splitClipsAt(t.clips, [at], gen);
          if (clips.length === t.clips.length) return t;
          n++;
          return { ...t, clips };
        }),
      }));
      dRef.current.notify(`✂️ Séparé à la tête de lecture sur le groupe (${ids.length} pistes). Maj+Ctrl : la piste seule.`);
      return n >= 0;
    },
    groupCreate: () => { openR12Panel('groups', { newGroup: true }); return true; },
    groupsSuspend: () => {
      const s = dRef.current.stateRef.current;
      const next = !s.groupSettings?.suspended;
      dRef.current.setState(prev => setSuspended(prev as DAWState & GroupsState, next));
      dRef.current.notify(next ? '⏸ Tous les groupes sont suspendus (Pro Tools : Suspend All Groups). Ctrl+Maj+G pour les reprendre.' : '▶ Groupes repris.');
      return true;
    },
    insertTime: () => {
      const sel = editSelectionStore.get().time;
      openR12Panel('time', { preset: sel ? { mode: 'insert', at: sel.start, length: sel.end - sel.start, trackIds: sel.trackIds } : { mode: 'insert', at: playheadStore.get() } });
      return true;
    },
  }, 20), []);

  // Commandes du bus R12.
  useEffect(() => r12Bus.on(cmd => {
    const dd = dRef.current;
    if (cmd.kind === 'panel') { dd.setPanel(cmd.panel ? { panel: cmd.panel, preset: cmd.preset, newGroup: cmd.newGroup } : null); return; }
    if (cmd.kind === 'groups') {
      dd.setState(prev => {
        const next = cmd.apply(prev as DAWState & GroupsState) as DAWState;
        return next === prev ? prev : next;
      });
      if (cmd.label) dd.notify(cmd.label);
      return;
    }
    if (cmd.kind === 'timeop') {
      const r = runTimeOpOn(dd.stateRef.current, cmd.op);
      dd.setState(() => r.state);
      dd.onLocalTimeOp?.(cmd.op, r.state);
      dd.notify(`${r.report.summary}${r.report.exactTempo ? '' : ' · le tempo a suivi à la mesure près (pas à l’échantillon)'} — Ctrl+Z pour revenir.`);
    }
  }), []);
}

/** Opération appliquée à un projet (pur, mêmes ids chez tous). */
export function runTimeOpOn(s: DAWState, op: TimeOp): { state: DAWState; report: TimeOpReport } {
  const r = applyTimeOp(s, op);
  // La sélection ne pointe plus au bon endroit.
  editSelectionStore.set({ time: null });
  return { state: r.state as DAWState, report: r.report };
}

/** Mise à jour d'une piste depuis la console ou un en-tête : les pistes liées par les groupes de mix. */
export function linkedMixUpdates(s: DAWState, prev: Track, next: Track): Track[] {
  return mixLinkUpdates(prev, next, { groups: s.trackGroups || [], settings: s.groupSettings, tracks: s.tracks }, editGroupsStore.invertHeld());
}

export { createGroup, newTimeOpId };
