/**
 * Structure de session façon Pro Tools : effets bypass / inactifs, pistes
 * inactives et masquées, dossiers (routage / simples), VCA, 10 envois (a à j)
 * avec pan et mute, bus internes nommés (I/O Setup).
 *
 * Module PUR (aucune dépendance au moteur ni à React) : le moteur audio, la
 * console, la liste des pistes, les modèles et la collaboration s'en servent.
 *
 * Le principe : l'état du projet garde TOUT (pistes inactives, masquées,
 * dossiers, VCA, effets inactifs avec leurs réglages) ; `engineView()` en
 * déduit ce que le moteur joue réellement :
 *  - pistes inactives (ou dans un dossier inactif) : retirées du moteur, aucun
 *    traitement ; ce qui y sortait part dans le vide (comme Pro Tools) ;
 *  - dossiers simples et VCA : sans son, retirés du moteur ;
 *  - Muet / Solo d'un dossier : appliqués à ses enfants ;
 *  - VCA : volume des membres multiplié par le fader du VCA (dB relatifs),
 *    Muet / Solo du VCA appliqués aux membres ;
 *  - sortie vers un bus nommé : résolue vers la piste qui l'écoute (entrée) ;
 *    personne ne l'écoute : le son part dans le vide (comme Pro Tools).
 * Une piste MASQUÉE joue normalement (masquer n'est qu'un affichage).
 */
import type { NamedBus, PluginInstance, Track, TrackFolder, TrackSend } from '../types';
import { TrackType } from '../types';

// ─── Effets : actif / bypass / inactif ─────────────────────────────────────────

export type PluginState = 'active' | 'bypass' | 'inactive';

/** État d'un effet : inactif prime sur le bypass (un effet inactif peut aussi être en bypass). */
export const pluginState = (p: Pick<PluginInstance, 'isEnabled' | 'isInactive'>): PluginState =>
  p.isInactive ? 'inactive' : p.isEnabled ? 'active' : 'bypass';

/** L'effet traite-t-il le son (ni bypass, ni inactif) ? */
export const isPluginProcessing = (p: Pick<PluginInstance, 'isEnabled' | 'isInactive'>): boolean => !!p.isEnabled && !p.isInactive;

/** Effet avec un nouvel état. « active » enlève aussi l'inactivité ; « inactive » garde le bypass tel quel. */
export const withPluginState = (p: PluginInstance, state: PluginState): PluginInstance => {
  if (state === 'inactive') return { ...p, isInactive: true };
  const { isInactive: _i, ...rest } = p;
  void _i;
  return { ...rest, isEnabled: state === 'active' } as PluginInstance;
};

/** Rendre actif / inactif (sans toucher au bypass). */
export const withPluginInactive = (p: PluginInstance, inactive: boolean): PluginInstance => {
  if (inactive) return { ...p, isInactive: true };
  const { isInactive: _i, ...rest } = p;
  void _i;
  return rest as PluginInstance;
};

export interface ChainStep {
  id: string;
  /** process : le son passe dans l'effet ; bypass : il passe à côté, retardé de la latence de l'effet. */
  mode: 'process' | 'bypass';
}

/**
 * Chaîne d'effets jouée par le moteur. Les effets INACTIFS n'y sont pas (ni
 * chargés, ni comptés dans la latence) ; les effets en BYPASS y restent : le
 * son les contourne par un retard égal à leur latence, l'alignement est gardé.
 */
export const chainPlan = (plugins: Pick<PluginInstance, 'id' | 'isEnabled' | 'isInactive'>[]): ChainStep[] =>
  (plugins || []).filter(p => !p.isInactive).map(p => ({ id: p.id, mode: p.isEnabled ? 'process' : 'bypass' }));

/** Latence (s) d'une chaîne : effets actifs ET en bypass ; les inactifs ne comptent pas. */
export const chainLatency = (plugins: Pick<PluginInstance, 'id' | 'isEnabled' | 'isInactive'>[], latencyOf: (id: string) => number): number =>
  chainPlan(plugins).reduce((acc, s) => { const l = latencyOf(s.id); return acc + (Number.isFinite(l) && l > 0 ? l : 0); }, 0);

