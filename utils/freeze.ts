import { BreathEdit, Clip, FreezeRef, PluginInstance, Track, TrackType } from '../types';
import { breathSig } from './breathEnvelope';
import { envelopeDbAt, gainPointsSig, sortGainPoints } from './clipGain';

/**
 * Regles du gel de piste, partagees par le moteur audio, la sauvegarde et l'interface.
 *
 * Modele : track.frozenClip est le rendu PRE-fader des clips de la piste a travers
 * ses effets jusqu'a frozenUpToPluginIndex (inclus). En lecture :
 *   rendu gele -> effets restants -> fader/pan -> departs
 * Les clips ajoutes apres le rendu (absents de frozenClipIds) sont joues
 * normalement, a travers toute la chaine.
 */

/** Piste lue a partir de son rendu. */
export const isTrackFrozen = (t: Track): boolean => !!(t.isFrozen && t.frozenClip);

/** Dernier effet inclus dans le rendu (-1 : aucun). */
export const freezeIndex = (t: Track): number => {
  const n = (t.plugins || []).length;
  const k = t.frozenUpToPluginIndex;
  if (typeof k !== 'number' || !Number.isFinite(k)) return n - 1;
  return Math.max(-1, Math.min(n - 1, Math.floor(k)));
};

export const preFreezePlugins = (t: Track): PluginInstance[] => (t.plugins || []).slice(0, freezeIndex(t) + 1);
export const postFreezePlugins = (t: Track): PluginInstance[] => (t.plugins || []).slice(freezeIndex(t) + 1);

/** Clips couverts par le rendu gele (anciens projets : tous). */
export const coveredClipIds = (t: Track): Set<string> | null =>
  Array.isArray(t.frozenClipIds) ? new Set(t.frozenClipIds) : null;

// --- Clips ancrés : une piste gelée reste éditable --------------------------
//
// Modèle « clips ancrés » (rendus avec frozenPluginSig) : chaque clip rendu porte
// sa place dans le rendu (Clip.freezeRef). On édite toujours les clips d'origine ;
// la lecture rejoue, pour chaque clip, la tranche du rendu qui correspond à sa
// partie audio actuelle, à sa position actuelle. Au dégel, la vraie chaîne
// (VST du PC) retrouve donc toutes les modifications faites ailleurs, sans
// rien « rejouer ». Les reverbs / délais sont sur les pistes d'envoi (jamais
// gelées) : les queues d'effets d'insert sont courtes.

/** Queue d'effets d'insert gardée après la fin d'un clip non raccourci. */
export const FREEZE_SLICE_TAIL = 1.0;

/** Le clip est-il ancré dans le rendu actuel de sa piste ? */
const isAnchored = (t: Track, c: Clip): boolean =>
  !!t.frozenClip && !!c.freezeRef && c.freezeRef.renderId === t.frozenClip.id && !c.isReversed && !!c.bufferId;

/** Ancre les clips rendus (audio, non inversés) dans un nouveau rendu. */
export const anchorClipsToRender = (clips: Clip[], renderId: string): Map<string, NonNullable<Clip['freezeRef']>> => {
  const out = new Map<string, NonNullable<Clip['freezeRef']>>();
  for (const c of clips) {
    if (!c.bufferId || c.isReversed || c.notes) continue;
    const offset = c.offset || 0;
    out.set(c.id, {
      renderId, anchor: c.start - offset, from: offset, to: offset + c.duration,
      fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, gain: c.gain ?? 1, srcClipId: c.id,
      ...(c.fadeInCurve ? { fadeInCurve: c.fadeInCurve } : {}), ...(c.fadeOutCurve ? { fadeOutCurve: c.fadeOutCurve } : {}),
      // Respirations déjà traitées dans le rendu (utils/breaths).
      ...(c.breaths?.length ? { breaths: c.breaths.map(e => ({ ...e })) } : {}),
      // Ligne de gain déjà rendue (utils/clipGain).
      ...(c.gainPoints?.length ? { gainPoints: c.gainPoints.map(p => ({ ...p })) } : {}),
      // Empreinte du son rendu : un autre son (justesse, Melodyne…) périme le rendu.
      buf: c.bufferId, content: clipContentSig(c),
      ...(c.isMuted ? { muted: true } : {}),
    });
  }
  return out;
};

