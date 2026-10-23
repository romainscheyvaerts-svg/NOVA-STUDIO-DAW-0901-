import { useEffect, useRef } from 'react';
import type { DAWState, Track } from '../types';
import { registerEditCommands } from '../utils/editCommands';
import { editSelectionStore } from '../utils/editSelection';
import { canHavePlaylists } from '../utils/trackPlaylists';
import { selectionToNewPlaylist } from '../utils/playlistSelection';
import { glideAll, glideParam, SPAN_LABEL, spanRange, writeAllToSpan, writeParamToSpan, type WriteSpan } from '../utils/automationSpan';
import { fmtParamValue } from '../utils/automationWriteTo';
import { laneDisplayName, staticParamValue } from '../utils/automationWrite';
import { songEnd } from '../utils/timeOps';
import { coalesceOverflow, coalesceVca } from '../utils/vcaCoalesce';

/**
 * Écarts Pro Tools, 2e tour (chantier 19, 12/10/2026), branchés sur le bus des
 * commandes (raccourcis, palette Ctrl+K, menus, barre de la plage) :
 *  - copier / déplacer la sélection vers une nouvelle playlist (utils/playlistSelection) ;
 *  - Write to Start / End / All / Punch, Glide et Glide to Current (utils/automationSpan) ;
 *  - fusionner un VCA dans ses pistes (utils/vcaCoalesce).
 * Une étape d'annulation par geste ; chaque message dit ce qui a changé et comment revenir.
 */
export interface ProToolsEcarts2Deps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  selectedTrackIds: (s: DAWState) => string[];
}

