import { Clip, PluginInstance, Track, TrackType } from '../types';

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
    });
  }
  return out;
};

const playbackCache = new WeakMap<Track, { render: Clip[]; live: Clip[] }>();

/**
 * Tranches d'un rendu qui suivent les clips ancrés : pour chaque clip, la
 * partie du rendu qui correspond à son audio actuel, à sa position actuelle
 * (+ la queue des effets si sa fin n'a pas bougé, jusqu'au clip rendu suivant).
 * Les parties rallongées au-delà du rendu reviennent dans « live ».
 */
export const sliceAnchored = (
  clips: Clip[], render: Clip, isAnchoredClip: (c: Clip) => boolean, tailMax: number, idSuffix = '~fz',
): { render: Clip[]; live: Clip[] } => {
  const anchored: Clip[] = [];
  const live: Clip[] = [];
  clips.forEach(c => (isAnchoredClip(c) ? anchored : live).push(c));
  // Débuts des régions rendues (temps du rendu) : une queue s'arrête avant la suivante.
  const regionStarts = anchored.map(c => c.freezeRef!.anchor + c.freezeRef!.from).sort((a, b) => a - b);
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
        const next = regionStarts.find(s => s > renderEnd + 1e-3);
        const room = Math.min(tailMax, (next ?? Infinity) - renderEnd, render.duration - renderEnd);
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
    result = sliceAnchored(t.clips || [], fc, c => isAnchored(t, c), FREEZE_SLICE_TAIL);
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
