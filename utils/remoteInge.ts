import {
  AutomationPoint, Clip, FreezeRef, PluginInstance, RemoteIngePhase, RemoteTrackInfo, SendFreeze, Track, TrackSend, TrackType,
} from '../types';
import { classifyPlugin } from './vstKnowledge';
import { freezeIndex, isFrozenBus, isTrackFrozen, isVst, pluginsSignature } from './freeze';
import { makeFreezeBase, PRE_VOLUME } from './preFxEdits';
import type { KnownPlugin, MixPlan } from './mixPlanner';

/**
 * Mode « Ingé à distance (ses propres VST) ».
 *
 * L'artiste et l'ingé gardent CHACUN leur session, reliées par un lien (une
 * session en ligne qui sert de boîte aux lettres, voir services/RemoteInge).
 *  1. L'artiste envoie une piste : son audio BRUT + ses éditions (clips, fondus,
 *     gains, volume avant effets). Chez l'ingé, elle arrive dans SA session.
 *  2. L'ingé la traite avec ses VST (insert) et ses bus d'envoi, la gèle (gel
 *     existant : utils/freeze, services/VstFreeze) et l'envoie à l'artiste :
 *     rendu gelé de la piste + rendus par source des bus VST.
 *  3. Chez l'artiste, ces rendus se posent sur SES clips (ancrages du gel) :
 *     il continue d'éditer, la lecture suit ; la prise brute reste là.
 *  4. Une nouvelle édition de l'artiste repart toute seule ; l'ingé (pont VST
 *     connecté) dégèle, rejoue les éditions AVANT ses effets (c'est l'audio sec
 *     édité qui repasse dans la chaîne), regèle et renvoie.
 *
 * Règle : les effets temporels (reverb, délai, écho) sont TOUJOURS en envoi,
 * jamais en insert d'une piste échangée (sinon leur queue serait figée dans le
 * rendu et coupée net par une coupe de l'artiste). Pendant l'enregistrement,
 * seuls ceux de NOVA (que l'artiste a aussi) sont permis : leurs réglages sont
 * synchronisés et l'artiste les entend en direct, comme l'ingé.
 *
 * Ce module est pur (aucun audio, aucun réseau) : testable tel quel.
 */

// --- Empreinte -----------------------------------------------------------------------

