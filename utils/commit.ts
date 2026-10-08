/**
 * Commit, « Consolider avec effets » (bounce in place) et impression de bus
 * (R6) : transformations PURES des pistes, appliquées en une seule étape
 * d'annulation une fois le rendu fait (services/Bounce.ts).
 *
 *  - Commit (Pro Tools 2020+ « Commit », Logic « Bounce in Place », Ableton
 *    « Freeze and Flatten », FL « Consolidate this track ») : la piste rendue
 *    (ses effets compris, avant le fader) remplace l'originale, qui devient
 *    inactive et masquée — elle reste rappelable : « Restaurer la piste d'origine ».
 *  - Consolider avec effets (plage) : le rendu de la plage va sur une nouvelle
 *    piste, les clips d'origine de la plage sont coupés (le son ne double pas).
 *  - Imprimer un bus (Pro Tools : enregistrer un bus sur une piste audio) : le
 *    son exact du bus, aligné à l'échantillon, sur une nouvelle piste ; le bus
 *    peut être coupé.
 * La nouvelle piste garde le fader, le pan, les envois, la sortie et
 * l'automation de mix de l'originale : le rendu étant pris AVANT le fader, le
 * mix ne change pas.
 */
import { AutomationLane, Clip, PluginInstance, Track, TrackCommitInfo, TrackType } from '../types';
import { parsePluginParam, pluginParamName } from './automationWrite';
import { PRE_VOLUME } from './preFxEdits';
import { setTracksHidden, setTracksInactive } from './trackStructure';
import { idGenerator, splitClipsAt } from './timeSelection';

const clone = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/** Pistes qu'on peut « commiter » (audio, MIDI, instruments) : pas un bus, un dossier, un VCA ni le master. */
export const canCommit = (t: Track | undefined): boolean =>
  !!t && t.id !== 'master' && t.type !== TrackType.BUS && t.type !== TrackType.SEND && !t.folder && !t.isVca && t.id !== 'instrumental';

/** Bus / retours qu'on peut imprimer. */
export const canPrintBus = (t: Track | undefined): boolean =>
  !!t && t.id !== 'master' && (t.type === TrackType.BUS || t.type === TrackType.SEND || t.folder?.kind === 'routing') && !t.isVca;

/** Fin du contenu d'une piste (s). */
export const trackContentEnd = (t: Track): number => (t.clips || []).filter(c => !c.isFreezeSlice).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
export const trackContentStart = (t: Track): number => {
  const cs = (t.clips || []).filter(c => !c.isFreezeSlice && !c.isMuted);
  return cs.length ? Math.min(...cs.map(c => c.start)) : 0;
};

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Champs propres à la piste d'origine (son, collaboration, rendus) : jamais copiés sur la piste rendue. */
const NOT_COPIED: (keyof Track)[] = [
  'clips', 'plugins', 'frozenClip', 'frozenUpToPluginIndex', 'frozenClipIds', 'frozenSourceSig', 'frozenPluginSig', 'frozenAuto',
  'freezeBase', 'preFxJournal', 'sendFreezes', 'collabOwner', 'collabOwnerKey', 'collabOwnerName', 'collabOwnerColor', 'remote',
  'livePreview', 'volumeLock', 'drumMachine', 'bass808', 'novaSynth', 'vstInstrument', 'drumPads', 'takeMeta', 'midiChannel',
  'instrumentId', 'events', 'isHidden', 'isInactive', 'commit', 'folder', 'isVca', 'inputBusId', 'ioBuses', 'isTrackArmed', 'breathKind',
];

/**
 * Piste rendue : mêmes réglages de mix que la source, effets après le rendu
 * (copiés avec de nouveaux identifiants, leur automation suit), un seul clip.
 */
