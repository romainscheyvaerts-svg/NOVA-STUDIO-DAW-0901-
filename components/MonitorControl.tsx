import React, { useEffect, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';

/**
 * « Retour casque » de la piste qui enregistre : l'artiste règle le volume de
 * sa voix dans son casque (0-200 %) sans changer le niveau enregistré, et peut
 * couper / rallumer le retour. Affiché sur la piste armée (PC et téléphone).
 */
const MonitorControl: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const [level, setLevel] = useState(() => audioEngine.getMonitorLevel());
  const [on, setOn] = useState(() => audioEngine.isInputMonitoring());
  const [lat, setLat] = useState<{ ms: number; mode: string } | null>(null);

  useEffect(() => {
    const onLevel = (e: Event) => setLevel(Number((e as CustomEvent).detail));
    const onMon = (e: Event) => setOn(!!(e as CustomEvent).detail);
    window.addEventListener('nova:monitor-level', onLevel);
    window.addEventListener('nova:monitoring', onMon);
    const onLat = (e: Event) => setLat((e as CustomEvent).detail);
    window.addEventListener('nova:latency', onLat);
    return () => {
      window.removeEventListener('nova:latency', onLat);
      window.removeEventListener('nova:monitor-level', onLevel);
      window.removeEventListener('nova:monitoring', onMon);
    };
  }, []);

  const toggle = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('nova:set-monitoring', { detail: !on }));
  };

  return (
    <div className="space-y-1">
    <div
      className={`flex items-center gap-2 rounded-lg border px-2 ${compact ? 'py-1' : 'py-1.5'} ${on ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-white/10 bg-black/20'}`}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
      data-nova-target="monitor-level"
    >
      <button
        type="button"
        onClick={toggle}
        title={on ? 'Couper le retour de ta voix dans le casque' : 'Entendre ta voix dans le casque (avec un casque seulement)'}
        aria-pressed={on}
        className={`shrink-0 h-6 px-1.5 rounded-md text-[10px] font-black ${on ? 'bg-red-500 text-white' : 'bg-white/10 text-slate-400'}`}
      >
        🎧 {on ? 'Retour' : 'Retour coupé'}
      </button>
      <input
        type="range"
        min={0}
        max={2}
        step={0.01}
        value={level}
        disabled={!on}
        onChange={e => audioEngine.setMonitorLevel(parseFloat(e.target.value))}
        onDoubleClick={() => audioEngine.setMonitorLevel(1)}
        aria-label="Volume de ta voix dans le casque"
        title="Volume de ta voix dans le casque (double-clic : 100 %). Ne change pas le niveau enregistré."
        className="flex-1 min-w-0 accent-red-500 disabled:opacity-30"
      />
      <span className="w-9 text-right text-[10px] font-mono text-slate-300 tabular-nums">{Math.round(level * 100)}%</span>
    </div>
    {lat && (
      <p className="px-1 text-[10px] text-slate-400" title="Mesurée chaque seconde. À la fin de chaque prise, la voix est automatiquement replacée de cette durée. Réglage fin : Réglages audio." data-nova-target="latency">
        ⏱ Latence {lat.ms} ms · <span className="text-emerald-400">compensée</span> · {lat.mode === 'asio' ? 'carte son (ASIO), retour direct' : 'navigateur'}
        {lat.mode !== 'asio' && lat.ms > 110 && <span className="text-amber-300"> · élevée : casque Bluetooth ? Préfère un casque filaire</span>}
      </p>
    )}
    </div>
  );
};

export default MonitorControl;
