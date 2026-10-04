import { Clip, PluginInstance, SendFreeze, Track, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { liveVstNodes } from '../engine/VSTPluginNode';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { novaBridge } from './NovaBridge';
import {
  anchorClipsToRender, canBakeTrack, feedLevel, freezeIndex, freezeSignature, hasVst, isFreezeStale, isTrackFrozen, isVst, lastVstIndex,
  needsRerender, pluginsSignature, SEND_RENDER_TAIL,
} from '../utils/freeze';
import { makeFreezeBase, PRE_VOLUME } from '../utils/preFxEdits';

/**
 * Rendu des effets VST3 (via le pont du PC) dans l'audio de la piste, pour que
 * le projet continue sur un téléphone sans pont.
 *
 * Rendu = clips de la piste -> effets [0..upTo] (VST3 par le pont, effets natifs
 * en OfflineAudioContext), AVANT fader/pan/départs, avec une queue de 3 s.
 * Les effets natifs placés après le dernier VST3 restent hors du rendu : ils
 * restent modifiables sur le téléphone.
 */

export const FREEZE_TAIL_SECONDS = 3;

export interface FreezeResult {
  clip: Clip;
  upTo: number;
  clipIds: string[];
  sig: string;
  /** Empreinte des effets rendus seuls (clips ancrés : la piste reste éditable). */
  pluginSig: string;
  /** Place de chaque clip rendu dans le rendu, telle qu'au moment du rendu. */
  anchors: Map<string, NonNullable<Clip['freezeRef']>>;
}

/**
 * Applique un rendu à une piste (brouillon Immer ou copie) : rendu, empreintes,
 * et ancrage des clips restés identiques depuis le début du rendu.
 */
export function applyFreezeResult(t: Track, r: FreezeResult, by?: string): void {
  t.frozenClip = r.clip;
  t.frozenUpToPluginIndex = r.upTo;
  t.frozenClipIds = r.clipIds;
  t.frozenSourceSig = r.sig;
  t.frozenPluginSig = r.pluginSig;
  t.clips = (t.clips || []).map(c => {
    const ref = r.anchors.get(c.id);
    if (!ref) return c;
    const unchanged = Math.abs((c.start - (c.offset || 0)) - ref.anchor) < 1e-6 && Math.abs((c.offset || 0) - ref.from) < 1e-6 && Math.abs(c.duration - (ref.to - ref.from)) < 1e-6;
    return unchanged ? { ...c, freezeRef: ref } : c;
  });
  // Photo de la piste : les éditions faites ensuite (ailleurs) se lisent par rapport à elle.
  t.freezeBase = makeFreezeBase(t, r.clip.id, by);
  delete t.preFxJournal;
}

type Segment = { kind: 'native'; plugins: PluginInstance[] } | { kind: 'vst'; plugin: PluginInstance };

const splitSegments = (plugins: PluginInstance[]): Segment[] => {
  const out: Segment[] = [];
  for (const p of plugins) {
    if (!p.isEnabled) continue;
    if (isVst(p)) out.push({ kind: 'vst', plugin: p });
    else {
      const last = out[out.length - 1];
      if (last && last.kind === 'native') last.plugins.push(p);
      else out.push({ kind: 'native', plugins: [p] });
    }
  }
  return out;
};

/**
 * Piste isolée (sans bus, départs, solo, automation) pour un rendu pré-fader.
 * withPreVolume : garde le volume avant effets (export : il passe avant les effets).
 */
const isolated = (track: Track, plugins: PluginInstance[], clips?: Clip[], withPreVolume = false): Track => ({
  ...track,
  isFrozen: false, frozenClip: undefined, outputTrackId: '', sends: [], isMuted: false, isSolo: false,
  automationLanes: withPreVolume ? (track.automationLanes || []).filter(l => l.parameterName === PRE_VOLUME) : [],
  plugins, ...(clips ? { clips, type: TrackType.AUDIO } : {}),
});

const channelsOf = (b: AudioBuffer): Float32Array[] =>
  Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => b.getChannelData(c));