const renderedTrack = (src: Track, o: { id: string; name: string; clip: Clip; postPlugins: PluginInstance[]; commit: TrackCommitInfo }): Track => {
  const base = clone({ ...src, clips: [], plugins: [], frozenClip: undefined, freezeBase: undefined, sendFreezes: undefined }) as any;
  for (const k of NOT_COPIED) delete base[k];
  const ids = new Map<string, string>();
  const plugins = o.postPlugins.map(p => { const id = newId('pl'); ids.set(p.id, id); return { ...clone(p), id }; });
  const lanes: AutomationLane[] = (src.automationLanes || []).flatMap(l => {
    if (l.parameterName === PRE_VOLUME) return []; // déjà dans le rendu
    const pp = parsePluginParam(l.parameterName);
    if (!pp) return [clone(l)];
    const to = ids.get(pp.pluginId);
    return to ? [{ ...clone(l), id: newId('auto'), parameterName: pluginParamName(to, pp.key) }] : []; // effet rendu : son automation est dans le son
  });
  return {
    ...base,
    id: o.id, name: o.name.slice(0, 60), type: TrackType.AUDIO,
    isMuted: src.isMuted, isSolo: false, isFrozen: false, totalLatency: 0,
    clips: [o.clip], plugins, automationLanes: lanes,
    commit: o.commit,
  } as Track;
};

const insertAfter = (tracks: Track[], afterId: string, t: Track): Track[] => {
  const i = tracks.findIndex(x => x.id === afterId);
  return i < 0 ? [...tracks, t] : [...tracks.slice(0, i + 1), t, ...tracks.slice(i + 1)];
};

export interface CommitRender {
  /** Id de la nouvelle piste. */
  id: string;
  /** Clip du rendu (son déjà enregistré dans le registre). */
  clip: Clip;
  /** Dernier effet inclus (index dans plugins). */
  upTo: number;
  tail: number;
  at?: number;
}

/** Commit : nouvelle piste rendue juste après, l'originale inactive et masquée. */
export const commitTracks = (tracks: Track[], sourceId: string, r: CommitRender): Track[] => {
  const src = tracks.find(t => t.id === sourceId);
  if (!src) throw new Error('Piste introuvable.');
  if (!canCommit(src)) throw new Error('Commit : choisis une piste audio, MIDI ou d’instrument (pour un bus, « Imprimer le bus »).');
  const t = renderedTrack(src, {
    id: r.id, name: `${src.name} · commit`, clip: r.clip, postPlugins: (src.plugins || []).slice(r.upTo + 1),
    commit: { kind: 'commit', sourceTrackId: src.id, at: r.at ?? Date.now(), upTo: r.upTo, tail: r.tail, sourceWasHidden: !!src.isHidden, sourceWasInactive: !!src.isInactive },
  });
  let out = insertAfter(tracks, src.id, t);
  out = setTracksInactive(out, [src.id], true);
  out = setTracksHidden(out, [src.id], true);
  return out;
};

export interface BounceRender extends CommitRender {
  range: { start: number; end: number };
}

/**
 * Consolider avec effets : nouvelle piste avec le rendu de la plage ; les clips
 * d'origine sont coupés aux bords de la plage et ceux du dedans rendus muets.
 */
export const bounceTracks = (tracks: Track[], sourceId: string, r: BounceRender): Track[] => {
  const src = tracks.find(t => t.id === sourceId);
  if (!src) throw new Error('Piste introuvable.');
  const { start: s, end: e } = r.range;
  const split = splitClipsAt(src.clips || [], [s, e], idGenerator('bn'));
  const muted: string[] = [];
  const clips = split.map(c => {
    const inside = c.start >= s - 1e-6 && c.start + c.duration <= e + 1e-6;
    if (!inside || c.isMuted || c.isFreezeSlice) return c;
    muted.push(c.id);
    return { ...c, isMuted: true };
  });
  const t = renderedTrack(src, {
    id: r.id, name: `${src.name} · bounce`, clip: r.clip, postPlugins: (src.plugins || []).slice(r.upTo + 1),
    commit: { kind: 'bounce', sourceTrackId: src.id, at: r.at ?? Date.now(), upTo: r.upTo, tail: r.tail, range: { start: s, end: e }, mutedClipIds: muted },
  });
  return insertAfter(tracks.map(x => (x.id === src.id ? { ...x, clips } : x)), src.id, t);
};