/**
 * Raccourcis Pro Tools sur un effet :
 *  - Ctrl+clic (Cmd+clic) : bypass ;
 *  - Ctrl+Alt+clic (Pro Tools : Ctrl+Démarrer+clic, la touche Windows n'arrive pas au navigateur) : actif / inactif.
 */
export const pluginClickAction = (e: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): 'bypass' | 'inactive' | null => {
  const mod = !!(e.ctrlKey || e.metaKey);
  if (mod && e.altKey) return 'inactive';
  if (mod) return 'bypass';
  return null;
};

export const PLUGIN_STATE_LABEL: Record<PluginState, string> = { active: 'Actif', bypass: 'Bypass', inactive: 'Inactif' };

// ─── Envois a à j ──────────────────────────────────────────────────────────────

export const SEND_SLOT_COUNT = 10;
export const SEND_SLOT_LETTERS = 'abcdefghij'.split('');

/** Les 10 emplacements d'envoi d'une piste (null = libre), comme les envois A-J de Pro Tools. */
export const sendSlots = (sends: TrackSend[] | undefined): (TrackSend | null)[] => {
  const out: (TrackSend | null)[] = Array(SEND_SLOT_COUNT).fill(null);
  const rest: TrackSend[] = [];
  for (const s of sends || []) {
    const k = typeof s.slot === 'number' ? Math.floor(s.slot) : -1;
    if (k >= 0 && k < SEND_SLOT_COUNT && !out[k]) out[k] = s; else rest.push(s);
  }
  for (const s of rest) { const free = out.indexOf(null); if (free < 0) break; out[free] = s; }
  return out;
};

/** Emplacement (0-9) d'un envoi dans la piste. */
export const sendSlotOf = (sends: TrackSend[] | undefined, sendId: string): number => sendSlots(sends).findIndex(s => s?.id === sendId);

/** Pose (ou remplace) l'envoi de l'emplacement `slot` ; null le retire. */
export const setSendSlot = (sends: TrackSend[] | undefined, slot: number, send: TrackSend | null): TrackSend[] => {
  const slots: (TrackSend | null)[] = sendSlots(sends).map((s, i) => (s ? { ...s, slot: i } : null));
  const prev = slots[slot];
  if (send) {
    // Un même bus ne reçoit qu'un envoi par piste : l'ancien emplacement est libéré.
    const dup = slots.findIndex((s, i) => i !== slot && s?.id === send.id);
    if (dup >= 0) slots[dup] = null;
    slots[slot] = { ...(prev && prev.id === send.id ? prev : {}), ...send, slot };
  } else slots[slot] = null;
  return slots.filter((s): s is TrackSend => !!s);
};

/** Gain linéaire par canal d'un pan équi-puissance (-1 … 1), comme le StereoPannerNode sur une source mono. */
export const panGains = (pan: number): [number, number] => {
  const p = Math.max(-1, Math.min(1, pan || 0));
  const x = (p + 1) / 2;
  return [Math.cos(x * Math.PI / 2), Math.sin(x * Math.PI / 2)];
};

// ─── Bus nommés (I/O Setup) ────────────────────────────────────────────────────

const fold = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = (s: string) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bus';

/** Bus de la session (rangés sur la piste master, comme l'I/O Setup est rangé avec la session). */
export const busesOf = (tracks: Track[]): NamedBus[] => tracks.find(t => t.id === 'master')?.ioBuses || [];

export const busById = (tracks: Track[], id: string | undefined): NamedBus | undefined => (id ? busesOf(tracks).find(b => b.id === id) : undefined);

export const findBusByName = (tracks: Track[], name: string): NamedBus | undefined => {
  const f = fold(name).trim();
  return busesOf(tracks).find(b => fold(b.name).trim() === f);
};

const withMasterBuses = (tracks: Track[], buses: NamedBus[]): Track[] =>
  tracks.map(t => (t.id === 'master' ? { ...t, ioBuses: buses } : t));

/** Nouveau bus nommé (nom unique : « RV », « RV 2 »…). Renvoie les pistes et le bus. */
export const createBus = (tracks: Track[], name: string, channels: 1 | 2 = 2): { tracks: Track[]; bus: NamedBus } => {
  const list = busesOf(tracks);
  let n = (name || 'Bus').trim() || 'Bus';
  if (list.some(b => fold(b.name) === fold(n))) { let k = 2; while (list.some(b => fold(b.name) === fold(`${n} ${k}`))) k++; n = `${n} ${k}`; }
  let id = `bus:${slug(n)}`; let k = 2;
  while (list.some(b => b.id === id)) id = `bus:${slug(n)}-${k++}`;
  const bus: NamedBus = { id, name: n, ...(channels === 1 ? { channels: 1 as const } : {}) };
  if (!tracks.some(t => t.id === 'master')) return { tracks, bus };
  return { tracks: withMasterBuses(tracks, [...list, bus]), bus };
};