/**
 * Passe un son (stéréo) dans une chaîne d'effets : VST3 par le pont, effets
 * natifs hors ligne. La durée ne change pas (la queue doit déjà être dans le son).
 */
export async function renderThroughChain(input: AudioBuffer, plugins: PluginInstance[], host: Track, onStep?: (msg: string) => void): Promise<AudioBuffer> {
  await audioEngine.init();
  const ctx = audioEngine.ctx!;
  const sr = input.sampleRate;
  const segments = splitSegments(plugins);
  if (segments.some(s => s.kind === 'vst') && !novaBridge.isConnected()) {
    throw new Error('Connecte le pont VST pour rendre les effets VST3.');
  }
  const duration = input.length / sr;
  let buffer = input;
  for (const seg of segments) {
    if (seg.kind === 'vst') {
      const p = seg.plugin;
      onStep?.(`Rendu ${p.params?.name || p.name}…`);
      const live = liveVstNodes.get(p.id);
      const out = await novaBridge.render({
        slotId: live?.getSlotId() || null,
        path: p.params?.localPath, pluginName: p.params?.pluginName || null, stateB64: p.params?.stateB64 || null,
        sampleRate: sr, channels: channelsOf(buffer), tailSeconds: 0,
      });
      const next = ctx.createBuffer(2, buffer.length, sr);
      for (let c = 0; c < 2; c++) next.copyToChannel(out[Math.min(c, out.length - 1)].subarray(0, buffer.length), c);
      buffer = next;
    } else {
      const tmpId = `freeze-tmp-${host.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      audioBufferRegistry.register(buffer, tmpId);
      try {
        const clip: Clip = {
          id: tmpId, start: 0, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: 'freeze', color: '#000',
          type: TrackType.AUDIO, bufferId: tmpId, gain: 1,
        };
        buffer = await audioEngine.renderProject([isolated(host, seg.plugins, [clip])], duration, 0, sr, undefined, { preFader: true });
      } finally {
        audioBufferRegistry.remove(tmpId);
      }
    }
  }
  return buffer;
}

/**
 * Rend la piste jusqu'à l'effet upTo (inclus). Lève une erreur si un VST3 est
 * dans la plage et que le pont n'est pas connecté, ou si la piste est le beat.
 * opts.withPreVolume : le volume avant effets passe dans le rendu (export) ;
 * sinon il reste appliqué à la lecture (il s'édite sur la tablette).
 */
export async function renderTrackFreeze(track: Track, upTo: number, onStep?: (msg: string) => void, opts: { withPreVolume?: boolean } = {}): Promise<FreezeResult> {
  if (!canBakeTrack(track)) throw new Error("Le beat n'est jamais rendu dans un fichier (licence).");
  await audioEngine.init();
  const ctx = audioEngine.ctx!;
  // Fréquence du contexte (44,1 ou 48 kHz selon l'appareil) : jamais figée.
  const sr = ctx.sampleRate;
  const plugins = (track.plugins || []).slice(0, upTo + 1);
  const segments = splitSegments(plugins);
  if (segments.some(s => s.kind === 'vst') && !novaBridge.isConnected()) {
    throw new Error('Connecte le pont VST pour rendre les effets VST3.');
  }
  const clips = track.clips || [];
  const trackEnd = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  if (trackEnd <= 0) throw new Error('Rien à rendre sur cette piste.');
  const duration = trackEnd + FREEZE_TAIL_SECONDS;

  // 1) Clips -> premiers effets natifs (avant le premier VST3), volume avant effets compris si demandé
  const firstNative = segments[0]?.kind === 'native' ? (segments[0] as { kind: 'native'; plugins: PluginInstance[] }).plugins : [];
  const dry = await audioEngine.renderProject([isolated(track, firstNative, undefined, !!opts.withPreVolume)], duration, 0, sr, undefined, { preFader: true, keepPreVolume: !!opts.withPreVolume });
  // 2) Effets suivants : VST3 par le pont, effets natifs hors ligne
  const rest = segments[0]?.kind === 'native' ? plugins.slice(plugins.indexOf(firstNative[firstNative.length - 1]) + 1) : plugins;
  const buffer = await renderThroughChain(dry, rest, track, onStep);

  const clipId = `frozen-${track.id}-${Date.now()}`;
  audioBufferRegistry.register(buffer, clipId);
  const clip: Clip = {
    id: clipId, start: 0, duration, offset: 0, fadeIn: 0, fadeOut: 0,
    name: `${track.name} (rendu)`, color: track.color, type: TrackType.AUDIO,
    bufferId: clipId, isMuted: false, gain: 1,
  };
  return {
    clip, upTo, clipIds: clips.map(c => c.id), sig: freezeSignature(clips, track.plugins || [], upTo),
    pluginSig: pluginsSignature(track.plugins || [], upTo), anchors: anchorClipsToRender(clips, clipId),
  };
}

// --- Bus / envois à effets VST (reverb VST de l'ingé…) ----------------------------

/** Effets VST3 actifs dans les effets [0..upTo] d'une piste. */
const activeVstUpTo = (t: Track, upTo: number) => (t.plugins || []).slice(0, upTo + 1).some(p => isVst(p) && p.isEnabled);

/** Bus / envois d'effets qui passent par un VST3 du PC (à geler pour la tablette). */
export const vstBuses = (tracks: Track[]): Track[] =>
  tracks.filter(t => (t.type === TrackType.BUS || t.type === TrackType.SEND) && t.id !== 'master'
    && (t.clips || []).length === 0 && canBakeTrack(t) && activeVstUpTo(t, lastVstIndex(t)));

/** Pistes dont le son passe dans ce bus (envoi actif ou sortie routée), avec de l'audio rendable. */
export const busSources = (bus: Track, tracks: Track[]): Track[] =>
  tracks.filter(s => s.id !== bus.id && canBakeTrack(s) && feedLevel(s, bus.id) > 0
    && (s.type === TrackType.AUDIO || s.type === TrackType.SAMPLER)
    && (s.clips || []).some(c => !!c.bufferId && !c.notes));

/** La source est-elle lisible hors ligne (ses propres VST3 ont un rendu à jour) ? */
const sourcePlayable = (s: Track): Track | null => {
  if (!activeVst(s)) return s;
  if (s.frozenClip && !isFreezeStale(s) && freezeIndex(s) >= lastVstIndex(s)) return { ...s, isFrozen: true };
  return null;
};

/** Id de rendu auquel les clips de la source sont ancrés (son propre rendu VST, sinon un ancrage d'envoi). */
const anchorIdOf = (s: Track): string | null =>
  s.frozenClip && activeVst(s) && !isFreezeStale(s) ? s.frozenClip.id : null;

/** Empreinte de la part d'une source vers un bus (ce qui a été rendu). */
export const sendFreezeSig = (s: Track, bus: Track): string => {
  const upTo = lastVstIndex(bus);
  const anchored = (s.clips || []).filter(c => !!c.freezeRef).map(c => `${c.id}@${c.freezeRef!.renderId}`).join(',');
  return [
    freezeSignature(s.clips || [], s.plugins || [], (s.plugins || []).length - 1),
    pluginsSignature(bus.plugins || [], upTo),
    s.pan, JSON.stringify((s.automationLanes || []).filter(l => l.parameterName !== PRE_VOLUME && l.points.length > 0).map(l => [l.parameterName, l.points.map(p => [p.time, p.value, p.curveType || ''])])),
    s.frozenClip?.id || '', anchored,
  ].join('#');
};

/** Bus VST dont le rendu (par source) est à (re)faire avant une sauvegarde. */
export function busesNeedingVstRender(tracks: Track[]): Track[] {
  return vstBuses(tracks).filter(bus => {
    // Une source dont les propres VST3 n'ont pas pu être rendus est ignorée (pas de rendu en boucle).
    const sources = busSources(bus, tracks).filter(s => !!sourcePlayable(s));
    if (sources.length === 0) return false;
    if (!bus.frozenClip || isFreezeStale(bus) || freezeIndex(bus) < lastVstIndex(bus)) return true;
    return sources.some(s => {
      const sf = (s.sendFreezes || []).find(x => x.busId === bus.id);
      return !sf || sf.busRenderId !== bus.frozenClip!.id || sf.sig !== sendFreezeSig(s, bus);
    });
  });
}

const CAP = '__nova_cap';
const SINK = '__nova_sink';
const bareBus = (id: string, muted: boolean): Track => ({
  id, name: id, type: TrackType.BUS, color: '#000', isMuted: muted, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: '', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
});

/**
 * Son que ces sources envoient au bus (après leurs effets, fader, pan et
 * niveau d'envoi), sans les effets du bus. Muet/solo ignorés (appliqués à la lecture).
 */
async function renderFeed(sources: Track[], bus: Track, duration: number, sr: number): Promise<AudioBuffer> {
  const list: Track[] = [];
  for (const s of sources) {
    const play = sourcePlayable(s);
    if (!play) continue;
    const send = (s.sends || []).find(x => x.id === bus.id && x.isEnabled);
    list.push({
      ...play, isMuted: false, isSolo: false,
      outputTrackId: s.outputTrackId === bus.id ? CAP : SINK,
      sends: send ? [{ id: CAP, level: send.level, isEnabled: true }] : [],
      automationLanes: (play.automationLanes || [])
        .filter(l => !l.parameterName.startsWith('send::') || l.parameterName === `send::${bus.id}`)
        .map(l => (l.parameterName === `send::${bus.id}` ? { ...l, parameterName: `send::${CAP}` } : l)),
      sendFreezes: undefined,
    });
  }
  return audioEngine.renderProject([...list, bareBus(CAP, false), bareBus(SINK, true)], duration, 0, sr, undefined, {});
}

export interface BusFreezeResult {
  busId: string;
  /** Marqueur de rendu du bus (court silence : le son est dans les rendus par source). */
  busClip: Clip;
  upTo: number;
  pluginSig: string;
  /** Rendu de chaque source + ancrages à poser sur ses clips (source sans rendu VST propre). */
  perSource: Map<string, { sf: SendFreeze; anchors?: Map<string, NonNullable<Clip['freezeRef']>> }>;
}

/**
 * Gel d'un bus VST pour la tablette : pour chaque source, sa part passée dans
 * les effets du bus jusqu'au dernier VST3. Les tranches suivront les éditions
 * des clips de la source.
 */
export async function renderBusFreeze(bus: Track, tracks: Track[], onStep?: (msg: string) => void): Promise<BusFreezeResult> {
  await audioEngine.init();
  const ctx = audioEngine.ctx!;
  const sr = ctx.sampleRate;
  const upTo = lastVstIndex(bus);
  const chain = (bus.plugins || []).slice(0, upTo + 1);
  const stamp = Date.now();
  const busClipId = `frozen-${bus.id}-${stamp}`;
  const marker = ctx.createBuffer(2, Math.max(1, Math.round(sr * 0.05)), sr);
  audioBufferRegistry.register(marker, busClipId);
  const busClip: Clip = {
    id: busClipId, start: 0, duration: marker.duration, offset: 0, fadeIn: 0, fadeOut: 0, name: `${bus.name} (rendu)`,
    color: bus.color, type: TrackType.AUDIO, bufferId: busClipId, isMuted: false, gain: 1,
  };
  const perSource: BusFreezeResult['perSource'] = new Map();
  try {
    for (const s of busSources(bus, tracks)) {
      if (!sourcePlayable(s)) continue; // ses propres VST3 n'ont pas de rendu : rien de fiable à rendre
      onStep?.(`Rendu de l'envoi ${s.name} → ${bus.name}…`);
      const end = (s.clips || []).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      if (end <= 0) continue;
      const duration = end + SEND_RENDER_TAIL;
      const feed = await renderFeed([s], bus, duration, sr);
      const wet = await renderThroughChain(feed, chain, bus, onStep);
      const id = `send-${s.id}-${bus.id}-${stamp}`;
      audioBufferRegistry.register(wet, id);
      const own = anchorIdOf(s);
      const anchorId = own || `anchor-${s.id}-${stamp}`;
      const anchors = own ? undefined : anchorClipsToRender(s.clips || [], anchorId);
      perSource.set(s.id, {
        anchors,
        sf: {
          busId: bus.id, busRenderId: busClipId, anchorId, volume: s.volume, level: feedLevel(s, bus.id), sig: '',
          clip: {
            id, start: 0, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: `${s.name} → ${bus.name}`, color: bus.color,
            type: TrackType.AUDIO, bufferId: id, isMuted: false, gain: 1,
          },
        },
      });
    }
  } catch (e) {
    audioBufferRegistry.remove(busClipId);
    perSource.forEach(p => audioBufferRegistry.remove(p.sf.clip.bufferId!));
    throw e;
  }
  return { busId: bus.id, busClip, upTo, pluginSig: pluginsSignature(bus.plugins || [], upTo), perSource };
}