const names = (ts: Track[]) => ts.map(t => `« ${t.name} »`).join(', ');
const fmtT = (s0: number) => `${Math.floor(s0 / 60)}:${(s0 % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;

export function useProToolsEcarts2(d: ProToolsEcarts2Deps) {
  const ref = useRef(d);
  ref.current = d;

  useEffect(() => {
    const dd = () => ref.current;
    const st = () => dd().stateRef.current;
    const apply = (results: Map<string, Track>) =>
      dd().setState(prev => ({ ...prev, tracks: prev.tracks.map(t => results.get(t.id) || t) }));
    /** Pistes d'automation visées : celles de la plage, sinon la sélection. */
    const autoTargets = (): Track[] => {
      const s = st();
      const sel = editSelectionStore.get().time;
      const ids = new Set(sel?.trackIds?.length ? sel.trackIds : dd().selectedTrackIds(s));
      return s.tracks.filter(t => ids.has(t.id) && t.id !== 'master' && !t.isVca);
    };

    return registerEditCommands({
      // ── Sélection → nouvelle playlist ───────────────────────────────────
      playlistFromSelection: (arg?: { move?: boolean }) => {
        const sel = editSelectionStore.get().time;
        if (!sel || sel.end - sel.start < 1e-3) {
          dd().notify('Sélectionne d’abord une plage (la bonne phrase…) avec le Sélecteur : elle partira dans une nouvelle playlist.');
          return true;
        }
        const s = st();
        const ts = s.tracks.filter(t => sel.trackIds.includes(t.id) && canHavePlaylists(t));
        if (!ts.length) { dd().notify('La plage ne touche aucune piste audio ou MIDI.'); return true; }
        const stamp = Date.now().toString(36);
        const out = new Map<string, Track>();
        const made: string[] = [];
        for (const t of ts) {
          const r = selectionToNewPlaylist(t, sel.start, sel.end, { move: !!arg?.move, stamp });
          if (r.id) { out.set(t.id, r.track); made.push(`« ${r.name} »`); }
        }
        if (!out.size) { dd().notify('Rien à copier : la plage ne contient aucun clip.'); return true; }
        apply(out);
        dd().notify(arg?.move
          ? `✂️ Plage de ${fmtT(sel.start)} à ${fmtT(sel.end)} déplacée vers la playlist ${made.join(', ')} (retirée de la version qu’on entend). « Playlist d’avant » (Maj+← en préréglage Studio pro) pour l’écouter, Ctrl+Z pour annuler.`
          : `⧉ Plage de ${fmtT(sel.start)} à ${fmtT(sel.end)} copiée dans la playlist ${made.join(', ')} ; on entend toujours la même version. « Playlist d’avant » (Maj+← en préréglage Studio pro) pour l’écouter.`);
        return true;
      },

      // ── Write to Start / End / All / Punch ──────────────────────────────
      writeAutomationSpan: (arg?: { span?: WriteSpan; all?: boolean; param?: string }) => {
        const span: WriteSpan = arg?.span || 'all';
        const s = st();
        const r = spanRange(span, { sel: editSelectionStore.get().time, playhead: s.currentTime || 0, songEnd: songEnd(s), punch: s.punch });
        if (!r) {
          dd().notify(span === 'punch'
            ? 'Pose d’abord une zone de punch (bouton « Punch » de la barre de la plage, ou les poignées de la règle), puis écris dessus.'
            : 'Place la tête de lecture ou sélectionne une plage : l’écriture part de là.');
          return true;
        }
        const ts = autoTargets();
        if (!ts.length) { dd().notify('Sélectionne d’abord une piste (clic sur son nom) ou une plage.'); return true; }
        const param = arg?.param || 'volume';
        const res = new Map(ts.map(t => [t.id, arg?.all ? writeAllToSpan(t, r.a, r.b) : writeParamToSpan(t, param, r.a, r.b)] as const));
        const done = ts.filter(t => res.get(t.id)!.params.length);
        if (!done.length) { dd().notify('Rien à écrire : ce réglage n’existe pas sur ces pistes.'); return true; }
        apply(new Map(done.map(t => [t.id, res.get(t.id)!.track] as const)));
        const where = span === 'all' ? SPAN_LABEL.all : span === 'punch' ? `${SPAN_LABEL.punch} (${fmtT(r.a)} → ${fmtT(r.b)})`
          : span === 'start' ? `du début à ${fmtT(r.b)}` : `de ${fmtT(r.a)} à la fin`;
        if (arg?.all) {
          const n = done.reduce((k, t) => k + res.get(t.id)!.params.length, 0);
          dd().notify(`✍️ ${n} réglage${n > 1 ? 's' : ''} écrit${n > 1 ? 's' : ''} ${where} sur ${names(done)} (valeurs actuelles). Ctrl+Z pour annuler.`);
        } else {
          const v = staticParamValue(done[0], param);
          dd().notify(`✍️ ${laneDisplayName(param, done[0])} ${v !== null ? fmtParamValue(param, v) : ''} écrit ${where} sur ${names(done)}. Ctrl+Z pour annuler.`);
        }
        return true;
      },

      // ── Glide / Glide to Current ─────────────────────────────────────────
      glideAutomation: (arg?: { toCurrent?: boolean; all?: boolean; param?: string }) => {
        const sel = editSelectionStore.get().time;
        if (!sel || sel.end - sel.start < 1e-3) {
          dd().notify('Sélectionne la plage du glissé (du premier réglage au second) avec le Sélecteur : la courbe y devient une rampe droite.');
          return true;
        }
        const ts = autoTargets();
        if (!ts.length) return false;
        const toCurrent = !!arg?.toCurrent;
        const param = arg?.param || 'volume';
        const res = new Map(ts.map(t => [t.id, arg?.all ? glideAll(t, sel.start, sel.end, toCurrent) : glideParam(t, param, sel.start, sel.end, toCurrent)] as const));
        const done = ts.filter(t => res.get(t.id)!.params.length);
        if (!done.length) {
          dd().notify(toCurrent
            ? 'Rien à glisser : la courbe est déjà sur la valeur du fader. Règle le fader sur la valeur d’arrivée, puis recommence.'
            : 'Rien à glisser : pas de courbe d’automation sur cette plage. Écris d’abord deux valeurs (Ctrl+/), puis glisse entre elles.');
          return true;
        }
        apply(new Map(done.map(t => [t.id, res.get(t.id)!.track] as const)));
        const span = `de ${fmtT(sel.start)} à ${fmtT(sel.end)}`;
        if (toCurrent) {
          const v = staticParamValue(done[0], param);
          dd().notify(`↗️ Glissé ${span} jusqu’à ${arg?.all ? 'la valeur actuelle de chaque réglage' : `${laneDisplayName(param, done[0])} ${v !== null ? fmtParamValue(param, v) : ''}`} sur ${names(done)}. Ctrl+Z pour annuler.`);
        } else {
          dd().notify(`↗️ Rampe droite ${span} sur ${names(done)} : les points entre les deux ont été remplacés. Ctrl+Z pour annuler.`);
        }
        return true;
      },

      // ── Fusionner un VCA dans ses pistes ────────────────────────────────
      vcaCoalesce: (arg?: { trackIds?: string[] }) => {
        const s = st();
        const ids = arg?.trackIds?.length ? arg.trackIds : dd().selectedTrackIds(s);
        let vcas = s.tracks.filter(t => t.isVca && ids.includes(t.id));
        if (!vcas.length) vcas = s.tracks.filter(t => t.isVca);
        if (!vcas.length) { dd().notify('Aucun VCA dans le projet : crée-en un depuis la console (bouton « VCA »).'); return true; }
        if (vcas.length > 1 && !ids.some(id => vcas.some(v => v.id === id))) {
          dd().notify(`Plusieurs VCA (${names(vcas)}) : sélectionne celui à fusionner (clic sur son nom), puis recommence.`);
          return true;
        }
        let tracks = s.tracks;
        const parts: string[] = [];
        const over: string[] = [];
        for (const v of vcas) {
          const r = coalesceVca(tracks, v.id);
          if (!r.members.length) { parts.push(`« ${v.name} » déjà à 0 dB (rien à reporter)`); continue; }
          tracks = r.tracks;
          parts.push(`« ${v.name} » (${fmtParamValue('volume', r.gain)}) reporté dans ${r.members.length} piste${r.members.length > 1 ? 's' : ''}`);
          over.push(...coalesceOverflow(r));
        }
        if (tracks !== s.tracks) dd().setState(prev => ({ ...prev, tracks: prev.tracks.map(t => tracks.find(x => x.id === t.id) || t) }));
        dd().notify(`🎚️ ${parts.join(' ; ')}. Le son ne change pas ; le VCA est revenu à 0 dB.${over.length ? ` Attention : ${over.join(', ')} dépasse +12 dB.` : ''} Ctrl+Z pour annuler.`);
        return true;
      },
    });
  }, []);
}