export const renameBus = (tracks: Track[], id: string, name: string): Track[] => {
  const n = (name || '').trim();
  if (!n) return tracks;
  return withMasterBuses(tracks, busesOf(tracks).map(b => (b.id === id ? { ...b, name: n } : b)));
};

/** Supprime un bus : les pistes qui y sortaient repartent vers le master, celles qui l'écoutaient n'ont plus d'entrée. */
export const deleteBus = (tracks: Track[], id: string): Track[] =>
  withMasterBuses(tracks, busesOf(tracks).filter(b => b.id !== id)).map(t => {
    if (t.outputBusId !== id && t.inputBusId !== id) return t;
    const o = { ...t };
    if (o.outputBusId === id) { delete o.outputBusId; o.outputTrackId = 'master'; }
    if (o.inputBusId === id) delete o.inputBusId;
    return o;
  });

/** Pistes qui écoutent un bus (entrée), dans l'ordre de la session. */
export const busListeners = (tracks: Track[], busId: string): Track[] => tracks.filter(t => t.inputBusId === busId);

export interface BusUsage {
  bus: NamedBus;
  /** Pistes dont l'entrée est ce bus. */
  listeners: Track[];
  /** Pistes dont la sortie est ce bus. */
  outputs: Track[];
  /** Pistes qui envoient (envois a-j) vers une piste qui écoute ce bus. */
  senders: { track: Track; slot: number }[];
}

/** Qui écoute, qui sort et qui envoie vers chaque bus (panneau « Bus »). */
export const busUsage = (tracks: Track[]): BusUsage[] => busesOf(tracks).map(bus => {
  const listeners = busListeners(tracks, bus.id);
  const ids = new Set(listeners.map(l => l.id));
  const senders: BusUsage['senders'] = [];
  for (const t of tracks) sendSlots(t.sends).forEach((s, slot) => { if (s && ids.has(s.id)) senders.push({ track: t, slot }); });
  return { bus, listeners, outputs: tracks.filter(t => t.outputBusId === bus.id), senders };
});

export type OutputTarget = { kind: 'master' } | { kind: 'track'; id: string } | { kind: 'bus'; id: string } | { kind: 'none' };

/** Sortie choisie d'une piste (sélecteur Pro Tools). */
export const outputOf = (t: Track): OutputTarget =>
  t.outputBusId ? { kind: 'bus', id: t.outputBusId } : !t.outputTrackId || t.outputTrackId === 'master' ? { kind: 'master' } : { kind: 'track', id: t.outputTrackId };

/**
 * Pose la sortie d'une piste. Vers un bus : `outputBusId`, et `outputTrackId`
 * pointe aussi la piste qui l'écoute (les anciennes versions de NOVA suivent).
 */
export const setTrackOutput = (tracks: Track[], trackId: string, target: OutputTarget): Track[] => tracks.map(t => {
  if (t.id !== trackId) return t;
  const o = { ...t };
  delete o.outputBusId;
  if (target.kind === 'master') o.outputTrackId = 'master';
  else if (target.kind === 'track') o.outputTrackId = target.id;
  else if (target.kind === 'bus') {
    o.outputBusId = target.id;
    const l = busListeners(tracks, target.id).find(x => x.id !== t.id);
    o.outputTrackId = l ? l.id : 'master';
  }
  return o;
});

/** Pose l'entrée (bus écouté) d'une piste ; les pistes qui sortent vers ce bus suivent (outputTrackId). */
export const setTrackInputBus = (tracks: Track[], trackId: string, busId: string | null): Track[] => {
  const next = tracks.map(t => {
    if (t.id !== trackId) return t;
    const o = { ...t };
    if (busId) o.inputBusId = busId; else delete o.inputBusId;
    return o;
  });
  return next.map(t => {
    if (!t.outputBusId) return t;
    const l = busListeners(next, t.outputBusId).find(x => x.id !== t.id);
    const want = l ? l.id : 'master';
    return t.outputTrackId === want ? t : { ...t, outputTrackId: want };
  });
};

