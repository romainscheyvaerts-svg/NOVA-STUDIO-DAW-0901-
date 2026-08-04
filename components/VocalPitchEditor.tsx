import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { analyzeBuffer, PitchSegment, snapMidiToScale, SCALE_INTERVALS } from '../engine/PitchAnalyzer';
import { renderCorrectedBuffer } from '../engine/PitchShifter';

interface VocalPitchEditorProps {
  clipName: string;
  bufferId: string;
  bpm: number;
  initialKey?: number;
  initialScale?: keyof typeof SCALE_INTERVALS | string;
  onApply: (newBufferId: string, newAudioRef: string) => void;
  onClose: () => void;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ROW_HEIGHT = 18;
const PIXELS_PER_SECOND_DEFAULT = 90;
const DEFAULT_RANGE = 36; // semitones shown

const SCALE_OPTIONS: (keyof typeof SCALE_INTERVALS)[] = [
  'CHROMATIC', 'MAJOR', 'MINOR', 'MINOR_HARMONIC', 'PENTATONIC_MAJOR', 'PENTATONIC_MINOR', 'DORIAN', 'MIXOLYDIAN'
];

function midiLabel(midi: number) {
  const m = Math.round(midi);
  const note = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${note}${octave}`;
}

function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  // Minimal 16-bit PCM WAV writer (interleaved)
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

const VocalPitchEditor: React.FC<VocalPitchEditorProps> = ({ clipName, bufferId, initialKey = 0, initialScale = 'CHROMATIC', onApply, onClose }) => {
  const buffer = useMemo(() => audioBufferRegistry.get(bufferId), [bufferId]);
  const [phase, setPhase] = useState<'ANALYZE' | 'EDIT' | 'RENDER'>('ANALYZE');
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<PitchSegment[]>([]);
  const [waveformPeaks, setWaveformPeaks] = useState<Float32Array | null>(null);
  const [rootKey, setRootKey] = useState<number>(initialKey);
  const [scaleName, setScaleName] = useState<string>(typeof initialScale === 'string' ? initialScale : 'CHROMATIC');
  const [pixelsPerSecond, setPixelsPerSecond] = useState<number>(PIXELS_PER_SECOND_DEFAULT);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);

  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const minMidi = useMemo(() => {
    if (segments.length === 0) return 48;
    let m = Infinity;
    for (const s of segments) m = Math.min(m, s.targetMidi, Math.round(s.midiNote));
    return Math.max(24, Math.floor(m) - 4);
  }, [segments]);
  const maxMidi = minMidi + DEFAULT_RANGE;

  // Run analysis once
  useEffect(() => {
    if (!buffer) {
      setError('Audio introuvable pour ce clip.');
      return;
    }
    let cancelled = false;
    setPhase('ANALYZE');
    // Defer to next tick so the UI shows the loader before heavy CPU work.
    const id = window.setTimeout(() => {
      try {
        const { segments: detected } = analyzeBuffer(buffer);
        if (cancelled) return;
        setSegments(detected);

        // Build a low-resolution waveform peak array for background rendering
        const totalPx = Math.max(800, Math.ceil(buffer.duration * pixelsPerSecond));
        const peaks = new Float32Array(totalPx);
        const data = buffer.getChannelData(0);
        const samplesPerPx = data.length / totalPx;
        for (let p = 0; p < totalPx; p++) {
          const start = Math.floor(p * samplesPerPx);
          const end = Math.min(data.length, Math.floor((p + 1) * samplesPerPx));
          let max = 0;
          for (let i = start; i < end; i++) {
            const v = Math.abs(data[i]);
            if (v > max) max = v;
          }
          peaks[p] = max;
        }
        setWaveformPeaks(peaks);
        setPhase('EDIT');
      } catch (e: any) {
        console.error('[VocalPitchEditor] Analysis failed', e);
        setError(e?.message || 'Analyse impossible.');
      }
    }, 50);
    return () => { cancelled = true; clearTimeout(id); };
  }, [buffer, pixelsPerSecond]);

  // Stop preview when unmounting
  useEffect(() => {
    return () => {
      try { previewSourceRef.current?.stop(); } catch {}
      previewSourceRef.current = null;
    };
  }, []);

  const handleSnapAll = useCallback(() => {
    setSegments(prev => prev.map(s => ({
      ...s,
      targetMidi: snapMidiToScale(s.midiNote, rootKey, scaleName as any),
    })));
  }, [rootKey, scaleName]);

  const handleResetTargets = useCallback(() => {
    setSegments(prev => prev.map(s => ({ ...s, targetMidi: Math.round(s.midiNote) })));
  }, []);

  const handleSegmentMouseDown = (segId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingId(segId);
    const startY = e.clientY;
    const seg = segments.find(s => s.id === segId);
    if (!seg) return;
    const startMidi = seg.targetMidi;

    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY; // up = positive
      const deltaSemi = Math.round(dy / ROW_HEIGHT);
      setSegments(prev => prev.map(s => s.id === segId ? { ...s, targetMidi: Math.max(0, Math.min(127, startMidi + deltaSemi)) } : s));
    };
    const onUp = () => {
      setDraggingId(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleSegmentDoubleClick = (segId: string) => () => {
    setSegments(prev => prev.map(s => s.id === segId ? { ...s, targetMidi: snapMidiToScale(s.midiNote, rootKey, scaleName as any) } : s));
  };

  const playPreview = useCallback(async (corrected: AudioBuffer) => {
    try {
      try { previewSourceRef.current?.stop(); } catch {}
      if (!audioEngine.ctx) await audioEngine.init();
      const ctx = audioEngine.ctx!;
      if (ctx.state === 'suspended') await ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = corrected;
      src.connect(ctx.destination);
      src.onended = () => { setPreviewing(false); previewSourceRef.current = null; };
      src.start();
      previewSourceRef.current = src;
      setPreviewing(true);
    } catch (e) {
      console.error('[VocalPitchEditor] preview failed', e);
      setPreviewing(false);
    }
  }, []);

  const handleStopPreview = useCallback(() => {
    try { previewSourceRef.current?.stop(); } catch {}
    previewSourceRef.current = null;
    setPreviewing(false);
  }, []);

  const handlePreview = useCallback(async () => {
    if (!buffer || phase === 'RENDER') return;
    setPhase('RENDER');
    setRenderProgress(20);
    try {
      const corrected = await renderCorrectedBuffer(buffer, segments);
      setRenderProgress(100);
      setPhase('EDIT');
      await playPreview(corrected);
    } catch (e: any) {
      console.error('[VocalPitchEditor] preview render failed', e);
      setError(e?.message || 'Pré-écoute impossible.');
      setPhase('EDIT');
    }
  }, [buffer, segments, phase, playPreview]);

  const handleApply = useCallback(async () => {
    if (!buffer || phase === 'RENDER') return;
    handleStopPreview();
    setPhase('RENDER');
    setRenderProgress(10);
    try {
      const corrected = await renderCorrectedBuffer(buffer, segments);
      setRenderProgress(70);
      const blob = audioBufferToWavBlob(corrected);
      const url = URL.createObjectURL(blob);
      const newId = `clip-tuned-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      audioBufferRegistry.registerWithUrl(corrected, url, newId);
      setRenderProgress(100);
      onApply(newId, url);
    } catch (e: any) {
      console.error('[VocalPitchEditor] apply failed', e);
      setError(e?.message || 'Application impossible.');
      setPhase('EDIT');
    }
  }, [buffer, segments, phase, onApply, handleStopPreview]);

  if (!buffer) {
    return (
      <div className="fixed inset-0 z-[400] bg-black/90 flex items-center justify-center">
        <div className="bg-[#0f1115] border border-red-500/30 p-10 rounded-3xl text-center max-w-md">
          <i className="fas fa-bug text-3xl text-red-500 mb-3"></i>
          <p className="text-white text-sm font-bold mb-4">{error || "Aucun audio chargé pour ce clip."}</p>
          <button onClick={onClose} className="px-6 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-xs uppercase tracking-widest text-white">Fermer</button>
        </div>
      </div>
    );
  }

  const totalDuration = buffer.duration;
  const totalWidth = Math.max(800, Math.ceil(totalDuration * pixelsPerSecond));
  const visibleRange = maxMidi - minMidi + 1;
  const gridHeight = visibleRange * ROW_HEIGHT;

  return (
    <div className="fixed inset-0 z-[400] bg-black/95 backdrop-blur-md flex flex-col">
      {/* Header */}
      <div className="h-14 shrink-0 px-6 flex items-center justify-between bg-[#0f1115] border-b border-white/10">
        <div className="flex items-center space-x-4">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <i className="fas fa-microphone-alt"></i>
          </div>
          <div>
            <div className="text-[11px] font-black text-white uppercase tracking-[0.25em]">Vocal Pitch Editor</div>
            <div className="text-[10px] text-slate-500 mono truncate max-w-xs">{clipName}</div>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2">
            <span className="text-[9px] uppercase font-black tracking-widest text-slate-500">Key</span>
            <select value={rootKey} onChange={(e) => setRootKey(parseInt(e.target.value))} className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1 font-mono">
              {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
            </select>
            <select value={scaleName} onChange={(e) => setScaleName(e.target.value)} className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1 font-mono">
              {SCALE_OPTIONS.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>
          <button
            onClick={handleSnapAll}
            disabled={phase !== 'EDIT'}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
          >
            <i className="fas fa-magnet mr-2"></i>Snap All
          </button>
          <button
            onClick={handleResetTargets}
            disabled={phase !== 'EDIT'}
            className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
          >
            <i className="fas fa-undo mr-2"></i>Reset
          </button>
          {!previewing ? (
            <button
              onClick={handlePreview}
              disabled={phase !== 'EDIT'}
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white border border-white/10 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
            >
              <i className="fas fa-play mr-2"></i>Pré-écouter
            </button>
          ) : (
            <button
              onClick={handleStopPreview}
              className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 text-[10px] font-black uppercase tracking-widest"
            >
              <i className="fas fa-stop mr-2"></i>Stop
            </button>
          )}
          <button
            onClick={handleApply}
            disabled={phase !== 'EDIT'}
            className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black border border-cyan-400 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
          >
            <i className="fas fa-check mr-2"></i>Appliquer
          </button>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-white/5 hover:bg-red-500/30 text-slate-400 hover:text-white flex items-center justify-center">
            <i className="fas fa-times"></i>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Piano keys */}
        <div className="w-16 shrink-0 bg-[#0c0d10] border-r border-white/5 overflow-hidden">
          <div style={{ height: gridHeight }}>
            {Array.from({ length: visibleRange }).map((_, i) => {
              const midi = maxMidi - i;
              const isBlack = [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
              const isC = ((midi % 12) + 12) % 12 === 0;
              return (
                <div
                  key={midi}
                  className={`flex items-center justify-end pr-2 text-[9px] font-mono border-b border-white/5 ${isBlack ? 'bg-black/60 text-slate-600' : 'bg-white/5 text-slate-300'} ${isC ? 'border-b-cyan-500/30' : ''}`}
                  style={{ height: ROW_HEIGHT }}
                >
                  {midiLabel(midi)}
                </div>
              );
            })}
          </div>
        </div>

        {/* Timeline + segments */}
        <div className="flex-1 overflow-auto relative">
          {phase === 'ANALYZE' && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70">
              <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-4"></div>
              <p className="text-[10px] text-slate-300 uppercase tracking-widest font-black">Analyse de la prise vocale...</p>
            </div>
          )}
          {phase === 'RENDER' && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70">
              <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-4"></div>
              <p className="text-[10px] text-slate-300 uppercase tracking-widest font-black">Application de la correction... {renderProgress}%</p>
            </div>
          )}

          <div className="relative" style={{ width: totalWidth, height: gridHeight }}>
            {/* Grid lines */}
            <div className="absolute inset-0 pointer-events-none">
              {Array.from({ length: visibleRange + 1 }).map((_, i) => {
                const midi = maxMidi - i;
                const isC = ((midi % 12) + 12) % 12 === 0;
                return (
                  <div
                    key={i}
                    className={`absolute left-0 right-0 ${isC ? 'border-t border-cyan-500/15' : 'border-t border-white/[0.04]'}`}
                    style={{ top: i * ROW_HEIGHT }}
                  />
                );
              })}
              {Array.from({ length: Math.ceil(totalDuration) + 1 }).map((_, sec) => (
                <div
                  key={`sec-${sec}`}
                  className="absolute top-0 bottom-0 border-l border-white/[0.05]"
                  style={{ left: sec * pixelsPerSecond }}
                >
                  <div className="absolute -top-0 left-1 text-[8px] font-mono text-slate-600">{sec}s</div>
                </div>
              ))}
            </div>

            {/* Waveform background */}
            {waveformPeaks && (
              <svg className="absolute inset-x-0 pointer-events-none" style={{ top: gridHeight - 60, height: 60, width: totalWidth }} viewBox={`0 0 ${totalWidth} 60`} preserveAspectRatio="none">
                <path
                  d={(() => {
                    let d = `M0 30`;
                    for (let i = 0; i < waveformPeaks.length; i++) {
                      d += ` L${i} ${30 - waveformPeaks[i] * 28}`;
                    }
                    for (let i = waveformPeaks.length - 1; i >= 0; i--) {
                      d += ` L${i} ${30 + waveformPeaks[i] * 28}`;
                    }
                    return d + ' Z';
                  })()}
                  fill="rgba(0,242,255,0.08)"
                />
              </svg>
            )}

            {/* Segments */}
            {segments.map(seg => {
              const detectedMidi = Math.round(seg.midiNote);
              const targetMidi = seg.targetMidi;
              const detectedRow = maxMidi - detectedMidi;
              const targetRow = maxMidi - targetMidi;
              const left = seg.startTime * pixelsPerSecond;
              const width = Math.max(6, (seg.endTime - seg.startTime) * pixelsPerSecond);
              const isDragging = draggingId === seg.id;
              const isHover = hoverId === seg.id;
              const moved = detectedMidi !== targetMidi;
              const cents = seg.centsOffset.toFixed(0);
              return (
                <React.Fragment key={seg.id}>
                  {/* Original ghost */}
                  {moved && (
                    <div
                      className="absolute rounded-md pointer-events-none"
                      style={{
                        top: detectedRow * ROW_HEIGHT + 2,
                        left,
                        width,
                        height: ROW_HEIGHT - 4,
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px dashed rgba(255,255,255,0.18)',
                      }}
                    />
                  )}
                  {/* Active block */}
                  <div
                    onMouseDown={handleSegmentMouseDown(seg.id)}
                    onDoubleClick={handleSegmentDoubleClick(seg.id)}
                    onMouseEnter={() => setHoverId(seg.id)}
                    onMouseLeave={() => setHoverId(prev => prev === seg.id ? null : prev)}
                    className={`absolute rounded-md cursor-ns-resize select-none transition-shadow ${isDragging ? 'shadow-[0_0_18px_rgba(0,242,255,0.6)]' : ''}`}
                    style={{
                      top: targetRow * ROW_HEIGHT + 2,
                      left,
                      width,
                      height: ROW_HEIGHT - 4,
                      background: moved ? 'linear-gradient(180deg, rgba(0,242,255,0.85), rgba(0,180,210,0.7))' : 'linear-gradient(180deg, rgba(168,85,247,0.85), rgba(124,58,237,0.7))',
                      border: '1px solid rgba(255,255,255,0.25)',
                      opacity: 0.4 + Math.min(0.55, seg.confidence * 0.7),
                    }}
                    title={`${midiLabel(detectedMidi)} → ${midiLabel(targetMidi)} (${cents}¢)`}
                  >
                    <div className="px-1.5 py-0.5 text-[8.5px] font-black text-white truncate flex items-center gap-1">
                      <span>{midiLabel(targetMidi)}</span>
                      {moved && <span className="opacity-70">·{targetMidi - detectedMidi > 0 ? '+' : ''}{targetMidi - detectedMidi}st</span>}
                      {isHover && <span className="ml-auto opacity-60">{cents}¢</span>}
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="h-9 shrink-0 px-4 flex items-center justify-between bg-[#0c0d10] border-t border-white/5 text-[9px] uppercase tracking-widest text-slate-500 font-black">
        <span><i className="fas fa-microchip mr-2"></i>{segments.length} segments détectés</span>
        <span>Glisser ↑↓ : retune · Double-clic : snap to scale · Pré-écouter avant d'appliquer</span>
        <div className="flex items-center space-x-2">
          <button onClick={() => setPixelsPerSecond(p => Math.max(40, p - 20))} className="w-6 h-6 rounded bg-white/5 hover:bg-white/10 text-white">-</button>
          <span className="mono text-slate-400">{pixelsPerSecond}px/s</span>
          <button onClick={() => setPixelsPerSecond(p => Math.min(240, p + 20))} className="w-6 h-6 rounded bg-white/5 hover:bg-white/10 text-white">+</button>
        </div>
      </div>
    </div>
  );
};

export default VocalPitchEditor;
