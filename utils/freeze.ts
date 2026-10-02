import { Clip, PluginInstance, Track } from '../types';

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

/** Clips joues en direct sur une piste gelee (ajoutes apres le rendu). */
export const uncoveredClips = (t: Track): Clip[] => {
  const covered = coveredClipIds(t);
  if (!covered) return [];
  return (t.clips || []).filter(c => !covered.has(c.id));
};

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

/**
 * Rendu perime : un clip rendu a ete modifie / supprime, ou un effet rendu a
 * change. (Un clip AJOUTE ne rend pas le rendu perime : il est joue en direct.)
 */
export const isFreezeStale = (t: Track): boolean => {
  if (!t.frozenClip || !t.frozenSourceSig) return false;
  const covered = coveredClipIds(t);
  if (covered && Array.from(covered).some(id => !(t.clips || []).some(c => c.id === id))) return true;
  return currentFreezeSignature(t) !== t.frozenSourceSig;
};