// ─── Dossiers ──────────────────────────────────────────────────────────────────

export const isFolder = (t: Pick<Track, 'folder'> | undefined): boolean => !!t?.folder;
export const isRoutingFolder = (t: Pick<Track, 'folder'> | undefined): boolean => t?.folder?.kind === 'routing';
export const isBasicFolder = (t: Pick<Track, 'folder'> | undefined): boolean => t?.folder?.kind === 'basic';

/** Dossiers parents, du plus proche au plus lointain (boucles coupées). */
export const ancestorsOf = (t: Track, byId: Map<string, Track>): Track[] => {
  const out: Track[] = [];
  const seen = new Set<string>([t.id]);
  let cur = t.parentFolderId ? byId.get(t.parentFolderId) : undefined;
  while (cur && !seen.has(cur.id) && cur.folder) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined;
  }
  return out;
};

const mapOf = (tracks: Track[]) => new Map(tracks.map(t => [t.id, t]));

/** Profondeur dans les dossiers (0 = racine). */
export const folderDepth = (t: Track, tracks: Track[]): number => ancestorsOf(t, mapOf(tracks)).length;

/** Enfants directs d'un dossier. */
export const folderChildren = (folderId: string, tracks: Track[]): Track[] => tracks.filter(t => t.parentFolderId === folderId);

/** Tous les descendants d'un dossier (dossiers imbriqués compris). */
export const folderDescendants = (folderId: string, tracks: Track[]): Track[] => {
  const byId = mapOf(tracks);
  return tracks.filter(t => t.id !== folderId && ancestorsOf(t, byId).some(a => a.id === folderId));
};

/** Piste inactive, elle-même ou par un dossier parent inactif. */
export const isEffectivelyInactive = (t: Track, tracks: Track[] | Map<string, Track>): boolean => {
  if (t.isInactive) return true;
  const byId = tracks instanceof Map ? tracks : mapOf(tracks);
  return ancestorsOf(t, byId).some(a => a.isInactive);
};

/** Ligne affichée dans la fenêtre d'édition (ni masquée, ni dans un dossier replié). */
export const isShownInEdit = (t: Track, tracks: Track[] | Map<string, Track>): boolean => {
  if (t.isHidden) return false;
  const byId = tracks instanceof Map ? tracks : mapOf(tracks);
  return !ancestorsOf(t, byId).some(a => a.folder?.isOpen === false || a.isHidden);
};

/** Mémo par tableau de pistes (la liste n'est recalculée que si les pistes changent). */
const shownCache = new WeakMap<Track[], Set<string>>();
export const shownTrackIds = (tracks: Track[]): Set<string> => {
  let s = shownCache.get(tracks);
  if (!s) { const byId = mapOf(tracks); s = new Set(tracks.filter(t => isShownInEdit(t, byId)).map(t => t.id)); shownCache.set(tracks, s); }
  return s;
};

/** Fin du bloc d'un dossier (index après son dernier descendant). */
const blockEnd = (tracks: Track[], folderId: string): number => {
  const i = tracks.findIndex(t => t.id === folderId);
  if (i < 0) return tracks.length;
  const desc = new Set(folderDescendants(folderId, tracks).map(t => t.id));
  let j = i + 1;
  while (j < tracks.length && desc.has(tracks[j].id)) j++;
  return j;
};

/** Bloc d'une piste (elle + ses descendants si c'est un dossier), dans l'ordre. */
const blockOf = (tracks: Track[], id: string): Track[] => {
  const t = tracks.find(x => x.id === id);
  if (!t) return [];
  if (!t.folder) return [t];
  const desc = new Set(folderDescendants(id, tracks).map(x => x.id));
  return [t, ...tracks.filter(x => desc.has(x.id))];
};

/** Sortie à donner à une piste qui quitte un dossier de routage : la sortie du dossier. */
const outputOfFolder = (folder: Track): Pick<Track, 'outputTrackId' | 'outputBusId'> =>
  ({ outputTrackId: folder.outputTrackId || 'master', ...(folder.outputBusId ? { outputBusId: folder.outputBusId } : {}) });

