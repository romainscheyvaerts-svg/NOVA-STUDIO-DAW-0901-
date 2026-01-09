
import React, { useState, useEffect, useRef } from 'react';
import { PluginInstance } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import WaveformRenderer from './WaveformRenderer';
import { MelodicSamplerNode, MelodicSamplerParams } from '../engine/MelodicSamplerNode';
import { midiManager } from '../services/MidiManager'; // NEW

interface MelodicSamplerEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onClose: () => void;
}

const MelodicSamplerEditor: React.FC<MelodicSamplerEditorProps> = ({ plugin, trackId, onClose }) => {
  const [params, setParams] = useState<MelodicSamplerParams>({
    rootKey: 60, fineTune: 0, glide: 0.05, loop: true, loopStart: 0, loopEnd: 1,
    attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.5,
    filterCutoff: 20000, filterRes: 0, velocityToFilter: 0.5,
    lfoRate: 4, lfoAmount: 0, lfoDest: 'PITCH',
    saturation: 0, bitCrush: 0, chorus: 0, width: 0.5, isEnabled: true
  });
  
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("Drag & Drop Audio");
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set()); // NEW
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nodeRef = useRef<MelodicSamplerNode | null>(null);

  useEffect(() => {
     const node = audioEngine.getMelodicSamplerNode(trackId);
     if (node) {
         nodeRef.current = node;
         setParams(node.getParams());
         if (node.getBuffer()) {
             setBuffer(node.getBuffer());
             setFileName("Instrument Loaded");
         }
     }
  }, [trackId]);

  // NEW: MIDI Listener
  useEffect(() => {
      const unsub = midiManager.addNoteListener((cmd, note, vel) => {
          // Note On
          if (cmd === 144 && vel > 0) {
              setActiveNotes(prev => new Set(prev).add(note));
          } 
          // Note Off
          else if (cmd === 128 || (cmd === 144 && vel === 0)) {
              setActiveNotes(prev => {
                  const next = new Set(prev);
                  next.delete(note);
                  return next;
              });
          }
      });
      return unsub;
  }, []);

  const updateParam = (key: keyof MelodicSamplerParams, value: any) => {
      const newParams = { ...params, [key]: value };
      setParams(newParams);
      if (nodeRef.current) {
          nodeRef.current.updateParams({ [key]: value });
      }
  };

  const handleFileDrop = async (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadFile(file);
  };

  const loadFile = async (file: File) => {
      setFileName(file.name);
      try {
          const arrayBuffer = await file.arrayBuffer();
          await audioEngine.init();
          const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          setBuffer(audioBuffer);
          audioEngine.loadSamplerBuffer(trackId, audioBuffer);
          nodeRef.current = audioEngine.getMelodicSamplerNode(trackId);
      } catch (e) {
          console.error("Melodic Load Error:", e);
          setFileName("Error Loading File");
      }
  };

  const playNote = (pitch: number) => {
      if (nodeRef.current) {
          nodeRef.current.triggerAttack(pitch, 0.8, 0);
          setActiveNotes(prev => new Set(prev).add(pitch)); // Local feedback
      }
  };

  const stopNote = (pitch: number) => {
      if (nodeRef.current) {
          nodeRef.current.triggerRelease(pitch, 0);
          setActiveNotes(prev => {
             const next = new Set(prev);
             next.delete(pitch);
             return next;
          });
      }
  };

  return (
    <div className="w-[900px] bg-[#0c0d10] border border-cyan-500/20 rounded-[40px] p-8 shadow-[0_0_100px_rgba(6,182,212,0.1)] flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none text-white">
        {/* Header */}
        <div className="flex justify-between items-center">
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-lg shadow-cyan-500/5">
                    <i className="fas fa-wave-square text-xl"></i>
                </div>
                <div>
                    <h2 className="text-lg font-black uppercase italic tracking-tighter leading-none">Melodic <span className="text-cyan-400">Sampler</span></h2>
                    <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">Polyphonic Texture Engine</p>
                </div>
            </div>
            <button onClick={onClose} className="w-10 h-10 rounded-full flex items-center justify-center border bg-white/5 border-white/10 text-slate-600 hover:text-white transition-all">
                <i className="fas fa-times"></i>
            </button>
        </div>

        {/* Waveform & Loop Editor */}
        <div 
            className="h-40 bg-black/60 rounded-[28px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName !== 'INPUT') fileInputRef.current?.click();
            }}
        >
            {buffer ? (
                <div className="absolute inset-0 w-full h-full">
                    <WaveformRenderer 
                        buffer={buffer} 
                        color="#22d3ee" 
                        height={160} 
                        offset={0} 
                        duration={buffer.duration} 
                        pixelsPerSecond={900 / buffer.duration} 
                    />
                    {params.loop && (
                        <>
                            <div className="absolute top-0 bottom-0 left-0 bg-black/60 pointer-events-none transition-all" style={{ width: `${params.loopStart * 100}%` }} />
                            <div className="absolute top-0 bottom-0 right-0 bg-black/60 pointer-events-none transition-all" style={{ width: `${(1 - params.loopEnd) * 100}%` }} />
                            {/* Loop Markers */}
                            <div className="absolute top-0 bottom-0 w-0.5 bg-green-400 cursor-ew-resize hover:w-1 transition-all z-10 shadow-[0_0_10px_#4ade80]" style={{ left: `${params.loopStart * 100}%` }} 
                                onClick={e => e.stopPropagation()}
                                onMouseDown={(e) => {
                                    e.stopPropagation();
                                    const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                                    const onMove = (m: MouseEvent) => updateParam('loopStart', Math.max(0, Math.min(params.loopEnd - 0.01, (m.clientX - rect.left) / rect.width)));
                                    window.addEventListener('mousemove', onMove);
                                    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
                                }}
                            />
                            <div className="absolute top-0 bottom-0 w-0.5 bg-red-400 cursor-ew-resize hover:w-1 transition-all z-10 shadow-[0_0_10px_#f87171]" style={{ left: `${params.loopEnd * 100}%` }}
                                onClick={e => e.stopPropagation()}
                                onMouseDown={(e) => {
                                    e.stopPropagation();
                                    const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                                    const onMove = (m: MouseEvent) => updateParam('loopEnd', Math.max(params.loopStart + 0.01, Math.min(1, (m.clientX - rect.left) / rect.width)));
                                    window.addEventListener('mousemove', onMove);
                                    window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
                                }}
                            />
                        </>
                    )}
                </div>
            ) : (
                <div className="text-center opacity-40">
                    <i className="fas fa-music text-3xl mb-2"></i>
                    <p className="text-[9px] font-black uppercase tracking-widest">Drop Sample Here</p>
                </div>
            )}
            <div className="absolute bottom-2 left-4 text-[8px] font-mono text-cyan-500 bg-black/50 px-2 rounded">
                {fileName}
            </div>
            <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={handleFileSelect} onClick={(e) => e.stopPropagation()} />
        </div>

        {/* CONTROLS GRID */}
        <div className="grid grid-cols-10 gap-6">
            
            {/* 1. TUNING & LOOP */}
            <div className="col-span-2 space-y-4">
                <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Tuning</h3>
                <div className="grid grid-cols-2 gap-4">
                    <MKnob label="Root" value={(params.rootKey) / 127} displayVal={`MIDI ${params.rootKey}`} onChange={v => updateParam('rootKey', Math.round(v * 127))} />
                    <MKnob label="Fine" value={(params.fineTune + 100) / 200} displayVal={`${Math.round(params.fineTune)}ct`} onChange={v => updateParam('fineTune', (v * 200) - 100)} />
                    <MKnob label="Glide" value={params.glide} displayVal={`${Math.round(params.glide * 1000)}ms`} onChange={v => updateParam('glide', v)} />
                    <button onClick={() => updateParam('loop', !params.loop)} className={`h-12 rounded-xl text-[9px] font-black uppercase border transition-all ${params.loop ? 'bg-cyan-500 text-black border-cyan-400' : 'bg-white/5 text-slate-500 border-white/10'}`}>
                        Loop
                    </button>
                </div>
            </div>

            {/* 2. ENVELOPE */}
            <div className="col-span-3 space-y-4 border-l border-white/5 pl-6">
                <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Amp Envelope</h3>
                <div className="grid grid-cols-4 gap-2">
                    <MKnob label="Atk" value={params.attack * 2} displayVal={`${Math.round(params.attack * 1000)}ms`} onChange={v => updateParam('attack', v/2)} color="#10b981" />
                    <MKnob label="Dec" value={params.decay} displayVal={`${Math.round(params.decay * 1000)}ms`} onChange={v => updateParam('decay', v)} color="#10b981" />
                    <MKnob label="Sus" value={params.sustain} displayVal={`${Math.round(params.sustain * 100)}%`} onChange={v => updateParam('sustain', v)} color="#10b981" />
                    <MKnob label="Rel" value={params.release} displayVal={`${Math.round(params.release * 1000)}ms`} onChange={v => updateParam('release', v)} color="#10b981" />
                </div>
            </div>

            {/* 3. FILTER & LFO */}
            <div className="col-span-3 space-y-4 border-l border-white/5 pl-6">
                <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Filter & LFO</h3>
                <div className="grid grid-cols-4 gap-2">
                    <MKnob label="Cutoff" value={Math.log10(params.filterCutoff / 20) / Math.log10(1000)} displayVal={`${Math.round(params.filterCutoff)}Hz`} onChange={v => updateParam('filterCutoff', 20 * Math.pow(1000, v))} color="#f59e0b" />
                    <MKnob label="Res" value={params.filterRes / 20} displayVal={params.filterRes.toFixed(1)} onChange={v => updateParam('filterRes', v * 20)} color="#f59e0b" />
                    <MKnob label="LFO Hz" value={params.lfoRate / 20} displayVal={`${params.lfoRate.toFixed(1)}Hz`} onChange={v => updateParam('lfoRate', v * 20)} color="#8b5cf6" />
                    <MKnob label="LFO Amt" value={params.lfoAmount} displayVal={`${Math.round(params.lfoAmount * 100)}%`} onChange={v => updateParam('lfoAmount', v)} color="#8b5cf6" />
                </div>
                <div className="flex bg-white/5 p-1 rounded-lg">
                    {['PITCH', 'FILTER', 'VOLUME'].map(d => (
                        <button key={d} onClick={() => updateParam('lfoDest', d)} className={`flex-1 py-1 text-[7px] font-bold rounded ${params.lfoDest === d ? 'bg-violet-500 text-white' : 'text-slate-500'}`}>{d}</button>
                    ))}
                </div>
            </div>

            {/* 4. FX */}
            <div className="col-span-2 space-y-4 border-l border-white/5 pl-6">
                <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Effects</h3>
                <div className="grid grid-cols-2 gap-4">
                    <MKnob label="Drive" value={params.saturation} displayVal={`${Math.round(params.saturation * 100)}%`} onChange={v => updateParam('saturation', v)} color="#ef4444" />
                    <MKnob label="Crush" value={params.bitCrush} displayVal={`${Math.round(params.bitCrush * 100)}%`} onChange={v => updateParam('bitCrush', v)} color="#ef4444" />
                    <MKnob label="Width" value={params.width} displayVal={`${Math.round(params.width * 100)}%`} onChange={v => updateParam('width', v)} color="#3b82f6" />
                </div>
            </div>
        </div>

        {/* VIRTUAL KEYBOARD */}
        <div className="h-24 bg-black/40 rounded-xl border-t-4 border-white/5 flex overflow-hidden relative">
            {Array.from({ length: 24 }).map((_, i) => {
                const pitch = 48 + i; // Start C3
                const isBlack = [1, 3, 6, 8, 10].includes(i % 12);
                const noteName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][i % 12];
                if (isBlack) return null; // Render separately
                
                const isActive = activeNotes.has(pitch);

                return (
                    <div 
                        key={i} 
                        className={`flex-1 border-r border-gray-300 transition-colors cursor-pointer relative ${isActive ? 'bg-cyan-300' : 'bg-white hover:bg-gray-100 active:bg-cyan-200'}`}
                        onMouseDown={() => playNote(pitch)}
                        onMouseUp={() => stopNote(pitch)}
                        onMouseLeave={() => stopNote(pitch)}
                    >
                        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[8px] text-gray-400 font-bold">{noteName}</span>
                    </div>
                );
            })}
            {/* Black Keys Layer */}
            <div className="absolute inset-0 pointer-events-none flex">
                 {Array.from({ length: 24 }).map((_, i) => {
                    const pitch = 48 + i;
                    const isBlack = [1, 3, 6, 8, 10].includes(i % 12);
                    if (!isBlack) return <div key={i} className="flex-1"></div>;
                    
                    const isActive = activeNotes.has(pitch);

                    return (
                        <div 
                            key={i} 
                            className={`w-6 h-[60%] rounded-b-lg absolute pointer-events-auto cursor-pointer transition-colors ${isActive ? 'bg-cyan-500' : 'bg-black hover:bg-gray-800'}`}
                            style={{ left: `calc(${(i * (100/24))}% - 1.5%)`, width: '3%' }}
                            onMouseDown={() => playNote(pitch)}
                            onMouseUp={() => stopNote(pitch)}
                            onMouseLeave={() => stopNote(pitch)}
                        />
                    );
                 })}
            </div>
        </div>
    </div>
  );
};

