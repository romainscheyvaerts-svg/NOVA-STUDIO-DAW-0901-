
import React, { useState, useRef, useEffect } from 'react';
import { Track, DrumPad } from '../types';
import { audioEngine } from '../engine/AudioEngine';

interface DrumRackProps {
    track: Track;
    onUpdateTrack: (track: Track) => void;
}

const DRUM_RACK_SIZE = 30;
const COLUMNS = 6;

const DrumRack: React.FC<DrumRackProps> = ({ track, onUpdateTrack }) => {
    const [selectedPadId, setSelectedPadId] = useState<number | null>(null);
    const [activePadId, setActivePadId] = useState<number | null>(null); // For visual flash
    const activeTimerRef = useRef<number | null>(null);

    // Initial State Loader
    useEffect(() => {
        if (!track.drumPads || track.drumPads.length === 0) {
            const pads: DrumPad[] = Array.from({ length: DRUM_RACK_SIZE }, (_, i) => ({
                id: i + 1,
                name: `Pad ${i + 1}`,
                sampleName: 'Empty',
                volume: 0.8,
                pan: 0,
                isMuted: false,
                isSolo: false,
                midiNote: 60 + i
            }));
            onUpdateTrack({ ...track, drumPads: pads });
        }
    }, []);

    const handlePadTrigger = (padId: number) => {
        audioEngine.triggerTrackAttack(track.id, padId + 59, 1.0); // 1 = Note 60
        
        setActivePadId(padId);
        if (activeTimerRef.current) clearTimeout(activeTimerRef.current);
        activeTimerRef.current = window.setTimeout(() => setActivePadId(null), 100);
    };

    const handleFileDrop = async (e: React.DragEvent, padId: number) => {
        e.preventDefault();
        e.stopPropagation();

        let audioBuffer: AudioBuffer | null = null;
        let sampleName = "Unknown";
        let audioRef = "";

        // 1. Check for Catalog URL drop
        const url = e.dataTransfer.getData('audio-url');
        if (url) {
            sampleName = e.dataTransfer.getData('audio-name') || "Instrument";
            audioRef = url;
            try {
                await audioEngine.init();
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
            } catch (err) {
                console.error("Failed to load dropped URL:", err);
                return;
            }
        } 
        // 2. Check for Local File Drop
        else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type.startsWith('audio/')) {
                sampleName = file.name;
                // Create object URL for immediate use, but logic should handle saving for persistence
                audioRef = URL.createObjectURL(file); // Temporary Blob URL
                
                // If the app supports uploading to engine directly
                if (window.DAW_CONTROL.loadDrumSample) {
                    window.DAW_CONTROL.loadDrumSample(track.id, padId, file);
                    return; // loadDrumSample handles state update in App.tsx
                }

                // Fallback manual decode
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    await audioEngine.init();
                    audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
                } catch (err) {
                     console.error("Failed to load dropped file:", err);
                     return;
                }
            }
        }

        if (audioBuffer) {
            // Send to Engine
            audioEngine.loadDrumRackSample(track.id, padId, audioBuffer);
            
            // Update State with reference
            const newPads = track.drumPads!.map(p => 
                p.id === padId ? { ...p, sampleName, buffer: audioBuffer, audioRef } : p
            );
            onUpdateTrack({ ...track, drumPads: newPads });
        }
    };

    const updatePadState = (padId: number, changes: Partial<DrumPad>) => {
        const newPads = track.drumPads!.map(p => p.id === padId ? { ...p, ...changes } : p);
        onUpdateTrack({ ...track, drumPads: newPads });
    };

    const pads = track.drumPads || [];
    const selectedPad = pads.find(p => p.id === selectedPadId);

    // Layout: 5 Rows (Top to Bottom), 6 Columns (Left to Right)
    const renderGrid = () => {
        const rows = [];
        for (let r = 4; r >= 0; r--) { // 4, 3, 2, 1, 0
            const rowPads = [];
            for (let c = 0; c < COLUMNS; c++) {
                const padId = r * COLUMNS + c + 1; // 1..30
                const pad = pads.find(p => p.id === padId);
                if (!pad) continue;

                rowPads.push(
                    <div 
                        key={padId}
                        className={`
                            relative h-20 border border-white/10 rounded-lg flex flex-col items-center justify-center cursor-pointer select-none transition-all
                            ${activePadId === padId ? 'bg-cyan-500 border-cyan-400 shadow-[0_0_15px_cyan]' : 'bg-[#1a1c22] hover:bg-[#252830]'}
                            ${selectedPadId === padId ? 'ring-2 ring-white' : ''}
                            ${pad.isMuted ? 'opacity-40 grayscale' : ''}
                            ${pad.isSolo ? 'border-yellow-400' : ''}
                        `}
                        onMouseDown={() => { handlePadTrigger(padId); setSelectedPadId(padId); }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleFileDrop(e, padId)}
                    >
                        <span className="text-[10px] font-black text-slate-500 absolute top-1 left-2">{padId}</span>
                        <div className="text-center px-1 overflow-hidden w-full">
                            <div className="text-[10px] font-bold text-white truncate">{pad.sampleName !== 'Empty' ? pad.sampleName : <span className="text-slate-600">Empty</span>}</div>
                        </div>
                        {/* Status Dots */}
                        <div className="absolute bottom-1 right-2 flex space-x-1">
                             {pad.isMuted && <div className="w-1.5 h-1.5 bg-red-500 rounded-full"></div>}
                             {pad.isSolo && <div className="w-1.5 h-1.5 bg-yellow-500 rounded-full"></div>}
                        </div>
                    </div>
                );
            }
            rows.push(<div key={r} className="grid grid-cols-6 gap-2">{rowPads}</div>);
        }
        return rows;
    };

    return (
        <div className="w-[800px] h-[600px] bg-[#0c0d10] border border-white/10 rounded-[32px] p-6 shadow-2xl flex flex-col animate-in fade-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-4">
                <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-cyan-500/10 rounded-xl flex items-center justify-center text-cyan-400 border border-cyan-500/20">
                        <i className="fas fa-th text-lg"></i>
                    </div>
                    <div>
                        <h2 className="text-sm font-black text-white uppercase tracking-widest">Drum Rack</h2>
                        <p className="text-[9px] text-slate-500 font-mono">30-PAD SAMPLER</p>
                    </div>
                </div>
                {/* Pad Controls (Contextual) */}
                {selectedPad && (
                     <div className="flex items-center space-x-4 bg-black/40 p-2 rounded-xl border border-white/5">
                         <div className="flex flex-col w-24">
                             <label className="text-[8px] text-slate-500 uppercase font-bold">Vol</label>
                             <input type="range" min="0" max="1" step="0.01" value={selectedPad.volume} onChange={(e) => updatePadState(selectedPad.id, { volume: parseFloat(e.target.value) })} className="h-1 bg-white/10 rounded-full accent-cyan-500" />
                         </div>
                         <div className="flex flex-col w-24">
                             <label className="text-[8px] text-slate-500 uppercase font-bold">Pan</label>
                             <input type="range" min="-1" max="1" step="0.01" value={selectedPad.pan} onChange={(e) => updatePadState(selectedPad.id, { pan: parseFloat(e.target.value) })} className="h-1 bg-white/10 rounded-full accent-cyan-500" />
                         </div>
                         <button onClick={() => updatePadState(selectedPad.id, { isMuted: !selectedPad.isMuted })} className={`w-6 h-6 rounded flex items-center justify-center text-[8px] font-black border ${selectedPad.isMuted ? 'bg-red-500 text-white' : 'bg-white/5 text-slate-400'}`}>M</button>
                         <button onClick={() => updatePadState(selectedPad.id, { isSolo: !selectedPad.isSolo })} className={`w-6 h-6 rounded flex items-center justify-center text-[8px] font-black border ${selectedPad.isSolo ? 'bg-yellow-500 text-black' : 'bg-white/5 text-slate-400'}`}>S</button>
                     </div>
                )}
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto custom-scroll pr-2">
                {renderGrid()}
            </div>
            
            <div className="mt-4 pt-4 border-t border-white/5 flex justify-between items-center">
                <span className="text-[9px] text-slate-600 font-mono uppercase">MIDI Map: C3 (60) - F#5 (89)</span>
                <span className="text-[9px] text-slate-600 font-mono uppercase">Drag & Drop Supported</span>
            </div>
        </div>
    );
};

export default DrumRack;