/**
 * Range une piste (et son bloc si c'est un dossier) dans un dossier, à la fin
 * de celui-ci. Dossier de routage : la piste y est routée (sa sortie devient le
 * dossier). Dossier simple : la sortie ne change pas.
 */
export const moveIntoFolder = (tracks: Track[], trackId: string, folderId: string): Track[] => {
  const folder = tracks.find(t => t.id === folderId);
  const t = tracks.find(x => x.id === trackId);
  if (!folder?.folder || !t || trackId === folderId || t.id === 'master') return tracks;
  // Un dossier ne va pas dans un de ses descendants.
  if (folderDescendants(trackId, tracks).some(d => d.id === folderId)) return tracks;
  const block = blockOf(tracks, trackId);
  const ids = new Set(block.map(b => b.id));
  const rest = tracks.filter(x => !ids.has(x.id));
  const moved = block.map(b => {
    if (b.id !== trackId) return b;
    const o: Track = { ...b, parentFolderId: folderId };
    if (folder.folder!.kind === 'routing') { delete o.outputBusId; o.outputTrackId = folderId; }
    else if (b.parentFolderId && b.outputTrackId === b.parentFolderId) {
      // Sorti d'un dossier de routage vers un dossier simple : la sortie du dossier quitté.
      const old = tracks.find(x => x.id === b.parentFolderId);
      if (old) Object.assign(o, outputOfFolder(old));
    }
    return o;
  });
  const at = blockEnd(rest, folderId);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
};

/** Sort une piste de son dossier (elle remonte d'un niveau, juste après le dossier). */
export const moveOutOfFolder = (tracks: Track[], trackId: string): Track[] => {
  const t = tracks.find(x => x.id === trackId);
  if (!t?.parentFolderId) return tracks;
  const folder = tracks.find(x => x.id === t.parentFolderId);
  const block = blockOf(tracks, trackId);
  const ids = new Set(block.map(b => b.id));
  const rest = tracks.filter(x => !ids.has(x.id));
  const moved = block.map(b => {
    if (b.id !== trackId) return b;
    const o: Track = { ...b };
    if (folder?.parentFolderId) o.parentFolderId = folder.parentFolderId; else delete o.parentFolderId;
    if (folder && (b.outputTrackId === folder.id)) {
      // La piste sortait dans le dossier (de routage) : elle prend la sortie du dossier.
      const parent = folder.parentFolderId ? tracks.find(x => x.id === folder.parentFolderId) : undefined;
      if (parent?.folder?.kind === 'routing') { delete o.outputBusId; o.outputTrackId = parent.id; }
      else Object.assign(o, outputOfFolder(folder));
    }
    return o;
  });
  if (!folder) return [...rest, ...moved];
  const at = blockEnd(rest, folder.id);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
};

export interface NewFolderOptions {
  id: string;
  name: string;
  kind: TrackFolder['kind'];
  color?: string;
  /** Pistes rangées tout de suite dans le dossier. */
  childIds?: string[];
}

/** Nouvelle piste dossier (routage = un bus avec fader et inserts ; simple = range seulement). */
export const makeFolderTrack = (o: { id: string; name: string; kind: TrackFolder['kind']; color?: string; outputTrackId?: string }): Track => ({
  id: o.id, name: o.name, type: TrackType.BUS, color: o.color || (o.kind === 'routing' ? '#f59e0b' : '#64748b'),
  isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
  outputTrackId: o.outputTrackId || 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
  folder: { kind: o.kind, isOpen: true },
});

/**
 * Crée un dossier avant la première piste choisie et y range les pistes.
 * Dossier de routage : il sort là où sortaient les pistes (si elles allaient
 * toutes au même endroit), sinon au master.
 */
export const createFolder = (tracks: Track[], opts: NewFolderOptions): Track[] => {
  const kids = (opts.childIds || []).map(id => tracks.find(t => t.id === id)).filter((t): t is Track => !!t && t.id !== 'master');
  const outs = new Set(kids.map(k => k.outputBusId ? `bus:${k.outputBusId}` : (k.outputTrackId || 'master')));
  const common = outs.size === 1 ? kids[0] : undefined;
  const folder = makeFolderTrack({ id: opts.id, name: opts.name, kind: opts.kind, color: opts.color, outputTrackId: common?.outputTrackId || 'master' });
  if (common?.outputBusId) folder.outputBusId = common.outputBusId;
  // Le dossier prend la place de la 1re piste (et son parent).
  const firstIdx = kids.length ? Math.min(...kids.map(k => tracks.indexOf(k))) : tracks.findIndex(t => t.id === 'master');
  const first = kids.length ? tracks[firstIdx] : undefined;
  if (first?.parentFolderId && !kids.some(k => k.id === first.parentFolderId)) folder.parentFolderId = first.parentFolderId;
  const at = firstIdx < 0 ? tracks.length : firstIdx;
  let out = [...tracks.slice(0, at), folder, ...tracks.slice(at)];
  for (const k of kids) out = moveIntoFolder(out, k.id, folder.id);
  return out;
};