const breathKey = (e: BreathEdit) => breathSig([e]);

/**
 * Ligne de gain d'une tranche de rendu (repère du rendu = ancrage + temps
 * source) : rien si elle n'a pas changé depuis le gel ; sinon l'écart (ligne
 * actuelle − ligne rendue), évalué aux points des deux lignes.
 */
export const sliceGainPoints = (c: Pick<Clip, 'gainPoints'>, ref: FreezeRef): Clip['gainPoints'] => {
  const cur = sortGainPoints(c.gainPoints), old = sortGainPoints(ref.gainPoints);
  if (gainPointsSig(cur) === gainPointsSig(old)) return undefined;
  const ts = Array.from(new Set([...cur, ...old].map(p => p.t))).sort((a, b) => a - b);
  if (!ts.length) return undefined;
  return ts.map(t => ({ t: ref.anchor + t, db: envelopeDbAt(cur, t) - envelopeDbAt(old, t) }));
};

/**
 * Respirations d'une tranche de rendu (repère du rendu) : seulement celles que
 * le rendu ne contient pas déjà. Les zones sont en secondes de l'audio source :
 * on les décale de l'ancrage (temps du rendu = ancrage + temps source).
 * exact = false : une respiration rendue a été changée ou retirée depuis le
 * gel ; le rendu la contient encore, seule une nouvelle passe (regel) la rend.
 */
export const sliceBreaths = (c: Pick<Clip, 'breaths'>, ref: FreezeRef): { edits?: BreathEdit[]; exact: boolean } => {
  const cur = c.breaths || [];
  const old = ref.breaths || [];
  if (!cur.length && !old.length) return { exact: true };
  const curKeys = new Set(cur.map(breathKey));
  const oldKeys = new Set(old.map(breathKey));
  const exact = old.every(e => curKeys.has(breathKey(e)));
  const added = cur.filter(e => !oldKeys.has(breathKey(e))).map(e => ({ ...e, start: e.start + ref.anchor, end: e.end + ref.anchor }));
  return { edits: added.length ? added : undefined, exact };
};

/**
 * Piste gelée dont des respirations rendues ont changé : le rendu ne peut pas
 * les « défaire », il faut la regeler (ou la dégeler) pour entendre le
 * nouveau traitement. Les respirations ajoutées, elles, s'entendent tout de
 * suite (tranches). Ancien modèle (un seul rendu) : toute modification.
 */
export const breathsNeedRefreeze = (t: Track): boolean => {
  if (!isTrackFrozen(t)) return false;
  if (!t.frozenPluginSig) {
    const covered = coveredClipIds(t);
    return (t.clips || []).some(c => (!covered || covered.has(c.id)) && !!c.breaths?.length) && needsRerender(t);
  }
  return (t.clips || []).some(c => isAnchored(t, c) && !sliceBreaths(c, c.freezeRef!).exact);
};

const playbackCache = new WeakMap<Track, { render: Clip[]; live: Clip[] }>();

/** Places des clips audibles au moment du rendu (temps du rendu = temps du morceau), d'après la photo du gel. */
const renderedRegions = (t: Track): Array<readonly [number, number]> =>
  t.freezeBase && t.frozenClip && t.freezeBase.renderId === t.frozenClip.id
    ? t.freezeBase.clips.filter(b => !b.isMuted).map(b => [b.start, b.start + b.duration] as const)
    : [];

/**
 * Tranches d'un rendu qui suivent les clips ancrés : pour chaque clip, la
 * partie du rendu qui correspond à son audio actuel, à sa position actuelle
 * (+ la queue des effets si sa fin n'a pas bougé, jusqu'au clip rendu suivant).
 * Les parties rallongées au-delà du rendu reviennent dans « live ».
 */