export interface BusPrintRender {
  id: string;
  clip: Clip;
  tail: number;
  /** Couper le bus d'origine (le son ne double pas). */
  muteBus: boolean;
  at?: number;
}

/** Impression d'un bus : nouvelle piste audio qui joue le son du bus, à sa place dans le mix. */
export const printBusTracks = (tracks: Track[], busId: string, r: BusPrintRender): Track[] => {
  const bus = tracks.find(t => t.id === busId);
  if (!bus) throw new Error('Bus introuvable.');
  if (!canPrintBus(bus)) throw new Error('Impression : choisis un bus, un retour d’effet ou un dossier de routage.');
  // Le rendu est pris APRÈS le fader et le pan du bus : la piste imprimée est à 0 dB, au centre.
  const base = renderedTrack(bus, {
    id: r.id, name: `${bus.name} · imprimé`, clip: r.clip, postPlugins: [],
    commit: { kind: 'bus', sourceTrackId: bus.id, at: r.at ?? Date.now(), tail: r.tail, mutedSource: r.muteBus && !bus.isMuted },
  });
  const t: Track = {
    ...base, volume: 1, pan: 0, isMuted: false,
    automationLanes: base.automationLanes.filter(l => l.parameterName !== 'volume' && l.parameterName !== 'pan').concat(
      [{ id: newId('auto'), parameterName: 'volume', points: [], color: bus.color, isExpanded: false, min: 0, max: 1.5 }]),
  };
  delete t.parentFolderId;
  // Sortie : là où va le bus (un dossier de routage sort vers sa propre sortie).
  if (bus.parentFolderId) t.parentFolderId = bus.parentFolderId;
  const out = insertAfter(tracks, bus.id, t);
  return r.muteBus ? out.map(x => (x.id === bus.id ? { ...x, isMuted: true } : x)) : out;
};

/** Piste rendue qui peut rendre sa piste d'origine. */
export const canRestore = (t: Track | undefined, tracks: Track[]): boolean => !!t?.commit && tracks.some(x => x.id === t.commit!.sourceTrackId);

/**
 * « Restaurer la piste d'origine » : la piste rendue disparaît, l'originale
 * retrouve son état (active / visible, clips rallumés, bus rallumé).
 * Renvoie aussi les sons de la piste rendue (à libérer s'ils ne servent plus).
 */
export const restoreCommitted = (tracks: Track[], committedId: string): { tracks: Track[]; sourceId: string; bufferIds: string[] } => {
  const t = tracks.find(x => x.id === committedId);
  const info = t?.commit;
  if (!t || !info) throw new Error('Cette piste n’est pas un rendu (Commit, bounce ou bus imprimé).');
  const src = tracks.find(x => x.id === info.sourceTrackId);
  if (!src) throw new Error('La piste d’origine n’est plus dans la session.');
  let out = tracks.filter(x => x.id !== committedId);
  if (info.kind === 'commit') {
    out = setTracksInactive(out, [src.id], !!info.sourceWasInactive);
    out = setTracksHidden(out, [src.id], !!info.sourceWasHidden);
  } else if (info.kind === 'bounce') {
    const ids = new Set(info.mutedClipIds || []);
    out = out.map(x => (x.id === src.id ? { ...x, clips: x.clips.map(c => (ids.has(c.id) ? { ...c, isMuted: false } : c)) } : x));
  } else if (info.kind === 'bus' && info.mutedSource) {
    out = out.map(x => (x.id === src.id ? { ...x, isMuted: false } : x));
  }
  return { tracks: out, sourceId: src.id, bufferIds: (t.clips || []).map(c => c.bufferId).filter(Boolean) as string[] };
};