/** Supprime un dossier en gardant ses pistes (elles remontent d'un niveau). */
export const dissolveFolder = (tracks: Track[], folderId: string): Track[] => {
  let out = tracks;
  for (const k of folderChildren(folderId, tracks)) out = moveOutOfFolder(out, k.id);
  return out.filter(t => t.id !== folderId);
};

export const setFolderOpen = (tracks: Track[], folderId: string, open: boolean): Track[] =>
  tracks.map(t => (t.id === folderId && t.folder ? { ...t, folder: { ...t.folder, isOpen: open } } : t));

// ─── Pistes masquées / inactives ───────────────────────────────────────────────

const patch = (tracks: Track[], ids: Set<string>, f: (t: Track) => Track): Track[] => tracks.map(t => (ids.has(t.id) ? f(t) : t));

const setFlag = <K extends 'isHidden' | 'isInactive'>(t: Track, k: K, v: boolean): Track => {
  if (!!t[k] === v) return t;
  const o = { ...t };
  if (v) o[k] = true as Track[K]; else delete o[k];
  return o;
};

/** Masque / affiche des pistes. Le master ne se masque pas. */
export const setTracksHidden = (tracks: Track[], ids: string[], hidden: boolean): Track[] =>
  patch(tracks, new Set(ids.filter(id => id !== 'master')), t => setFlag(t, 'isHidden', hidden));

/** Ctrl+clic dans la liste : tout afficher ou tout masquer (sauf le master). */
export const setAllHidden = (tracks: Track[], hidden: boolean): Track[] =>
  setTracksHidden(tracks, tracks.map(t => t.id), hidden);

/** Rend inactive / active une piste (pas le master). */
export const setTracksInactive = (tracks: Track[], ids: string[], inactive: boolean): Track[] =>
  patch(tracks, new Set(ids.filter(id => id !== 'master')), t => setFlag(t, 'isInactive', inactive));

/**
 * « Afficher et activer » en un geste (piste prête à servir : BACK B, AMB…) :
 * la piste, ses dossiers parents (affichés, actifs, dépliés) et, pour un
 * dossier, tout ce qu'il contient.
 */
export const showAndActivate = (tracks: Track[], id: string): Track[] => {
  const t = tracks.find(x => x.id === id);
  if (!t) return tracks;
  const byId = mapOf(tracks);
  const ids = new Set<string>([id, ...ancestorsOf(t, byId).map(a => a.id)]);
  if (t.folder) folderDescendants(id, tracks).forEach(d => ids.add(d.id));
  return tracks.map(x => {
    if (!ids.has(x.id)) return x;
    let o = setFlag(setFlag(x, 'isHidden', false), 'isInactive', false);
    if (o.folder && o.folder.isOpen === false && o.id !== id) o = { ...o, folder: { ...o.folder, isOpen: true } };
    if (o.id === id && o.folder && o.folder.isOpen === false) o = { ...o, folder: { ...o.folder, isOpen: true } };
    return o;
  });
};

/** Pistes « prêtes à servir » : masquées ET inactives (KICK, 808, BACK B, AMB, REF… dans LENNON). */
export const readyToUseTracks = (tracks: Track[]): Track[] => tracks.filter(t => t.isHidden && t.isInactive && t.id !== 'master');

export type TrackListFilter = 'all' | 'active' | 'hidden' | 'inactive';

export const filterTrackList = (tracks: Track[], f: TrackListFilter): Track[] => {
  const byId = mapOf(tracks);
  if (f === 'active') return tracks.filter(t => !isEffectivelyInactive(t, byId));
  if (f === 'hidden') return tracks.filter(t => t.isHidden);
  if (f === 'inactive') return tracks.filter(t => isEffectivelyInactive(t, byId));
  return tracks;
};

