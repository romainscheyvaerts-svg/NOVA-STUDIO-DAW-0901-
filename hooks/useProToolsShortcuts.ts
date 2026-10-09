import { useEffect, useRef } from 'react';
import type { DAWState } from '../types';
import { eventChord, findShortcut, keyToken, ShortcutDef } from '../utils/keymap';
import { keymapStore } from '../utils/keymapStore';
import { scrubControl } from '../utils/scrubControl';
import { applyLayout, saveLayout } from '../utils/windowLayouts';
import { editSelectionStore } from '../utils/editSelection';
import { chooseEditMode, editModeStore, EDIT_MODES } from '../utils/editModes';
import { runEditCommand } from '../utils/editCommands';
import { isKeyboardFocus, toggleKeyboardFocus } from '../utils/keyboardFocus';
import { tempoMapStore, timeToPosition, barToTime } from '../utils/tempoMap';
import { MarkerRecallBuffer, markerByNumber } from '../utils/memoryLocations';
import { applySelection, restoreLastSelection, selectionFromMarker, startSelectionHistory } from '../utils/selectionMemory';
import { openNovaWindow } from '../utils/novaWindows';
import { gridStepSeconds } from '../utils/grid';
import { recordAction } from '../utils/feedbackLog';

/**
 * Raccourcis Pro Tools (table utils/keymap). Écoute en phase de capture : un
 * raccourci de la table passe avant ceux de NOVA (pavé numérique, Keyboard
 * Focus) ; tout le reste continue vers App.tsx et l'arrangement, inchangés.
 */
export interface ProToolsShortcutDeps {
  stateRef: React.MutableRefObject<DAWState>;
  getTime: () => number;
  togglePlay: () => void;
  toggleRecord: () => void;
  seek: (time: number) => void;
  toggleLoop: () => void;
  toggleMetronome: () => void;
  addMarker: (time: number) => void;
  selectTrack: (trackId: string) => void;
  undo: () => void;
  notify: (msg: string) => void;
  /** R17 : pavé numérique complet, fenêtres. */
  toggleQuickPunch?: () => void;
  toggleCountIn?: () => void;
  toggleMidiMerge?: () => void;
  openKeymapEditor?: () => void;
  openLayouts?: () => void;
}

const isTypingTarget = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  if (tag === 'input') return !['range', 'button', 'checkbox', 'radio'].includes((node as HTMLInputElement).type);
  return tag === 'textarea' || tag === 'select' || node.isContentEditable;
};

/** Tab (Tab to Transient) : focus nulle part, ou dans l'arrangement. */
const tabBelongsToTimeline = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName || node === document.body || node === document.documentElement) return true;
  return !!node.closest?.('.nova-grille');
};

/** Fenêtre modale ouverte (export, sauvegarde, Strip Silence…) : on laisse faire. */
const modalOpen = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some(el => el.getClientRects().length > 0);

const CLIP_HINT = 'Sélectionne d’abord un clip (ou place la tête de lecture dans un clip de la piste choisie).';