/**
 * Pose un gel de bus dans le projet (brouillon Immer) : marqueur sur le bus,
 * rendus et ancrages sur les sources, photo des sources sans rendu propre.
 * Renvoie les sons remplacés (à libérer).
 */
export function applyBusFreezeResult(tracks: Track[], r: BusFreezeResult, by?: string): string[] {
  const old: string[] = [];
  const bus = tracks.find(t => t.id === r.busId);
  if (!bus) return old;
  if (bus.frozenClip?.bufferId) old.push(bus.frozenClip.bufferId);
  bus.frozenClip = r.busClip;
  bus.frozenUpToPluginIndex = r.upTo;
  bus.frozenClipIds = [];
  bus.frozenPluginSig = r.pluginSig;
  delete bus.frozenSourceSig;
  for (const s of tracks) {
    const p = r.perSource.get(s.id);
    const prev = (s.sendFreezes || []).filter(x => x.busId === r.busId);
    if (!p) {
      // Plus d'envoi rendu vers ce bus : l'ancien rendu est retiré.
      if (prev.length) { prev.forEach(x => x.clip.bufferId && old.push(x.clip.bufferId)); s.sendFreezes = (s.sendFreezes || []).filter(x => x.busId !== r.busId); }
      continue;
    }
    prev.forEach(x => x.clip.bufferId && old.push(x.clip.bufferId));
    if (p.anchors) {
      s.clips = (s.clips || []).map(c => { const ref = p.anchors!.get(c.id); return ref ? { ...c, freezeRef: ref } : c; });
      if (!s.freezeBase || s.freezeBase.renderId !== p.sf.anchorId) s.freezeBase = makeFreezeBase(s, p.sf.anchorId, by);
    }
    s.sendFreezes = [...(s.sendFreezes || []).filter(x => x.busId !== r.busId), { ...p.sf, sig: sendFreezeSig(s, bus) }];
  }
  return old;
}