export const sliceAnchored = (
  clips: Clip[], render: Clip, isAnchoredClip: (c: Clip) => boolean, tailMax: number, idSuffix = '~fz',
  rendered: ReadonlyArray<readonly [number, number]> = [],
): { render: Clip[]; live: Clip[] } => {
  const anchored: Clip[] = [];
  const live: Clip[] = [];
  clips.forEach(c => (isAnchoredClip(c) ? anchored : live).push(c));
  // Régions rendues (temps du rendu) : une queue s'arrête où commence la suivante. Une
  // région collée (clips découpés puis regelés) ou qui chevauche (fondu croisé) contient
  // déjà cette queue : la rejouer doublerait le son.
  // `rendered` : toutes les régions présentes au rendu (un clip supprimé depuis y a laissé son son).
  const regions = [...rendered, ...anchored.map(c => [c.freezeRef!.anchor + c.freezeRef!.from, c.freezeRef!.anchor + c.freezeRef!.to] as const)];
  const out: Clip[] = [];
  for (const c of anchored) {
    const ref = c.freezeRef!;
    const off = c.offset || 0;
    const end = off + c.duration;
    const a = Math.max(off, ref.from);
    const b = Math.min(end, ref.to);
    if (b - a > 0.001) {
      const startsAtRenderStart = Math.abs(a - ref.from) < 1e-3;
      const endsAtRenderEnd = Math.abs(b - ref.to) < 1e-3 && end <= ref.to + 1e-3;
      let duration = b - a;
      const userFadeOut = c.fadeOut || 0;
      // Fin d'origine (pas raccourcie, pas de nouveau fondu) : on garde la queue des effets.
      // Fondu inchangé (longueur ET courbe) : il est déjà dans le rendu.
      const sameIn = Math.abs((c.fadeIn || 0) - ref.fadeIn) < 1e-3 && (!(c.fadeIn || 0) || (c.fadeInCurve || 'LINEAR') === (ref.fadeInCurve || 'LINEAR'));
      const sameOut = Math.abs(userFadeOut - ref.fadeOut) < 1e-3 && (!userFadeOut || (c.fadeOutCurve || 'LINEAR') === (ref.fadeOutCurve || 'LINEAR'));
      if (endsAtRenderEnd && sameOut && userFadeOut < 0.02) {
        const renderEnd = ref.anchor + ref.to;
        const next = regions.reduce((m, [s, e]) => (e > renderEnd + 1e-3 ? Math.min(m, s) : m), Infinity);
        const room = Math.min(tailMax, next - renderEnd, render.duration - renderEnd);
        if (room > 0) duration += room;
      }
      out.push({
        ...c,
        id: `${c.id}${idSuffix}`,
        bufferId: render.bufferId,
        buffer: undefined,
        audioRef: undefined,
        warp: undefined,
        start: c.start + (a - off),
        offset: ref.anchor + a,
        duration,
        // Le rendu contient déjà le gain et les fondus d'origine : on n'applique que les changements.
        gain: (c.gain ?? 1) / (ref.gain || 1),
        fadeIn: startsAtRenderStart && sameIn ? 0 : Math.max(c.fadeIn || 0, startsAtRenderStart ? 0 : 0.005),
        fadeOut: endsAtRenderEnd && sameOut ? 0 : Math.max(userFadeOut, endsAtRenderEnd ? 0 : 0.005),
        isFreezeSlice: true,
        freezeRef: undefined,
        // Respirations : le rendu contient déjà celles du gel ; on n'ajoute que les nouvelles.
        breaths: sliceBreaths(c, ref).edits,
        // Ligne de gain : le rendu contient celle du gel ; on n'applique que l'écart.
        gainPoints: sliceGainPoints(c, ref),
      });
    }
    // Clip rallongé au-delà de ce qui a été rendu : ces parties passent en direct.
    if (off < ref.from - 1e-3) {
      live.push({ ...c, id: `${c.id}~pre`, duration: Math.min(c.duration, ref.from - off), fadeOut: 0.005 });
    }
    if (end > ref.to + 1e-3) {
      const s = Math.max(off, ref.to);
      live.push({ ...c, id: `${c.id}~post`, start: c.start + (s - off), offset: s, duration: end - s, fadeIn: 0.005 });
    }
  }
  return { render: out, live };
};