const MKnob: React.FC<{ label: string, value: number, displayVal: string, onChange: (v: number) => void, color?: string }> = ({ label, value, displayVal, onChange, color = '#22d3ee' }) => {
    const handleMouseDown = (e: React.MouseEvent) => {
        const startY = e.clientY;
        const startVal = value;
        const onMouseMove = (m: MouseEvent) => {
            const delta = (startY - m.clientY) / 100;
            onChange(Math.max(0, Math.min(1, startVal + delta)));
        };
        const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };

    const rotation = (Math.max(0, Math.min(1, value)) * 270) - 135;

    return (
        <div className="flex flex-col items-center space-y-1 group cursor-ns-resize" onMouseDown={handleMouseDown}>
             <div className="relative w-10 h-10 rounded-full bg-[#14161a] border border-white/10 flex items-center justify-center shadow-lg group-hover:border-white/30 transition-colors">
                 <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
                 <div 
                    className="absolute w-1 h-3 rounded-full origin-bottom bottom-1/2 shadow-[0_0_8px_currentColor]"
                    style={{ transform: `rotate(${rotation}deg)`, backgroundColor: color, color: color }}
                 />
             </div>
             <span className="text-[8px] font-black text-slate-500 uppercase tracking-wide">{label}</span>
             <span className="text-[8px] font-mono text-white bg-black/40 px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity absolute -translate-y-8 pointer-events-none">{displayVal}</span>
        </div>
    );
};

export default MelodicSamplerEditor;