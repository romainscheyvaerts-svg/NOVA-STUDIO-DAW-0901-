import type { DrumRow } from './drumKits';
import { loadDrumSound } from './drumSounds';
import { audioBufferRegistry } from './audioBufferRegistry';
import { clipRegionChannels, hasRegion, newSampleId, padLoadKey, padSampleKey, PadSampleInfo, regionOf, renderRegion, sampleLabel, userSampleId } from './drumSamples';

/**
 * Côté navigateur : son prêt à jouer d'un pad (bibliothèque, son Nova ou
 * sample perso), zone jouée appliquée (début / fin, fondus, reverse).
 */

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

export function bufferFrom(ctx: BaseAudioContext, chans: Float32Array[], sampleRate: number): AudioBuffer {
  const b = ctx.createBuffer(Math.max(1, chans.length), Math.max(1, chans[0]?.length || 1), sampleRate);
  chans.forEach((c, i) => b.getChannelData(i).set(c));
  return b;
}

const ready = new Map<string, Promise<AudioBuffer>>();

/** Son d'origine du pad (sans la zone). */
export async function padSourceBuffer(row: Pick<DrumRow, 'sound'>, ctx: BaseAudioContext, root = 0): Promise<AudioBuffer> {
  const id = userSampleId(row.sound);
  if (id) {
    const b = audioBufferRegistry.get(padSampleKey(id));
    if (!b) throw new Error('sample perso absent');
    return b;
  }
  return loadDrumSound(row.sound, ctx, root);
}

/** Son prêt à jouer (mis en cache par réglage de zone). */
export function loadPadBuffer(row: DrumRow, ctx: BaseAudioContext, root = 0): Promise<AudioBuffer> {
  if (!hasRegion(row)) return padSourceBuffer(row, ctx, root);
  const key = `${padLoadKey(row, root)}|${ctx.sampleRate}`;
  let p = ready.get(key);
  if (!p) {
    p = padSourceBuffer(row, ctx, root).then(src => bufferFrom(ctx, renderRegion(channelsOf(src), src.sampleRate, regionOf(row)), src.sampleRate));
    ready.set(key, p);
    p.catch(() => ready.delete(key));
    if (ready.size > 96) ready.delete(ready.keys().next().value as string);
  }
  return p;
}

/** Range un son dans le registre comme sample perso ; renvoie son id. */
export function registerPadSample(buffer: AudioBuffer, name: string, extra: Partial<PadSampleInfo> = {}): { id: string; info: PadSampleInfo } {
  const id = newSampleId();
  audioBufferRegistry.register(buffer, padSampleKey(id));
  return { id, info: { name: sampleLabel(name), duration: buffer.duration, ...extra } };
}

/** Fichier audio déposé → sample perso. */
export async function sampleFromFile(ctx: BaseAudioContext, file: File | Blob, name?: string): Promise<{ id: string; info: PadSampleInfo; buffer: AudioBuffer }> {
  const data = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(data);
  const r = registerPadSample(buffer, name || (file as File).name || 'Sample');
  return { ...r, buffer };
}

/** Clip de la session (zone jouée du clip) → sample perso. */
export function sampleFromClip(ctx: BaseAudioContext, source: AudioBuffer, clip: { name?: string; offset?: number; duration: number; isReversed?: boolean; gain?: number }): { id: string; info: PadSampleInfo; buffer: AudioBuffer } {
  const buffer = bufferFrom(ctx, clipRegionChannels(channelsOf(source), source.sampleRate, clip), source.sampleRate);
  const r = registerPadSample(buffer, clip.name || 'Clip');
  return { ...r, buffer };
}