/**
 * Lecture d'une piste gelée : tranches du rendu (entrent après les effets
 * rendus) + clips joués en direct (ajoutés après le rendu, parties rallongées).
 */
export const frozenPlayback = (t: Track): { render: Clip[]; live: Clip[] } => {
  const cached = playbackCache.get(t);
  if (cached) return cached;
  const fc = t.frozenClip!;
  let result: { render: Clip[]; live: Clip[] };
  if (!t.frozenPluginSig) {
    // Ancien modèle : un seul rendu figé, les clips couverts ne se modifient pas.
    const covered = coveredClipIds(t);
    result = { render: [fc], live: covered ? (t.clips || []).filter(c => !covered.has(c.id)) : [] };
  } else {
    result = sliceAnchored(t.clips || [], fc, c => isAnchored(t, c), FREEZE_SLICE_TAIL, '~fz', renderedRegions(t));
  }
  playbackCache.set(t, result);
  return result;
};

// --- Bus / envois à effets VST gelés (reverb VST de l'ingé…) ------------------
//
// Un bus d'effets n'a pas de clips : son rendu est fait PAR SOURCE (la part que
// chaque piste y envoie, passée dans les effets du bus) et rangé sur la piste
// source (Track.sendFreezes). Ses tranches suivent les clips de la source :
// une voix supprimée sur la tablette emporte sa reverb. Au dégel sur le PC, la
// vraie reverb repart de l'audio sec édité.

/** Queue maximale gardée après un clip pour un envoi (reverb, délai). */
export const SEND_SLICE_TAIL = 8;
/** Queue de rendu d'un bus d'effets (reverb longue). */
export const SEND_RENDER_TAIL = 6;

/** Rendu d'envoi valable pour ce bus (bus gelé sur ce rendu). */
export const activeSendFreeze = (source: Track, bus: Track | undefined) => {
  if (!bus || !isTrackFrozen(bus) || !source.sendFreezes) return undefined;
  return source.sendFreezes.find(sf => sf.busId === bus.id && sf.busRenderId === bus.frozenClip!.id);
};

/** La part de cette source vers ce bus est-elle jouée depuis un rendu ? (son envoi direct est alors coupé) */
export const isFeedCovered = (source: Track, busId: string, tracks: Track[]): boolean =>
  !!activeSendFreeze(source, tracks.find(t => t.id === busId));

/** Bus d'effets gelé (pas de clips : ses sources portent ses rendus). */
export const isFrozenBus = (t: Track): boolean =>
  isTrackFrozen(t) && (t.type === TrackType.BUS || t.type === TrackType.SEND) && (t.clips || []).length === 0;

/** Niveau actuel de la part de la source vers le bus (envoi, ou sortie routée = 1). */
export const feedLevel = (source: Track, busId: string): number => {
  const send = (source.sends || []).find(s => s.id === busId && s.isEnabled);
  if (send) return send.level;
  return source.outputTrackId === busId ? 1 : 0;
};

const sendSliceCache = new WeakMap<Track, Map<string, Clip[]>>();

