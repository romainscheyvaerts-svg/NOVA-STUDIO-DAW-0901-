import { useSyncExternalStore } from 'react';
import { Clip, Track, TrackGroup, TrackType } from '../types';

/**
 * R12 · Groupes façon Pro Tools : Édition, Mix ou les deux.
 *
 * - Groupe d'ÉDITION : un geste fait sur une piste du groupe (sélection de
 *   plage, clic sur un clip, coupe, rognage, fondus, nudge, déplacement,
 *   Shuffle, gain de clip, AudioSuite, Consolider) vaut pour toutes les pistes
 *   du groupe. Exemple : LEAD + DOUBLE + BACKS coupés d'un coup.
 * - Groupe de MIX : les attributs cochés (volume relatif, muet, solo, pan,
 *   envois, mode d'automation) suivent sur les autres membres.
 * - Groupe actif / inactif (Pro Tools : surligné dans la Groups List),
 *   « Suspendre tous les groupes » (Ctrl+Maj+G), groupe virtuel « <TOUT> ».
 * - Maj+Ctrl pendant le geste inverse l'état des groupes (Pro Tools : la
 *   touche de suspension temporaire) : groupe actif → la piste seule ; groupe
 *   inactif → tout le groupe.
 * - Une piste peut être dans plusieurs groupes (Track.groupIds, dérivé).
 *   Les VCA prennent leurs membres par groupe (Track.vcaGroupId).
 *
 * Module pur (sauf le petit store partagé en bas) : testable tel quel.
 */

export type GroupKind = 'edit' | 'mix' | 'both';
export type MixAttr = 'volume' | 'mute' | 'solo' | 'pan' | 'sends' | 'automation';

export interface GroupSettings {
  /** Tous les groupes suspendus (Pro Tools : Suspend All Groups). */
  suspended?: boolean;
  /** Groupe <TOUT> actif (Pro Tools : groupe <ALL>, inactif par défaut). */
  allActive?: boolean;
}

/** Identifiant du groupe virtuel <TOUT> (jamais rangé dans trackGroups). */
export const ALL_GROUP_ID = '__tout__';
export const ALL_GROUP_NAME = '<TOUT>';

export const GROUP_KIND_LABEL: Record<GroupKind, string> = { edit: 'Édition', mix: 'Mix', both: 'Édition et mix' };
export const GROUP_KIND_HINT: Record<GroupKind, string> = {
  edit: 'Pro Tools « Edit » : sélection, coupe, rognage, fondus, nudge et déplacements faits ensemble',
  mix: 'Pro Tools « Mix » : volume, muet, solo… liés dans la console',
  both: 'Pro Tools « Edit and Mix » : l’édition ET le mix liés',
};
export const MIX_ATTR_LABEL: Record<MixAttr, { short: string; label: string; pt: string }> = {
  volume: { short: 'Vol', label: 'Volume (relatif)', pt: 'Main Volume' },
  mute: { short: 'M', label: 'Muet', pt: 'Main Mute' },
  solo: { short: 'S', label: 'Solo', pt: 'Solo' },
  pan: { short: 'Pan', label: 'Panoramique (relatif)', pt: 'Pan' },
  sends: { short: 'Env', label: 'Envois (niveau relatif, muet)', pt: 'Send Level / Send Mute' },
  automation: { short: 'Auto', label: 'Mode d’automation', pt: 'Automation Mode' },
};
export const MIX_ATTRS: MixAttr[] = ['volume', 'mute', 'solo', 'pan', 'sends', 'automation'];

const FIELD: Record<MixAttr, keyof TrackGroup> = {
  volume: 'linkedVolume', mute: 'linkedMute', solo: 'linkedSolo', pan: 'linkedPan', sends: 'linkedSends', automation: 'linkedAutomation',
};

export const GROUP_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'];

export const groupKind = (g: Pick<TrackGroup, 'kind'>): GroupKind => g.kind || 'mix';
export const linksEdit = (g: Pick<TrackGroup, 'kind'>): boolean => groupKind(g) !== 'mix';
export const linksMix = (g: Pick<TrackGroup, 'kind'>): boolean => groupKind(g) !== 'edit';
export const isGroupOn = (g: Pick<TrackGroup, 'isActive'>): boolean => g.isActive !== false;
export const hasAttr = (g: TrackGroup, a: MixAttr): boolean => !!g[FIELD[a]];
export const attrPatch = (a: MixAttr, on: boolean): Partial<TrackGroup> => ({ [FIELD[a]]: on } as Partial<TrackGroup>);

