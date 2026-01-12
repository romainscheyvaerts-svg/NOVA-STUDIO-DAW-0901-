import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { audioEngine } from '../engine/AudioEngine';

interface AudioSettingsPanelProps {
  onClose: () => void;
}

const AudioSettingsPanel: React.FC<AudioSettingsPanelProps> = ({ onClose }) => {
  const [sampleRate, setSampleRate] = useState(48000);
  const [bufferSize, setBufferSize] = useState(512);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>('');
  const [latency, setLatency] = useState(0);

  useEffect(() => {
    loadDevices();
    if (audioEngine.ctx) {
      setSampleRate(audioEngine.ctx.sampleRate);
      setLatency(audioEngine.ctx.baseLatency * 1000);
    }
  }, []);

  const loadDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputDevices(devices.filter(d => d.kind === 'audioinput'));
      setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
    } catch (e) {
      console.error('Failed to enumerate devices:', e);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-lg p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-white/5 rounded-full text-slate-400 hover:text-white hover:bg-red-500/50 transition-all"
        >
          <i className="fas fa-times"></i>
        </button>

        <div className="mb-6">
          <h2 className="text-lg font-black text-white mb-1">
            <i className="fas fa-cog mr-2 text-cyan-500"></i>
            Paramètres Audio
          </h2>
          <p className="text-[10px] text-slate-500">Configuration du moteur audio WebAudio</p>
        </div>

        <div className="space-y-6">
          {/* Status */}
          <div className="p-4 bg-white/5 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black text-slate-500 uppercase">État du moteur</span>
              <span className={`text-[10px] font-black uppercase ${audioEngine.ctx?.state === 'running' ? 'text-green-500' : 'text-orange-500'}`}>
                {audioEngine.ctx?.state || 'Non initialisé'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-lg font-black text-cyan-400">{sampleRate / 1000}kHz</p>
                <p className="text-[8px] text-slate-500">Sample Rate</p>
              </div>
              <div>
                <p className="text-lg font-black text-cyan-400">{bufferSize}</p>
                <p className="text-[8px] text-slate-500">Buffer Size</p>
              </div>
              <div>
                <p className="text-lg font-black text-cyan-400">{latency.toFixed(1)}ms</p>
                <p className="text-[8px] text-slate-500">Latence</p>
              </div>
            </div>
          </div>

          {/* Input Device */}
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">
              Entrée Audio (Micro)
            </label>
            <select
              value={selectedInput}
              onChange={(e) => setSelectedInput(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            >
              <option value="">Défaut du système</option>
              {inputDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Micro ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>

          {/* Output Device */}
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">
              Sortie Audio
            </label>
            <select
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            >
              <option value="">Défaut du système</option>
              {outputDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Sortie ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>

          <p className="text-[9px] text-slate-600 text-center">
            <i className="fas fa-info-circle mr-1"></i>
            Les paramètres avancés (buffer size, sample rate) nécessitent un rechargement de l'application
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AudioSettingsPanel;
