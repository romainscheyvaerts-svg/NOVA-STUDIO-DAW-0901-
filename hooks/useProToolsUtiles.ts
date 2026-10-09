import { useEffect, useRef } from 'react';
import type { ClipLock, DAWState } from '../types';
import { registerEditCommands } from '../utils/editCommands';
import { editSelectionStore } from '../utils/editSelection';
import { playheadStore } from '../utils/playheadStore';
import { countLabel, setAllMute, setAllSolo, soloMuteStatus, toggleField, toggleSoloSafe } from '../utils/soloMute';
import { clipLockNotices, toggleClipLock } from '../utils/clipLock';
import { meterBank } from '../engine/meters/meterBank';

/**
 * Commandes Pro Tools du quotidien (ingé voix / mix), branchées sur le bus des
 * commandes d'édition (utils/editCommands) : raccourcis (utils/keymap),
 * palette Ctrl+K, boutons Solo / Mute (Alt+clic, Ctrl+clic), indicateurs.
 * La logique est dans utils/soloMute et utils/clipLock ; ici seulement le
 * branchement sur l'état du projet (une étape d'annulation par geste).
 *
 *  - soloAll / muteAll        : Alt+clic sur un Solo / Mute, « Effacer tous les solos / mutes » ;
 *  - soloSafe                 : Ctrl+clic sur un Solo, menu de la piste ;
 *  - soloSelected / muteSelected : Maj+S / Maj+M ;
 *  - clearClipIndicators      : Alt+C (diodes de saturation de toutes les pistes) ;
 *  - clipLock                 : Ctrl+L (édition) / Alt+Maj+L (position).
 */
export interface ProToolsUtilesDeps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  /** Pistes sélectionnées (plage, clips sélectionnés, sinon la piste active). */
  selectedTrackIds: (s: DAWState) => string[];
}

/** Clips visés par un verrou : la sélection, sinon le clip de la piste active sous la tête de lecture. */
export function lockTargets(s: DAWState): string[] {
  const sel = editSelectionStore.get().clipIds;
  if (sel.length) return [...sel];
  const t = s.tracks.find(x => x.id === s.selectedTrackId);
  const at = playheadStore.get();
  return t ? t.clips.filter(c => at >= c.start && at < c.start + c.duration).map(c => c.id) : [];
}

export function useProToolsUtiles(d: ProToolsUtilesDeps) {
  const ref = useRef(d);
  ref.current = d;

  // Refus d'une modification sur un clip verrouillé : le message part d'ici (une fois).
  useEffect(() => clipLockNotices.on(text => ref.current.notify(text)), []);

  useEffect(() => {
    const dd = () => ref.current;
    const tracksOf = () => dd().stateRef.current.tracks;
    const apply = (fn: (s: DAWState) => DAWState) => dd().setState(prev => { const n = fn(prev); return n === prev ? prev : n; });

    return registerEditCommands({
      soloAll: (arg?: { on?: boolean }) => {
        const on = !!arg?.on;
        const st = soloMuteStatus(tracksOf());
        if (!on && !st.soloed.length) { dd().notify('Aucune piste en solo : tout s’entend déjà.'); return true; }
        apply(s => ({ ...s, tracks: setAllSolo(s.tracks, on) }));
        dd().notify(on ? '🎧 Toutes les pistes en solo.' : `🔈 Solos effacés (${countLabel(st.soloed.length, 'piste', 'pistes')}) : tout le morceau s’entend.`);
        return true;
      },
      muteAll: (arg?: { on?: boolean }) => {
        const on = !!arg?.on;
        const st = soloMuteStatus(tracksOf());
        if (!on && !st.muted.length) { dd().notify('Aucune piste muette.'); return true; }
        apply(s => ({ ...s, tracks: setAllMute(s.tracks, on) }));
        dd().notify(on ? '🔇 Toutes les pistes sont muettes.' : `🔊 Mutes effacés (${countLabel(st.muted.length, 'piste', 'pistes')}) : toutes les pistes ont le son.`);
        return true;
      },
      soloSafe: (arg?: { trackIds?: string[] }) => {
        const s0 = dd().stateRef.current;
        const ids = arg?.trackIds?.length ? arg.trackIds : dd().selectedTrackIds(s0);
        if (!ids.length) { dd().notify('Sélectionne d’abord une piste (clic sur son nom).'); return true; }
        const r = toggleSoloSafe(s0.tracks, ids);
        if (r.tracks === s0.tracks) { dd().notify('Le master n’a pas de solo safe.'); return true; }
        apply(s => ({ ...s, tracks: toggleSoloSafe(s.tracks, ids).tracks }));
        const names = s0.tracks.filter(t => ids.includes(t.id)).map(t => `« ${t.name} »`).join(', ');
        dd().notify(r.on
          ? `🛡️ Solo safe : ${names} reste audible quand une autre piste est en solo. Ctrl+clic sur son S pour l’enlever.`
          : `Solo safe retiré : ${names} se coupe à nouveau quand une autre piste est en solo.`);
        return true;
      },
      soloSelected: () => toggleSelected('isSolo'),
      muteSelected: () => toggleSelected('isMuted'),
      clearClipIndicators: () => {
        meterBank.resetClip();
        dd().notify('Diodes de saturation éteintes sur toutes les pistes et le master.');
        return true;
      },
      clipLock: (arg?: { kind?: ClipLock; clipIds?: string[] }) => {
        const kind: ClipLock = arg?.kind === 'time' ? 'time' : 'edit';
        const s0 = dd().stateRef.current;
        const ids = arg?.clipIds?.length ? arg.clipIds : lockTargets(s0);
        if (!ids.length) { dd().notify('Sélectionne d’abord un clip (clic dessus), ou place la tête de lecture dans un clip de la piste choisie.'); return true; }
        const r = toggleClipLock(s0.tracks, ids, kind);
        apply(s => ({ ...s, tracks: toggleClipLock(s.tracks, ids, kind).tracks }));
        const what = countLabel(r.count, 'clip', 'clips');
        dd().notify(r.on
          ? (kind === 'edit'
            ? `🔒 ${what} verrouillé${r.count > 1 ? 's' : ''} : ni déplacé, ni rogné, ni coupé, ni supprimé. Ctrl+L pour déverrouiller.`
            : `📌 ${what} verrouillé${r.count > 1 ? 's' : ''} sur sa position : il se rogne et se retouche, mais reste calé. Alt+Maj+L pour libérer.`)
          : `🔓 ${what} déverrouillé${r.count > 1 ? 's' : ''}.`);
        return true;
      },
    });

    function toggleSelected(field: 'isSolo' | 'isMuted') {
      const s0 = dd().stateRef.current;
      const ids = dd().selectedTrackIds(s0);
      if (!ids.length) { dd().notify('Sélectionne d’abord une piste (clic sur son nom).'); return true; }
      const r = toggleField(s0.tracks, ids, field);
      if (!r.count) { dd().notify('Le master n’a ni solo ni muet de piste.'); return true; }
      apply(s => ({ ...s, tracks: toggleField(s.tracks, ids, field).tracks }));
      const names = s0.tracks.filter(t => ids.includes(t.id) && t.id !== 'master').map(t => `« ${t.name} »`).join(', ');
      dd().notify(field === 'isSolo'
        ? (r.on ? `🎧 Solo : ${names}. Maj+S pour réentendre tout, Alt+Maj+S efface tous les solos.` : `Solo retiré : ${names}.`)
        : (r.on ? `🔇 Muet : ${names}. Maj+M pour rendre le son.` : `🔊 Son rendu : ${names}.`));
      return true;
    }
  }, []);
}