/** Piste qu'on peut grouper : ni le master, ni un VCA, ni un dossier simple. */
export const groupable = (t: Track): boolean => t.id !== 'master' && !t.isVca && t.folder?.kind !== 'basic';
/** Piste éditable par un groupe d'édition : clips (audio, MIDI, sampler), visible et active. */
const editable = (t: Track): boolean =>
  groupable(t) && !t.isHidden && !t.isInactive && (t.type === TrackType.AUDIO || t.type === TrackType.MIDI || t.type === TrackType.SAMPLER);

export interface GroupCtx {
  groups: TrackGroup[];
  settings?: GroupSettings;
  /** Pistes dans l'ordre affiché. */
  tracks: Track[];
}

/** Le groupe virtuel <TOUT> : toutes les pistes groupables, édition et mix (volume, muet, solo). */
export function allGroup(tracks: Track[], settings?: GroupSettings): TrackGroup {
  return {
    id: ALL_GROUP_ID, name: ALL_GROUP_NAME, color: '#94a3b8', trackIds: tracks.filter(groupable).map(t => t.id), isCollapsed: false,
    kind: 'both', isActive: !!settings?.allActive, linkedVolume: true, linkedMute: true, linkedSolo: true, linkedPan: false,
  };
}

/** Groupes de la liste (Groups List) : <TOUT> en tête, puis ceux du projet. */
export const listGroups = (ctx: GroupCtx): TrackGroup[] => [allGroup(ctx.tracks, ctx.settings), ...(ctx.groups || [])];

/** Actif pour ce geste ? Suspension globale, puis inversion (Maj+Ctrl). */
export function effectiveOn(g: TrackGroup, settings: GroupSettings | undefined, invert = false): boolean {
  const on = settings?.suspended ? false : isGroupOn(g);
  // <TOUT> : l'inversion le coupe mais ne l'allume jamais (sinon Maj+Ctrl éditerait tout le morceau).
  if (g.id === ALL_GROUP_ID) return invert ? false : on;
  return invert ? !on : on;
}

const groupsOf = (trackId: string, ctx: GroupCtx): TrackGroup[] => listGroups(ctx).filter(g => g.trackIds.includes(trackId));

/**
 * Pistes touchées par un geste d'édition parti de `trackIds` : elles-mêmes, plus
 * les membres (visibles, actifs) des groupes d'édition qui les contiennent.
 * Ordre d'affichage. `invert` : Maj+Ctrl tenues pendant le geste.
 */
export function expandEditTracks(trackIds: string[], ctx: GroupCtx, invert = false): string[] {
  const want = new Set(trackIds);
  for (const id of trackIds) {
    for (const g of groupsOf(id, ctx)) {
      if (!linksEdit(g) || !effectiveOn(g, ctx.settings, invert)) continue;
      g.trackIds.forEach(m => want.add(m));
    }
  }
  if (want.size === trackIds.length) return [...trackIds];
  const byId = new Map(ctx.tracks.map(t => [t.id, t]));
  return ctx.tracks.filter(t => want.has(t.id) && (trackIds.includes(t.id) || editable(byId.get(t.id)!))).map(t => t.id);
}

/** Recouvrement de deux intervalles (s). */
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Clips « jumeaux » d'un clip sur les autres pistes du groupe d'édition : ceux
 * qui le recouvrent sur au moins la moitié de la plus courte des deux durées
 * (une double calée sur la lead, des backs de la même phrase). Pro Tools :
 * un clic au Grabber sélectionne la même zone sur tout le groupe.
 */
