import { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip, DAWState, TakeMeta, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import {
  applySwap, BeatInfo, BeatSwapOp, doneText, followsBeat, hasVoicesToKeep, isBeatTrack, KeyInfo, planSummary, planSwap, SwapOptions, SwapPlan,
} from '../utils/beatSwap';
import { compareScores, findRedoSpots, RedoSpot } from '../utils/repunch';
import { redoPunchZone } from '../utils/punch';
import { scoreTake, TakeScore } from '../utils/takeScore';
import { takeNumberOf } from '../utils/takes';
import { isVoiceTrack } from '../utils/vocalRoles';
import { r23Bus, redoSpotsStore, SwapSource } from '../utils/r23Store';
import { analyzeCurrentBeat, analyzeNewBeat, renderVoices } from '../services/beatSwapRun';

/**
 * R23 · Changer de beat en gardant les voix, repunch intelligent : les
 * branchements de App (court). La logique est dans utils/beatSwap,
 * utils/repunch et utils/punch ; l'audio dans services/beatSwapRun.
 *
 *  - « Remplacer l'instru… » : fenêtre (choix du beat, analyse, réglages,
 *    alertes), rendu des voix, puis le projet change en UNE étape
 *    d'annulation. Carte de résultat : Avant / Après (annuler / rétablir),
 *    « Revenir à l'ancien beat ».
 *  - « Repérer les passages à refaire » : repères sur la timeline ;
 *    « Refaire ce passage » pose la zone de punch (pré-roll), arme la piste et
 *    lance la prise ; ensuite avant / après et choix.
 */
export interface R23Deps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  setSilently: (fn: (prev: DAWState) => DAWState) => void;
  breakHistory: () => void;
  undo: () => void;
  redo: () => void;
  notify: (text: string) => void;
  /** Ouvre le store de beats (le prochain beat choisi passe par ici tant que la fenêtre attend). */
  openStore: () => void;
  /** Son du beat choisi (catalogue ou fichier), décodé ; méta du catalogue. */
  fetchBeat: (s: SwapSource) => Promise<{ buffer: AudioBuffer; audioRef: string; bpm?: number; key?: KeyInfo | null; instrumentId?: string | number; genre?: string; title: string }>;
  /** Aucune voix à garder : chargement normal du beat. */
  loadDirect: (s: SwapSource) => void;
  usesProjectKey: (type: string) => boolean;
  /** Arme la piste pour refaire un passage (gardant les autres pistes armées : multipiste). */
  armForRedo: (trackId: string) => Promise<boolean>;
  toggleRecord: () => void;
  playFrom: (t: number) => void;
  isRecording: () => boolean;
  /** Collaboration : le changement de beat part en une opération. */
  onSwapped?: (next: DAWState, op: Omit<BeatSwapOp, 'tracks' | 'id'> & { trackIds: string[] }) => void;
}

export type SwapPhase = 'choose' | 'store' | 'analyzing' | 'ready' | 'rendering' | 'error';

export interface SwapModel {
  phase: SwapPhase;
  source: SwapSource | null;
  oldInfo: BeatInfo | null;
  newInfo: BeatInfo | null;
  opts: SwapOptions;
  plan: SwapPlan | null;
  voices: number;
  progress?: { i: number; n: number; name: string };
  error?: string;
}

export interface SwapResult { plan: SwapPlan; title: string; showing: 'after' | 'before'; text: string }

export interface CompareModel {
  trackId: string;
  trackName: string;
  zone: { start: number; end: number };
  before: TakeScore | null;
  after: TakeScore | null;
  verdict: ReturnType<typeof compareScores>;
  showing: 'after' | 'before';
  /** Autres pistes refaites en même temps (multipiste). */
  others: number;
}

/** Son mono audible d'une piste entre deux instants (clips non mutés, gain du clip). */
export function trackAudio(track: Pick<Track, 'clips'>, from: number, to: number): { x: Float32Array; sr: number } | null {
  const clips = track.clips.filter(c => !c.isMuted && !c.notes && (c.bufferId || c.buffer) && c.start < to && c.start + c.duration > from);
  const first = clips.map(c => (c.bufferId ? audioBufferRegistry.get(c.bufferId) : c.buffer)).find(Boolean);
  if (!first) return null;
  const sr = first.sampleRate;
  const n = Math.max(0, Math.round((to - from) * sr));
  if (!n) return null;
  const x = new Float32Array(n);
  for (const c of clips) {
    const b = c.bufferId ? audioBufferRegistry.get(c.bufferId) : c.buffer;
    if (!b || b.sampleRate !== sr) continue;
    const a = Math.max(from, c.start), e = Math.min(to, c.start + c.duration);
    const g = c.gain ?? 1;
    const src0 = Math.round(((c.offset || 0) + (a - c.start)) * sr);
    const dst0 = Math.round((a - from) * sr);
    const len = Math.min(Math.round((e - a) * sr), n - dst0, b.length - src0);
    const k = b.numberOfChannels;
    for (let ch = 0; ch < k; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) x[dst0 + i] += (d[src0 + i] * g) / k;
    }
  }
  return { x, sr };
}

