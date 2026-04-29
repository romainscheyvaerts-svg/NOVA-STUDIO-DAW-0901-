/**
 * PitchShifter
 * ------------
 * Offline pitch shifter that renders a corrected AudioBuffer given a list of
 * pitch segments and target MIDI notes.
 *
 * The implementation uses a simple time-domain SOLA-style approach
 * (overlap-add of small grains) so it stays fully self-contained and works
 * inside the browser without any external WASM/PSOLA library.
 *
 * For each pitch segment we resample the underlying region at the desired
 * pitch ratio and time-stretch it back to the original duration via grain
 * overlap. Unvoiced regions are left untouched.
 */

import { PitchSegment, midiToFreq } from './PitchAnalyzer';

export interface RenderOptions {
  formantPreserve?: boolean; // unused placeholder for future improvements
  grainMs?: number;          // grain length (default 35ms)
  overlap?: number;          // 0..0.9 grain overlap factor (default 0.5)
}

const DEFAULT_OPTIONS: Required<RenderOptions> = {
  formantPreserve: false,
  grainMs: 35,
  overlap: 0.5,
};

function copyChannel(src: Float32Array, dst: Float32Array, dstOffset: number, length: number) {
  const end = Math.min(length, src.length, dst.length - dstOffset);
  for (let i = 0; i < end; i++) dst[dstOffset + i] += src[i];
}

/**
 * Resample a region by the given ratio (output is `len / ratio` samples).
 * Linear interpolation; ratio > 1 = pitch up (and shorter), ratio < 1 = pitch down (longer).
 */
function resampleLinear(src: Float32Array, ratio: number): Float32Array {
  if (ratio <= 0 || !isFinite(ratio)) return src.slice();
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const a = src[i0] || 0;
    const b = src[i0 + 1] || a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function makeHann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

/**
 * Pitch-shift a single channel region by `ratio` while keeping its original
 * length. Uses overlap-add of resampled grains (SOLA-lite).
 */
function pitchShiftRegion(channel: Float32Array, ratio: number, sampleRate: number, opts: Required<RenderOptions>): Float32Array {
  const out = new Float32Array(channel.length);
  if (Math.abs(ratio - 1) < 1e-4) {
    out.set(channel);
    return out;
  }
  const grainSize = Math.max(128, Math.floor((opts.grainMs / 1000) * sampleRate));
  const hop = Math.max(32, Math.floor(grainSize * (1 - opts.overlap)));
  const window = makeHann(grainSize);
  const norm = new Float32Array(channel.length);

  for (let outStart = 0; outStart < channel.length; outStart += hop) {
    // Determine source grain start so that pitch-shifted output covers the same span
    const srcStart = outStart; // SOLA preserves time domain alignment
    const srcEnd = Math.min(channel.length, srcStart + grainSize);
    const grainSrc = channel.subarray(srcStart, srcEnd);
    if (grainSrc.length < 8) break;

    // Resample then truncate/pad to grainSize so overlap-add is uniform
    const resampled = resampleLinear(grainSrc, ratio);
    const padded = new Float32Array(grainSize);
    const copyLen = Math.min(resampled.length, grainSize);
    for (let i = 0; i < copyLen; i++) padded[i] = resampled[i];

    // Apply window and accumulate
    for (let i = 0; i < grainSize; i++) {
      const dst = outStart + i;
      if (dst >= out.length) break;
      const w = window[i];
      out[dst] += padded[i] * w;
      norm[dst] += w;
    }
  }

  for (let i = 0; i < out.length; i++) {
    if (norm[i] > 1e-6) out[i] /= norm[i];
  }
  return out;
}

/**
 * Apply pitch corrections to an AudioBuffer offline and return a new buffer
 * of identical length. Segments outside the buffer or with targetMidi equal
 * to detected midiNote are passed through untouched.
 */
export async function renderCorrectedBuffer(
  source: AudioBuffer,
  segments: PitchSegment[],
  options: RenderOptions = {}
): Promise<AudioBuffer> {
  const opts: Required<RenderOptions> = { ...DEFAULT_OPTIONS, ...options };
  const sr = source.sampleRate;
  const channels = source.numberOfChannels;
  const length = source.length;

  const Ctor = (typeof window !== 'undefined' && (window as any).OfflineAudioContext) || (globalThis as any).OfflineAudioContext;
  const offlineCtx: OfflineAudioContext = Ctor
    ? new Ctor(channels, length, sr)
    : new OfflineAudioContext(channels, length, sr);
  const out = offlineCtx.createBuffer(channels, length, sr);

  // Start by copying source unchanged; we'll overwrite per-segment ranges.
  for (let ch = 0; ch < channels; ch++) {
    out.getChannelData(ch).set(source.getChannelData(ch));
  }

  for (const seg of segments) {
    const detectedFreq = seg.frequency;
    if (detectedFreq <= 0) continue;
    const targetFreq = midiToFreq(seg.targetMidi);
    if (!isFinite(targetFreq) || targetFreq <= 0) continue;
    const ratio = targetFreq / detectedFreq;
    if (Math.abs(ratio - 1) < 1e-4) continue;

    const startSample = Math.max(0, Math.floor(seg.startTime * sr));
    const endSample = Math.min(length, Math.floor(seg.endTime * sr));
    const segLen = endSample - startSample;
    if (segLen <= 64) continue;

    for (let ch = 0; ch < channels; ch++) {
      const srcCh = source.getChannelData(ch);
      const region = srcCh.subarray(startSample, endSample);
      const shifted = pitchShiftRegion(region.slice(), ratio, sr, opts);
      const dst = out.getChannelData(ch);
      // Cross-fade 8ms at boundaries to avoid clicks against untouched audio
      const fadeSamples = Math.min(Math.floor(0.008 * sr), Math.floor(segLen / 4));
      for (let i = 0; i < segLen; i++) {
        let mix = 1;
        if (i < fadeSamples) mix = i / fadeSamples;
        else if (i > segLen - fadeSamples) mix = Math.max(0, (segLen - i) / fadeSamples);
        const original = srcCh[startSample + i];
        const corrected = shifted[i];
        dst[startSample + i] = original * (1 - mix) + corrected * mix;
      }
    }
  }

  return out;
}