/** FNV-1a 32 bits d'un JSON (détecter un changement, pas un usage crypto). */
export const hashOf = (v: unknown): string => {
  const s = JSON.stringify(v) ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}:${h.toString(16)}`;
};

// --- Effets temporels -------------------------------------------------------------------

const TEMPORAL_RE = /reverb|verb|valhalla|\bhall\b|\bplate\b|\broom\b|chamber|shimmer|echo|écho|delay|\bdly\b|echoboy|timeless|replika|tape ?echo/i;

const pluginLabel = (p: PluginInstance): string =>
  [p.params?.name, p.params?.pluginName, p.name].filter(Boolean).join(' ');

/**
 * Effet temporel (reverb, délai, écho) : natifs REVERB / DELAY de NOVA, et
 * plugins VST de catégorie Reverb / Delay (base de connaissance VST, sinon
 * reconnus à leur nom). categoryOf : catégorie connue (base de connaissance).
 */
export function isTemporalPlugin(p: PluginInstance, categoryOf?: (p: PluginInstance) => string | undefined): boolean {
  if (p.type === 'REVERB' || p.type === 'DELAY') return true;
  if (!isVst(p)) return false;
  const known = categoryOf?.(p) || (typeof p.params?.category === 'string' ? p.params.category : undefined);
  if (known) return known === 'reverb' || known === 'delay';
  const label = pluginLabel(p);
  const cls = classifyPlugin(label);
  if (cls.category === 'reverb' || cls.category === 'delay') return true;
  // Reconnu à son nom comme autre chose (compresseur, « Trackspacer »…) : pas temporel.
  if (cls.by === 'name') return false;
  return TEMPORAL_RE.test(label);
}

export const isBusTrack = (t: Track): boolean =>
  (t.type === TrackType.SEND || t.type === TrackType.BUS) && t.id !== 'master';

/** Bus / pistes d'envoi alimentés par la piste (envois actifs, sortie routée vers un bus). */
export const busesFedBy = (t: Track, tracks: Track[]): Track[] => {
  const ids = new Set<string>();
  (t.sends || []).forEach(s => { if (s.isEnabled && s.level > 0) ids.add(s.id); });
  if (t.outputTrackId && t.outputTrackId !== 'master') ids.add(t.outputTrackId);
  return tracks.filter(b => b.id !== t.id && ids.has(b.id) && isBusTrack(b));
};

export const REC_LOCK_MESSAGE =
  "Pendant l'enregistrement, seules les reverbs et délais de NOVA sont permis : l'artiste les a aussi et les entend en direct, exactement comme toi. Tu mettras ta reverb VST au mix (« Enregistrement terminé : passer au mix »).";

export const insertMessage = (name: string): string =>
  `« ${name} » est un effet temporel (reverb, délai, écho) : en mode Ingé à distance, il va sur une piste d'envoi, jamais en insert. Sinon sa queue serait figée dans le rendu et coupée net quand l'artiste coupe ou remplace un passage.`;

export interface RemoteRuleIssue {
  code: 'temporal-insert' | 'vst-temporal-recording';
  trackId: string;
  trackName: string;
  pluginId: string;
  pluginName: string;
  message: string;
  /** Réparation en un clic : déplacer en envoi, ou mettre en pause (VST pendant l'enregistrement). */
  fix: 'move-to-send' | 'disable';
}

/** Ce qui empêche d'envoyer ces pistes à l'artiste (règle des envois, verrou d'enregistrement). */
export function remoteRuleIssues(
  tracks: Track[], remoteTrackIds: string[], phase: RemoteIngePhase,
  categoryOf?: (p: PluginInstance) => string | undefined,
): RemoteRuleIssue[] {
  const out: RemoteRuleIssue[] = [];
  const seenBus = new Set<string>();
  for (const id of remoteTrackIds) {
    const t = tracks.find(x => x.id === id);
    if (!t) continue;
    for (const p of t.plugins || []) {
      if (!p.isEnabled || !isTemporalPlugin(p, categoryOf)) continue;
      out.push({ code: 'temporal-insert', trackId: t.id, trackName: t.name, pluginId: p.id, pluginName: p.params?.name || p.name, message: insertMessage(p.params?.name || p.name), fix: 'move-to-send' });
    }
    if (phase !== 'recording') continue;
    for (const b of busesFedBy(t, tracks)) {
      if (seenBus.has(b.id)) continue;
      seenBus.add(b.id);
      for (const p of b.plugins || []) {
        if (!p.isEnabled || !isVst(p) || !isTemporalPlugin(p, categoryOf)) continue;
        out.push({ code: 'vst-temporal-recording', trackId: b.id, trackName: b.name, pluginId: p.id, pluginName: p.params?.name || p.name, message: REC_LOCK_MESSAGE, fix: 'disable' });
      }
    }
  }
  return out;
}

export type PluginAddCheck =
  | { ok: true }
  | { ok: false; code: 'vst-temporal-recording' | 'temporal-insert'; message: string };

/**
 * Ajout d'un effet dans la session de l'ingé (mode Ingé à distance).
 *  - pendant l'enregistrement : reverb / délai VST refusés partout ;
 *  - effet temporel forcé en insert sur une piste échangée : refusé (il ira en envoi).
 */
export function checkPluginAdd(
  o: { phase: RemoteIngePhase; isRemoteTrack: boolean; forceInsert?: boolean },
  p: PluginInstance, categoryOf?: (p: PluginInstance) => string | undefined,
): PluginAddCheck {
  if (!isTemporalPlugin(p, categoryOf)) return { ok: true };
  if (o.phase === 'recording' && isVst(p)) return { ok: false, code: 'vst-temporal-recording', message: REC_LOCK_MESSAGE };
  if (o.isRemoteTrack && o.forceInsert) return { ok: false, code: 'temporal-insert', message: insertMessage(p.params?.name || p.name) };
  return { ok: true };
}

let busSeq = 0;
/**
 * « Déplacer en envoi » : l'effet temporel quitte l'insert de la piste et part
 * sur une nouvelle piste d'envoi (mêmes réglages, 100 % mouillé), alimentée par
 * un envoi de la piste (niveau = son ancien dosage). Mutation (brouillon Immer).
 */
export function moveInsertToSend(tracks: Track[], trackId: string, pluginId: string, now = Date.now()): { busId: string; busName: string; level: number } | null {
  const t = tracks.find(x => x.id === trackId);
  const idx = t ? (t.plugins || []).findIndex(p => p.id === pluginId) : -1;
  if (!t || idx < 0) return null;
  const p = t.plugins[idx];
  const label = String(p.params?.name || p.name || (p.type === 'DELAY' ? 'Délai' : 'Reverb'));
  const busId = `send-ri-${p.type.toLowerCase()}-${now.toString(36)}${(busSeq++).toString(36)}`;
  const wet = typeof p.params?.mix === 'number' ? p.params.mix : null;
  const level = Math.round(Math.max(0.05, Math.min(1, wet ?? 0.32)) * 100) / 100;
  const isDelay = p.type === 'DELAY' || /delay|echo|écho/i.test(label);
  const bus: Track = {
    id: busId, name: `${label} (envoi)`.slice(0, 32), type: TrackType.SEND, color: isDelay ? '#00f2ff' : '#10b981',
    isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master',
    sends: [], clips: [], automationLanes: [], totalLatency: 0,
    plugins: [{ ...p, params: { ...(p.params || {}), ...(isVst(p) ? {} : { mix: 1 }) } }],
  };
  t.plugins.splice(idx, 1);
  const at = tracks.findIndex(x => x.id === 'master');
  tracks.splice(at >= 0 ? at : tracks.length, 0, bus);
  t.sends = [...(t.sends || []).filter(s => s.id !== busId), { id: busId, level, isEnabled: true }];
  return { busId, busName: bus.name, level };
}

// --- Envoi de l'artiste : audio brut + éditions ---------------------------------------

/** Clip tel qu'il voyage (audio brut + éditions), sans rendu ni ancrage. */
export const rawClip = (c: Clip): Clip => {
  const { buffer: _b, audioRef: _a, freezeRef: _f, isFreezeSlice: _s, ...rest } = c as Clip & { buffer?: AudioBuffer };
  return rest as Clip;
};

const editableClips = (t: Track): Clip[] =>
  (t.clips || []).filter(c => !c.isFreezeSlice && !c.notes).map(rawClip).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));

const preVolumePoints = (t: Track): AutomationPoint[] =>
  ((t.automationLanes || []).find(l => l.parameterName === PRE_VOLUME)?.points || []).map(p => ({ id: p.id, time: p.time, value: p.value, ...(p.curveType ? { curveType: p.curveType } : {}) }));

/**
 * Empreinte de ce que l'ingé doit retraiter : audio brut + éditions (clips,
 * fondus, gains, mute, volume avant effets). Ni les rendus reçus de l'ingé, ni
 * le fader (après les effets) n'y entrent : appliquer un retour ne renvoie rien.
 */
export const rawSignature = (t: Track): string => hashOf({ c: editableClips(t), pv: preVolumePoints(t) });

export interface RemoteSendPayload {
  /** Piste chez l'artiste. */
  trackId: string;
  v: number;
  sig: string;
  name: string;
  color: string;
  slot?: string;
  clips: Clip[];
  preVolume?: AutomationPoint[];
}

export const buildSendPayload = (t: Track, v: number): RemoteSendPayload => {
  const pv = preVolumePoints(t);
  return {
    trackId: t.id, v, sig: rawSignature(t), name: t.name, color: t.color,
    ...(t.remote?.slot ? { slot: t.remote.slot } : {}),
    clips: editableClips(t), ...(pv.length ? { preVolume: pv } : {}),
  };
};

export const sendBufferIds = (p: RemoteSendPayload): string[] =>
  Array.from(new Set(p.clips.map(c => c.bufferId).filter(Boolean) as string[]));

/** Artiste : y a-t-il quelque chose de nouveau à envoyer pour cette piste ? */
export const artistNeedsSend = (t: Track): boolean =>
  !!t.remote && (t.clips || []).some(c => !!c.bufferId) && rawSignature(t) !== t.remote.sentSig;

/** Artiste : marque la piste comme envoyée (version suivante). Mutation. */
export function markSent(t: Track, sig: string): number {
  const v = (t.remote?.sentV || 0) + 1;
  t.remote = { ...(t.remote || { peerTrackId: t.id }), sentV: v, sentSig: sig };
  return v;
}

// --- Chez l'ingé : réception -----------------------------------------------------------

/** Version reçue : nouvelle, doublon (même contenu), ou plus ancienne que la dernière. */
export function acceptSend(info: RemoteTrackInfo | undefined, p: Pick<RemoteSendPayload, 'v' | 'sig'>): 'new' | 'dup' | 'old' {
  if (!info) return 'new';
  if (info.recvSig && p.sig === info.recvSig) return 'dup';
  if (typeof info.recvV === 'number' && p.v <= info.recvV) return 'old';
  return 'new';
}

export const SLOT_LABEL: Record<string, string> = { lead: 'Lead', back: 'Backs', adlib: 'Ad-libs', harmony: 'Harmonies' };

/**
 * Pose une version de l'artiste dans la session de l'ingé (brouillon Immer) :
 * piste créée la première fois ; ensuite ses clips sont remplacés par l'audio
 * brut édité et la piste est DÉGELÉE (sa vraie chaîne d'effets repasse sur
 * l'audio sec : les éditions passent avant les effets). Ses effets et ses
 * envois (le travail de l'ingé) ne bougent pas.
 */
export function applySendOnEngineer(tracks: Track[], p: RemoteSendPayload): { trackId: string; created: boolean } {
  let t = tracks.find(x => x.remote?.peerTrackId === p.trackId);
  let created = false;
  if (!t) {
    let id = p.trackId;
    for (let k = 2; tracks.some(x => x.id === id); k++) id = `${p.trackId}-ri${k > 2 ? k : ''}`;
    const slot = p.slot && SLOT_LABEL[p.slot];
    t = {
      id, name: (slot && !p.name.toUpperCase().includes(slot.toUpperCase()) ? `${p.name} · ${slot}` : p.name).slice(0, 40),
      type: TrackType.AUDIO, color: p.color || '#22d3ee',
      isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
      outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
      collabOwner: 'artist',
      remote: { peerTrackId: p.trackId },
    };
    const at = tracks.findIndex(x => isBusTrack(x) || x.id === 'master');
    tracks.splice(at >= 0 ? at : tracks.length, 0, t);
    created = true;
  }
  t.clips = p.clips.map(c => ({ ...c }));
  const lanes = (t.automationLanes || []).filter(l => l.parameterName !== PRE_VOLUME);
  if (p.preVolume?.length) {
    lanes.push({ id: `prevol-${t.id}`, parameterName: PRE_VOLUME, points: p.preVolume.map(x => ({ ...x })), color: t.color, isExpanded: false, min: 0, max: 1.5 });
  }
  t.automationLanes = lanes;
  // Dégel : le rendu reste en cache (périmé), la chaîne réelle rejoue l'audio sec.
  t.isFrozen = false;
  delete t.frozenAuto;
  t.remote = { ...(t.remote || { peerTrackId: p.trackId }), peerTrackId: p.trackId, recvV: p.v, recvSig: p.sig, ...(p.slot ? { slot: p.slot } : {}) };
  return { trackId: t.id, created };
}

/** Ingé : une version reçue attend son retraitement automatique (renvoi auto activé). */
export const needsProcessing = (t: Track): boolean =>
  !!t.remote?.auto && (t.remote.recvV ?? 0) > (t.remote.returnedV ?? 0);

// --- Retour de l'ingé : rendus gelés -------------------------------------------------------

/** Effet tel qu'il voyage chez l'artiste : un VST n'est qu'un nom (son son est dans le rendu). */
export const stripPluginForWire = (p: PluginInstance): PluginInstance => {
  if (!isVst(p)) return { ...p, params: { ...(p.params || {}) } };
  const { name, vendor, pluginName } = (p.params || {}) as Record<string, any>;
  return { ...p, params: { name: name || p.name, ...(vendor ? { vendor } : {}), ...(pluginName ? { pluginName } : {}), remoteBaked: true } };
};

const wireClip = (c: Clip): Clip => { const { buffer: _b, audioRef: _a, ...rest } = c as Clip & { buffer?: AudioBuffer }; return rest as Clip; };

export interface RemoteBusWire {
  id: string;
  name: string;
  color: string;
  volume: number;
  pan: number;
  plugins: PluginInstance[];
  /** Bus VST gelé (rendus par source sur les pistes) : son marqueur de rendu. */
  frozen?: { clip: Clip; upTo: number };
}

export interface RemoteReturnPayload {
  /** Piste chez l'artiste. */
  trackId: string;
  /** Version de l'artiste traitée. */
  forV: number;
  sig: string;
  phase: RemoteIngePhase;
  plugins: PluginInstance[];
  frozen?: { clip: Clip; upTo: number; clipIds?: string[] };
  /** Ancrage des clips rendus (id du clip, son, place dans le rendu). */
  rendered: { clipId: string; bufferId?: string; ref: FreezeRef }[];
  sends: TrackSend[];
  buses: RemoteBusWire[];
  sendFreezes: SendFreeze[];
  pan: number;
  /** Compensation de latence de la chaîne de l'ingé (affichage). */
  latencyMs?: number;
}

const busWire = (b: Track, opts: { nativeOnly?: boolean } = {}): RemoteBusWire => {
  const frozen = isFrozenBus(b);
  const plugins = (b.plugins || []).filter(p => !opts.nativeOnly || !isVst(p)).map(stripPluginForWire);
  return {
    id: b.id, name: b.name, color: b.color, volume: b.volume, pan: b.pan, plugins,
    ...(frozen && !opts.nativeOnly ? { frozen: { clip: wireClip(b.frozenClip!), upTo: freezeIndex(b) } } : {}),
  };
};

/** Ingé : retour à envoyer pour une piste reçue (rendu gelé, bus, envois). */
export function buildReturnPayload(t: Track, tracks: Track[], phase: RemoteIngePhase, latencyMs?: number): { payload: RemoteReturnPayload; bufferIds: string[] } {
  const buses = busesFedBy(t, tracks).map(b => busWire(b));
  const frozenBusIds = new Map(busesFedBy(t, tracks).filter(isFrozenBus).map(b => [b.id, b.frozenClip!.id]));
  const sendFreezes = (t.sendFreezes || [])
    .filter(sf => frozenBusIds.get(sf.busId) === sf.busRenderId)
    .map(sf => ({ ...sf, clip: wireClip(sf.clip) }));
  const plugins = (t.plugins || []).map(stripPluginForWire);
  const frozen = isTrackFrozen(t) ? { clip: wireClip(t.frozenClip!), upTo: freezeIndex(t), ...(t.frozenClipIds ? { clipIds: [...t.frozenClipIds] } : {}) } : undefined;
  const rendered = (t.clips || []).filter(c => !!c.freezeRef).map(c => ({ clipId: c.id, ...(c.bufferId ? { bufferId: c.bufferId } : {}), ref: { ...c.freezeRef! } }));
  const sends = (t.sends || []).filter(s => buses.some(b => b.id === s.id)).map(s => ({ ...s }));
  const forV = t.remote?.recvV ?? 0;
  const sig = hashOf({
    forV, f: frozen?.clip.id || null, u: frozen?.upTo ?? null, p: plugins.map(p => [p.id, p.type, p.isEnabled, isVst(p) ? null : p.params]),
    b: buses.map(b => [b.id, b.volume, b.pan, b.frozen?.clip.id || null, b.plugins.map(p => [p.id, p.isEnabled, isVst(p) ? null : p.params])]),
    s: sends, sf: sendFreezes.map(sf => sf.clip.id), pan: t.pan,
  });
  const payload: RemoteReturnPayload = {
    trackId: t.remote?.peerTrackId || t.id, forV, sig, phase, plugins, ...(frozen ? { frozen } : {}), rendered, sends, buses, sendFreezes, pan: t.pan,
    ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
  };
  const bufferIds = Array.from(new Set([
    frozen?.clip.bufferId,
    ...buses.map(b => b.frozen?.clip.bufferId),
    ...sendFreezes.map(sf => sf.clip.bufferId),
  ].filter(Boolean) as string[]));
  return { payload, bufferIds };
}

/** Ingé : ce retour n'a pas déjà été envoyé (jamais deux fois le même). */
export const shouldSendReturn = (info: RemoteTrackInfo | undefined, payloadSig: string): boolean => !info || info.returnedSig !== payloadSig;

// --- Chez l'artiste : réception du retour --------------------------------------------------

/** Les bus de l'ingé ont leur propre piste d'envoi chez l'artiste (ses bus à lui restent intacts). */
export const ARTIST_BUS_PREFIX = 'ri-';
export const artistBusId = (id: string): string => (id.startsWith(ARTIST_BUS_PREFIX) ? id : `${ARTIST_BUS_PREFIX}${id}`);

/**
 * Pose les ancrages du rendu sur les clips ACTUELS de l'artiste : même clip
 * (même id), sinon un clip issu du même son (découpé depuis) qui recouvre la
 * partie rendue. Une nouvelle prise (autre son) reste en direct jusqu'au
 * prochain retour.
 */
export function mapRenderedRefs(clips: Clip[], rendered: RemoteReturnPayload['rendered']): Map<string, FreezeRef> {
  const out = new Map<string, FreezeRef>();
  for (const c of clips) {
    if (c.isFreezeSlice || c.notes || !c.bufferId) continue;
    const exact = rendered.find(r => r.clipId === c.id);
    if (exact) { out.set(c.id, { ...exact.ref }); continue; }
    const from = c.offset || 0;
    const to = from + c.duration;
    let best: { ref: FreezeRef; overlap: number } | null = null;
    for (const r of rendered) {
      if (!r.bufferId || r.bufferId !== c.bufferId) continue;
      const overlap = Math.min(to, r.ref.to) - Math.max(from, r.ref.from);
      if (overlap > 0.001 && (!best || overlap > best.overlap)) best = { ref: r.ref, overlap };
    }
    if (best) out.set(c.id, { ...best.ref });
  }
  return out;
}

const upsertArtistBus = (tracks: Track[], b: RemoteBusWire): Track => {
  const id = artistBusId(b.id);
  let bus = tracks.find(x => x.id === id);
  if (!bus) {
    bus = {
      id, name: `${b.name} · ingé`.slice(0, 32), type: TrackType.SEND, color: b.color, isMuted: false, isSolo: false, isTrackArmed: false,
      isFrozen: false, volume: b.volume, pan: b.pan, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
    };
    const at = tracks.findIndex(x => x.id === 'master');
    tracks.splice(at >= 0 ? at : tracks.length, 0, bus);
  }
  bus.name = `${b.name} · ingé`.slice(0, 32);
  bus.color = b.color;
  bus.volume = b.volume;
  bus.pan = b.pan;
  bus.plugins = b.plugins.map(p => ({ ...p, params: { ...(p.params || {}) } }));
  if (b.frozen) {
    bus.isFrozen = true;
    bus.frozenClip = { ...b.frozen.clip };
    bus.frozenUpToPluginIndex = b.frozen.upTo;
    bus.frozenClipIds = [];
    bus.frozenPluginSig = pluginsSignature(bus.plugins, b.frozen.upTo);
    delete bus.frozenSourceSig;
  } else {
    bus.isFrozen = false;
    delete bus.frozenClip; delete bus.frozenUpToPluginIndex; delete bus.frozenClipIds; delete bus.frozenPluginSig; delete bus.frozenSourceSig;
  }
  return bus;
};

/** Artiste : ses réglages à lui, gardés avant le premier retour de l'ingé. */
const rememberBefore = (t: Track) => {
  if (t.remote?.before) return;
  t.remote = { ...(t.remote || { peerTrackId: t.id }), before: {
    plugins: (t.plugins || []).map(p => ({ ...p, params: { ...(p.params || {}) } })),
    sends: (t.sends || []).map(s => ({ ...s })), pan: t.pan,
  } };
};

/** Retour plus ancien / identique à ce qui est déjà appliqué : ignoré. */
export function acceptReturn(info: RemoteTrackInfo | undefined, p: Pick<RemoteReturnPayload, 'forV' | 'sig'>): 'new' | 'dup' | 'old' {
  if (!info) return 'new';
  if (info.appliedSig === p.sig || info.pending?.sig === p.sig) return 'dup';
  if (typeof info.appliedV === 'number' && p.forV < info.appliedV) return 'old';
  return 'new';
}

/**
 * Artiste : pose les réglages de l'ingé sur sa piste (brouillon Immer). Les
 * clips (sa prise brute, ses éditions) ne bougent pas : le rendu gelé se pose
 * par-dessus et suit ses éditions. Renvoie les sons remplacés (à libérer).
 */
export function applyReturnOnArtist(tracks: Track[], p: RemoteReturnPayload, by?: string): { trackId: string; released: string[] } | null {
  const t = tracks.find(x => x.id === p.trackId);
  if (!t) return null;
  const released: string[] = [];
  rememberBefore(t);
  // Bus de l'ingé (ses envois) : pistes d'envoi à part.
  for (const b of p.buses) {
    const old = tracks.find(x => x.id === artistBusId(b.id))?.frozenClip?.bufferId;
    upsertArtistBus(tracks, b);
    if (old && old !== b.frozen?.clip.bufferId) released.push(old);
  }
  t.plugins = p.plugins.map(x => ({ ...x, params: { ...(x.params || {}) } }));
  t.pan = p.pan;
  t.sends = p.sends.map(s => ({ ...s, id: artistBusId(s.id) }));
  if (t.frozenClip?.bufferId && t.frozenClip.bufferId !== p.frozen?.clip.bufferId) released.push(t.frozenClip.bufferId);
  (t.sendFreezes || []).forEach(sf => { if (sf.clip.bufferId && !p.sendFreezes.some(x => x.clip.bufferId === sf.clip.bufferId)) released.push(sf.clip.bufferId); });
  const refs = mapRenderedRefs(t.clips || [], p.rendered);
  t.clips = (t.clips || []).map(c => {
    const ref = refs.get(c.id);
    if (ref) return { ...c, freezeRef: ref };
    if (c.freezeRef) { const { freezeRef: _f, ...rest } = c; return rest as Clip; }
    return c;
  });
  if (p.frozen) {
    t.isFrozen = true;
    t.frozenClip = { ...p.frozen.clip };
    t.frozenUpToPluginIndex = p.frozen.upTo;
    t.frozenClipIds = p.frozen.clipIds ? [...p.frozen.clipIds] : undefined;
    t.frozenPluginSig = pluginsSignature(t.plugins, p.frozen.upTo);
  } else {
    t.isFrozen = false;
    delete t.frozenClip; delete t.frozenUpToPluginIndex; delete t.frozenClipIds; delete t.frozenPluginSig;
  }
  delete t.frozenSourceSig;
  delete t.frozenAuto;
  t.sendFreezes = p.sendFreezes.map(sf => ({ ...sf, busId: artistBusId(sf.busId), clip: { ...sf.clip } }));
  if (!t.sendFreezes.length) delete t.sendFreezes;
  // Photo pour le journal pré-effet : les éditions de l'artiste se lisent par rapport au retour.
  const renderId = p.frozen?.clip.id || p.rendered[0]?.ref.renderId;
  if (renderId) t.freezeBase = makeFreezeBase(t, renderId, by);
  else delete t.freezeBase;
  delete t.preFxJournal;
  t.remote = { ...t.remote!, appliedV: p.forV, appliedSig: p.sig, accepted: true, reverted: false };
  delete t.remote.pending;
  return { trackId: t.id, released };
}

/**
 * Artiste : « Revenir à ma prise brute » — ses effets et envois d'avant
 * reviennent, la piste n'est plus gelée. Le retour de l'ingé reste en réserve
 * (« Réappliquer les réglages de l'ingé »). Mutation (brouillon Immer).
 */
export function revertOnArtist(tracks: Track[], trackId: string, lastReturn?: RemoteReturnPayload): boolean {
  const t = tracks.find(x => x.id === trackId);
  const before = t?.remote?.before;
  if (!t || !before) return false;
  t.plugins = before.plugins.map(p => ({ ...p, params: { ...(p.params || {}) } }));
  t.sends = before.sends.map(s => ({ ...s }));
  t.pan = before.pan;
  t.isFrozen = false;
  delete t.frozenClip; delete t.frozenUpToPluginIndex; delete t.frozenClipIds; delete t.frozenPluginSig; delete t.frozenSourceSig;
  delete t.sendFreezes; delete t.freezeBase; delete t.preFxJournal;
  t.clips = (t.clips || []).map(c => { if (!c.freezeRef) return c; const { freezeRef: _f, ...rest } = c; return rest as Clip; });
  t.remote = { ...t.remote!, reverted: true, appliedSig: undefined, ...(lastReturn ? { pending: lastReturn } : {}) };
  return true;
}

// --- Effets temporels de NOVA pendant l'enregistrement (synchronisés en direct) ----------

export interface RemoteFxPayload {
  buses: RemoteBusWire[];
  /** Envois des pistes échangées (id chez l'artiste). */
  tracks: { trackId: string; sends: TrackSend[] }[];
}

/**
 * Ingé : réglages des bus d'effets NATIFS alimentés par les pistes échangées
 * (reverb, délai de NOVA) + envois de ces pistes. Les bus VST gelés partent
 * avec le retour (leur rendu), pas ici.
 */
export function buildFxPayload(tracks: Track[]): RemoteFxPayload {
  const remoteTracks = tracks.filter(t => !!t.remote && !isBusTrack(t));
  const buses = new Map<string, RemoteBusWire>();
  const out: RemoteFxPayload['tracks'] = [];
  for (const t of remoteTracks) {
    const native = busesFedBy(t, tracks).filter(b => !(b.plugins || []).some(p => isVst(p) && p.isEnabled) && !isFrozenBus(b));
    native.forEach(b => buses.set(b.id, busWire(b, { nativeOnly: true })));
    out.push({ trackId: t.remote!.peerTrackId, sends: (t.sends || []).filter(s => busesFedBy(t, tracks).some(b => b.id === s.id)).map(s => ({ ...s })) });
  }
  return { buses: Array.from(buses.values()), tracks: out };
}

export const fxSignature = (p: RemoteFxPayload): string => hashOf(p);

/** Artiste : applique les réglages d'effets natifs de l'ingé (il les entend en direct). Mutation. */
export function applyFxOnArtist(tracks: Track[], p: RemoteFxPayload): number {
  let n = 0;
  for (const b of p.buses) {
    const cur = tracks.find(x => x.id === artistBusId(b.id));
    // Bus gelé reçu au mix (reverb VST) : ce n'est plus un bus natif, on n'y touche pas.
    if (cur && isFrozenBus(cur)) continue;
    upsertArtistBus(tracks, b);
  }
  for (const x of p.tracks) {
    const t = tracks.find(y => y.id === x.trackId && !!y.remote);
    if (!t || t.remote?.reverted) continue;
    rememberBefore(t);
    const keep = (t.sends || []).filter(s => s.id.startsWith(ARTIST_BUS_PREFIX) && !x.sends.some(o => artistBusId(o.id) === s.id) && tracks.some(b => b.id === s.id && isFrozenBus(b)));
    t.sends = [...keep, ...x.sends.map(s => ({ ...s, id: artistBusId(s.id) }))];
    n++;
  }
  return n;
}

// --- État affiché chez l'artiste -------------------------------------------------------------

export type EngineerAckState = 'received' | 'processing' | 'waiting_bridge' | 'waiting_engineer' | 'blocked';

export interface ArtistStatus {
  code: 'queued' | 'sending' | 'at_engineer' | 'processing' | 'waiting_bridge' | 'blocked' | 'ready' | 'updated' | 'reverted' | 'none';
  label: string;
  tone: 'info' | 'busy' | 'ok' | 'warn';
}

export function artistStatus(t: Track, ack: { v: number; state: EngineerAckState; detail?: string } | undefined, queued: boolean): ArtistStatus {
  const r = t.remote;
  if (!r) return { code: 'none', label: '', tone: 'info' };
  const sentV = r.sentV || 0;
  if (r.pending && !r.reverted && !r.accepted) return { code: 'ready', label: "Réglages de l'ingé prêts", tone: 'ok' };
  if (queued) return { code: 'queued', label: 'Pas de connexion : partira tout seul dès que possible', tone: 'warn' };
  if (r.reverted) return { code: 'reverted', label: "Ta prise brute (réglages de l'ingé en réserve)", tone: 'info' };
  if (sentV > (r.appliedV || 0)) {
    if (!ack || ack.v < sentV) return { code: 'sending', label: "Envoi chez l'ingé…", tone: 'busy' };
    if (ack.state === 'processing') return { code: 'processing', label: "Chez l'ingé… il applique ses effets", tone: 'busy' };
    if (ack.state === 'waiting_bridge') return { code: 'waiting_bridge', label: "Chez l'ingé… (son pont VST est fermé : ça repartira dès qu'il le rouvre)", tone: 'warn' };
    if (ack.state === 'blocked') return { code: 'blocked', label: `Chez l'ingé… ${ack.detail || 'il doit ajuster ses effets'}`, tone: 'warn' };
    return { code: 'at_engineer', label: "Chez l'ingé…", tone: 'busy' };
  }
  if (r.appliedV) return { code: 'updated', label: 'Mise à jour reçue', tone: 'ok' };
  return { code: 'none', label: '', tone: 'info' };
}