/** Tranches du rendu d'envoi d'une source vers un bus gelé. */
export const sendFreezeSlices = (source: Track, bus: Track): Clip[] => {
  const sf = activeSendFreeze(source, bus);
  if (!sf || source.isMuted) return [];
  let per = sendSliceCache.get(source);
  if (!per) { per = new Map(); sendSliceCache.set(source, per); }
  const key = `${bus.id}|${sf.busRenderId}|${feedLevel(source, bus.id)}`;
  const hit = per.get(key);
  if (hit) return hit;
  const { render } = sliceAnchored(
    source.clips || [], sf.clip,
    c => !!c.freezeRef && c.freezeRef.renderId === sf.anchorId && !c.isReversed && !!c.bufferId,
    SEND_SLICE_TAIL, `~snd-${bus.id}`,
  );
  // Fader de la source ou niveau d'envoi changés depuis le rendu : on suit (c'est linéaire).
  const ratio = (sf.volume > 0 ? source.volume / sf.volume : 1) * (sf.level > 0 ? feedLevel(source, bus.id) / sf.level : 1);
  const slices = render.map(c => ({ ...c, id: `${source.id}:${c.id}`, gain: (c.gain ?? 1) * ratio }));
  per.set(key, slices);
  return slices;
};

/** Tranches jouées par un bus gelé : celles de toutes ses sources. */
export const busFrozenSlices = (bus: Track, tracks: Track[]): Clip[] => {
  if (!isFrozenBus(bus)) return [];
  const out: Clip[] = [];
  for (const s of tracks) if (s.id !== bus.id && s.sendFreezes) out.push(...sendFreezeSlices(s, bus));
  return out;
};

/** Tous les sons qu'une piste garde en mémoire (clips, rendus, photo du gel). */
export const trackBufferIds = (t: Track): string[] => {
  const ids: string[] = [];
  (t.clips || []).forEach(c => { if (c.bufferId) ids.push(c.bufferId); });
  // Prise d'origine d'un clip corrigé en justesse (V19) : gardée pour revenir en arrière.
  (t.clips || []).forEach(c => { if (c.pitchEdit?.sourceBufferId) ids.push(c.pitchEdit.sourceBufferId); });
  // Prise d'origine d'un clip retouché par Melodyne / VocAlign (ARA).
  (t.clips || []).forEach(c => { if (c.araEdit?.sourceBufferId) ids.push(c.araEdit.sourceBufferId); });
  // Son d'origine d'un clip dont la ligne de gain a été rendue (« Revenir »).
  (t.clips || []).forEach(c => { if (c.gainRender?.sourceBufferId) ids.push(c.gainRender.sourceBufferId); });
  // Prise d'origine d'un clip traité par AudioSuite (R6) : gardée pour « Revenir à l'original ».
  (t.clips || []).forEach(c => { if (c.audioSuite?.sourceBufferId) ids.push(c.audioSuite.sourceBufferId); });
  if (t.frozenClip?.bufferId) ids.push(t.frozenClip.bufferId);
  (t.sendFreezes || []).forEach(sf => { if (sf.clip.bufferId) ids.push(sf.clip.bufferId); });
  (t.freezeBase?.clips || []).forEach(c => { const b = (c as { bufferId?: string }).bufferId; if (b) ids.push(b); });
  return ids;
};

/** Clips joues en direct sur une piste gelee (ajoutes apres le rendu, parties rallongees). */
export const uncoveredClips = (t: Track): Clip[] => (t.frozenClip ? frozenPlayback(t).live : []);

export const isVst = (p: PluginInstance): boolean => p.type === 'VST3';
export const hasVst = (t: Track): boolean => (t.plugins || []).some(isVst);
export const lastVstIndex = (t: Track): number => {
  const plugins = t.plugins || [];
  for (let i = plugins.length - 1; i >= 0; i--) if (isVst(plugins[i])) return i;
  return -1;
};

/**
 * Le beat (piste instrumentale ou issue du catalogue) n'est JAMAIS rendu dans un
 * fichier : sa licence l'interdit, et un rendu gele serait sauvegarde avec le projet.
 */
export const canBakeTrack = (t: Track): boolean =>
  t.id !== 'instrumental' && (t.instrumentId === undefined || t.instrumentId === null || t.instrumentId === '');