// ─── VCA ───────────────────────────────────────────────────────────────────────

export const isVca = (t: Pick<Track, 'isVca'> | undefined): boolean => !!t?.isVca;

export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** Membres d'un VCA : pistes qui le désignent (vcaId) et pistes de son groupe (Track.groupId = vcaGroupId). */
export const vcaMembers = (vca: Track, tracks: Track[]): Track[] =>
  tracks.filter(t => t.id !== vca.id && (t.vcaId === vca.id || (!!vca.vcaGroupId && t.groupId === vca.vcaGroupId)));

export const makeVcaTrack = (o: { id: string; name: string; color?: string; groupId?: string }): Track => ({
  id: o.id, name: o.name, type: TrackType.BUS, color: o.color || '#8b5cf6',
  isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
  outputTrackId: '', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
  isVca: true, ...(o.groupId ? { vcaGroupId: o.groupId } : {}),
});

/** Crée un VCA (avant le master) et y attache des pistes choisies à la main. */
export const createVca = (tracks: Track[], o: { id: string; name: string; memberIds?: string[]; groupId?: string; color?: string }): Track[] => {
  const vca = makeVcaTrack(o);
  const members = new Set(o.memberIds || []);
  const out = tracks.map(t => (members.has(t.id) && t.id !== 'master' ? { ...t, vcaId: vca.id } : t));
  const mi = out.findIndex(t => t.id === 'master');
  return mi < 0 ? [...out, vca] : [...out.slice(0, mi), vca, ...out.slice(mi)];
};

// ─── Vue du moteur ─────────────────────────────────────────────────────────────

/** Sortie « dans le vide » : bus que personne n'écoute, piste de destination inactive. */
export const VOID_OUTPUT = '__nova_void__';

export interface EngineView {
  /** Pistes jouées par le moteur (pistes actives, avec Muet / Solo / VCA / sorties résolus). */
  tracks: Track[];
  byId: Map<string, Track>;
  /** Pistes retirées du moteur : inactives, dossiers simples, VCA. */
  excluded: Set<string>;
  /** Facteur de gain des VCA par piste membre (1 = aucun VCA). */
  vcaScale: Map<string, number>;
}

const viewCache = new WeakMap<Track[], EngineView>();
const derivedCache = new WeakMap<Track, { sig: string; out: Track }>();

/** Gain, muet et solo hérités des VCA d'une piste (VCA imbriqués compris). */
const vcaChain = (t: Track, vcas: Track[], tracks: Track[], memberOf: Map<string, Track[]>): { gain: number; mute: boolean; solo: boolean } => {
  let gain = 1, mute = false, solo = false;
  const seen = new Set<string>();
  let level = memberOf.get(t.id) || [];
  while (level.length) {
    const next: Track[] = [];
    for (const v of level) {
      if (seen.has(v.id) || v.isInactive) continue;
      seen.add(v.id);
      gain *= Math.max(0, v.volume);
      mute = mute || !!v.isMuted;
      solo = solo || !!v.isSolo;
      next.push(...(memberOf.get(v.id) || []));
    }
    level = next;
  }
  void vcas; void tracks;
  return { gain, mute, solo };
};

/**
 * Ce que le moteur joue : voir l'en-tête du fichier. Mémorisé par tableau de
 * pistes, et chaque piste inchangée garde son objet (le moteur ne recâble que
 * ce qui a changé). `engineView(view.tracks)` renvoie la même vue.
 */
