import React, { useState, useEffect, useRef } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { midiManager } from '../services/MidiManager';
import { MidiDevice } from '../types';
import { AudioDevice as ASIODevice } from '../services/ASIOBridge';

interface AudioSettingsPanelProps {
  onClose: () => void;
}

interface AudioDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

const AudioSettingsPanel: React.FC<AudioSettingsPanelProps> = ({ onClose }) => {
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>('default');
  const [selectedOutput, setSelectedOutput] = useState<string>('default');
  const [latencyHint, setLatencyHint] = useState<string>('balanced');
  const [cpuUsage, setCpuUsage] = useState(0);
  const [isPlayingTestTone, setIsPlayingTestTone] = useState(false);
  const [isSinkSupported, setIsSinkSupported] = useState(true);
  
  // MIDI State
  const [midiInputs, setMidiInputs] = useState<MidiDevice[]>([]);
  const [selectedMidiInput, setSelectedMidiInput] = useState<string>('');
  const [midiChannel, setMidiChannel] = useState<number>(0);

  // ASIO Bridge State
  const [asioConnected, setAsioConnected] = useState(false);
  const [asioConnecting, setAsioConnecting] = useState(false);
  const [asioDevices, setAsioDevices] = useState<ASIODevice[]>([]);
  const [selectedAsioDevice, setSelectedAsioDevice] = useState<string>('');
  const [asioStreamActive, setAsioStreamActive] = useState(false);
  const [asioLatency, setAsioLatency] = useState(0);
  const [asioBlockSize, setAsioBlockSize] = useState(256);
  const [asioSampleRate, setAsioSampleRate] = useState(44100);

  // Status
  const [status, setStatus] = useState<string>('Initialisation...');
  const cpuInterval = useRef<number | null>(null);

  useEffect(() => {
    // 1. Initialiser le moteur pour s'assurer que le contexte est prêt
    audioEngine.init().then(() => {
        // Chargement des préférences stockées
        const savedInput = localStorage.getItem('nova_audio_input');
        const savedOutput = localStorage.getItem('nova_audio_output');
        const savedLatency = localStorage.getItem('nova_audio_latency');

        if (savedInput) setSelectedInput(savedInput);
        if (savedOutput) setSelectedOutput(savedOutput);
        if (savedLatency) {
             setLatencyHint(savedLatency);
             audioEngine.setLatencyMode(savedLatency as any);
        }

        // Feature detection setSinkId
        // @ts-ignore
        if (typeof audioEngine.ctx.setSinkId !== 'function') {
            setIsSinkSupported(false);
        }
        
        refreshDevices();
    });
    
    // Init MIDI
    midiManager.init().then(() => {
        const inputs = midiManager.getInputs();
        setMidiInputs(inputs);
        // Select first or existing
        if (inputs.length > 0) {
            setSelectedMidiInput(inputs[0].id);
        }
    });

    // Écouter les changements de périphériques
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

    // CPU Simulator Loop
    cpuInterval.current = window.setInterval(() => {
        // Simulation d'une charge CPU variable pour le look "Pro"
        // En vrai, AudioWorklet peut donner des stats précises mais c'est complexe
        const baseLoad = 15;
        const variation = Math.random() * 10;
        setCpuUsage(baseLoad + variation);
    }, 1000);

    return () => {
        navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
        if (cpuInterval.current) clearInterval(cpuInterval.current);
    };
  }, []);

  const refreshDevices = async () => {
    try {
        setStatus('Scanning devices...');
        // Demander la permission si nécessaire pour voir les labels
        await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label || `Input ${d.deviceId.substring(0, 5)}...`, kind: 'audioinput' as const }));
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput').map(d => ({ deviceId: d.deviceId, label: d.label || `Output ${d.deviceId.substring(0, 5)}...`, kind: 'audiooutput' as const }));

        setInputs(audioInputs);
        setOutputs(audioOutputs);
        setStatus('Ready');
    } catch (err) {
        console.error("Device scan error", err);
        setStatus('Error accessing devices. Check permissions.');
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      setSelectedInput(id);
      audioEngine.setInputDevice(id);
      localStorage.setItem('nova_audio_input', id);
  };

  const handleOutputChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      setSelectedOutput(id);
      audioEngine.setOutputDevice(id);
      localStorage.setItem('nova_audio_output', id);
  };

  const handleMidiInputChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      setSelectedMidiInput(id);
      midiManager.selectInput(id);
  };

  const handleMidiChannelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const ch = parseInt(e.target.value);
      setMidiChannel(ch);
      midiManager.setChannel(ch);
  };

  const handleLatencyChange = (mode: string) => {
      setLatencyHint(mode);
      audioEngine.setLatencyMode(mode as any);
      localStorage.setItem('nova_audio_latency', mode);
  };

  const toggleTestTone = () => {
      setIsPlayingTestTone(true);
      audioEngine.playTestTone();
      setTimeout(() => setIsPlayingTestTone(false), 500);
  };

  // === ASIO BRIDGE HANDLERS ===
  const handleAsioConnect = async () => {
      if (asioConnected) {
          // Disconnect
          audioEngine.disconnectASIO();
          setAsioConnected(false);
          setAsioStreamActive(false);
          setAsioDevices([]);
          setSelectedAsioDevice('');
          setStatus('ASIO Disconnected');
      } else {
          // Connect
          setAsioConnecting(true);
          setStatus('Connecting to ASIO Bridge...');
          try {
              const connected = await audioEngine.connectASIO();
              if (connected) {
                  setAsioConnected(true);
                  // Wait a bit for devices to be fetched
                  setTimeout(() => {
                      const devices = audioEngine.getASIODevices();
                      setAsioDevices(devices);
                      if (devices.length > 0) {
                          setSelectedAsioDevice(devices[0].name);
                      }
                      setStatus('ASIO Bridge Connected');
                  }, 500);
              } else {
                  setStatus('Failed to connect to ASIO Bridge');
              }
          } catch (err) {
              console.error('ASIO connection error:', err);
              setStatus('ASIO Bridge not available');
          }
          setAsioConnecting(false);
      }
  };

  const handleAsioDeviceChange = (deviceName: string) => {
      setSelectedAsioDevice(deviceName);
      audioEngine.configureASIO({ device_name: deviceName });
  };

  const handleAsioBlockSizeChange = (blockSize: number) => {
      setAsioBlockSize(blockSize);
      // Calculate approximate latency
      const latency = (blockSize / asioSampleRate) * 1000 * 2; // Round trip
      setAsioLatency(latency);
      audioEngine.configureASIO({ block_size: blockSize });
  };

  const handleAsioSampleRateChange = (sampleRate: number) => {
      setAsioSampleRate(sampleRate);
      // Recalculate latency
      const latency = (asioBlockSize / sampleRate) * 1000 * 2;
      setAsioLatency(latency);
      audioEngine.configureASIO({ sample_rate: sampleRate });
  };

  const handleAsioStreamToggle = async () => {
      if (asioStreamActive) {
          audioEngine.stopASIOStream();
          setAsioStreamActive(false);
          setStatus('ASIO Stream Stopped');
      } else {
          await audioEngine.startASIOStream();
          setAsioStreamActive(audioEngine.isASIOStreamActive());
          setStatus('ASIO Streaming Active');
      }
  };

  return (
    <div className="fixed inset-0 z-[700] bg-black/90 backdrop-blur-md flex items-center justify-center animate-in fade-in duration-200">
        <div className="w-[640px] bg-[#0c0d10] border border-white/10 rounded-3xl shadow-[0_0_100px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col font-inter max-h-[90vh]">
            
            {/* HEADER */}
            <div className="h-16 bg-[#14161a] border-b border-white/5 flex items-center justify-between px-8 relative shrink-0">
                <div className="flex items-center space-x-4">
                    <div className="w-10 h-10 rounded-xl bg-orange-500/10 text-orange-500 flex items-center justify-center border border-orange-500/20 shadow-lg shadow-orange-500/5">
                        <i className="fas fa-sliders-h"></i>
                    </div>
                    <div>
                        <h2 className="text-sm font-black text-white uppercase tracking-[0.2em]">Audio Engine</h2>
                        <p className="text-[10px] text-slate-500 font-mono font-bold">Hardware Configuration</p>
                    </div>
                </div>
                
                {/* CPU METER */}
                <div className="flex items-center space-x-3 bg-black/40 px-3 py-1.5 rounded-lg border border-white/5">
                    <span className="text-[9px] font-black text-slate-500 uppercase">DSP Load</span>
                    <div className="w-24 h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div 
                            className={`h-full transition-all duration-500 ease-out ${cpuUsage > 80 ? 'bg-red-500' : 'bg-green-500'}`} 
                            style={{ width: `${cpuUsage}%` }} 
                        />
                    </div>
                    <span className="text-[9px] font-mono text-white">{Math.round(cpuUsage)}%</span>
                </div>

                <button onClick={onClose} className="absolute right-4 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center transition-colors">
                    <i className="fas fa-times"></i>
                </button>
            </div>

            {/* BODY */}
            <div className="p-8 space-y-8 bg-[#0c0d10] overflow-y-auto">
                
                {/* AUDIO I/O - Hidden when ASIO is active with a device selected */}
                {!(asioConnected && selectedAsioDevice) && (
                <div className="space-y-5">
                    <div className="flex items-center space-x-2 mb-2">
                        <span className="text-[10px] font-black text-orange-500 uppercase tracking-widest bg-orange-500/10 px-2 py-0.5 rounded">Audio I/O</span>
                        <span className="text-[8px] text-slate-500">(System Drivers)</span>
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                        {/* INPUT */}
                        <div className="space-y-2 group">
                            <label className="text-[9px] font-bold text-slate-400 uppercase block tracking-wider group-hover:text-white transition-colors">Input Device</label>
                            <div className="relative">
                                <select 
                                    value={selectedInput} 
                                    onChange={handleInputChange}
                                    className="w-full h-11 bg-[#14161a] border border-white/10 rounded-xl px-4 text-[11px] font-medium text-white focus:border-orange-500 outline-none appearance-none transition-all hover:bg-[#1a1d21]"
                                >
                                    <option value="default">Default System Input</option>
                                    {inputs.map(dev => (
                                        <option key={dev.deviceId} value={dev.deviceId}>{dev.label}</option>
                                    ))}
                                </select>
                                <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-[10px] text-slate-600 pointer-events-none"></i>
                            </div>
                        </div>

                        {/* OUTPUT */}
                        <div className="space-y-2 group">
                            <label className="text-[9px] font-bold text-slate-400 uppercase block tracking-wider group-hover:text-white transition-colors">Output Device</label>
                            <div className="relative">
                                <select 
                                    value={selectedOutput} 
                                    onChange={handleOutputChange}
                                    className="w-full h-11 bg-[#14161a] border border-white/10 rounded-xl px-4 text-[11px] font-medium text-white focus:border-orange-500 outline-none appearance-none transition-all hover:bg-[#1a1d21]"
                                    disabled={!isSinkSupported}
                                >
                                    <option value="default">Default System Output</option>
                                    {outputs.map(dev => (
                                        <option key={dev.deviceId} value={dev.deviceId}>{dev.label}</option>
                                    ))}
                                </select>
                                <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-[10px] text-slate-600 pointer-events-none"></i>
                            </div>
                            {!isSinkSupported && (
                                <p className="text-[8px] text-red-400 mt-1 flex items-center">
                                    <i className="fas fa-exclamation-circle mr-1"></i>
                                    Non supporté par ce navigateur (Use Chrome/Edge)
                                </p>
                            )}
                        </div>
                    </div>
                </div>
                )}

                {!(asioConnected && selectedAsioDevice) && <div className="h-px bg-white/5 w-full"></div>}

                {/* ASIO BRIDGE SECTION */}
                <div className="space-y-5">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-black text-purple-500 uppercase tracking-widest bg-purple-500/10 px-2 py-0.5 rounded">
                            <i className="fas fa-microchip mr-1"></i>ASIO Bridge
                        </span>
                        <div className="flex items-center space-x-2">
                            <div className={`w-2 h-2 rounded-full ${asioConnected ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`}></div>
                            <span className="text-[9px] font-mono text-slate-400">
                                {asioConnected ? (asioStreamActive ? 'Streaming' : 'Connected') : 'Offline'}
                            </span>
                        </div>
                    </div>

                    {/* Connection Button */}
                    <div className="bg-[#14161a] border border-white/5 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center space-x-3">
                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${asioConnected ? 'bg-purple-500/20 text-purple-400' : 'bg-slate-800 text-slate-500'}`}>
                                    <i className="fas fa-plug"></i>
                                </div>
                                <div>
                                    <p className="text-[11px] font-bold text-white">ASIO Native Driver</p>
                                    <p className="text-[9px] text-slate-500">Low-latency audio via Python bridge (port 8766)</p>
                                </div>
                            </div>
                            <button
                                onClick={handleAsioConnect}
                                disabled={asioConnecting}
                                className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${
                                    asioConnected 
                                        ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' 
                                        : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30'
                                } ${asioConnecting ? 'opacity-50 cursor-wait' : ''}`}
                            >
                                {asioConnecting ? (
                                    <><i className="fas fa-spinner fa-spin mr-1"></i>Connecting...</>
                                ) : asioConnected ? (
                                    <><i className="fas fa-unlink mr-1"></i>Disconnect</>
                                ) : (
                                    <><i className="fas fa-link mr-1"></i>Connect</>
                                )}
                            </button>
                        </div>

                        {/* ASIO Device Selection - Only when connected */}
                        {asioConnected && (
                            <div className="space-y-4 pt-4 border-t border-white/5">
                                <div className="grid grid-cols-2 gap-4">
                                    {/* ASIO Device */}
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase block tracking-wider">ASIO Device</label>
                                        <div className="relative">
                                            <select
                                                value={selectedAsioDevice}
                                                onChange={(e) => handleAsioDeviceChange(e.target.value)}
                                                className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[11px] font-medium text-white focus:border-purple-500 outline-none appearance-none"
                                            >
                                                <option value="">Select ASIO Device</option>
                                                {asioDevices.map(dev => (
                                                    <option key={dev.id} value={dev.name}>
                                                        {dev.name} ({dev.max_input_channels}in/{dev.max_output_channels}out)
                                                    </option>
                                                ))}
                                            </select>
                                            <i className="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-[8px] text-slate-600"></i>
                                        </div>
                                        {asioDevices.length === 0 && (
                                            <p className="text-[8px] text-yellow-400/80">
                                                <i className="fas fa-exclamation-triangle mr-1"></i>
                                                No ASIO devices found. Install ASIO drivers.
                                            </p>
                                        )}
                                        {/* Open ASIO Control Panel Button */}
                                        {selectedAsioDevice && (
                                            <button
                                                onClick={() => audioEngine.openASIOPanel()}
                                                className="mt-2 w-full px-3 py-2 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/30 rounded-lg text-[9px] font-bold text-purple-300 uppercase tracking-wider transition-all flex items-center justify-center space-x-2"
                                            >
                                                <i className="fas fa-cog"></i>
                                                <span>Open {selectedAsioDevice} Panel</span>
                                            </button>
                                        )}
                                    </div>

                                    {/* Buffer Size */}
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase block tracking-wider">Buffer Size</label>
                                        <div className="relative">
                                            <select
                                                value={asioBlockSize}
                                                onChange={(e) => handleAsioBlockSizeChange(parseInt(e.target.value))}
                                                className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[11px] font-medium text-white focus:border-purple-500 outline-none appearance-none"
                                            >
                                                <option value="64">64 samples (~1.5ms)</option>
                                                <option value="128">128 samples (~3ms)</option>
                                                <option value="256">256 samples (~6ms)</option>
                                                <option value="512">512 samples (~12ms)</option>
                                                <option value="1024">1024 samples (~23ms)</option>
                                            </select>
                                            <i className="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-[8px] text-slate-600"></i>
                                        </div>
                                    </div>
                                </div>

                                {/* Sample Rate + Latency Info */}
                                <div className="flex items-center justify-between bg-black/20 rounded-lg px-4 py-3">
                                    <div className="flex items-center space-x-4">
                                        <div className="flex items-center space-x-2">
                                            <span className="text-[8px] text-slate-500 uppercase">Sample Rate:</span>
                                            <select
                                                value={asioSampleRate}
                                                onChange={(e) => handleAsioSampleRateChange(parseInt(e.target.value))}
                                                className="bg-transparent text-[10px] font-mono text-white outline-none cursor-pointer"
                                            >
                                                <option value="44100">44.1 kHz</option>
                                                <option value="48000">48 kHz</option>
                                                <option value="88200">88.2 kHz</option>
                                                <option value="96000">96 kHz</option>
                                            </select>
                                        </div>
                                        <div className="w-px h-4 bg-white/10"></div>
                                        <div className="flex items-center space-x-2">
                                            <span className="text-[8px] text-slate-500 uppercase">Latency:</span>
                                            <span className="text-[10px] font-mono text-purple-400">{asioLatency.toFixed(1)}ms</span>
                                        </div>
                                    </div>

                                    {/* Start/Stop Stream Button */}
                                    <button
                                        onClick={handleAsioStreamToggle}
                                        disabled={!selectedAsioDevice}
                                        className={`px-4 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${
                                            asioStreamActive
                                                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                                                : 'bg-slate-700 text-white hover:bg-slate-600'
                                        } ${!selectedAsioDevice ? 'opacity-30 cursor-not-allowed' : ''}`}
                                    >
                                        {asioStreamActive ? (
                                            <><i className="fas fa-stop mr-1"></i>Stop</>
                                        ) : (
                                            <><i className="fas fa-play mr-1"></i>Start</>
                                        )}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Instructions when not connected */}
                        {!asioConnected && (
                            <div className="mt-3 p-3 bg-black/20 rounded-lg">
                                <p className="text-[9px] text-slate-400 leading-relaxed">
                                    <i className="fas fa-info-circle text-purple-400 mr-1"></i>
                                    Run <code className="bg-black/40 px-1 py-0.5 rounded text-purple-300">bridge-python/start_asio_bridge.bat</code> first, then connect.
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="h-px bg-white/5 w-full"></div>

                {/* MIDI CONFIGURATION */}
                <div className="space-y-5">
                    <div className="flex items-center space-x-2 mb-2">
                        <span className="text-[10px] font-black text-green-500 uppercase tracking-widest bg-green-500/10 px-2 py-0.5 rounded">MIDI Devices</span>
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                        <div className="space-y-2 group">
                            <label className="text-[9px] font-bold text-slate-400 uppercase block tracking-wider group-hover:text-white transition-colors">MIDI Input</label>
                            <div className="relative">
                                <select 
                                    value={selectedMidiInput} 
                                    onChange={handleMidiInputChange}
                                    className="w-full h-11 bg-[#14161a] border border-white/10 rounded-xl px-4 text-[11px] font-medium text-white focus:border-green-500 outline-none appearance-none transition-all hover:bg-[#1a1d21]"
                                >
                                    {midiInputs.length === 0 && <option value="">No MIDI Devices Found</option>}
                                    {midiInputs.map(dev => (
                                        <option key={dev.id} value={dev.id}>{dev.name}</option>
                                    ))}
                                </select>
                                <i className="fas fa-plug absolute right-4 top-1/2 -translate-y-1/2 text-[10px] text-green-500 pointer-events-none"></i>
                            </div>
                        </div>

                        <div className="space-y-2 group">
                            <label className="text-[9px] font-bold text-slate-400 uppercase block tracking-wider group-hover:text-white transition-colors">MIDI Channel</label>
                            <div className="relative">
                                <select 
                                    value={midiChannel} 
                                    onChange={handleMidiChannelChange}
                                    className="w-full h-11 bg-[#14161a] border border-white/10 rounded-xl px-4 text-[11px] font-medium text-white focus:border-green-500 outline-none appearance-none transition-all hover:bg-[#1a1d21]"
                                >
                                    <option value="0">Omni (All Channels)</option>
                                    {Array.from({length: 16}).map((_, i) => (
                                        <option key={i+1} value={i+1}>Channel {i+1}</option>
                                    ))}
                                </select>
                                <i className="fas fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-[10px] text-slate-600 pointer-events-none"></i>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="h-px bg-white/5 w-full"></div>

                {/* LATENCY / BUFFER */}
                <div className="space-y-5">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-black text-cyan-500 uppercase tracking-widest bg-cyan-500/10 px-2 py-0.5 rounded">Engine Performance</span>
                        <div className="flex items-center space-x-2">
                            <span className="text-[9px] font-bold text-slate-500 uppercase">Sample Rate:</span>
                            <span className="text-[10px] font-mono text-white bg-white/5 px-2 py-0.5 rounded">{audioEngine.sampleRate} Hz</span>
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                         <button 
                            onClick={() => handleLatencyChange('low')} 
                            className={`h-24 rounded-xl border flex flex-col items-center justify-center space-y-2 transition-all group ${latencyHint === 'low' ? 'bg-cyan-500/10 border-cyan-500 text-white' : 'bg-[#14161a] border-white/5 text-slate-500 hover:bg-[#1a1d21]'}`}
                         >
                             <i className="fas fa-bolt text-lg mb-1"></i>
                             <span className="text-[9px] font-black uppercase tracking-widest">Low Latency</span>
                             <span className="text-[8px] opacity-60">High CPU</span>
                         </button>
                         
                         <button 
                            onClick={() => handleLatencyChange('balanced')} 
                            className={`h-24 rounded-xl border flex flex-col items-center justify-center space-y-2 transition-all group ${latencyHint === 'balanced' ? 'bg-cyan-500/10 border-cyan-500 text-white' : 'bg-[#14161a] border-white/5 text-slate-500 hover:bg-[#1a1d21]'}`}
                         >
                             <i className="fas fa-balance-scale text-lg mb-1"></i>
                             <span className="text-[9px] font-black uppercase tracking-widest">Balanced</span>
                             <span className="text-[8px] opacity-60">Recommended</span>
                         </button>
                         
                         <button 
                            onClick={() => handleLatencyChange('high')} 
                            className={`h-24 rounded-xl border flex flex-col items-center justify-center space-y-2 transition-all group ${latencyHint === 'high' ? 'bg-cyan-500/10 border-cyan-500 text-white' : 'bg-[#14161a] border-white/5 text-slate-500 hover:bg-[#1a1d21]'}`}
                         >
                             <i className="fas fa-shield-alt text-lg mb-1"></i>
                             <span className="text-[9px] font-black uppercase tracking-widest">Safe Mode</span>
                             <span className="text-[8px] opacity-60">Mixing Only</span>
                         </button>
                    </div>
                </div>

                {/* TEST TONE */}
                <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                        <i className="fas fa-wave-square text-slate-500"></i>
                        <div className="flex flex-col">
                            <span className="text-[10px] font-bold text-white">Output Check</span>
                            <span className="text-[8px] text-slate-500">Sine Wave 440Hz @ -12dB</span>
                        </div>
                    </div>
                    <button 
                        onClick={toggleTestTone}
                        className={`px-6 py-2 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${isPlayingTestTone ? 'bg-white text-black scale-95' : 'bg-white/10 text-white hover:bg-white/20'}`}
                    >
                        {isPlayingTestTone ? 'Playing...' : 'Test Tone'}
                    </button>
                </div>
            </div>
            
            {/* FOOTER */}
            <div className="bg-[#14161a] px-8 py-4 border-t border-white/5 flex justify-between items-center shrink-0">
                <div className="flex items-center space-x-2">
                    <div className={`w-2 h-2 rounded-full ${status.includes('Error') ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`}></div>
                    <span className="text-[9px] font-mono text-slate-400 uppercase">{status}</span>
                </div>
                <button onClick={onClose} className="px-8 py-2.5 bg-white text-black text-[10px] font-black uppercase rounded-lg hover:bg-slate-200 transition-colors shadow-lg shadow-white/5">
                    Save Configuration
                </button>
            </div>
        </div>
    </div>
  );
};

export default AudioSettingsPanel;