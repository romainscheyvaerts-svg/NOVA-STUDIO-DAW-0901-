
import React, { useState, useEffect, useRef } from 'react';
import { PluginInstance } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import WaveformRenderer from './WaveformRenderer';
import { DrumSamplerNode, DrumSamplerParams } from '../engine/DrumSamplerNode';

interface DrumSamplerEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onClose: () => void;
}

const DrumSamplerEditor: React.FC<DrumSamplerEditorProps> = ({ plugin, trackId, onClose }) => {
  const [params, setParams] = useState<DrumSamplerParams>({
    gain: 0, transpose: 0, fineTune: 0, sampleStart: 0, sampleEnd: 1,
    attack: 0.005, hold: 0.05, decay: 0.2, sustain: 0, release: 0.1,
    cutoff: 20000, resonance: 0, pan: 0, velocitySens: 0.8,
    reverse: false, normalize: false, chokeGroup: 1, isEnabled: true
  });
  
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("Drag & Drop Audio");
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Reference to the audio node
  const nodeRef = useRef<DrumSamplerNode | null>(null);

  useEffect(() => {
     // Retrieve or init node
     const node = audioEngine.getDrumSamplerNode(trackId);
     if (node) {
         nodeRef.current = node;
         setParams(node.getParams());
         if (node.getBuffer()) {
             setBuffer(node.getBuffer());
             setFileName("Sample Loaded");
         }
     }
  }, [trackId]);

  const updateParam = (key: keyof DrumSamplerParams, value: any) => {
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
          
          // Re-sync local ref
          nodeRef.current = audioEngine.getDrumSamplerNode(trackId);
      } catch (e) {
          console.error("Drum Sample Load Error:", e);
          setFileName("Error Loading File");
      }
  };

  const previewSound = () => {
      if (nodeRef.current) {
          nodeRef.current.trigger(1.0, 0);
      }
  };

  return (
    <div className="w-[800px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none text-white">
        {/* Header */}
        <div className="flex justify-between items-center">
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 rounded-2xl bg-orange-500/10 flex items-center justify-center text-orange-400 border border-orange-500/20 shadow-lg shadow-orange-500/5">
                    <i className="fas fa-drum text-xl"></i>
                </div>
                <div>
                    <h2 className="text-lg font-black uppercase italic tracking-tighter leading-none">Pro <span className="text-orange-400">Drum Sampler</span></h2>
                    <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">Zero Latency Engine</p>
                </div>
            </div>
            <div className="flex space-x-2">
                <button onClick={previewSound} className="h-10 px-6 bg-white/10 hover:bg-white/20 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center space-x-2">
                    <i className="fas fa-play"></i> <span>Preview</span>
                </button>
                <button onClick={onClose} className="w-10 h-10 rounded-full flex items-center justify-center border bg-white/5 border-white/10 text-slate-600 hover:text-white transition-all">
                    <i className="fas fa-times"></i>
                </button>
            </div>
        </div>

        {/* Waveform Editor */}
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
                        color="#f97316" 
                        height={160} 
                        offset={0} 
                        duration={buffer.duration} 
                        pixelsPerSecond={800 / buffer.duration} 
                    />
                    {/* Start Marker */}
                    <div className="absolute top-0 bottom-0 w-0.5 bg-green-500 cursor-ew-resize hover:w-1 transition-all z-10" style={{ left: `${params.sampleStart * 100}%` }} 
                         onClick={(e) => e.stopPropagation()}
                         onMouseDown={(e) => {
                             e.stopPropagation();
                             const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                             const onMove = (m: MouseEvent) => {
                                 const p = Math.max(0, Math.min(params.sampleEnd, (m.clientX - rect.left) / rect.width));
                                 updateParam('sampleStart', p);
                             };
                             window.addEventListener('mousemove', onMove);
                             window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
                         }}
                    />
                    {/* End Marker */}
                    <div className="absolute top-0 bottom-0 w-0.5 bg-red-500 cursor-ew-resize hover:w-1 transition-all z-10" style={{ left: `${params.sampleEnd * 100}%` }}
                         onClick={(e) => e.stopPropagation()}
                         onMouseDown={(e) => {
                             e.stopPropagation();
                             const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                             const onMove = (m: MouseEvent) => {
                                 const p = Math.max(params.sampleStart, Math.min(1, (m.clientX - rect.left) / rect.width));
                                 updateParam('sampleEnd', p);
                             };
                             window.addEventListener('mousemove', onMove);
                             window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
                         }}
                    />
                    {/* Shade outside regions */}
                    <div className="absolute top-0 bottom-0 left-0 bg-black/50 pointer-events-none" style={{ width: `${params.sampleStart * 100}%` }} />
                    <div className="absolute top-0 bottom-0 right-0 bg-black/50 pointer-events-none" style={{ width: `${(1 - params.sampleEnd) * 100}%` }} />
                </div>
            ) : (
                <div className="text-center opacity-40">
                    <i className="fas fa-file-audio text-3xl mb-2"></i>
                    <p className="text-[9px] font-black uppercase tracking-widest">Drop Audio File Here</p>
                </div>
            )}
            <div className="absolute bottom-2 left-4 text-[8px] font-mono text-orange-500 bg-black/50 px-2 rounded">
                {fileName}
            </div>
            <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={handleFileSelect} onClick={(e) => e.stopPropagation()} />
        </div>

        {/* CONTROLS GRID */}
        <div className="grid grid-cols-8 gap-4 bg-white/[0.02] p-6 rounded-[32px] border border-white/5">
            
            {/* SOURCE */}
            <div className="col-span-2 space-y-4 border-r border-white/5 pr-4">
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Source</div>
                <div className="grid grid-cols-2 gap-4">
                    <DKnob label="Gain" value={(params.gain + 60) / 72} displayVal={`${Math.round(params.gain)}dB`} onChange={v => updateParam('gain', (v * 72) - 60)} />
                    <DKnob label="Pan" value={(params.pan + 1) / 2} displayVal={`${Math.round(params.pan * 100)}%`} onChange={v => updateParam('pan', (v * 2) - 1)} />
                    <DKnob label="Tune" value={(params.transpose + 24) / 48} displayVal={`${Math.round(params.transpose)}st`} onChange={v => updateParam('transpose', Math.round((v * 48) - 24))} />
                    <DKnob label="Fine" value={(params.fineTune + 100) / 200} displayVal={`${Math.round(params.fineTune)}ct`} onChange={v => updateParam('fineTune', (v * 200) - 100)} />
                </div>
                <div className="flex space-x-2">
                    <button onClick={() => updateParam('reverse', !params.reverse)} className={`flex-1 py-1 text-[8px] font-black uppercase rounded border ${params.reverse ? 'bg-orange-500 text-black border-orange-500' : 'bg-white/5 text-slate-500 border-white/10'}`}>Rev</button>
                    <button onClick={() => updateParam('normalize', !params.normalize)} className={`flex-1 py-1 text-[8px] font-black uppercase rounded border ${params.normalize ? 'bg-orange-500 text-black border-orange-500' : 'bg-white/5 text-slate-500 border-white/10'}`}>Norm</button>
                </div>
            </div>

            {/* ENVELOPE (AHDSR) */}
            <div className="col-span-3 space-y-4 border-r border-white/5 px-4">
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">AHDSR Envelope</div>
                <div className="grid grid-cols-5 gap-2">
                    <DKnob label="Attack" value={params.attack * 2} displayVal={`${Math.round(params.attack * 1000)}ms`} onChange={v => updateParam('attack', v/2)} />
                    <DKnob label="Hold" value={params.hold * 2} displayVal={`${Math.round(params.hold * 1000)}ms`} onChange={v => updateParam('hold', v/2)} />
                    <DKnob label="Decay" value={params.decay} displayVal={`${Math.round(params.decay * 1000)}ms`} onChange={v => updateParam('decay', v)} />
                    <DKnob label="Sustain" value={params.sustain} displayVal={`${Math.round(params.sustain * 100)}%`} onChange={v => updateParam('sustain', v)} />
                    <DKnob label="Release" value={params.release} displayVal={`${Math.round(params.release * 1000)}ms`} onChange={v => updateParam('release', v)} />
                </div>
                <div className="h-10 bg-black/40 rounded-lg border border-white/5 relative opacity-50">
                    {/* Mini visualizer for ADSR could go here */}
                    <div className="absolute bottom-0 left-0 h-full bg-orange-500/20" style={{ width: `${params.attack * 100}%` }}></div>
                </div>
            </div>

            {/* FILTER & MISC */}
            <div className="col-span-3 space-y-4 pl-4">
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Filter & Mods</div>
                <div className="grid grid-cols-3 gap-4">
                    <DKnob label="Cutoff" value={Math.log10(params.cutoff / 20) / Math.log10(1000)} displayVal={`${Math.round(params.cutoff)}Hz`} onChange={v => updateParam('cutoff', 20 * Math.pow(1000, v))} />
                    <DKnob label="Res" value={params.resonance / 20} displayVal={params.resonance.toFixed(1)} onChange={v => updateParam('resonance', v * 20)} />
                    <DKnob label="Vel Sens" value={params.velocitySens} displayVal={`${Math.round(params.velocitySens * 100)}%`} onChange={v => updateParam('velocitySens', v)} />
                </div>
                <div className="flex items-center justify-between bg-black/40 p-2 rounded-lg border border-white/5">
                    <span className="text-[8px] font-black text-slate-500 uppercase">Choke Group</span>
                    <div className="flex space-x-1">
                        {[1, 2, 3, 4].map(g => (
                            <button 
                                key={g} 
                                onClick={() => updateParam('chokeGroup', g)}
                                className={`w-6 h-6 rounded text-[9px] font-bold ${params.chokeGroup === g ? 'bg-orange-500 text-black' : 'bg-white/5 text-slate-600'}`}
                            >
                                {g}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    </div>
  );
};

const DKnob: React.FC<{ label: string, value: number, displayVal: string, onChange: (v: number) => void }> = ({ label, value, displayVal, onChange }) => {
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
             <div className="relative w-10 h-10 rounded-full bg-[#14161a] border border-white/10 flex items-center justify-center shadow-lg group-hover:border-orange-500/50 transition-colors">
                 <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
                 <div 
                    className="absolute w-1 h-3 bg-orange-500 rounded-full origin-bottom bottom-1/2 shadow-[0_0_5px_#f97316]"
                    style={{ transform: `rotate(${rotation}deg)` }}
                 />
             </div>
             <span className="text-[8px] font-black text-slate-500 uppercase tracking-wide">{label}</span>
             <span className="text-[9px] font-mono text-white bg-black/40 px-1 rounded">{displayVal}</span>
        </div>
    );
};

export default DrumSamplerEditor;
