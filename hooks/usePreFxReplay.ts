import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { produce } from 'immer';
import { AutomationLane, Clip, DAWState } from '../types';
import { novaBridge } from '../services/NovaBridge';
import { useBridgeState } from './useNovaBridge';
import { canRevert, PRE_VOLUME, revertToBase } from '../utils/preFxEdits';
import { applyRefreeze, applyThaw, planThaw, replaySummary, ReplaySummary, thawCandidates, ThawPlan } from '../utils/preFxThaw';
import { SessionConflict, SessionMerge, takeTheirsFor } from '../utils/preFxMerge';

export interface PreFxPanelData {
  summary: ReplaySummary;
  missing: ThawPlan['missing'];
  thawed: string[];
  /** Pistes remises dans la version d'avant les éditions (pour « Rétablir »). */
  reverted: Record<string, { clips: Clip[]; lanes: AutomationLane[] }>;
  /** Fusion de deux versions (session modifiée ailleurs en même temps). */
  merge?: { conflicts: SessionConflict[]; theirs: DAWState['tracks']; resolved: string[]; added: number };
}

/**
 * PC de l'ingé (pont VST connecté) : à l'ouverture d'une session gelée
 * automatiquement, dégèle les pistes dont les plugins sont sur ce PC et
 * montre le résumé des éditions rejouées avant les effets.
 */
export function usePreFxReplay(o: {
  stateId: string;
  tracks: DAWState['tracks'];
  showLanding: boolean;
  stateRef: MutableRefObject<DAWState>;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  notify: (msg: string, ms?: number) => void;
}) {
  const { stateId, tracks, showLanding, stateRef, setState, notify } = o;
  const bridge = useBridgeState();
  const [panel, setPanel] = useState<PreFxPanelData | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const triedRef = useRef(new Set<string>());
  const busyRef = useRef(false);
  const [doneTick, setDoneTick] = useState(0);
  // Pistes gelées automatiquement pas encore essayées (une piste dont le plugin
  // manque n'est réessayée qu'avec « Réessayer » : pas de boucle, pas de résumé écrasé).
  const keyOf = (id: string, render: string) => `${stateId}:${id}:${render}`;
  const pendKey = thawCandidates(tracks).filter(t => !triedRef.current.has(keyOf(t.id, t.frozenClip!.id)))
    .map(t => `${t.id}:${t.frozenClip!.id}`).join('|');

  useEffect(() => {
    if (bridge.status !== 'connected' || showLanding || !pendKey || busyRef.current) return;
    busyRef.current = true;
    void (async () => {
      try {
        const list = await novaBridge.listPlugins().catch(() => novaBridge.getCachedPlugins());
        const tracksNow = stateRef.current.tracks;
        thawCandidates(tracksNow).forEach(t => triedRef.current.add(keyOf(t.id, t.frozenClip!.id)));
        const plan = planThaw(tracksNow, list.map(p => p.path).filter(Boolean));
        if (plan.thaw.length) setState(produce((d: DAWState) => { applyThaw(d.tracks, plan.thaw); }));
        const summary = replaySummary(tracksNow, plan.thaw);
        if (summary.total > 0 || plan.missing.length > 0) {
          setPanel({ summary, missing: plan.missing, thawed: plan.thaw, reverted: {} });
        } else if (plan.thaw.length) {
          notify('🔥 Pistes dégelées : tes plugins tournent à nouveau sur ce PC.', 4000);
        }
      } catch (e) {
        console.warn('[Dégel auto]', e);
      } finally {
        busyRef.current = false;
        setDoneTick(n => n + 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.status, showLanding, pendKey, retryTick, doneTick, stateRef, setState, notify]);

  /** Dégel fait à la main : même résumé s'il y a des éditions. */
  const announce = useCallback((ids: string[]) => {
    const summary = replaySummary(stateRef.current.tracks, ids);
    if (summary.total > 0) setPanel({ summary, missing: [], thawed: ids, reverted: {} });
  }, [stateRef]);

  const close = useCallback(() => setPanel(null), []);

  /** Après une fusion de versions : éditions reprises et conflits expliqués. */
  const showMerge = useCallback((m: SessionMerge, theirs: DAWState) => {
    const summary = replaySummary(m.state.tracks, m.mergedTrackIds);
    setPanel({ summary, missing: [], thawed: [], reverted: {}, merge: { conflicts: m.conflicts, theirs: theirs.tracks, resolved: [], added: m.addedTrackIds.length } });
  }, []);

  /** Conflit : prendre la version de l'autre pour ce passage (annulable : Ctrl+Z). */
  const takeTheirs = useCallback((c: SessionConflict) => {
    const other = panel?.merge?.theirs.find(t => t.id === c.trackId);
    if (!other) return;
    setState(produce((d: DAWState) => {
      const x = d.tracks.find(y => y.id === c.trackId);
      if (x) x.clips = takeTheirsFor(x as any, other, c.baseClipId) as Clip[];
    }));
    setPanel(p => (p?.merge ? { ...p, merge: { ...p.merge, resolved: [...p.merge.resolved, `${c.trackId}:${c.baseClipId}`] } } : p));
  }, [panel, setState]);

  const refreeze = useCallback(() => {
    const ids = panel?.thawed || [];
    setState(produce((d: DAWState) => { applyRefreeze(d.tracks, ids); }));
    setPanel(null);
    notify('❄️ Pistes regelées : tu réentends le rendu fait au studio. Dégèle-les (❄️) quand tu veux.', 5000);
  }, [panel, setState, notify]);

  const revertTrack = useCallback((trackId: string) => {
    const t = stateRef.current.tracks.find(x => x.id === trackId);
    const base = t?.freezeBase;
    const info = panel?.summary.tracks.find(x => x.trackId === trackId);
    if (!t || !base || !info || base.renderId !== info.baseRenderId || !canRevert(base, t.clips)) {
      notify("Impossible de revenir à la version d'avant pour cette piste (elle a été re-rendue depuis). Ctrl+Z reste possible.", 5000);
      return;
    }
    const prev = { clips: t.clips, lanes: t.automationLanes };
    setState(produce((d: DAWState) => {
      const x = d.tracks.find(y => y.id === trackId);
      if (!x) return;
      x.clips = revertToBase(base, x.clips as Clip[]);
      const lane = x.automationLanes.find(l => l.parameterName === PRE_VOLUME);
      if (lane) lane.points = (base.preVolume || []).map(p => ({ ...p }));
    }));
    setPanel(p => (p ? { ...p, reverted: { ...p.reverted, [trackId]: prev } } : p));
  }, [panel, stateRef, setState, notify]);

  const restoreTrack = useCallback((trackId: string) => {
    const prev = panel?.reverted[trackId];
    if (!prev) return;
    setState(produce((d: DAWState) => {
      const x = d.tracks.find(y => y.id === trackId);
      if (!x) return;
      x.clips = prev.clips as Clip[];
      x.automationLanes = prev.lanes as AutomationLane[];
    }));
    setPanel(p => {
      if (!p) return p;
      const { [trackId]: _drop, ...rest } = p.reverted;
      return { ...p, reverted: rest };
    });
  }, [panel, setState]);

  const retry = useCallback(() => { triedRef.current.clear(); setPanel(null); setRetryTick(n => n + 1); }, []);

  return { panel, announce, close, refreeze, revertTrack, restoreTrack, retry, showMerge, takeTheirs, bridgeConnected: bridge.status === 'connected' };
}