/** Effets VST3 compris dans le rendu (affiches « Rendu (VST du PC) » sans pont). */
export const isPluginBaked = (t: Track, pluginIndex: number): boolean =>
  isTrackFrozen(t) && pluginIndex <= freezeIndex(t);

// --- Empreinte -------------------------------------------------------------

/** FNV-1a 32 bits : assez pour detecter un changement, pas un usage crypto. */
const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

const clipSig = (c: Clip): string => [
  c.id, c.start, c.duration, c.offset, c.gain ?? 1, c.fadeIn, c.fadeOut,
  c.isMuted ? 1 : 0, c.isReversed ? 1 : 0, c.bufferId || '', c.notes ? fnv(JSON.stringify(c.notes)) : '',
  // Courbes de fondu : ajoutées seulement si présentes (signatures des gels d'avant inchangées).
  ...(c.fadeInCurve || c.fadeOutCurve ? [`${c.fadeInCurve || ''}/${c.fadeOutCurve || ''}`] : []),
  // Respirations traitées (utils/breaths) : idem, seulement si présentes.
  ...(c.breaths?.length ? [fnv(breathSig(c.breaths))] : []),
  // Ligne de gain (utils/clipGain) : idem, seulement si présente.
  ...(c.gainPoints?.length ? [fnv(gainPointsSig(c.gainPoints))] : []),
].join(':');

const pluginSig = (p: PluginInstance): string => {
  const { stateB64, ...rest } = (p.params || {}) as Record<string, any>;
  return [p.id, p.type, p.isEnabled ? 1 : 0, fnv(JSON.stringify(rest)), stateB64 ? fnv(String(stateB64)) : ''].join(':');
};

/** Empreinte des sources d'un rendu : clips donnes + effets [0..upTo]. */
export const freezeSignature = (clips: Clip[], plugins: PluginInstance[], upTo: number): string =>
  fnv(clips.map(clipSig).join('|') + '#' + plugins.slice(0, upTo + 1).map(pluginSig).join('|'));

/** Signature actuelle des sources couvertes par le rendu de la piste. */
export const currentFreezeSignature = (t: Track): string => {
  const covered = coveredClipIds(t);
  const clips = covered ? (t.clips || []).filter(c => covered.has(c.id)) : (t.clips || []);
  return freezeSignature(clips, t.plugins || [], freezeIndex(t));
};

/** Empreinte des seuls effets [0..upTo] (modèle « clips ancrés »). */
export const pluginsSignature = (plugins: PluginInstance[], upTo: number): string =>
  fnv(plugins.slice(0, upTo + 1).map(pluginSig).join('|'));

/**
 * Le rendu ne correspond plus exactement aux sources (clip rendu modifié /
 * supprimé, effet rendu changé). Sur PC avec le pont, on le refait.
 */
export const needsRerender = (t: Track): boolean => {
  if (!t.frozenClip || !t.frozenSourceSig) return false;
  const covered = coveredClipIds(t);
  if (covered && Array.from(covered).some(id => !(t.clips || []).some(c => c.id === id))) return true;
  return currentFreezeSignature(t) !== t.frozenSourceSig;
};

/**
 * Rendu inutilisable : un effet rendu a changé. Avec les clips ancrés, éditer
 * les clips ne périme PAS le rendu (la lecture suit les modifications) ; pour
 * les anciens rendus, toute modification d'un clip rendu le périme.
 */
export const isFreezeStale = (t: Track): boolean => {
  if (!t.frozenClip) return false;
  if (t.frozenPluginSig) return pluginsSignature(t.plugins || [], freezeIndex(t)) !== t.frozenPluginSig;
  return needsRerender(t);
};