// --- File d'attente hors ligne -----------------------------------------------------------------

export interface OutboxStore { load(): string[]; save(keys: string[]): void }

export const localOutboxStore = (key: string): OutboxStore => ({
  load: () => { try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } },
  save: (keys) => { try { if (keys.length) localStorage.setItem(key, JSON.stringify(keys)); else localStorage.removeItem(key); } catch { /* stockage indisponible */ } },
});

/**
 * File d'envois (hors ligne, échec réseau) : une INTENTION par piste et par
 * type (« envoyer la piste X »), jamais un contenu figé. À l'envoi, le contenu
 * est relu tel qu'il est : deux éditions hors ligne ne partent qu'une fois, en
 * leur dernière version. Gardée dans le navigateur (survit à un rechargement).
 */
export class RemoteOutbox {
  private keys: string[];
  private running: Promise<{ sent: number; failed: number }> | null = null;

  constructor(private store: OutboxStore, private send: (kind: string, trackId: string) => Promise<void>, private onChange?: () => void) {
    this.keys = Array.from(new Set(store.load()));
  }

  add(kind: string, trackId: string) {
    const k = `${kind}:${trackId}`;
    if (this.keys.includes(k)) return;
    this.keys.push(k);
    this.store.save(this.keys);
    this.onChange?.();
  }

