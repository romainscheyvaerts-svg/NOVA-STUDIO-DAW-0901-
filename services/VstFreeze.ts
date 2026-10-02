import { Clip, PluginInstance, Track, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { liveVstNodes } from '../engine/VSTPluginNode';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { novaBridge } from './NovaBridge';
import {
  canBakeTrack, freezeIndex, freezeSignature, hasVst, isFreezeStale, isTrackFrozen, isVst, lastVstIndex,
} from '../utils/freeze';

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

/** Piste isolée (sans bus, départs, solo, automation) pour un rendu pré-fader. */
const isolated = (track: Track, plugins: PluginInstance[], clips?: Clip[]): Track => ({
  ...track,
  isFrozen: false, frozenClip: undefined, outputTrackId: '', sends: [], isMuted: false, isSolo: false,
  automationLanes: [], plugins, ...(clips ? { clips, type: TrackType.AUDIO } : {}),
});

const channelsOf = (b: AudioBuffer): Float32Array[] =>
  Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => b.getChannelData(c));

/**
 * Rend la piste jusqu'à l'effet upTo (inclus). Lève une erreur si un VST3 est
 * dans la plage et que le pont n'est pas connecté, ou si la piste est le beat.
 */
export async function renderTrackFreeze(track: Track, upTo: number, onStep?: (msg: string) => void): Promise<FreezeResult> {
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

  // 1) Clips -> premiers effets natifs (avant le premier VST3)
  const first = segments[0]?.kind === 'native' ? (segments.shift() as { kind: 'native'; plugins: PluginInstance[] }).plugins : [];
  let buffer = await audioEngine.renderProject([isolated(track, first)], duration, 0, sr, undefined, { preFader: true });

  // 2) Segments suivants : VST3 par le pont, effets natifs hors ligne
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
      const tmpId = `freeze-tmp-${track.id}-${Date.now()}`;
      audioBufferRegistry.register(buffer, tmpId);
      try {
        const clip: Clip = {
          id: tmpId, start: 0, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: 'freeze', color: '#000',
          type: TrackType.AUDIO, bufferId: tmpId, gain: 1,
        };
        buffer = await audioEngine.renderProject([isolated(track, seg.plugins, [clip])], duration, 0, sr, undefined, { preFader: true });
      } finally {
        audioBufferRegistry.remove(tmpId);
      }
    }
  }

  const clipId = `frozen-${track.id}-${Date.now()}`;
  audioBufferRegistry.register(buffer, clipId);
  const clip: Clip = {
    id: clipId, start: 0, duration, offset: 0, fadeIn: 0, fadeOut: 0,
    name: `${track.name} (rendu)`, color: track.color, type: TrackType.AUDIO,
    bufferId: clipId, isMuted: false, gain: 1,
  };
  return { clip, upTo, clipIds: clips.map(c => c.id), sig: freezeSignature(clips, track.plugins || [], upTo) };
}

/** Effets VST3 actifs (pas contournés) sur la piste. */
const activeVst = (t: Track) => (t.plugins || []).some(p => isVst(p) && p.isEnabled);

/**
 * Pistes dont le rendu VST3 est à (re)faire avant une sauvegarde : VST3 actif,
 * pas le beat, et pas de rendu à jour couvrant le dernier VST3.
 */
export function tracksNeedingVstRender(tracks: Track[]): Track[] {
  return tracks.filter(t => {
    if (!canBakeTrack(t) || !activeVst(t) || (t.clips || []).length === 0) return false;
    if (!t.frozenClip) return true;
    if (isFreezeStale(t)) return true;
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

/**
 * Export : pistes avec VST3 remplacées par leur rendu (à jour ou fait à la
 * volée si le pont est connecté). Sans pont ni rendu, le VST3 est ignoré (son sec).
 */
export async function prepareTracksForOffline(tracks: Track[], onStep?: (msg: string) => void): Promise<{ tracks: Track[]; missingVst: string[]; cleanup: () => void }> {
  const temp: string[] = [];
  const missingVst: string[] = [];
  const out: Track[] = [];
  for (const t of tracks) {
    if (isTrackFrozen(t) || !activeVst(t) || !canBakeTrack(t)) { out.push(t); continue; }
    if (t.frozenClip && !isFreezeStale(t) && freezeIndex(t) >= lastVstIndex(t)) {
      out.push({ ...t, isFrozen: true });
      continue;
    }
    if (novaBridge.isConnected()) {
      try {
        const r = await renderTrackFreeze(t, lastVstIndex(t), onStep);
        temp.push(r.clip.bufferId!);
        out.push({ ...t, isFrozen: true, frozenClip: r.clip, frozenUpToPluginIndex: r.upTo, frozenClipIds: r.clipIds, frozenSourceSig: r.sig });
        continue;
      } catch (e) {
        console.warn('[Export] Rendu VST impossible', e);
      }
    }
    missingVst.push(t.name);
    out.push(t);
  }
  return { tracks: out, missingVst, cleanup: () => temp.forEach(id => audioBufferRegistry.remove(id)) };
}