/** Libellé de l'origine d'une piste rendue (en-tête, menus). */
export const commitLabel = (t: Track, tracks: Track[]): string | null => {
  if (!t.commit) return null;
  const src = tracks.find(x => x.id === t.commit!.sourceTrackId);
  const name = src ? `« ${src.name} »` : 'sa piste d’origine';
  return t.commit.kind === 'commit' ? `Commit de ${name}` : t.commit.kind === 'bounce' ? `Bounce de ${name}` : `Impression du bus ${name}`;
};

/**
 * Pistes dont le son entre dans `busId` (sortie ou envoi actif), en remontant
 * les bus en chaîne. Sur des pistes déjà résolues (utils/trackStructure engineView).
 */
export const busUpstream = (tracks: Track[], busId: string): Set<string> => {
  const up = new Set<string>();
  let frontier = [busId];
  while (frontier.length) {
    const next: string[] = [];
    for (const t of tracks) {
      if (up.has(t.id) || t.id === busId) continue;
      const feeds = frontier.some(f => t.outputTrackId === f || (t.sends || []).some(s => s.id === f && s.isEnabled));
      if (feeds) { up.add(t.id); next.push(t.id); }
    }
    frontier = next;
  }
  return up;
};

/** Piste de capture : reçoit le point d'écoute et sort directement (sans le master). */
export const CAPTURE = '__nova_capture';

/** Pistes en aval de `ids` (sorties et envois actifs), sans elles. */
const downstreamOf = (tracks: Track[], ids: Set<string>): Set<string> => {
  const byId = new Map(tracks.map(t => [t.id, t]));
  const down = new Set<string>();
  let frontier = [...ids];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const t = byId.get(id);
      if (!t) continue;
      for (const d of [t.outputTrackId, ...(t.sends || []).filter(s => s.isEnabled).map(s => s.id)]) {
        if (d && byId.has(d) && !ids.has(d) && !down.has(d)) { down.add(d); next.push(d); }
      }
    }
    frontier = next;
  }
  return down;
};

/** Pistes utiles au rendu d'un point d'écoute (sur des pistes résolues). */
export const captureIds = (resolved: Track[], tapId: string, mode: 'pre' | 'post'): Set<string> => {
  const sources = new Set([tapId, ...(mode === 'post' ? busUpstream(resolved, tapId) : [])]);
  return new Set([...sources, ...downstreamOf(resolved, sources)]);
};

/**
 * Graphe de rendu d'un point d'écoute, sur des pistes déjà résolues
 * (utils/trackStructure engineView) :
 *  - 'pre' (Commit, bounce) : le son de la piste après ses effets, AVANT son
 *    fader (envoi pré-fader vers la capture) ;
 *  - 'post' (impression de bus) : le son qui sort du bus, APRÈS son fader et
 *    son pan (envoi post-fader), avec tout ce qui y entre.
 * Les pistes en aval (bus, retours, master) restent dans le graphe, muettes :
 * leur latence compte dans la compensation, exactement comme à l'export ; le
 * son capturé arrive donc calé sur le temps du morceau. Muet / solo de la
 * session déjà résolus (`silenced`).
 */
export const captureGraph = (resolved: Track[], tapId: string, mode: 'pre' | 'post', silenced: Set<string>): Track[] => {
  const sources = new Set([tapId, ...(mode === 'post' ? busUpstream(resolved, tapId) : [])]);
  const down = downstreamOf(resolved, sources);
  const out: Track[] = [];
  for (const t of resolved) {
    if (!sources.has(t.id) && !down.has(t.id)) continue;
    const c: Track = { ...t, isSolo: false };
    delete c.outputBusId;
    delete c.inputBusId;
    if (t.id === tapId) {
      c.isMuted = false;
      c.sends = [...(t.sends || []), { id: CAPTURE, level: 1, isEnabled: true, ...(mode === 'pre' ? { preFader: true } : {}) }];
    } else if (sources.has(t.id)) {
      c.isMuted = t.isMuted || silenced.has(t.id);
    } else {
      c.isMuted = true;
      c.clips = [];
    }
    out.push(c);
  }
  out.push({
    id: CAPTURE, name: CAPTURE, type: TrackType.BUS, color: '#000', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: '', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
  });
  return out;
};
