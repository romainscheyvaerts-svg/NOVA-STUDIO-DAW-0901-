import { useEffect, useRef } from 'react';
import type { DAWState, Track } from '../types';
import { registerEditCommands } from '../utils/editCommands';
import { editSelectionStore } from '../utils/editSelection';
import {
  activePlaylistName, canHavePlaylists, createPlaylist, deletePlaylist, playlistsOf, renamePlaylist, stepPlaylist, switchPlaylist, toggleRecentPlaylist,
} from '../utils/trackPlaylists';
import { fmtParamValue, writeAllToRange, writeParamToRange } from '../utils/automationWriteTo';
import { laneDisplayName, staticParamValue } from '../utils/automationWrite';
import { soloModeStore, type SoloLatch } from '../utils/soloModes';
import { batchPlan, batchSummary, type BatchKind } from '../utils/batchRender';
import { openNovaWindow } from '../utils/novaWindows';
import { commitTracks } from '../utils/commit';
import { novaBridge } from '../services/NovaBridge';

/**
 * Écarts restants avec Pro Tools pour une séance voix / mix (12/10/2026),
 * branchés sur le bus des commandes d'édition (raccourcis, palette Ctrl+K,
 * menus de piste). La logique est dans des modules purs :
 *  - utils/trackPlaylists  : playlists de piste (nouvelle, dupliquer, basculer) ;
 *  - utils/automationWriteTo : écrire la valeur actuelle sur la sélection ;
 *  - utils/soloModes       : solo Verrouiller / X-OR ;
 *  - utils/batchRender     : Commit / gel de plusieurs pistes d'un coup.
 * Une étape d'annulation par geste.
 */
export interface ProToolsEcartsDeps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  selectedTrackIds: (s: DAWState) => string[];
  /** Gel / dégel d'une piste (App : handleFreezeTrack, bascule). */
  freezeTrack: (trackId: string) => Promise<void> | void;
}