// --- Rendu gelé périmé -------------------------------------------------------
//
// Un seul mécanisme pour toutes les opérations qui changent un clip d'une piste
// gelée (justesse, Melodyne / VocAlign, alignement, retour à l'original,
// inversion, consolidation, Strip Silence, découpe, gain, fondus…), sans les
// énumérer : chaque clip rendu garde l'empreinte de ce que le rendu contient
// (FreezeRef), comparée en continu à ce que le clip joue maintenant.
//
//   content : le son a changé (autre fichier, inversé, calage, clip remplacé,
//             respiration retirée, clip rendu muet puis réactivé) : la tranche
//             joue encore l'ANCIEN son, seul un nouveau rendu le corrige.
//   approx  : gain, fondus, découpe / raccourci, respirations ajoutées : la
//             tranche suit, mais APRÈS les effets rendus (un compresseur ne
//             réagit pas au nouveau gain, la queue d'effet est coupée).
//   live    : clip absent du rendu (nouvelle prise…) : joué en direct à
//             travers toute la chaîne (sans le pont, sans ses VST).
//
// L'hôte (hooks/useFrozenRefresh) regèle quand c'est sûr ; sinon il prévient
// (content) et la piste affiche « gel à refaire ».

/** Dans un fichier projet, FreezeRef.buf : le son rendu est celui du clip / un autre. */
export const FREEZE_SAME_SOUND = '=';
export const FREEZE_OTHER_SOUND = '≠';

/**
 * Ce que les tranches du rendu ne savent pas suivre, hors fichier joué (FreezeRef.buf) :
 * sens, calage, notes. Indépendant des identifiants des sons (stables d'une ouverture à l'autre).
 */
export const clipContentSig = (c: Clip): string => fnv([
  c.isReversed ? 1 : 0,
  c.warp?.enabled ? JSON.stringify(c.warp) : '',
  c.notes ? JSON.stringify(c.notes) : '',
].join('|'));

export type FreezeDriftKind = 'content' | 'approx' | 'live';

export interface FreezeDrift {
  /** Clips dont le son a changé (ou qui en remplacent un rendu). */
  content: string[];
  /** Clips suivis approximativement par les tranches. */
  approx: string[];
  /** Clips absents du rendu, joués en direct. */
  live: string[];
}

/** Pistes qui suivent leur propre circuit de rendu (instrument VST, ingé à distance, aperçu en direct). */
const ownRenderFlow = (t: Track): boolean => !!t.vstInstrument || !!t.remote || !!t.livePreview;

/** Le clip pourrait-il être ancré dans un rendu (audio non inversé, audible) ? */
const anchorable = (c: Clip): boolean => !!c.bufferId && !c.isReversed && !c.notes && !c.isFreezeSlice && !c.isMuted;

const sameFade = (len: number, curve: string | undefined, refLen: number, refCurve: string | undefined): boolean =>
  Math.abs(len - refLen) < 1e-3 && (!len || (curve || 'LINEAR') === (refCurve || 'LINEAR'));

/** Le son du clip est-il celui que le rendu contient ? */
const contentChanged = (t: Track, c: Clip, ref: FreezeRef): boolean => {
  if (c.isReversed) return true;
  if (ref.muted && !c.isMuted) return true;
  if (!sliceBreaths(c, ref).exact) return true;
  if (ref.buf !== undefined && ref.buf !== c.bufferId) return true;
  if (ref.content !== undefined) return ref.content !== clipContentSig(c);
  // Rendus d'avant l'empreinte : le son photographié au gel, s'il est connu.
  const base = t.freezeBase && t.freezeBase.renderId === ref.renderId
    ? (t.freezeBase.clips.find(b => b.id === (ref.srcClipId || c.id)) as { bufferId?: string } | undefined) : undefined;
  return !!(base?.bufferId && c.bufferId && base.bufferId !== c.bufferId);
};