export function groupClipMates(trackId: string, clip: Pick<Clip, 'id' | 'start' | 'duration'>, ctx: GroupCtx, invert = false): { trackId: string; clip: Clip }[] {
  const ids = expandEditTracks([trackId], ctx, invert).filter(id => id !== trackId);
  const out: { trackId: string; clip: Clip }[] = [];
  const c0 = clip.start, c1 = clip.start + clip.duration;
  for (const id of ids) {
    const t = ctx.tracks.find(x => x.id === id);
    if (!t) continue;
    for (const c of t.clips || []) {
      const ov = overlap(c0, c1, c.start, c.start + c.duration);
      if (ov > 0 && ov >= 0.5 * Math.min(clip.duration, c.duration) - 1e-6) out.push({ trackId: id, clip: c });
    }
  }
  return out;
}

const clampVol = (v: number) => Math.max(0, Math.min(1.5, v));
const clampPan = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Mise à jour d'une piste par un geste de mix : autres pistes à modifier selon
 * les groupes de mix actifs (attributs cochés). Volume et pan RELATIFS (comme
 * Pro Tools : chaque fader garde son écart), muet / solo / mode d'automation
 * recopiés, envois vers la même destination : niveau relatif et muet recopié.
 */
export function mixLinkUpdates(prev: Track, next: Track, ctx: GroupCtx, invert = false): Track[] {
  const changed: MixAttr[] = [];
  if (prev.volume !== next.volume) changed.push('volume');
  if (!!prev.isMuted !== !!next.isMuted) changed.push('mute');
  if (!!prev.isSolo !== !!next.isSolo) changed.push('solo');
  if (prev.pan !== next.pan) changed.push('pan');
  if (prev.sends !== next.sends && JSON.stringify(prev.sends || []) !== JSON.stringify(next.sends || [])) changed.push('sends');
  if ((prev.automationMode || 'read') !== (next.automationMode || 'read')) changed.push('automation');
  if (!changed.length) return [];
  const out = new Map<string, Track>();
  const cur = (id: string) => out.get(id) || ctx.tracks.find(t => t.id === id);
  for (const g of groupsOf(prev.id, ctx)) {
    if (!linksMix(g) || !effectiveOn(g, ctx.settings, invert)) continue;
    const attrs = changed.filter(a => hasAttr(g, a));
    if (!attrs.length) continue;
    for (const mid of g.trackIds) {
      if (mid === prev.id) continue;
      const t0 = cur(mid);
      if (!t0 || !groupable(t0)) continue;
      let t = t0;
      for (const a of attrs) {
        if (a === 'volume') {
          if (prev.volume > 1e-9) t = { ...t, volume: clampVol(t.volume * (next.volume / prev.volume)) };
          else t = { ...t, volume: clampVol(next.volume) };
        } else if (a === 'mute') t = { ...t, isMuted: !!next.isMuted };
        else if (a === 'solo') t = { ...t, isSolo: !!next.isSolo };
        else if (a === 'pan') t = { ...t, pan: clampPan(t.pan + (next.pan - prev.pan)) };
        else if (a === 'automation') t = { ...t, automationMode: next.automationMode };
        else if (a === 'sends') {
          const before = new Map((prev.sends || []).map(s => [s.id, s]));
          const after = new Map((next.sends || []).map(s => [s.id, s]));
          let touched = false;
          const sends = (t.sends || []).map(s => {
            const b = before.get(s.id), n = after.get(s.id);
            if (!b || !n) return s;
            let level = s.level;
            if (n.level !== b.level) { level = b.level > 1e-9 ? Math.max(0, Math.min(1.5, s.level * (n.level / b.level))) : n.level; }
            const isEnabled = n.isEnabled !== b.isEnabled ? n.isEnabled : s.isEnabled;
            if (level === s.level && isEnabled === s.isEnabled) return s;
            touched = true;
            return { ...s, level, isEnabled };
          });
          if (touched) t = { ...t, sends };
        }
      }
      if (t !== t0) out.set(mid, t);
    }
  }
  return [...out.values()];
}

// ─── Groupes : création, modification (logique pure sur pistes + groupes) ──────

export interface GroupsState { tracks: Track[]; trackGroups: TrackGroup[]; groupSettings?: GroupSettings }

/**
 * Recalcule Track.groupId (1er groupe) et Track.groupIds (tous, s'il y en a
 * plusieurs) depuis TrackGroup.trackIds. Les pistes inchangées gardent leur objet.
 */