export const engineView = (tracks: Track[]): EngineView => {
  const cached = viewCache.get(tracks);
  if (cached) return cached;
  const byId = mapOf(tracks);
  const excluded = new Set<string>();
  const vcaScale = new Map<string, number>();
  const inactive = (t: Track) => t.id !== 'master' && isEffectivelyInactive(t, byId);

  for (const t of tracks) {
    if (t.id === 'master') continue;
    if (inactive(t) || t.folder?.kind === 'basic' || t.isVca) excluded.add(t.id);
  }

  // VCA : qui pilote qui.
  const vcas = tracks.filter(t => t.isVca);
  const memberOf = new Map<string, Track[]>();
  for (const v of vcas) for (const m of vcaMembers(v, tracks)) {
    const l = memberOf.get(m.id) || []; l.push(v); memberOf.set(m.id, l);
  }

  // Bus nommés : qui écoute quoi (pistes jouées seulement).
  const listeners = new Map<string, string[]>();
  for (const t of tracks) {
    if (!t.inputBusId || excluded.has(t.id)) continue;
    const l = listeners.get(t.inputBusId) || []; l.push(t.id); listeners.set(t.inputBusId, l);
  }
  const knownBuses = new Set(busesOf(tracks).map(b => b.id));

  const out: Track[] = [];
  for (const t of tracks) {
    if (excluded.has(t.id)) continue;
    const anc = ancestorsOf(t, byId);
    const folderMute = anc.some(a => a.isMuted);
    const folderSolo = anc.some(a => a.isSolo);
    const v = memberOf.has(t.id) ? vcaChain(t, vcas, tracks, memberOf) : { gain: 1, mute: false, solo: false };
    if (v.gain !== 1) vcaScale.set(t.id, v.gain);

    // Sortie résolue.
    let output = t.outputTrackId;
    let extraTaps: string[] = [];
    if (t.outputBusId && t.id !== 'master') {
      const ls = (listeners.get(t.outputBusId) || []).filter(id => id !== t.id);
      if (!knownBuses.has(t.outputBusId) || !ls.length) output = VOID_OUTPUT;
      else { output = ls[0]; extraTaps = ls.slice(1); }
    } else if (output && output !== 'master' && byId.has(output)) {
      const dest = byId.get(output)!;
      if (excluded.has(output)) output = dest.isVca || dest.folder?.kind === 'basic' ? 'master' : VOID_OUTPUT;
    }

    // Envois : vers une piste retirée du moteur = rien.
    const sendsIn = t.sends || [];
    const keptSends = sendsIn.filter(s => !excluded.has(s.id));
    const taps: TrackSend[] = extraTaps.map(id => ({ id, level: 1, isEnabled: true }));
    const sends = keptSends.length === sendsIn.length && !taps.length ? sendsIn : [...keptSends, ...taps];

    const mute = !!t.isMuted || folderMute || v.mute;
    const solo = !!t.isSolo || folderSolo || v.solo;
    const changed = mute !== !!t.isMuted || solo !== !!t.isSolo || v.gain !== 1 || output !== t.outputTrackId || sends !== sendsIn;
    if (!changed) { out.push(t); continue; }
    const sig = `${mute ? 1 : 0}|${solo ? 1 : 0}|${v.gain}|${output}|${sends === sendsIn ? '=' : JSON.stringify(sends)}`;
    const prev = derivedCache.get(t);
    if (prev && prev.sig === sig) { out.push(prev.out); continue; }
    const d: Track = { ...t, isMuted: mute, isSolo: solo, outputTrackId: output, sends };
    if (v.gain !== 1) {
      d.volume = t.volume * v.gain;
      // Automation du volume : la courbe passe aussi par le VCA.
      if (t.automationLanes?.some(l => l.parameterName === 'volume' && l.points.length)) {
        d.automationLanes = t.automationLanes.map(l => (l.parameterName === 'volume'
          ? { ...l, points: l.points.map(p => ({ ...p, value: p.value * v.gain })) } : l));
      }
    }
    derivedCache.set(t, { sig, out: d });
    out.push(d);
  }
  const view: EngineView = { tracks: out, byId: mapOf(out), excluded, vcaScale };
  viewCache.set(tracks, view);
  viewCache.set(out, view);
  return view;
};

/** Pistes jouées par le moteur (raccourci). */
export const playedTracks = (tracks: Track[]): Track[] => engineView(tracks).tracks;

/** Empreinte du routage effectif : change dès qu'une piste doit être recâblée à cause d'une autre. */
export const structureSig = (tracks: Track[]): string => {
  const v = engineView(tracks);
  return `${[...v.excluded].join(',')}#${v.tracks.map(t => `${t.id}>${t.outputTrackId || ''}|${t.isMuted ? 1 : 0}${t.isSolo ? 1 : 0}|${(t.sends || []).map(s => `${s.id}:${s.isEnabled ? 1 : 0}${s.isMuted ? 'm' : ''}${s.pan !== undefined ? 'p' : ''}${s.preFader ? 'P' : ''}`).join(',')}`).join(';')}`;
};