/** Empreinte des clips (identifiant, son, place) : Avant / Après reconnus après annuler / rétablir. */
const tracksSig = (tracks: Track[]) => tracks.map(t => `${t.id}:${t.clips.map(c => `${c.id}/${c.bufferId}/${Math.round(c.start * 1e4)}`).join(',')}`).join('|');

const keyOf = (s: DAWState) => (typeof s.projectKey === 'number' ? { root: s.projectKey, scale: s.projectScale } : null);

export function useR23(state: DAWState, d: R23Deps) {
  const dRef = useRef(d);
  dRef.current = d;
  const [swap, setSwap] = useState<SwapModel | null>(null);
  const swapRef = useRef(swap);
  swapRef.current = swap;
  const fetchedRef = useRef<Awaited<ReturnType<R23Deps['fetchBeat']>> | null>(null);
  const [result, setResult] = useState<SwapResult | null>(null);
  const resultTracksRef = useRef<{ before: string | null; after: string | null }>({ before: null, after: null });
  const [compare, setCompare] = useState<CompareModel | null>(null);
  const cancelRef = useRef(false);

  // Le moteur suit le tempo du projet (annuler / rétablir un changement de beat compris).
  useEffect(() => {
    void import('../engine/AudioEngine').then(({ audioEngine }) => audioEngine.setBpm(state.bpm)).catch(() => { /* moteur absent (tests) */ });
  }, [state.bpm]);

  // ── Changer de beat ─────────────────────────────────────────────────────────
  const analyze = useCallback(async (source: SwapSource) => {
    const dd = dRef.current;
    cancelRef.current = false;
    setSwap(s => ({ phase: 'analyzing', source, oldInfo: s?.oldInfo ?? null, newInfo: null, opts: {}, plan: null, voices: 0 }));
    try {
      const st0 = dd.stateRef.current;
      const [oldInfo, fetched] = await Promise.all([analyzeCurrentBeat(st0), dd.fetchBeat(source)]);
      if (cancelRef.current) return;
      fetchedRef.current = fetched;
      const beatClip = st0.tracks.find(isBeatTrack)?.clips[0];
      const newInfo = await analyzeNewBeat(fetched.buffer, beatClip?.start ?? 0, { bpm: fetched.bpm, key: fetched.key, title: fetched.title, id: fetched.audioRef });
      if (cancelRef.current) return;
      const old = oldInfo || { bpm: st0.bpm, key: keyOf(st0) as KeyInfo | null, downbeat: 0, bpmFrom: 'projet' as const };
      const voices = st0.tracks.filter(t => !isBeatTrack(t)).reduce((n, t) => n + t.clips.filter(c => !c.notes && (c.bufferId || c.buffer)).length, 0);
      setSwap({ phase: 'ready', source, oldInfo: old, newInfo, opts: {}, plan: planSwap(old, newInfo, {}), voices });
    } catch (e: any) {
      if (cancelRef.current) return;
      setSwap(s => ({ ...(s || { source, oldInfo: null, newInfo: null, opts: {}, plan: null, voices: 0 }), phase: 'error', error: e?.message || 'Ce beat n’a pas pu être lu.' }));
    }
  }, []);

  const openSwap = useCallback((source?: SwapSource) => {
    const dd = dRef.current;
    const st = dd.stateRef.current;
    if (dd.isRecording()) { dd.notify('⏺️ Arrête la prise en cours avant de changer de beat.'); return; }
    if (!hasVoicesToKeep(st.tracks) || !st.tracks.find(isBeatTrack)?.clips.length) {
      if (source) { dd.loadDirect(source); return; }
      dd.notify('🔁 Pas encore de voix à garder : choisis simplement un beat dans le store.');
      dd.openStore();
      return;
    }
    setResult(null);
    if (source) void analyze(source);
    else setSwap({ phase: 'choose', source: null, oldInfo: null, newInfo: null, opts: {}, plan: null, voices: 0 });
  }, [analyze]);

  const setOptions = useCallback((o: Partial<SwapOptions>) => {
    setSwap(s => {
      if (!s?.oldInfo || !s.newInfo) return s;
      const opts = { ...s.opts, ...o };
      return { ...s, opts, plan: planSwap(s.oldInfo, s.newInfo, opts) };
    });
  }, []);

  const closeSwap = useCallback(() => { cancelRef.current = true; setSwap(null); fetchedRef.current = null; }, []);
  /** « Choisir dans le store » : la fenêtre se replie en bandeau, le prochain beat choisi arrive ici. */
  const waitStore = useCallback(() => {
    setSwap(s => (s ? { ...s, phase: 'store' } : s));
    dRef.current.openStore();
  }, []);

  const confirmSwap = useCallback(async () => {
    const dd = dRef.current;
    const s = swapRef.current;
    const fetched = fetchedRef.current;
    if (!s?.plan || !fetched) return;
    const plan = s.plan;
    cancelRef.current = false;
    setSwap({ ...s, phase: 'rendering', progress: { i: 0, n: 1, name: '' } });
    try {
      const st0 = dd.stateRef.current;
      const renders = await renderVoices(st0, plan, (i, n, name) => setSwap(x => (x ? { ...x, progress: { i, n, name } } : x)), () => cancelRef.current);
      if (cancelRef.current) return;
      const old = st0.tracks.find(isBeatTrack)?.clips[0];
      const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const clipId = `clip-beat-${uid}`;
      const bufferId = audioBufferRegistry.register(fetched.buffer, clipId);
      const beatClip: Clip = {
        id: clipId, name: fetched.title.replace(/\.[^/.]+$/, ''), type: old?.type || ('AUDIO' as any), start: old?.start ?? 0,
        duration: fetched.buffer.duration, offset: 0, bufferId, audioRef: fetched.audioRef, color: old?.color || '#eab308',
        fadeIn: 0, fadeOut: 0, gain: old?.gain ?? 1, isMuted: false,
        ...(plan.newBpm > 0 ? { warp: { enabled: false, mode: 'BEATS' as const, originalBpm: plan.newBpm, preservePitch: true } } : {}),
      };
      const input = { plan, beatClip, beat: { instrumentId: fetched.instrumentId, title: fetched.title, genre: fetched.genre }, renders, usesProjectKey: dd.usesProjectKey };
      // Calculé ici (l'état React se met à jour plus tard) : le même projet part en collaboration.
      const base = dd.stateRef.current;
      const next: DAWState = applySwap(base, input);
      dd.breakHistory();
      dd.setState(prev => (prev === base ? next : applySwap(prev, input)));
      dd.breakHistory();
      resultTracksRef.current = { before: tracksSig(base.tracks), after: tracksSig(next.tracks) };
      const text = doneText(plan, renders.length, fetched.title);
      setSwap(null);
      fetchedRef.current = null;
      setResult({ plan, title: fetched.title, showing: 'after', text });
      redoSpotsStore.set([]);
      dd.notify(text);
      if (dd.onSwapped) {
        const touched = next.tracks.filter(t => isBeatTrack(t) || (followsBeat(t) && t.clips.length > 0)).map(t => t.id);
        dd.onSwapped(next, {
          trackIds: touched, bpm: next.bpm, tempoEvents: next.tempoEvents, markers: next.markers, chords: next.chords,
          projectKey: next.projectKey, projectScale: next.projectScale, beatTitle: fetched.title, beatGenre: fetched.genre, summary: planSummary(plan),
        });
      }
    } catch (e: any) {
      if (cancelRef.current) return;
      setSwap(x => (x ? { ...x, phase: 'error', error: `Rendu impossible : ${e?.message || 'erreur'}. Ton projet n’a pas changé.` } : x));
    }
  }, []);

  /** Avant / Après : annuler / rétablir le changement (aucune nouvelle étape). */
  const resultRef = useRef(result);
  resultRef.current = result;
  const showSwap = useCallback((which: 'before' | 'after') => {
    const r = resultRef.current;
    if (!r || r.showing === which) return;
    // Effet de bord hors de l'updater (React peut l'appeler deux fois en développement).
    if (which === 'before') dRef.current.undo(); else dRef.current.redo();
    const next = { ...r, showing: which };
    resultRef.current = next;
    setResult(next);
  }, []);
  const revertSwap = useCallback(() => {
    const r = result;
    setResult(null);
    if (r?.showing === 'after') dRef.current.undo();
    dRef.current.notify('↩️ Ancien beat remis : tes voix sont revenues comme avant (Ctrl+Y pour reprendre le nouveau).');
  }, [result]);
  const keepSwap = useCallback(() => {
    const r = result;
    setResult(null);
    if (r?.showing === 'before') dRef.current.redo();
  }, [result]);
  // Projet modifié autrement (une autre action) : la carte se ferme (Avant / Après n'aurait plus de sens).
  useEffect(() => {
    if (!result) return;
    const { before, after } = resultTracksRef.current;
    const sig = tracksSig(state.tracks);
    if (sig !== before && sig !== after) setResult(null);
  }, [state.tracks, result]);

  // ── Passages à refaire ────────────────────────────────────────────────────
  const gridOriginRef = useRef<{ key: string; at: number } | null>(null);
  const gridOrigin = useCallback(async (): Promise<number> => {
    const st = dRef.current.stateRef.current;
    const beat = st.tracks.find(isBeatTrack)?.clips[0];
    const key = `${beat?.bufferId || ''}@${beat?.start}@${st.bpm}`;
    if (gridOriginRef.current?.key === key) return gridOriginRef.current.at;
    const info = beat ? await analyzeCurrentBeat(st).catch(() => null) : null;
    // Origine ramenée à la mesure la plus proche de 0 (la grille de calage est périodique).
    const bar = (60 / (st.bpm || 120)) * 4;
    const at = info ? ((info.downbeat % bar) + bar) % bar : 0;
    gridOriginRef.current = { key, at };
    return at;
  }, []);

  const findSpots = useCallback(async (trackId?: string) => {
    const dd = dRef.current;
    const st = dd.stateRef.current;
    const sel = st.tracks.find(t => t.id === (trackId || st.selectedTrackId));
    const t = isVoiceTrack(sel) && sel.clips.some(c => !c.isMuted) ? sel : st.tracks.find(x => isVoiceTrack(x) && !x.isGuide && x.clips.some(c => !c.isMuted && (c.bufferId || c.buffer)));
    if (!t) { dd.notify('🎯 Pas encore de voix enregistrée : pose une prise, puis je te montre les passages à refaire.'); return; }
    const audible = t.clips.filter(c => !c.isMuted && (c.bufferId || c.buffer));
    const from = Math.min(...audible.map(c => c.start)), to = Math.max(...audible.map(c => c.start + c.duration));
    const a = trackAudio(t, from, to);
    if (!a) { dd.notify('🎯 Le son de cette piste n’est pas encore chargé.'); return; }
    const g0 = await gridOrigin();
    await new Promise(r => setTimeout(r, 0));
    const spots = findRedoSpots(a.x, a.sr, from, { trackId: t.id, bpm: st.bpm, key: keyOf(st), gridOrigin: g0 });
    redoSpotsStore.set([...redoSpotsStore.get().filter(s => s.trackId !== t.id), ...spots]);
    dd.notify(spots.length
      ? `🎯 ${spots.length} passage${spots.length > 1 ? 's' : ''} à refaire sur « ${t.name} » (en rouge sur la timeline) — le pire : ${spots[0].label.toLowerCase()} à ${spots[0].start.toFixed(1).replace('.', ',')} s. Clique « Refaire » pour poser le punch.`
      : `✅ « ${t.name} » : rien ne détonne (justesse, calage, niveau, saturation, bruit). Belle prise !`);
  }, [gridOrigin]);

  const pendingRef = useRef<{ trackIds: string[]; zone: { start: number; end: number }; before: Map<string, { score: TakeScore | null; clips: Clip[]; takeMeta?: TakeMeta[] }>; spotId: string } | null>(null);

  const redoSpot = useCallback(async (spotId: string) => {
    const dd = dRef.current;
    const spot = redoSpotsStore.get().find(s => s.id === spotId);
    if (!spot) return;
    if (dd.isRecording()) { dd.notify('⏺️ Une prise est déjà en cours.'); return; }
    const st = dd.stateRef.current;
    const g0 = await gridOrigin();
    const zone = redoPunchZone(st.punch, spot, st.bpm, st.timeSignature, g0);
    // Multipiste (R14) : les autres pistes déjà armées refont le passage avec elle.
    const trackIds = [...new Set([spot.trackId, ...st.tracks.filter(t => t.isTrackArmed && isVoiceTrack(t)).map(t => t.id)])];
    const before = new Map<string, { score: TakeScore | null; clips: Clip[]; takeMeta?: TakeMeta[] }>();
    for (const id of trackIds) {
      const t = st.tracks.find(x => x.id === id);
      if (!t) continue;
      const a = trackAudio(t, zone.punchIn, zone.punchOut);
      before.set(id, { score: a ? scoreTake(a.x, a.sr, { bpm: st.bpm, key: keyOf(st), t0: zone.punchIn - g0 }) : null, clips: t.clips as Clip[], takeMeta: t.takeMeta as TakeMeta[] | undefined });
    }
    dd.setState(prev => ({ ...prev, punch: zone }));
    dd.stateRef.current = { ...dd.stateRef.current, punch: zone };
    if (!(await dd.armForRedo(spot.trackId))) return;
    pendingRef.current = { trackIds, zone: { start: zone.punchIn, end: zone.punchOut }, before, spotId };
    redoSpotsStore.select(null);
    dd.notify(`🎯 Zone de punch posée (${zone.punchIn.toFixed(2).replace('.', ',')} → ${zone.punchOut.toFixed(2).replace('.', ',')} s) avec pré-roll : la lecture repart un peu avant, chante seulement le passage. La prise s’arrête toute seule.`);
    setTimeout(() => dRef.current.toggleRecord(), 120);
  }, [gridOrigin]);

  // Après la prise : avant / après sur la zone refaite.
  useEffect(() => {
    const onPlaced = (e: Event) => {
      const det = (e as CustomEvent).detail as { trackIds: string[]; isPunch: boolean; in: number | null; out: number | null };
      const p = pendingRef.current;
      if (!p || !det?.isPunch) { if (p && det && !det.isPunch) pendingRef.current = null; return; }
      pendingRef.current = null;
      setTimeout(() => {
        const st = dRef.current.stateRef.current;
        const tid = det.trackIds.find(id => p.trackIds.includes(id)) || p.trackIds[0];
        const t = st.tracks.find(x => x.id === tid);
        if (!t) return;
        const a = trackAudio(t, p.zone.start, p.zone.end);
        const g0 = gridOriginRef.current?.at ?? 0;
        const after = a ? scoreTake(a.x, a.sr, { bpm: st.bpm, key: keyOf(st), t0: p.zone.start - g0 }) : null;
        const before = p.before.get(tid)?.score ?? null;
        compareBeforeRef.current = p;
        compareAfterRef.current = null;
        redoSpotsStore.set(redoSpotsStore.get().filter(s => s.id !== p.spotId));
        setCompare({ trackId: tid, trackName: t.name, zone: p.zone, before, after, verdict: compareScores(before, after), showing: 'after', others: det.trackIds.filter(id => id !== tid && p.trackIds.includes(id)).length });
      }, 250);
    };
    window.addEventListener('nova:take-placed', onPlaced);
    return () => window.removeEventListener('nova:take-placed', onPlaced);
  }, []);

  const compareBeforeRef = useRef<NonNullable<typeof pendingRef.current> | null>(null);
  const compareAfterRef = useRef<Map<string, { clips: Clip[]; takeMeta?: TakeMeta[] }> | null>(null);
  /** Version « ancienne » : les clips d'avant, la nouvelle prise gardée (mutée) dans son couloir. */
  const oldVersion = (cur: Track, snap: { clips: Clip[]; takeMeta?: TakeMeta[] }): { clips: Clip[]; takeMeta?: TakeMeta[] } => {
    const known = new Set(snap.clips.map(c => c.id));
    const nums = new Set(snap.clips.map(c => takeNumberOf(c)).filter((n): n is number => n !== null));
    const added = (cur.clips as Clip[]).filter(c => !known.has(c.id) && takeNumberOf(c) !== null && !nums.has(takeNumberOf(c)!));
    return { clips: [...snap.clips, ...added.map(c => ({ ...c, isMuted: true }))], takeMeta: cur.takeMeta as TakeMeta[] | undefined };
  };
  const swapTracks = (pick: (id: string, t: Track) => { clips: Clip[]; takeMeta?: TakeMeta[] } | null) => (prev: DAWState): DAWState => ({
    ...prev,
    tracks: prev.tracks.map(t => { const v = pick(t.id, t); return v ? { ...t, clips: v.clips as any, takeMeta: v.takeMeta } : t; }),
  });

  const showCompare = useCallback((which: 'before' | 'after') => {
    const p = compareBeforeRef.current;
    const c = compare;
    if (!p || !c || c.showing === which) return;
    const dd = dRef.current;
    const st = dd.stateRef.current;
    if (which === 'before') {
      compareAfterRef.current = new Map(p.trackIds.map(id => { const t = st.tracks.find(x => x.id === id)!; return [id, { clips: t.clips as Clip[], takeMeta: t.takeMeta as TakeMeta[] | undefined }]; }));
      dd.setSilently(swapTracks((id, t) => (p.before.has(id) ? oldVersion(t, p.before.get(id)!) : null)));
    } else if (compareAfterRef.current) {
      const after = compareAfterRef.current;
      dd.setSilently(swapTracks(id => after.get(id) || null));
    }
    setCompare({ ...c, showing: which });
    dd.playFrom(Math.max(0, c.zone.start - (60 / (st.bpm || 120)) * 4));
  }, [compare]);

  const keepNew = useCallback(() => {
    if (compare?.showing === 'before') showCompare('after');
    setCompare(null);
    compareBeforeRef.current = null;
    dRef.current.notify('✅ Nouvelle prise gardée. L’ancienne reste dans son couloir de prises.');
  }, [compare, showCompare]);

  const keepOld = useCallback(() => {
    const p = compareBeforeRef.current;
    const dd = dRef.current;
    if (!p) { setCompare(null); return; }
    // Retour d'abord à l'état réel (après), puis UNE étape d'annulation vers l'ancienne.
    if (compare?.showing === 'before' && compareAfterRef.current) { const after = compareAfterRef.current; dd.setSilently(swapTracks(id => after.get(id) || null)); }
    dd.breakHistory();
    dd.setState(swapTracks((id, t) => (p.before.has(id) ? oldVersion(t, p.before.get(id)!) : null)));
    dd.breakHistory();
    setCompare(null);
    compareBeforeRef.current = null;
    dd.notify('↩️ Ancienne prise reprise sur ce passage. La nouvelle reste dans son couloir (Ctrl+Z pour revenir).');
  }, [compare]);

  // ── Ordres (menus, panneau voix, timeline) ──────────────────────────────────
  useEffect(() => r23Bus.on(cmd => {
    switch (cmd.kind) {
      case 'openSwap': openSwap(cmd.source); break;
      case 'findSpots': void findSpots(cmd.trackId); break;
      case 'redo': void redoSpot(cmd.spotId); break;
      case 'listenSpot': {
        const s = redoSpotsStore.get().find(x => x.id === cmd.spotId);
        if (s) dRef.current.playFrom(Math.max(0, s.start - 1));
        break;
      }
      case 'dismissSpot': redoSpotsStore.set(redoSpotsStore.get().filter(x => x.id !== cmd.spotId)); break;
      case 'clearSpots': redoSpotsStore.set(cmd.trackId ? redoSpotsStore.get().filter(x => x.trackId !== cmd.trackId) : []); break;
    }
  }), [openSwap, findSpots, redoSpot]);

  // Les repères d'une piste dont la voix a changé (prise, comp, coupe) ne valent plus : retirés.
  // Pendant un « Refaire ce passage », seuls ceux de la zone refaite partent (le reste n'a pas bougé).
  const lastClipsRef = useRef(new Map<string, Track['clips']>());
  useEffect(() => {
    const cur = redoSpotsStore.get();
    const prev = lastClipsRef.current;
    const next = new Map(state.tracks.map(t => [t.id, t.clips]));
    lastClipsRef.current = next;
    if (!cur.length || !prev.size) return;
    const changed = new Set(state.tracks.filter(t => prev.has(t.id) && prev.get(t.id) !== t.clips).map(t => t.id));
    if (!changed.size) return;
    const z = (pendingRef.current || compareBeforeRef.current)?.zone;
    redoSpotsStore.set(cur.filter(s => !changed.has(s.trackId) || (z ? s.end <= z.start || s.start >= z.end : false)));
  }, [state.tracks]);

  return {
    swap, openSwap, chooseSource: analyze, setOptions, closeSwap, confirmSwap, waitStore,
    result, showSwap, revertSwap, keepSwap,
    compare, showCompare, keepNew, keepOld, closeCompare: () => setCompare(null),
    findSpots,
    /** La fenêtre attend un beat du store : le prochain choix passe par elle. */
    waitingForBeat: swap?.phase === 'choose' || swap?.phase === 'store',
  };
}

export type R23Api = ReturnType<typeof useR23>;
export type { RedoSpot };