export function useProToolsShortcuts(deps: ProToolsShortcutDeps) {
  const ref = useRef(deps);
  ref.current = deps;

  // « Restaurer la dernière sélection » : l'historique des sélections suit la sélection partagée.
  useEffect(() => startSelectionHistory(), []);
  useEffect(() => {
    const recall = new MarkerRecallBuffer();
    // Shuttle Lock (Pro Tools : Démarrer+1–9 ; ici Ctrl+Alt+pavé 1–9).
    let lock = false;
    let lockDir: 1 | -1 = 1;
    let eventLast: KeyboardEvent | null = null;

    const moveTrack = (dir: 1 | -1) => {
      const st = ref.current.stateRef.current;
      const list = st.tracks.filter(t => t.type !== 'SEND' && t.id !== 'master');
      if (!list.length) return;
      const i = list.findIndex(t => t.id === st.selectedTrackId);
      const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + dir))];
      ref.current.selectTrack(next.id);
    };

    const nudgePlayhead = (dir: 1 | -1, fine: boolean) => {
      const st = ref.current.stateRef.current;
      const step = fine ? 0.01 : gridStepSeconds(String((window as any).gridSize || '1/4'), st.bpm || 120);
      const t = ref.current.getTime();
      const target = fine ? t + dir * step : Math.round((t + dir * step) / step) * step;
      ref.current.seek(Math.max(0, target));
    };

    const run = (sc: ShortcutDef) => {
      const d = ref.current;
      // Mesure d'après la piste tempo (R2) : 3/4, 6/8, changements de tempo.
      const m = tempoMapStore.get();
      const cur = timeToPosition(m, d.getTime());
      switch (sc.id) {
        case 'pt.recordAlt': d.toggleRecord(); return;
        case 'pt.numPlay': d.togglePlay(); return;
        case 'pt.numRew': { const st = barToTime(m, cur.bar); d.seek(Math.max(0, d.getTime() - st > 1e-3 ? st : barToTime(m, Math.max(0, cur.bar - 1)))); return; }
        case 'pt.numFf': d.seek(barToTime(m, cur.bar + 1)); return;
        case 'pt.numLoop': d.toggleLoop(); return;
        case 'pt.numClick': d.toggleMetronome(); return;
        case 'pt.newMarker': d.addMarker(d.getTime()); return;
        case 'pt.recallMarker': recall.dot(); return;
        case 'pt.memoryWindow': openNovaWindow('memory-locations'); return;
        case 'pt.restoreSelection': {
          const st = d.stateRef.current;
          const tracks = new Set(st.tracks.map(t => t.id));
          const clips = new Set(st.tracks.flatMap(t => t.clips.map(c => c.id)));
          d.notify(restoreLastSelection({ track: id => tracks.has(id), clip: id => clips.has(id) }));
          return;
        }
        case 'pt.trackUp': case 'kf.prevTrack': moveTrack(-1); return;
        case 'pt.trackDown': case 'kf.nextTrack': moveTrack(1); return;
        case 'kf.undo': d.undo(); return;
        case 'pt.numLoopRec': d.toggleLoop(); d.notify(d.stateRef.current.isLoopActive ? 'Enregistrement en boucle arrêté.' : '🔁 Enregistrement en boucle : chaque tour devient une prise (couloirs de prises).'); return;
        case 'pt.numQuickPunch': case 'pt.quickPunch': d.toggleQuickPunch?.(); return;
        case 'pt.numCountoff': d.toggleCountIn?.(); return;
        case 'pt.numMidiMerge': d.toggleMidiMerge?.(); return;
        case 'shuttle.fwd': case 'shuttle.back': {
          const v = scrubControl.shuttleStep(sc.id === 'shuttle.fwd' ? 1 : -1);
          d.notify(`⏩ Shuttle ${v < 0 ? 'arrière' : 'avant'} ×${Math.abs(v)} — ${sc.id === 'shuttle.fwd' ? 'appuie encore pour accélérer' : 'appuie encore pour accélérer'}, Alt+K pour arrêter.`);
          return;
        }
        case 'shuttle.stop': lock = false; scrubControl.stopShuttle(); return;
        case 'shuttle.lock': {
          const n = Number(/num(\d)$/.exec(keyToken(eventLast!))?.[1] || 5);
          lock = true;
          const v = scrubControl.shuttleLock(n, lockDir);
          d.notify(`🔒 Shuttle Lock ×${Math.round(Math.abs(v) * 1000) / 1000} : pavé 1–9 = vitesse, − / + = sens, 0 = pause, Espace ou Échap pour sortir.`);
          return;
        }
        case 'scrub.nudgeL': scrubControl.nudge(-1); return;
        case 'scrub.nudgeR': scrubControl.nudge(1); return;
        case 'pt.modeCycle': {
          const i = EDIT_MODES.indexOf(editModeStore.get().mode);
          d.notify(chooseEditMode(EDIT_MODES[(i + 1) % EDIT_MODES.length]).message);
          return;
        }
        case 'layout.1': case 'layout.2': case 'layout.3': case 'layout.4': case 'layout.5': {
          const n = Number(sc.arg);
          const l = applyLayout(n);
          d.notify(l ? `🪟 Disposition ${n} : ${l.name}` : `Disposition ${n} vide : ouvre la liste (Ctrl+Alt+J) pour y enregistrer la vue actuelle.`);
          return;
        }
        case 'layout.list': d.openLayouts?.(); return;
        case 'keymap.editor': d.openKeymapEditor?.(); return;
        case 'pt.focus': {
          toggleKeyboardFocus();
          d.notify(isKeyboardFocus()
            ? 'Keyboard Focus actif : une touche = une commande (A, S, D, G, B, R, T…). Ctrl+Espace pour enregistrer, Ctrl+Alt+1 pour arrêter.'
            : 'Keyboard Focus arrêté : les raccourcis de NOVA reviennent.');
          return;
        }
      }
      if (!sc.command) return;
      if (runEditCommand(sc.command, sc.arg)) return;
      // Replis : sans sélection (ou tant que le nudge des clips n'est pas branché), la tête de lecture.
      if (sc.command === 'nudgeLeft' || sc.command === 'nudgeRight') { nudgePlayhead(sc.command === 'nudgeLeft' ? -1 : 1, !!sc.arg?.fine); return; }
      if (sc.command.startsWith('zoom') || sc.command.startsWith('trackHeight')) return;
      d.notify(CLIP_HINT);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      // Piano roll / batterie ouverts : leurs propres touches (flèches = transposer…).
      if (document.querySelector('[data-nova-transport]')) return;
      if (modalOpen()) return;

      // Saisie « . N . » du pavé numérique (rappel d'un repère).
      if (recall.active) {
        const tok = keyToken(e);
        if (/^num\d$/.test(tok)) { e.preventDefault(); e.stopPropagation(); recall.digit(tok.slice(3)); return; }
        // « . » N « * » : rappeler la disposition N ; « . » N « / » : y enregistrer la vue (Pro Tools : Window Configurations).
        if (tok === 'nummul' || tok === 'numdiv') {
          e.preventDefault(); e.stopPropagation();
          const n = recall.close();
          if (n === null) return;
          if (tok === 'nummul') {
            const l = applyLayout(n);
            ref.current.notify(l ? `🪟 Disposition ${n} : ${l.name}` : `Disposition ${n} vide : enregistre la vue actuelle avec pavé . ${n} / (ou Ctrl+Alt+J).`);
          } else {
            const l = saveLayout(n);
            ref.current.notify(`🪟 Vue enregistrée dans la disposition ${n} (${l.name}). Rappel : pavé . ${n} * ou Ctrl+Maj+${n <= 5 ? n : '…'}.`);
          }
          return;
        }
        if (tok === 'numdec' || tok === 'numenter') {
          e.preventDefault(); e.stopPropagation();
          const n = recall.close();
          if (n === null) return;
          const st = ref.current.stateRef.current;
          const m = markerByNumber(st.markers, n);
          // Repère de sélection : la plage revient sélectionnée (Pro Tools : Memory Location « Selection »).
          const sel = m ? selectionFromMarker(m, st.tracks.map(t => t.id)) : null;
          if (sel) { applySelection({ time: sel, clipIds: [] }); ref.current.notify(`📍 ${m!.name} : plage resélectionnée.`); }
          if (m) ref.current.seek(m.time);
          else ref.current.notify(`Pas de repère n° ${n}. Ouvre la liste des repères (Ctrl+5).`);
          return;
        }
        recall.cancel();
      }

      // Shuttle Lock en cours (Pro Tools) : chiffres du pavé = vitesse, − / + = sens, 0 = pause, Espace / Échap = sortir.
      if (lock) {
        const tok = keyToken(e);
        const dg = /^num(\d)$/.exec(tok);
        if (dg || tok === 'numsub' || tok === 'numadd' || tok === 'space' || tok === 'escape') {
          e.preventDefault(); e.stopPropagation();
          if (e.repeat) return;
          if (tok === 'space' || tok === 'escape') { lock = false; scrubControl.stopShuttle(); ref.current.notify('Shuttle Lock terminé.'); return; }
          if (tok === 'numsub' || tok === 'numadd') { lockDir = tok === 'numsub' ? -1 : 1; scrubControl.shuttleDirection(lockDir); return; }
          scrubControl.shuttleLock(Number(dg![1]), lockDir);
          return;
        }
      }

      const chord = eventChord(e);
      const sc = findShortcut(chord, isKeyboardFocus());
      if (!sc) return;
      // Ctrl+F sans plage : la recherche du navigateur, sauf si l'option « Ctrl+F = fondus » est cochée.
      if (sc.id === 'pt.fadesRange' && !editSelectionStore.get().time && !keymapStore.get().ctrlFFades) return;
      // Tab to Transient : seulement depuis l'arrangement (ou sans focus) ; ailleurs,
      // Tab garde son rôle de navigation au clavier entre les boutons.
      if (keyToken(e) === 'tab' && !tabBelongsToTimeline(e.target)) return;
      // Touche maintenue : seuls le nudge, le zoom, la hauteur et Tab se répètent.
      if (e.repeat && !/^(nudge|zoom|trackHeight|tabToTransient|clipGainNudge)/.test(sc.command || '') && !sc.id.startsWith('scrub.')) { e.preventDefault(); e.stopPropagation(); return; }
      e.preventDefault();
      e.stopPropagation();
      recordAction(`raccourci:${sc.id}`);
      eventLast = e;
      run(sc);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
