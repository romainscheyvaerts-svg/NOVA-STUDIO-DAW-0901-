import React, { useEffect, useState } from 'react';
import type { Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { applyTracks } from '../utils/structureBus';
import { channelsOf, decodeInput, encodeInput, inputLabel, inputOptions } from '../utils/multiRecord';

/**
 * R14 · Sélecteur d'entrée physique d'une piste (Pro Tools : Input) : « Entrée 3 »
 * (mono) ou « Entrées 1-2 » (stéréo), ou l'entrée des Réglages audio (auto). Chaque
 * piste armée enregistre SON entrée : 4 micros = 4 pistes armées, une entrée chacune.
 */
const InputSelect: React.FC<{ track: Track; compact?: boolean }> = ({ track, compact }) => {
  const [info, setInfo] = useState(() => audioEngine.getInputInfo());
  useEffect(() => {
    const refresh = () => setInfo(audioEngine.getInputInfo());
    const evs = ['nova:asio-stream', 'nova:input-missing', 'nova:latency'];
    evs.forEach(e => window.addEventListener(e, refresh));
    return () => evs.forEach(e => window.removeEventListener(e, refresh));
  }, []);
  const spec = track.recordInput ?? null;
  const used = channelsOf(spec);
  const count = Math.max(info.available, used.length ? Math.max(...used) + 1 : 0);
  const armed = info.armed.find(a => a.trackId === track.id);
  const missing = !!armed?.missing || used.some(c => c >= info.available);
  const where = info.mode === 'asio' ? 'la carte (pont ASIO)' : 'le navigateur';
  const title = missing
    ? `${inputLabel(spec)} : absente (${where} donne ${info.available} entrée${info.available > 1 ? 's' : ''}). Choisis une autre entrée.`
    : `Entrée enregistrée par « ${track.name} » : ${inputLabel(spec)}${armed ? ` — ${where}` : ''}. Plusieurs pistes armées enregistrent chacune la leur.`;
  return (
    <label className={`relative flex items-center gap-1 ${compact ? 'h-5' : 'h-6'} min-w-0 rounded px-1.5 border ${missing ? 'border-red-500/60 bg-red-500/10' : 'border-white/10 bg-black/40'} cursor-pointer`}
      title={title} data-testid={`record-input-${track.id}`} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
      <i className={`fas fa-sign-in-alt text-[8px] ${missing ? 'text-red-300' : 'text-slate-500'}`} />
      <span className={`truncate text-[9px] font-mono ${missing ? 'text-red-200' : 'text-cyan-300'}`}>{inputLabel(spec, true)}</span>
      <i className="fas fa-caret-down text-[8px] text-slate-600" />
      <select aria-label={`Entrée enregistrée par ${track.name}`} className="absolute inset-0 opacity-0 cursor-pointer" value={encodeInput(spec)}
        onChange={e => {
          const next = decodeInput(e.target.value);
          applyTracks(ts => ts.map(t => (t.id === track.id ? { ...t, recordInput: next } : t)), `🎤 « ${track.name} » enregistre : ${inputLabel(next)}`);
        }}>
        <optgroup label="Auto">
          {inputOptions(count).filter(o => o.group === 'auto').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
        <optgroup label="Mono">
          {inputOptions(count).filter(o => o.group === 'mono').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
        <optgroup label="Stéréo">
          {inputOptions(count).filter(o => o.group === 'stereo').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      </select>
    </label>
  );
};

export default InputSelect;