export function syncGroupFields(tracks: Track[], groups: TrackGroup[]): Track[] {
  let changed = false;
  const out = tracks.map(t => {
    const ids = groups.filter(g => g.trackIds.includes(t.id)).map(g => g.id);
    const gid = ids[0];
    const many = ids.length > 1 ? ids : undefined;
    if (t.groupId === gid && JSON.stringify(t.groupIds) === JSON.stringify(many)) return t;
    changed = true;
    const n: Track = { ...t };
    if (gid) n.groupId = gid; else delete n.groupId;
    if (many) n.groupIds = many; else delete n.groupIds;
    return n;
  });
  return changed ? out : tracks;
}

/** La piste est-elle dans ce groupe (VCA : membres par groupe) ? */
export const inGroup = (t: Pick<Track, 'groupId' | 'groupIds'>, groupId: string): boolean =>
  t.groupId === groupId || !!t.groupIds?.includes(groupId);

let gidSeq = 0;
export const newGroupId = () => `grp-${Date.now().toString(36)}${(gidSeq++).toString(36)}`;

export interface NewGroup {
  name?: string;
  kind?: GroupKind;
  trackIds: string[];
  color?: string;
  attrs?: Partial<Record<MixAttr, boolean>>;
  id?: string;
  deduced?: boolean;
}

/** Nom libre « Groupe N ». */
const freeName = (groups: TrackGroup[]) => {
  let n = groups.length + 1;
  while (groups.some(g => g.name === `Groupe ${n}`)) n++;
  return `Groupe ${n}`;
};

/** Fabrique un groupe (Pro Tools : Ctrl+G, « Édition et mix » par défaut, volume / muet / solo liés). */
export function makeGroup(groups: TrackGroup[], o: NewGroup): TrackGroup {
  const kind = o.kind || 'both';
  const a = { volume: true, mute: true, solo: true, pan: false, sends: false, automation: false, ...(o.attrs || {}) };
  return {
    id: o.id || newGroupId(), name: (o.name || '').trim() || freeName(groups),
    color: o.color || GROUP_COLORS[groups.length % GROUP_COLORS.length],
    trackIds: [...new Set(o.trackIds)], isCollapsed: false, kind, isActive: true,
    linkedVolume: a.volume, linkedMute: a.mute, linkedSolo: a.solo, linkedPan: a.pan, linkedSends: a.sends, linkedAutomation: a.automation,
    ...(o.deduced ? { deduced: true } : {}),
  };
}

export function createGroup<S extends GroupsState>(s: S, o: NewGroup): S & { createdId: string } {
  const g = makeGroup(s.trackGroups || [], o);
  const trackGroups = [...(s.trackGroups || []), g];
  return { ...s, trackGroups, tracks: syncGroupFields(s.tracks, trackGroups), createdId: g.id };
}

export function updateGroup<S extends GroupsState>(s: S, id: string, patch: Partial<TrackGroup>): S {
  if (id === ALL_GROUP_ID) {
    if (patch.isActive === undefined) return s;
    return { ...s, groupSettings: { ...(s.groupSettings || {}), allActive: !!patch.isActive } };
  }
  const trackGroups = (s.trackGroups || []).map(g => (g.id === id ? { ...g, ...patch, id: g.id } : g));
  return { ...s, trackGroups, tracks: patch.trackIds ? syncGroupFields(s.tracks, trackGroups) : s.tracks };
}

/** Supprime un groupe ; un VCA qui prenait ses membres par ce groupe n'en a plus. */
export function deleteGroup<S extends GroupsState>(s: S, id: string): S {
  const trackGroups = (s.trackGroups || []).filter(g => g.id !== id);
  const tracks = syncGroupFields(s.tracks, trackGroups).map(t => (t.vcaGroupId === id ? (() => { const n = { ...t }; delete n.vcaGroupId; return n; })() : t));
  return { ...s, trackGroups, tracks };
}

/** Active / désactive un groupe (Pro Tools : clic sur son nom dans la Groups List). */
export function toggleGroup<S extends GroupsState>(s: S, id: string): S {
  if (id === ALL_GROUP_ID) return { ...s, groupSettings: { ...(s.groupSettings || {}), allActive: !s.groupSettings?.allActive } };
  const g = (s.trackGroups || []).find(x => x.id === id);
  return g ? updateGroup(s, id, { isActive: !isGroupOn(g) }) : s;
}