/** Piste d'instrument VST vue comme une piste audio : son rendu = son unique clip. */
const instrumentAsAudio = (t: Track): Track => ({
  ...t, type: TrackType.AUDIO, isFrozen: false, vstInstrument: undefined,
  frozenClip: undefined, frozenClipIds: undefined, frozenUpToPluginIndex: undefined, frozenSourceSig: undefined, frozenPluginSig: undefined,
  clips: [{ ...t.frozenClip!, start: 0, offset: 0 }],
});

/** Effets VST3 actifs (pas contournés) sur la piste. */
const activeVst = (t: Track) => (t.plugins || []).some(p => isVst(p) && p.isEnabled);

/**
 * Pistes dont le rendu VST3 est à (re)faire avant une sauvegarde : VST3 actif,
 * pas le beat, et pas de rendu à jour couvrant le dernier VST3.
 */
export function tracksNeedingVstRender(tracks: Track[]): Track[] {
  return tracks.filter(t => {
    // Instrument VST : son rendu (frozenClip) suit les notes, il n'est jamais remplacé ici.
    if (t.vstInstrument) return false;
    if (!canBakeTrack(t) || !activeVst(t) || (t.clips || []).length === 0) return false;
    if (!t.frozenClip) return true;
    // Sur PC (pont connecté), un rendu dont les clips ont bougé est refait :
    // la tranche ancrée suffit ailleurs, mais ici on peut avoir l'exact.
    if (needsRerender(t)) return true;
    return freezeIndex(t) < lastVstIndex(t);
  });
}

