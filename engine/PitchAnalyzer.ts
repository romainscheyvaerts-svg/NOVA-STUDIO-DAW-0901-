/**
 * PitchAnalyzer
 * -------------
 * Offline pitch detection over an AudioBuffer using YIN-style autocorrelation.
 * Produces a list of voice segments (notes) suitable for a Melodyne-like editor.
 */

export interface PitchFrame {
  time: number;        // seconds
  frequency: number;   // Hz, 0 if unvoiced
  confidence: number;  // 0..1
  rms: number;         // 0..1 frame loudness
}

export interface PitchSegment {
  id: string;
  startTime: number;     // seconds, relative to buffer start
  endTime: number;       // seconds
  frequency: number;     // average detected frequency, Hz
  midiNote: number;      // average detected MIDI note (float for cents)
  centsOffset: number;   // offset from nearest equal-tempered note (-50..+50)
  confidence: number;    // average detection confidence
  targetMidi: number;    // user-chosen target MIDI note (initially === round(midiNote))
}

export interface AnalyzeOptions {
  windowMs?: number;     // analysis window (default 46ms)
  hopMs?: number;        // hop size (default 12ms)
  minHz?: number;        // min detectable pitch
  maxHz?: number;        // max detectable pitch
  rmsGate?: number;      // gate below which frame is unvoiced
}

const DEFAULTS: Required<AnalyzeOptions> = {
  windowMs: 46,
  hopMs: 12,
  minHz: 70,
  maxHz: 1200,
  rmsGate: 0.012,
};

export function freqToMidi(freq: number): number {
  if (freq <= 0) return 0;
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * YIN difference function followed by cumulative mean normalization.
 * Returns the best lag (in samples) for the most likely period, or -1.
 */
function yinDetect(buf: Float32Array, sampleRate: number, minHz: number, maxHz: number, threshold = 0.15): { freq: number; confidence: number } {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(buf.length - 1, Math.floor(sampleRate / minHz));
  const N = buf.length;
  const halfN = Math.floor(N / 2);
  if (tauMax >= halfN) return { freq: 0, confidence: 0 };

  // Step 1: difference function d(tau)
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < halfN; i++) {
      const diff = buf[i] - buf[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Step 2: cumulative mean normalized difference
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    runningSum += d[tau];
    cmnd[tau] = runningSum > 0 ? d[tau] * tau / runningSum : 1;
  }

  // Step 3: find first tau under threshold; otherwise pick global minimum
  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) {
    // fallback: lowest cmnd in range
    let best = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < best) {
        best = cmnd[tau];
        tauEstimate = tau;
      }
    }
    if (tauEstimate === -1 || best > 0.7) return { freq: 0, confidence: 0 };
  }

  // Step 4: parabolic interpolation around tauEstimate for sub-sample accuracy
  let betterTau = tauEstimate;
  if (tauEstimate > 1 && tauEstimate < tauMax) {
    const s0 = cmnd[tauEstimate - 1];
    const s1 = cmnd[tauEstimate];
    const s2 = cmnd[tauEstimate + 1];
    const denom = 2 * (2 * s1 - s0 - s2);
    if (denom !== 0) {
      betterTau = tauEstimate + (s2 - s0) / denom;
    }
  }
  const freq = sampleRate / betterTau;
  const confidence = Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]));
  return { freq, confidence };
}

