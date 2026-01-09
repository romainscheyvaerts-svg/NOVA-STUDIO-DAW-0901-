
import React, { useState, useEffect, useRef } from 'react';
import { PluginInstance } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import WaveformRenderer from './WaveformRenderer';

interface SamplerEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onClose: () => void;
}

const SamplerEditor: React.FC<SamplerEditorProps> = ({ plugin, trackId, onClose }) => {
  const [adsr, setAdsr] = useState({ attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.5 });
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("Drag & Drop Audio File");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync with AudioEngine on mount
  useEffect(() => {
     // Ideally we would fetch current ADSR from engine, but here we just push initial
     // or check if we can retrieve it. For now, local state pushes to engine.
     updateEngine();
  }, []);

  const updateEngine = () => {
     const dsp = (audioEngine as any).tracksDSP.get(trackId);
     if (dsp && dsp.sampler) {
         dsp.sampler.setADSR(adsr);
         if (dsp.sampler.getBuffer()) {
             setBuffer(dsp.sampler.getBuffer());
             setFileName("Loaded Sample");
         }
     }
  };

  const handleKnobChange = (param: keyof typeof adsr, value: number) => {
     const newAdsr = { ...adsr, [param]: value };
     setAdsr(newAdsr);
     const dsp = (audioEngine as any).tracksDSP.get(trackId);
     if (dsp && dsp.sampler) {
         dsp.sampler.setADSR(newAdsr);
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
          // Assuming audioEngine is initialized
          await audioEngine.init();
          const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          setBuffer(audioBuffer);
          audioEngine.loadSamplerBuffer(trackId, audioBuffer);
      } catch (e) {
          console.error("Sampler Load Error:", e);
          setFileName("Error Loading File");
      }
  };

  return (
    <div className="w-[500px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-8 shadow-2xl flex flex-col space-y-6 animate-in fade-in zoom-in duration-300 select-none text-white">
        {/* Header */}
        <div className="flex justify-between items-center">
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 rounded-2xl bg-pink-500/10 flex items-center justify-center text-pink-400 border border-pink-500/20 shadow-lg shadow-pink-500/5">
                    <i className="fas fa-wave-square text-xl"></i>
                </div>
                <div>
                    <h2 className="text-lg font-black uppercase italic tracking-tighter leading-none">Nova <span className="text-pink-400">Sampler</span></h2>
                    <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">Audio Engine v1.0</p>
                </div>
            </div>
            <button onClick={onClose} className="w-10 h-10 rounded-full flex items-center justify-center border bg-white/5 border-white/10 text-slate-600 hover:text-white transition-all">
                <i className="fas fa-times"></i>
            </button>
        </div>

        {/* Drop Zone / Waveform */}
        <div 
            className="h-32 bg-black/60 rounded-[28px] border border-white/5 relative overflow-hidden flex items-center justify-center shadow-inner group cursor-pointer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
            onClick={() => fileInputRef.current?.click()}
        >
            {buffer ? (
                <WaveformRenderer 
                    buffer={buffer} 
                    color="#ec4899" 
                    height={128} 
                    offset={0} 
                    duration={buffer.duration} 
                    pixelsPerSecond={500 / buffer.duration} 
                />
            ) : (
                <div className="text-center opacity-40 group-hover:opacity-80 transition-opacity">
                    <i className="fas fa-file-audio text-3xl mb-2"></i>
                    <p className="text-[9px] font-black uppercase tracking-widest">Drop Audio File Here</p>
                </div>
            )}
            <div className="absolute bottom-2 left-4 text-[8px] font-mono text-pink-500 bg-black/50 px-2 rounded">
                {fileName}
            </div>
            <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={handleFileSelect} />
        </div>

        {/* ADSR Controls */}
        <div className="bg-white/[0.02] p-4 rounded-[24px] border border-white/5">
            <div className="grid grid-cols-4 gap-4">
                <Knob label="Attack" value={adsr.attack} min={0} max={2} onChange={v => handleKnobChange('attack', v)} color="#ec4899" />
                <Knob label="Decay" value={adsr.decay} min={0} max={2} onChange={v => handleKnobChange('decay', v)} color="#ec4899" />
                <Knob label="Sustain" value={adsr.sustain} min={0} max={1} onChange={v => handleKnobChange('sustain', v)} color="#ec4899" />
                <Knob label="Release" value={adsr.release} min={0} max={5} onChange={v => handleKnobChange('release', v)} color="#ec4899" />
            </div>
        </div>
    </div>
  );
};

const Knob: React.FC<{ label: string, value: number, min: number, max: number, onChange: (v: number) => void, color: string }> = ({ label, value, min, max, onChange, color }) => {
    const handleMouseDown = (e: React.MouseEvent) => {
        const startY = e.clientY;
        const startVal = value;
        const onMouseMove = (m: MouseEvent) => {
            const delta = (startY - m.clientY) / 100;
            const newVal = Math.max(min, Math.min(max, startVal + delta * (max - min)));
            onChange(newVal);
        };
        const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };

    const percentage = (value - min) / (max - min);
    const rotation = percentage * 270 - 135;

    return (
        <div className="flex flex-col items-center space-y-2 group cursor-ns-resize" onMouseDown={handleMouseDown}>
             <div className="relative w-12 h-12 rounded-full bg-[#14161a] border border-white/10 shadow-lg flex items-center justify-center">
                 <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40" />
                 <div 
                    className="absolute w-1 h-4 bg-current rounded-full origin-bottom bottom-1/2"
                    style={{ transform: `rotate(${rotation}deg)`, color }}
                 />
             </div>
             <div className="text-center">
                 <span className="block text-[8px] font-black text-slate-500 uppercase tracking-widest">{label}</span>
                 <span className="text-[9px] font-mono text-white">{value.toFixed(2)}s</span>
             </div>
        </div>
    );
};

export default SamplerEditor;