/** Plage à rendre : jusqu'au dernier VST3 (gel manuel : la plage déjà gelée). */
export const renderRangeFor = (t: Track): number =>
  isTrackFrozen(t) ? Math.max(freezeIndex(t), lastVstIndex(t)) : lastVstIndex(t);

/** Relit l'état de chaque VST3 chargé (réglages faits dans sa fenêtre) : id du plugin -> état. */
export async function syncLiveVstStates(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(Array.from(liveVstNodes.entries()).map(async ([id, n]) => {
    const st = await n.syncState().catch(() => null);
    if (st) out.set(id, st);
  }));
  return out;
}

/**
 * Le projet doit-il s'ouvrir gelé ailleurs ? Oui si la piste est gelée, ou si
 * elle porte un rendu à jour de ses VST3 (cache fait à la sauvegarde sur PC).
 */
export const shouldPersistFrozen = (t: Track): boolean => {
  if (!t.frozenClip || !canBakeTrack(t)) return false;
  if (isTrackFrozen(t)) return true;
  return hasVst(t) && !isFreezeStale(t) && freezeIndex(t) >= lastVstIndex(t);
};

/** Volume avant effets dessiné sur la piste. */
const hasPreVolume = (t: Track) => (t.automationLanes || []).some(l => l.parameterName === PRE_VOLUME && l.points.length > 0);
const withoutPreVolume = (t: Track): Track => ({ ...t, automationLanes: (t.automationLanes || []).filter(l => l.parameterName !== PRE_VOLUME) });