/** Le clip est-il joué depuis le rendu tel qu'il y a été rendu (seulement déplacé) ? */
const approxChanged = (c: Clip, ref: FreezeRef): boolean => {
  const off = c.offset || 0;
  if (Math.abs((c.gain ?? 1) - (ref.gain ?? 1)) > 1e-6) return true;
  // Raccourci, découpé, rallongé : fondus anti-clic et queue d'effet coupée aux bords.
  if (Math.abs(off - ref.from) > 1e-3 || Math.abs(off + c.duration - ref.to) > 1e-3) return true;
  if (!sameFade(c.fadeIn || 0, c.fadeInCurve, ref.fadeIn, ref.fadeInCurve)) return true;
  if (!sameFade(c.fadeOut || 0, c.fadeOutCurve, ref.fadeOut, ref.fadeOutCurve)) return true;
  return !!sliceBreaths(c, ref).edits;
};

const driftCache = new WeakMap<Track, FreezeDrift | null>();

/**
 * Ce qui, sur une piste gelée, ne correspond plus à son rendu (null : rendu à
 * jour, piste non gelée, ou piste qui suit son propre circuit de rendu).
 */
export const freezeDrift = (t: Track): FreezeDrift | null => {
  if (!isTrackFrozen(t) || ownRenderFlow(t)) return null;
  if (driftCache.has(t)) return driftCache.get(t)!;
  const d: FreezeDrift = { content: [], approx: [], live: [] };
  const clips = t.clips || [];
  if (!t.frozenPluginSig) {
    // Ancien modèle (un seul rendu figé) : toute modification d'un clip rendu est inaudible.
    const covered = coveredClipIds(t);
    if (needsRerender(t)) d.content.push(...clips.filter(c => !covered || covered.has(c.id)).map(c => c.id));
    if (covered) d.live.push(...clips.filter(c => !covered.has(c.id) && anchorable(c)).map(c => c.id));
  } else {
    const renderId = t.frozenClip!.id;
    // Places d'origine des clips rendus (audibles) : un nouveau son posé là les remplace.
    const rendered = (t.freezeBase && t.freezeBase.renderId === renderId ? t.freezeBase.clips : []).filter(b => !b.isMuted);
    // Clip rendu supprimé (ni lui ni un morceau de lui) : sa place se tait, mais la queue
    // d'effet du clip d'avant, prise dans le rendu, n'est plus jouée → à refaire.
    for (const b of rendered) {
      if (!clips.some(c => c.id === b.id || (c.freezeRef?.renderId === renderId && c.freezeRef.srcClipId === b.id))) d.approx.push(b.id);
    }
    for (const c of clips) {
      if (c.isFreezeSlice || c.notes) continue;
      const ref = c.freezeRef && c.freezeRef.renderId === renderId ? c.freezeRef : undefined;
      if (ref) {
        if (contentChanged(t, c, ref)) d.content.push(c.id);
        else if (!c.isMuted && approxChanged(c, ref)) d.approx.push(c.id);
      } else if (anchorable(c)) {
        // Nouveau son posé là où jouait un clip rendu (consolidation, remplacement) : le son a changé.
        const replaces = rendered.some(b => c.start < b.start + b.duration - 1e-3 && c.start + c.duration > b.start + 1e-3);
        (replaces ? d.content : d.live).push(c.id);
      }
    }
  }
  const out = d.content.length || d.approx.length || d.live.length ? d : null;
  driftCache.set(t, out);
  return out;
};

/** Le rendu gelé est-il à refaire (« gel à refaire ») ? */
export const freezeOutdated = (t: Track): boolean => !!freezeDrift(t);

/**
 * Empreinte de l'écart actuel (null : à jour) : change à chaque nouvelle
 * modification d'un clip concerné, pour ne traiter chaque état qu'une fois.
 */
export const freezeDriftKey = (t: Track): string | null => {
  const d = freezeDrift(t);
  if (!d) return null;
  const byId = new Map((t.clips || []).map(c => [c.id, c] as const));
  const part = (kind: string, ids: string[]) => ids.map(id => { const c = byId.get(id); return `${kind}:${c ? clipSig(c) : id}`; }).join('|');
  return `${t.frozenClip?.id}#${fnv([part('c', d.content), part('a', d.approx), part('l', d.live)].join('#'))}`;
};