  has(kind: string, trackId: string) { return this.keys.includes(`${kind}:${trackId}`); }
  size() { return this.keys.length; }
  list() { return [...this.keys]; }

  /** Envoie tout ce qui attend (un seul passage à la fois) ; garde ce qui échoue. */
  flush(): Promise<{ sent: number; failed: number }> {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run() {
    let sent = 0; let failed = 0;
    for (const k of [...this.keys]) {
      const i = k.indexOf(':');
      try {
        await this.send(k.slice(0, i), k.slice(i + 1));
        this.keys = this.keys.filter(x => x !== k);
        sent++;
      } catch {
        failed++;
      }
    }
    this.store.save(this.keys);
    if (sent) this.onChange?.();
    return { sent, failed };
  }
}

// --- Lien ---------------------------------------------------------------------------------------

/** Lien d'invitation de l'ingé : « id.clé » (même format que les sessions en ligne). */
export const parseRemoteLink = (raw: string | null | undefined): { id: string; secret: string } | null => {
  const s = String(raw || '').trim();
  const m = /(?:[?&]inge=)?([a-z0-9]{12})\.([A-Za-z0-9]{24,64})/.exec(decodeURIComponent(s));
  return m ? { id: m[1], secret: m[2] } : null;
};

// --- Mix piloté par le chat Nova ------------------------------------------------------------


export interface RemoteMixRule {
  phase: RemoteIngePhase;
  /** Pistes échangées avec l'artiste (pas d'effet temporel en insert). */
  trackIds: string[];
}

/** Pendant l'enregistrement, Nova n'utilise que les reverbs / délais de NOVA (l'artiste les a aussi). */
export const installedForRemote = (installed: KnownPlugin[], rule: RemoteMixRule | null): KnownPlugin[] =>
  rule?.phase === 'recording' ? installed.filter(p => p.category !== 'reverb' && p.category !== 'delay') : installed;

/**
 * Garde-fou sur un plan de mix : aucun effet temporel en insert d'une piste
 * échangée, aucun VST temporel pendant l'enregistrement. Les effets de NOVA
 * remplacés restent actifs (rien n'est mis en pause pour un VST retiré).
 */
export function enforceRemoteMixRule(plan: MixPlan, rule: RemoteMixRule | null): MixPlan {
  if (!rule) return plan;
  const remote = new Set(rule.trackIds);
  const dropped: string[] = [];
  const tracks = plan.tracks.map(tp => {
    const vst = tp.vst.filter(v => {
      const temporal = v.plugin.category === 'reverb' || v.plugin.category === 'delay' || v.slot === 'verb' || v.slot === 'delay';
      const bad = temporal && (remote.has(tp.trackId) || rule.phase === 'recording');
      if (bad) dropped.push(v.plugin.name);
      return !bad;
    });
    if (vst.length === tp.vst.length) return tp;
    // Effets de NOVA qui devaient céder la place à un VST retiré : ils restent.
    return { ...tp, vst, pauseBuiltin: vst.length ? tp.pauseBuiltin : [] };
  });
  if (!dropped.length) return plan;
  const why = rule.phase === 'recording'
    ? "enregistrement en cours : reverb et délai de NOVA seulement (l'artiste les entend aussi)"
    : 'les effets temporels restent en envoi';
  return { ...plan, tracks, warnings: [...plan.warnings, `${dropped.join(', ')} non utilisé${dropped.length > 1 ? 's' : ''} (${why}).`] };
}