export function setSuspended<S extends GroupsState>(s: S, suspended: boolean): S {
  return { ...s, groupSettings: { ...(s.groupSettings || {}), suspended } };
}

// ─── Collaboration : les groupes voyagent en UNE opération ─────────────────────

export interface GroupsOp { groups: TrackGroup[]; settings: GroupSettings }

const KINDS: GroupKind[] = ['edit', 'mix', 'both'];
const str = (v: unknown, max = 80) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Groupe reçu vérifié champ par champ (rien d'autre ne passe). */
export function sanitizeGroup(raw: unknown): TrackGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  if (!id || id === ALL_GROUP_ID) return null;
  const color = /^#[0-9a-f]{3,8}$/i.test(str(r.color, 9)) ? str(r.color, 9) : '#94a3b8';
  const trackIds = Array.isArray(r.trackIds) ? [...new Set(r.trackIds.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 120)))].slice(0, 400) : [];
  const g: TrackGroup = {
    id, name: str(r.name) || 'Groupe', color, trackIds, isCollapsed: !!r.isCollapsed,
    linkedVolume: !!r.linkedVolume, linkedMute: !!r.linkedMute, linkedSolo: !!r.linkedSolo, linkedPan: !!r.linkedPan,
  };
  if (KINDS.includes(r.kind as GroupKind)) g.kind = r.kind as GroupKind;
  if (r.isActive === false) g.isActive = false;
  if (r.linkedSends) g.linkedSends = true;
  if (r.linkedAutomation) g.linkedAutomation = true;
  if (r.deduced) g.deduced = true;
  return g;
}

export const groupsOpOf = (s: Pick<GroupsState, 'trackGroups' | 'groupSettings'>): GroupsOp => ({
  groups: (s.trackGroups || []).map(g => sanitizeGroup(g)).filter((g): g is TrackGroup => !!g),
  settings: { ...(s.groupSettings?.suspended ? { suspended: true } : {}), ...(s.groupSettings?.allActive ? { allActive: true } : {}) },
});

export function sanitizeGroupsOp(raw: unknown): GroupsOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.groups)) return null;
  const seen = new Set<string>();
  const groups = r.groups.slice(0, 200).map(sanitizeGroup).filter((g): g is TrackGroup => !!g && !seen.has(g.id) && !!seen.add(g.id));
  const st = (r.settings && typeof r.settings === 'object' ? r.settings : {}) as Record<string, unknown>;
  return { groups, settings: { ...(st.suspended ? { suspended: true } : {}), ...(st.allActive ? { allActive: true } : {}) } };
}

/** Empreinte des groupes (rien n'est renvoyé en écho). */
export const groupsSig = (s: Pick<GroupsState, 'trackGroups' | 'groupSettings'>): string => JSON.stringify(groupsOpOf(s));

/** Applique les groupes reçus : liste, réglages, champs dérivés des pistes. */
export function applyGroupsOp<S extends GroupsState>(s: S, op: GroupsOp): S {
  const ids = new Set(s.tracks.map(t => t.id));
  const trackGroups = op.groups.map(g => ({ ...g, trackIds: g.trackIds.filter(id => ids.has(id)) }));
  return { ...s, trackGroups, groupSettings: op.settings, tracks: syncGroupFields(s.tracks, trackGroups) };
}

// ─── Modèle (fiche « spec ») : les groupes Pro Tools deviennent de vrais groupes ──

export interface SpecGroup {
  name: string;
  kind?: GroupKind;
  /** Noms des pistes membres (comme dans Pro Tools). */
  members: string[];
  /** Attributs de mix liés (par défaut volume, muet, solo). */
  attrs?: Partial<Record<MixAttr, boolean>>;
  active?: boolean;
  color?: string;
  /** Membres déduits (fenêtre des groupes pas relevée). */
  deduced?: boolean;
  note?: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Groupes d'une fiche de modèle → TrackGroup (membres retrouvés par leur nom,
 * espaces de fin tolérés). `idOfName` : nom de piste → id.
 */