function frameRMS(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/**
 * Mix all channels of an AudioBuffer down to a single Float32Array.
 */
function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

export function analyzeFrames(buffer: AudioBuffer, opts: AnalyzeOptions = {}): PitchFrame[] {
  const o = { ...DEFAULTS, ...opts };
  const sr = buffer.sampleRate;
  const windowSize = Math.max(256, Math.round((o.windowMs / 1000) * sr));
  const hopSize = Math.max(32, Math.round((o.hopMs / 1000) * sr));
  const mono = toMono(buffer);
  const frames: PitchFrame[] = [];

  for (let start = 0; start + windowSize <= mono.length; start += hopSize) {
    const slice = mono.subarray(start, start + windowSize);
    const rms = frameRMS(slice);
    if (rms < o.rmsGate) {
      frames.push({ time: start / sr, frequency: 0, confidence: 0, rms });
      continue;
    }
    const { freq, confidence } = yinDetect(slice, sr, o.minHz, o.maxHz);
    frames.push({ time: start / sr, frequency: freq, confidence, rms });
  }
  return frames;
}

/**
 * Group consecutive voiced frames into note segments.
 * A segment ends when:
 *   - the frame becomes unvoiced
 *   - the rounded MIDI note changes
 *   - a long enough silence/transition is detected
 */
export function segmentFrames(frames: PitchFrame[], minSegmentMs = 60): PitchSegment[] {
  const segments: PitchSegment[] = [];
  if (frames.length === 0) return segments;

  let active: { start: number; end: number; mids: number[]; freqs: number[]; confs: number[]; lastMidi: number } | null = null;
  const flush = () => {
    if (!active) return;
    const durationMs = (active.end - active.start) * 1000;
    if (durationMs < minSegmentMs) {
      active = null;
      return;
    }
    const avgFreq = active.freqs.reduce((a, b) => a + b, 0) / active.freqs.length;
    const avgMidi = active.mids.reduce((a, b) => a + b, 0) / active.mids.length;
    const avgConf = active.confs.reduce((a, b) => a + b, 0) / active.confs.length;
    const round = Math.round(avgMidi);
    const cents = (avgMidi - round) * 100;
    segments.push({
      id: `seg-${segments.length}-${Math.round(active.start * 1000)}`,
      startTime: active.start,
      endTime: active.end,
      frequency: avgFreq,
      midiNote: avgMidi,
      centsOffset: cents,
      confidence: avgConf,
      targetMidi: round,
    });
    active = null;
  };

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const next = frames[i + 1];
    const frameEnd = next ? next.time : f.time + 0.012;
    if (f.frequency > 0 && f.confidence > 0.4) {
      const midi = freqToMidi(f.frequency);
      const rounded = Math.round(midi);
      if (!active) {
        active = { start: f.time, end: frameEnd, mids: [midi], freqs: [f.frequency], confs: [f.confidence], lastMidi: rounded };
      } else if (Math.abs(rounded - active.lastMidi) >= 1) {
        flush();
        active = { start: f.time, end: frameEnd, mids: [midi], freqs: [f.frequency], confs: [f.confidence], lastMidi: rounded };
      } else {
        active.end = frameEnd;
        active.mids.push(midi);
        active.freqs.push(f.frequency);
        active.confs.push(f.confidence);
        active.lastMidi = rounded;
      }
    } else {
      flush();
    }
  }
  flush();
  return segments;
}

export function analyzeBuffer(buffer: AudioBuffer, opts: AnalyzeOptions = {}): { frames: PitchFrame[]; segments: PitchSegment[] } {
  const frames = analyzeFrames(buffer, opts);
  const segments = segmentFrames(frames);
  return { frames, segments };
}

/**
 * Snap a MIDI note to the nearest scale degree given a root key (0..11) and a scale name.
 */
export const SCALE_INTERVALS: Record<string, number[]> = {
  CHROMATIC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  MAJOR: [0, 2, 4, 5, 7, 9, 11],
  MINOR: [0, 2, 3, 5, 7, 8, 10],
  MINOR_HARMONIC: [0, 2, 3, 5, 7, 8, 11],
  PENTATONIC_MAJOR: [0, 2, 4, 7, 9],
  PENTATONIC_MINOR: [0, 3, 5, 7, 10],
  DORIAN: [0, 2, 3, 5, 7, 9, 10],
  MIXOLYDIAN: [0, 2, 4, 5, 7, 9, 10],
};

export function snapMidiToScale(midi: number, rootKey: number, scaleName: keyof typeof SCALE_INTERVALS | string): number {
  const intervals = SCALE_INTERVALS[scaleName] || SCALE_INTERVALS.CHROMATIC;
  const octave = Math.floor((midi - rootKey) / 12);
  const noteInOctave = ((Math.round(midi) - rootKey) % 12 + 12) % 12;
  let best = intervals[0];
  let bestDiff = Infinity;
  for (const interval of intervals) {
    const candidates = [interval, interval + 12, interval - 12];
    for (const c of candidates) {
      const diff = Math.abs(noteInOctave - c);
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
  }
  return rootKey + octave * 12 + best;
}