/**
 * Export : pistes avec VST3 remplacées par leur rendu (à jour ou fait à la
 * volée si le pont est connecté). Sans pont ni rendu, le VST3 est ignoré (son sec).
 *
 * Pont connecté (PC de l'ingé), les éditions faites ailleurs sont rejouées
 * AVANT les effets : clips édités depuis le rendu ou volume avant effets
 * dessiné → nouveau rendu à partir de l'audio sec. Les bus / envois VST
 * (reverb VST) sont rendus à partir de tout ce qui y entre.
 */
export async function prepareTracksForOffline(tracks: Track[], onStep?: (msg: string) => void): Promise<{ tracks: Track[]; missingVst: string[]; cleanup: () => void }> {
  const temp: string[] = [];
  const missingVst: string[] = [];
  let out: Track[] = [];
  const bridge = novaBridge.isConnected();
  for (const t of tracks) {
    // Instrument VST rendu + effets VST3 : les effets sont rendus sur le son de l'instrument.
    if (t.vstInstrument && isTrackFrozen(t) && activeVst(t) && canBakeTrack(t)) {
      if (bridge) {
        try {
          const src = instrumentAsAudio(t);
          const r = await renderTrackFreeze(src, lastVstIndex(src), onStep);
          temp.push(r.clip.bufferId!);
          const ft: Track = { ...src, isFrozen: true };
          applyFreezeResult(ft, r);
          out.push(ft);
          continue;
        } catch (e) {
          console.warn('[Export] Rendu VST impossible', e);
        }
      }
      missingVst.push(t.name);
      out.push(t);
      continue;
    }
    if ((t.clips || []).length === 0 && vstBuses([t]).length > 0) { out.push(t); continue; } // bus VST : plus bas
    const manualFrozen = isTrackFrozen(t) && !t.frozenAuto;
    if (manualFrozen || !activeVst(t) || !canBakeTrack(t)) { out.push(t); continue; }
    const fresh = !!t.frozenClip && !isFreezeStale(t) && freezeIndex(t) >= lastVstIndex(t);
    // Au PC, une piste éditée depuis son rendu (ou avec un volume avant effets) est re-rendue depuis l'audio sec.
    const rerender = bridge && (!fresh || needsRerender(t) || hasPreVolume(t));
    if (!rerender && fresh) {
      out.push({ ...t, isFrozen: true });
      continue;
    }
    if (bridge) {
      try {
        const r = await renderTrackFreeze(t, lastVstIndex(t), onStep, { withPreVolume: true });
        temp.push(r.clip.bufferId!);
        const ft: Track = { ...withoutPreVolume(t), isFrozen: true };
        applyFreezeResult(ft, r);
        out.push(ft);
        continue;
      } catch (e) {
        console.warn('[Export] Rendu VST impossible', e);
      }
    }
    if (fresh) { out.push({ ...t, isFrozen: true }); continue; }
    missingVst.push(t.name);
    out.push(t);
  }

  // Bus / envois VST (reverb VST de l'ingé…)
  for (const bus of vstBuses(tracks)) {
    const idx = out.findIndex(x => x.id === bus.id);
    if (bridge) {
      try {
        const solo = out.some(x => x.isSolo);
        const sources = busSources(bus, out).filter(s => !s.isMuted && (!solo || s.isSolo) && !!sourcePlayable(s));
        if (sources.length === 0) { out[idx] = { ...bus, isFrozen: false }; continue; }
        const sr = audioEngine.ctx?.sampleRate || 44100;
        const end = sources.reduce((m, s) => Math.max(m, ...(s.clips || []).map(c => c.start + c.duration)), 0);
        onStep?.(`Rendu de ${bus.name}…`);
        const feed = await renderFeed(sources, bus, end + SEND_RENDER_TAIL, sr);
        const upTo = lastVstIndex(bus);
        const wet = await renderThroughChain(feed, (bus.plugins || []).slice(0, upTo + 1), bus, onStep);
        const id = `export-${bus.id}-${Date.now()}`;
        audioBufferRegistry.register(wet, id);
        temp.push(id);
        // Le bus joue son rendu complet ; tout ce qui y entrait (déjà dans le rendu) est coupé.
        const srcIds = new Set(sources.map(s => s.id));
        let needSink = false;
        out = out.map(x => {
          if (!srcIds.has(x.id)) return x;
          const routed = x.outputTrackId === bus.id;
          if (routed) needSink = true;
          return { ...x, sends: (x.sends || []).filter(sd => sd.id !== bus.id), ...(routed ? { outputTrackId: SINK } : {}) };
        });
        out[idx] = {
          ...bus, isFrozen: false, frozenClip: undefined, plugins: (bus.plugins || []).slice(upTo + 1),
          clips: [{ id, start: 0, duration: wet.duration, offset: 0, fadeIn: 0, fadeOut: 0, name: `${bus.name} (rendu)`, color: bus.color, type: TrackType.AUDIO, bufferId: id, gain: 1 }],
        };
        if (needSink) out.push(bareBus(SINK, true));
        continue;
      } catch (e) {
        console.warn('[Export] Rendu du bus VST impossible', e);
      }
    }
    if (isTrackFrozen(bus)) continue;
    if (bus.frozenClip && !isFreezeStale(bus) && freezeIndex(bus) >= lastVstIndex(bus)) { out[idx] = { ...bus, isFrozen: true }; continue; }
    missingVst.push(bus.name);
  }
  return { tracks: out, missingVst, cleanup: () => temp.forEach(id => audioBufferRegistry.remove(id)) };
}