export function groupsFromSpec(spec: SpecGroup[] | undefined, idOfName: (name: string) => string | undefined): TrackGroup[] {
  const out: TrackGroup[] = [];
  for (const sg of spec || []) {
    if (!sg || typeof sg.name !== 'string') continue;
    const trackIds = (sg.members || []).map(n => idOfName(n)).filter((x): x is string => !!x);
    const g = makeGroup(out, { name: sg.name.trim(), kind: sg.kind || 'both', trackIds, color: sg.color, attrs: sg.attrs, deduced: sg.deduced,
      id: `grp-${norm(sg.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` });
    if (sg.active === false) g.isActive = false;
    out.push(g);
  }
  return out;
}
export const groupNameKey = norm;

// ─── Store partagé (Arrangement, liste des groupes, commandes) ─────────────────

let ctxState: GroupCtx = { groups: [], settings: {}, tracks: [] };
let invertHeld = false;
const listeners = new Set<() => void>();

/** Groupes du projet ouvert, lus hors de React par l'arrangement et les commandes. */
export const editGroupsStore = {
  get: (): GroupCtx => ctxState,
  set(next: GroupCtx) {
    if (next.groups === ctxState.groups && next.settings === ctxState.settings && next.tracks === ctxState.tracks) return;
    ctxState = next;
    listeners.forEach(l => l());
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Maj+Ctrl tenues en ce moment (inversion des groupes pendant le geste). */
  invertHeld: () => invertHeld,
  setInvertHeld(v: boolean) { invertHeld = v; },
};
export const useEditGroups = (): GroupCtx => useSyncExternalStore(editGroupsStore.subscribe, editGroupsStore.get, editGroupsStore.get);

/** Maj+Ctrl (ou Maj+Cmd) d'un événement souris / clavier. */
export const invertFromEvent = (e?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } | null): boolean =>
  !!e && !!e.shiftKey && !!(e.ctrlKey || e.metaKey);

/** Message court : combien de pistes un geste a touchées par les groupes. */
export const groupGestureNote = (n: number, inverted: boolean): string =>
  inverted ? 'Maj+Ctrl : groupes inversés pour ce geste' : n > 1 ? `Groupe d’édition : ${n} pistes` : '';

// ─── Gestes sur les clips jumeaux (rognage, fondus, gain) ──────────────────────

/** Début rogné du même décalage (le son ne glisse pas : l'offset suit). */
export function mateTrimStart(c: Clip, delta: number): Partial<Clip> {
  const maxStart = c.start + c.duration - 0.05;
  const minStart = c.start - (c.offset || 0);
  const start = Math.min(maxStart, Math.max(0, Math.max(minStart, c.start + delta)));
  const d = start - c.start;
  return { start, offset: Math.max(0, (c.offset || 0) + d), duration: Math.max(0.05, c.duration - d), fadeIn: Math.min(c.fadeIn || 0, Math.max(0, c.duration - d)) };
}
/** Fin rognée du même décalage. */
export function mateTrimEnd(c: Clip, delta: number): Partial<Clip> {
  const duration = Math.max(0.05, c.duration + delta);
  return { duration, fadeOut: Math.min(c.fadeOut || 0, duration) };
}
/** Même fondu (borné à la durée du clip). */
export const mateFade = (c: Clip, which: 'in' | 'out', len: number): Partial<Clip> =>
  (which === 'in' ? { fadeIn: Math.max(0, Math.min(c.duration, len)) } : { fadeOut: Math.max(0, Math.min(c.duration, len)) });
/** Gain du clip relatif (chaque clip garde son écart). */
export const mateGain = (c: Clip, ratio: number): Partial<Clip> => ({ gain: Math.max(0, Math.min(4, (c.gain ?? 1) * ratio)) });

/** Clip jumeau photographié au début du geste (avec les clips de sa piste, pour le Shuffle). */
export interface MateSnap { trackId: string; clip: Clip; trackClips: Clip[] }
export function snapMates(trackId: string, clip: Clip, ctx: GroupCtx, invert: boolean): MateSnap[] {
  return groupClipMates(trackId, clip, ctx, invert).map(m => ({
    trackId: m.trackId, clip: { ...m.clip }, trackClips: (ctx.tracks.find(t => t.id === m.trackId)?.clips || []).map(c => ({ ...c })),
  }));
}