/** Commit d'une piste (même chemin que la fenêtre Commit : services/Bounce + utils/commit). */
async function commitOne(d: ProToolsEcartsDeps, trackId: string): Promise<boolean> {
  const s = d.stateRef.current;
  const track = s.tracks.find(t => t.id === trackId);
  if (!track) return false;
  const vst = (track.plugins || []).some(p => p.type === 'VST3' && p.isEnabled && !p.isInactive);
  if (vst && !novaBridge.isConnected()) return false;
  // Chargé à la demande (comme la fenêtre Commit) : le paquet principal reste léger.
  const { DEFAULT_TAIL, renderCommitClip } = await import('../services/Bounce');
  const r = await renderCommitClip(track, { upTo: (track.plugins || []).length - 1, tail: DEFAULT_TAIL, label: 'commit', session: s.tracks });
  const id = `track-commit-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  d.setState(prev => (prev.tracks.some(x => x.id === trackId) ? { ...prev, tracks: commitTracks(prev.tracks, trackId, { id, clip: r.clip, upTo: r.upTo, tail: DEFAULT_TAIL }) } : prev));
  return true;
}

const names = (ts: Track[]) => ts.map(t => `« ${t.name} »`).join(', ');

export function useProToolsEcarts(d: ProToolsEcartsDeps) {
  const ref = useRef(d);
  ref.current = d;

  useEffect(() => {
    const dd = () => ref.current;
    const st = () => dd().stateRef.current;
    const mapTracks = (ids: Set<string>, fn: (t: Track) => Track) =>
      dd().setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (ids.has(t.id) ? fn(t) : t)) }));
    /** Pistes visées : celles données, sinon la sélection (plage, clips, piste active). */
    const targets = (arg?: { trackIds?: string[] }, filter: (t: Track) => boolean = canHavePlaylists) => {
      const s = st();
      const ids = arg?.trackIds?.length ? arg.trackIds : dd().selectedTrackIds(s);
      return s.tracks.filter(t => ids.includes(t.id) && filter(t));
    };
    let busy = false;

    return registerEditCommands({
      // ── Playlists de piste ────────────────────────────────────────────────
      playlistNew: (arg?: { duplicate?: boolean; trackIds?: string[]; name?: string }) => {
        const ts = targets(arg);
        if (!ts.length) { dd().notify('Sélectionne d’abord une piste audio ou MIDI (clic sur son nom).'); return true; }
        const made: string[] = [];
        const stamp = Date.now().toString(36);
        const byId = new Map(ts.map(t => {
          const r = createPlaylist(t, { duplicate: !!arg?.duplicate, name: ts.length === 1 ? arg?.name : undefined, stamp });
          made.push(`« ${r.name} »`);
          return [t.id, r.track] as const;
        }));
        dd().setState(prev => ({ ...prev, tracks: prev.tracks.map(t => byId.get(t.id) || t) }));
        dd().notify(arg?.duplicate
          ? `⧉ Playlist ${made.join(', ')} : copie de la version qu’on entendait, l’originale est gardée intacte. Maj+← pour y revenir.`
          : `🆕 Playlist ${made.join(', ')} : piste vide, prête pour une nouvelle version. L’ancienne est gardée (Maj+← pour y revenir).`);
        return true;
      },
      playlistStep: (arg?: { dir?: 1 | -1; trackIds?: string[] }) => {
        const dir = arg?.dir === -1 ? -1 : 1;
        const ts = targets(arg).filter(t => (t.playlists?.length || 0) > 1);
        if (!ts.length) { dd().notify('Cette piste n’a qu’une playlist : « Nouvelle playlist » (Ctrl+\\) ou « Dupliquer la playlist » (Ctrl+Alt+\\) pour en créer une.'); return true; }
        const next = new Map(ts.map(t => [t.id, stepPlaylist(t, dir)] as const));
        const moved = ts.filter(t => next.get(t.id) !== t);
        if (!moved.length) { dd().notify(dir > 0 ? 'Déjà sur la dernière playlist.' : 'Déjà sur la première playlist.'); return true; }
        dd().setState(prev => ({ ...prev, tracks: prev.tracks.map(t => next.get(t.id) || t) }));
        dd().notify(`▤ ${moved.map(t => activePlaylistName(next.get(t.id)!)).join(', ')} : on entend cette version.`);
        return true;
      },
      playlistRecent: (arg?: { trackIds?: string[] }) => {
        const ts = targets(arg).filter(t => !!t.recentPlaylistId);
        if (!ts.length) { dd().notify('Aucune autre playlist récente sur cette piste.'); return true; }
        const next = new Map(ts.map(t => [t.id, toggleRecentPlaylist(t)] as const));
        dd().setState(prev => ({ ...prev, tracks: prev.tracks.map(t => next.get(t.id) || t) }));
        dd().notify(`⇄ ${ts.map(t => activePlaylistName(next.get(t.id)!)).join(', ')} : on entend cette version (Maj+← pour revenir).`);
        return true;
      },
      playlistSwitch: (arg?: { trackId: string; id: string }) => {
        const t = st().tracks.find(x => x.id === arg?.trackId);
        if (!t || !arg) return false;
        const n = switchPlaylist(t, arg.id);
        if (n === t) return true;
        mapTracks(new Set([t.id]), () => n);
        dd().notify(`▤ « ${t.name} » joue la playlist « ${activePlaylistName(n)} ».`);
        return true;
      },
      playlistRename: (arg?: { trackId: string; id: string; name: string }) => {
        const t = st().tracks.find(x => x.id === arg?.trackId);
        if (!t || !arg) return false;
        mapTracks(new Set([t.id]), x => renamePlaylist(x, arg.id, arg.name));
        return true;
      },
      playlistDelete: (arg?: { trackId: string; id: string }) => {
        const t = st().tracks.find(x => x.id === arg?.trackId);
        if (!t || !arg) return false;
        const { activeId, list } = playlistsOf(t);
        if (arg.id === activeId) { dd().notify('On ne supprime pas la playlist qu’on entend : bascule d’abord sur une autre.'); return true; }
        const name = list.find(p => p.id === arg.id)?.name || 'la playlist';
        mapTracks(new Set([t.id]), x => deletePlaylist(x, arg.id));
        dd().notify(`🗑️ Playlist « ${name} » supprimée. Ctrl+Z pour la retrouver.`);
        return true;
      },

      // ── Écrire l'automation sur la sélection ────────────────────────────
      writeAutomation: (arg?: { all?: boolean; param?: string }) => {
        const sel = editSelectionStore.get().time;
        if (!sel || sel.end - sel.start < 1e-3) {
          dd().notify('Sélectionne d’abord une plage (le refrain…) avec le Sélecteur, règle le fader, puis écris : la valeur s’écrit sur toute la plage.');
          return true;
        }
        const ids = new Set(sel.trackIds);
        const s = st();
        const ts = s.tracks.filter(t => ids.has(t.id) && t.id !== 'master' && !t.isVca);
        if (!ts.length) return false;
        const param = arg?.param || 'volume';
        const results = new Map(ts.map(t => [t.id, arg?.all ? writeAllToRange(t, sel.start, sel.end) : writeParamToRange(t, param, sel.start, sel.end)] as const));
        const done = ts.filter(t => results.get(t.id)!.params.length);
        if (!done.length) { dd().notify('Rien à écrire : ce réglage n’existe pas sur les pistes de la plage.'); return true; }
        dd().setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (results.get(t.id)?.params.length ? results.get(t.id)!.track : t)) }));
        const fmt = (s0: number) => `${Math.floor(s0 / 60)}:${(s0 % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;
        const span = `de ${fmt(sel.start)} à ${fmt(sel.end)}`;
        if (arg?.all) {
          const n = done.reduce((k, t) => k + results.get(t.id)!.params.length, 0);
          dd().notify(`✍️ ${n} réglage${n > 1 ? 's' : ''} écrit${n > 1 ? 's' : ''} ${span} sur ${names(done)} (valeurs actuelles des faders, potards et effets). Ctrl+Z pour annuler.`);
        } else {
          const t0 = done[0];
          const v = staticParamValue(t0, param);
          dd().notify(`✍️ ${laneDisplayName(param, t0)} ${v !== null ? fmtParamValue(param, v) : ''} écrit ${span} sur ${names(done)} ; la courbe hors de la plage ne bouge pas. Ctrl+Z pour annuler.`);
        }
        return true;
      },

      // ── Mode de solo ────────────────────────────────────────────────────
      soloMode: (arg?: { mode?: SoloLatch }) => {
        const mode: SoloLatch = arg?.mode || (soloModeStore.get() === 'xor' ? 'latch' : 'xor');
        soloModeStore.set(mode);
        // Passage en X-OR avec plusieurs solos : on garde le dernier choix de l'ingé (rien n'est coupé d'office).
        dd().notify(mode === 'xor'
          ? '🎧 Solo X-OR : un solo annule les précédents (passer d’une voix à l’autre d’un clic).'
          : '🎧 Solo Verrouiller : les solos s’ajoutent (comme avant).');
        return true;
      },

      // ── Commit / gel en lot ─────────────────────────────────────────────
      batchRender: (arg?: { kind?: BatchKind; trackIds?: string[] }) => {
        if (!arg?.kind) { openNovaWindow('batch-render', { trackIds: dd().selectedTrackIds(st()) } as any); return true; }
        if (busy) { dd().notify('Un rendu en lot est déjà en cours : attends qu’il finisse.'); return true; }
        const kind = arg.kind;
        const ids = arg.trackIds?.length ? arg.trackIds : dd().selectedTrackIds(st());
        const plan = batchPlan(st().tracks, ids, kind);
        if (!plan.todo.length) { dd().notify(batchSummary(kind, plan, 0, [])); return true; }
        busy = true;
        void (async () => {
          let done = 0;
          const failed: string[] = [];
          try {
            for (const id of plan.todo) {
              const t = st().tracks.find(x => x.id === id);
              if (!t) continue;
              dd().notify(`${kind === 'commit' ? '✅ Commit' : kind === 'freeze' ? '❄️ Gel' : '🔥 Dégel'} ${done + 1} / ${plan.todo.length} : « ${t.name} »…`);
              try {
                if (kind === 'commit') { if (await commitOne(dd(), id)) done++; else failed.push(t.name); }
                else { await dd().freezeTrack(id); const now = st().tracks.find(x => x.id === id); if (now && !!now.isFrozen === (kind === 'freeze')) done++; else failed.push(t.name); }
              } catch { failed.push(t.name); }
            }
          } finally { busy = false; }
          dd().notify(batchSummary(kind, plan, done, failed));
        })();
        return true;
      },
    });
  }, []);
}
