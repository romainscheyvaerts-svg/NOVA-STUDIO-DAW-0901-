
import React, { useState, useEffect } from 'react';
import { DAWState, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { AudioEncoder, BitDepth, AudioFormat } from '../services/AudioEncoder';
import JSZip from 'jszip';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectState: DAWState;
}

const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, projectState }) => {
  // --- STATE ---
  const [filename, setFilename] = useState(projectState.name || 'Master');
  
  // SOURCE & PLAGE
  const [source, setSource] = useState<'MASTER' | 'STEMS'>('MASTER');
  const [rangeMode, setRangeMode] = useState<'FULL' | 'LOOP'>('FULL');

  // FORMAT & QUALITÉ
  const [format, setFormat] = useState<AudioFormat>('WAV');
  const [sampleRate, setSampleRate] = useState<number>(44100);
  const [bitDepth, setBitDepth] = useState<BitDepth>('24');
  const [mp3Bitrate, setMp3Bitrate] = useState<string>('320');

  // TRAITEMENT
  const [normalize, setNormalize] = useState(false);
  const [dither, setDither] = useState(true); // On by default for lower bit depths

  // UI STATE
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');

  useEffect(() => {
    if (isOpen) {
        setFilename(projectState.name || 'Master');
        setProgress(0);
        setStatusText('');
        setIsRendering(false);
    }
  }, [isOpen, projectState.name]);

  if (!isOpen) return null;

  // --- HELPERS ---

  const getDuration = () => {
      if (rangeMode === 'LOOP') {
          return Math.max(1, projectState.loopEnd - projectState.loopStart);
      }
      // Full Project + Tail
      const maxTime = Math.max(...projectState.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 0);
      return maxTime + 2; // +2s tail reverb
  };

  const getStartOffset = () => {
      return rangeMode === 'LOOP' ? projectState.loopStart : 0;
  };

  const processAudioBuffer = (buffer: AudioBuffer): AudioBuffer => {
      // 1. Normalisation
      if (normalize) {
          setStatusText('Normalisation (-0.1 dB)...');
          AudioEncoder.normalizeBuffer(buffer, -0.1);
      }
      
      // 2. Dithering (Uniquement si réduction de bits)
      if (dither && format === 'WAV' && bitDepth !== '32') {
          setStatusText('Application du Dithering (TPDF)...');
          AudioEncoder.applyDither(buffer, parseInt(bitDepth));
      }

      return buffer;
  };

  // --- CORE RENDER LOGIC ---

  const renderTrackList = async (tracksToRender: Track[], label: string): Promise<Blob> => {
      setStatusText(`Rendu Audio : ${label}...`);
      
      const duration = getDuration();
      const startOffset = getStartOffset();

      // Rendu Offline via AudioEngine
      const renderedBuffer = await audioEngine.renderProject(
          tracksToRender,
          duration,
          startOffset,
          sampleRate, // Custom SR
          (p) => {
              if (source === 'MASTER') setProgress(p); // Only update main progress bar here if master
          }
      );

      // Post-Processing (DSP)
      const processedBuffer = processAudioBuffer(renderedBuffer);

      // Encodage
      setStatusText(`Encodage ${format} (${bitDepth}bit)...`);
      return AudioEncoder.encodeWAV(processedBuffer, bitDepth);
  };

  const handleExport = async () => {
    setIsRendering(true);
    setProgress(0);

    try {
        if (source === 'MASTER') {
            // --- EXPORT MASTER SIMPLE ---
            const blob = await renderTrackList(projectState.tracks, "Master Mix");
            downloadBlob(blob, `${filename}_${sampleRate}Hz_${bitDepth}bit.${format.toLowerCase()}`);
        } 
        else {
            // --- EXPORT STEMS (ZIP) ---
            const zip = new JSZip();
            const tracksToExport = projectState.tracks.filter(t => 
                !t.isMuted && (t.clips.length > 0 || t.type === 'BUS' || t.type === 'SEND')
            );
            
            const totalSteps = tracksToExport.length;
            
            for (let i = 0; i < totalSteps; i++) {
                const track = tracksToExport[i];
                const trackName = track.name.replace(/[^a-z0-9]/gi, '_');
                
                // Update UI
                setStatusText(`Export Stem ${i + 1}/${totalSteps} : ${track.name}`);
                setProgress((i / totalSteps) * 100);

                // Isolate Track: We pass ONLY this track to the renderer
                // Note: If using buses/sends, logic is complex. 
                // Simplified approach: Mute all others in a clone config.
                
                // Clone tracks and mute everyone except current
                const stemTracks = projectState.tracks.map(t => ({
                    ...t,
                    isMuted: t.id !== track.id && t.type !== 'BUS' && t.type !== 'SEND' 
                    // Note: Ideally we should keep routing logic, but simple solo works for now.
                    // If track routes to bus, we should keep bus unmuted.
                }));
                
                // Better approach: Solo the track in the engine logic.
                // Since renderProject takes a list of tracks, we just pass the full list 
                // but with modifications to isMuted.
                const isolatedTracks = projectState.tracks.map(t => {
                   if (t.id === track.id) return { ...t, isMuted: false, isSolo: true }; // Force solo
                   return { ...t, isSolo: false }; // Others not solo
                });
                
                // Render Logic handles Solo implicitly
                const blob = await renderTrackList(isolatedTracks, track.name);
                zip.file(`${trackName}.wav`, blob);
            }

            setStatusText("Compression ZIP...");
            const zipBlob = await zip.generateAsync({ type: "blob" });
            downloadBlob(zipBlob, `${filename}_Stems.zip`);
        }

        setStatusText('✅ Export Terminé !');
        setTimeout(() => {
            onClose();
            setIsRendering(false);
        }, 1500);

    } catch (e: any) {
        console.error(e);
        setStatusText(`❌ Erreur: ${e.message}`);
        setIsRendering(false);
    }
  };

  const downloadBlob = (blob: Blob, name: string) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[1200] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-[#14161a] border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        
        {/* Header */}
        <div className="p-6 border-b border-white/5 bg-gradient-to-r from-cyan-900/20 to-transparent flex justify-between items-center">
            <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
                    <i className="fas fa-file-export text-lg"></i>
                </div>
                <div>
                    <h2 className="text-sm font-black text-white uppercase tracking-widest">Bounce Audio</h2>
                    <p className="text-[10px] text-slate-500 font-mono">Mastering & Export</p>
                </div>
            </div>
            <button onClick={onClose} disabled={isRendering} className="w-8 h-8 rounded-full hover:bg-white/10 text-slate-500 hover:text-white flex items-center justify-center transition-colors">
                <i className="fas fa-times"></i>
            </button>
        </div>

        <div className="p-8 flex flex-col space-y-6">
            
            <div className="flex space-x-8">
                {/* COLUMN 1: CONFIG */}
                <div className="flex-1 space-y-6">
                    
                    {/* SECTION: SOURCE */}
                    <div className="space-y-3">
                        <span className="text-[9px] font-black text-cyan-500 uppercase tracking-widest block border-b border-white/5 pb-1">1. Source & Plage</span>
                        
                        <div className="grid grid-cols-2 gap-3">
                             <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Source</label>
                                <select 
                                    value={source} 
                                    onChange={e => setSource(e.target.value as any)}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="MASTER">Master Mix (Stereo)</option>
                                    <option value="STEMS">All Tracks (Stems .zip)</option>
                                </select>
                             </div>
                             <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Plage Temporelle</label>
                                <select 
                                    value={rangeMode} 
                                    onChange={e => setRangeMode(e.target.value as any)}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="FULL">Projet Entier</option>
                                    <option value="LOOP">Boucle Active ({projectState.loopStart.toFixed(1)}s - {projectState.loopEnd.toFixed(1)}s)</option>
                                </select>
                             </div>
                        </div>
                    </div>

                    {/* SECTION: FORMAT */}
                    <div className="space-y-3">
                        <span className="text-[9px] font-black text-cyan-500 uppercase tracking-widest block border-b border-white/5 pb-1">2. Format & Qualité</span>
                        
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Type de fichier</label>
                                <select 
                                    value={format} 
                                    onChange={e => { setFormat(e.target.value as any); if(e.target.value === 'MP3') setBitDepth('16'); }}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="WAV">WAV (PCM)</option>
                                    <option value="MP3">MP3 (Web Ready)</option>
                                </select>
                            </div>

                            <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Sample Rate</label>
                                <select 
                                    value={sampleRate} 
                                    onChange={e => setSampleRate(Number(e.target.value))}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="44100">44100 Hz (CD)</option>
                                    <option value="48000">48000 Hz (Video)</option>
                                    <option value="88200">88200 Hz (Hi-Res)</option>
                                    <option value="96000">96000 Hz (Studio)</option>
                                </select>
                            </div>

                            {format === 'WAV' ? (
                                <div className="space-y-1">
                                    <label className="text-[9px] font-bold text-slate-400">Bit Depth</label>
                                    <select 
                                        value={bitDepth} 
                                        onChange={e => setBitDepth(e.target.value as any)}
                                        disabled={isRendering}
                                        className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                    >
                                        <option value="16">16-bit (Standard)</option>
                                        <option value="24">24-bit (Pro)</option>
                                        <option value="32">32-bit Float (Max)</option>
                                    </select>
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <label className="text-[9px] font-bold text-slate-400">Bitrate</label>
                                    <select 
                                        value={mp3Bitrate} 
                                        onChange={e => setMp3Bitrate(e.target.value)}
                                        disabled={isRendering}
                                        className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                    >
                                        <option value="320">320 kbps (Max)</option>
                                        <option value="192">192 kbps (Good)</option>
                                        <option value="128">128 kbps (Fast)</option>
                                    </select>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* SECTION: DSP OPTIONS */}
                    <div className="space-y-3">
                        <span className="text-[9px] font-black text-cyan-500 uppercase tracking-widest block border-b border-white/5 pb-1">3. Traitement du Signal</span>
                        <div className="flex space-x-6">
                            <label className="flex items-center space-x-2 cursor-pointer group">
                                <div className={`w-4 h-4 border rounded flex items-center justify-center transition-all ${normalize ? 'bg-cyan-500 border-cyan-500 text-black' : 'border-white/20 bg-black/40'}`}>
                                    {normalize && <i className="fas fa-check text-[8px]"></i>}
                                </div>
                                <input type="checkbox" checked={normalize} onChange={e => setNormalize(e.target.checked)} className="hidden" disabled={isRendering} />
                                <span className={`text-[10px] font-bold ${normalize ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'}`}>Normaliser (-0.1 dB)</span>
                            </label>

                            <label className="flex items-center space-x-2 cursor-pointer group">
                                <div className={`w-4 h-4 border rounded flex items-center justify-center transition-all ${dither ? 'bg-cyan-500 border-cyan-500 text-black' : 'border-white/20 bg-black/40'}`}>
                                    {dither && <i className="fas fa-check text-[8px]"></i>}
                                </div>
                                <input type="checkbox" checked={dither} onChange={e => setDither(e.target.checked)} className="hidden" disabled={isRendering || bitDepth === '32'} />
                                <span className={`text-[10px] font-bold ${dither ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'} ${bitDepth === '32' ? 'opacity-50' : ''}`}>Dithering (Triangular)</span>
                            </label>
                        </div>
                    </div>
                </div>

                {/* COLUMN 2: SUMMARY & ACTION */}
                <div className="w-48 flex flex-col border-l border-white/5 pl-8 justify-between">
                    <div className="space-y-4">
                        <div className="space-y-1">
                             <label className="text-[9px] font-bold text-slate-500">Nom du fichier</label>
                             <input 
                                type="text" 
                                value={filename} 
                                onChange={e => setFilename(e.target.value)} 
                                disabled={isRendering}
                                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:border-cyan-500 outline-none"
                             />
                        </div>
                        <div className="bg-white/5 p-3 rounded-lg space-y-2">
                             <div className="flex justify-between text-[9px]">
                                <span className="text-slate-500">Taille estimée</span>
                                <span className="text-white font-mono">~{(getDuration() * sampleRate * (parseInt(bitDepth)/8) * 2 / 1024 / 1024).toFixed(1)} MB</span>
                             </div>
                             <div className="flex justify-between text-[9px]">
                                <span className="text-slate-500">Durée</span>
                                <span className="text-white font-mono">{getDuration().toFixed(1)}s</span>
                             </div>
                             <div className="flex justify-between text-[9px]">
                                <span className="text-slate-500">Canaux</span>
                                <span className="text-white font-mono">Stéréo L/R</span>
                             </div>
                        </div>
                    </div>

                    <div className="space-y-3">
                        {isRendering && (
                            <div className="space-y-1">
                                <div className="flex justify-between text-[8px] font-black uppercase text-cyan-400">
                                    <span>Exporting...</span>
                                    <span>{Math.round(progress)}%</span>
                                </div>
                                <div className="h-1.5 bg-black/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-cyan-500 transition-all duration-100 ease-linear" style={{ width: `${progress}%` }} />
                                </div>
                                <span className="text-[8px] text-slate-500 block text-center animate-pulse">{statusText}</span>
                            </div>
                        )}

                        <button 
                            onClick={handleExport}
                            disabled={isRendering}
                            className="w-full h-12 bg-cyan-500 hover:bg-cyan-400 text-black rounded-xl text-[10px] font-black uppercase tracking-[0.2em] shadow-lg shadow-cyan-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
                        >
                            {isRendering ? <i className="fas fa-circle-notch fa-spin"></i> : <i className="fas fa-download"></i>}
                            <span>EXPORTER</span>
                        </button>
                    </div>
                </div>
            </div>

        </div>
      </div>
    </div>
  );
};

export default ExportModal;
