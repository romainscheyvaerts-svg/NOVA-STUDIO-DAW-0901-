import React, { useEffect, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import InputMeter from './InputMeter';

/**
 * « Retour casque » de la piste qui enregistre : l'artiste règle le volume de
 * sa voix dans son casque (0-200 %) sans changer le niveau enregistré, et peut
 * couper / rallumer le retour. Avec le vumètre d'entrée et la latence mesurée.
 * `compact` (en-tête de piste sur PC) : tout tient sur une ligne.
 */
const MonitorControl: React.FC<{ compact?: boolean; mini?: boolean; trackId?: string; onExpand?: () => void }> = ({ compact, mini, trackId, onExpand }) => {
  const [level, setLevel] = useState(() => audioEngine.getMonitorLevel());
  const [on, setOn] = useState(() => audioEngine.isInputMonitoring());
  const [lat, setLat] = useState<{ ms: number; mode: string } | null>(() => {
    const ms = audioEngine.getLastLatencyMs();
    return ms ? { ms, mode: audioEngine.isUsingASIOInput() ? 'asio' : 'navigateur' } : null;
  });

  useEffect(() => {
    const onLevel = (e: Event) => setLevel(Number((e as CustomEvent).detail));
    const onMon = (e: Event) => setOn(!!(e as CustomEvent).detail);
    const onLat = (e: Event) => setLat((e as CustomEvent).detail);
    window.addEventListener('nova:monitor-level', onLevel);
    window.addEventListener('nova:monitoring', onMon);
    window.addEventListener('nova:latency', onLat);
    return () => {
      window.removeEventListener('nova:monitor-level', onLevel);
      window.removeEventListener('nova:monitoring', onMon);
      window.removeEventListener('nova:latency', onLat);
    };
  }, []);

  const toggle = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('nova:set-monitoring', { detail: !on }));
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const latTitle = lat
    ? `Latence mesurée ${lat.ms} ms (${lat.mode === 'asio' ? 'carte son ASIO, retour direct' : 'navigateur'}) — compensée automatiquement à la fin de chaque prise. Réglage fin : Réglages audio.`
    : 'La latence est mesurée dès que la piste est armée.';

  const slider = (
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
      className={`${compact ? 'w-14' : 'flex-1'} min-w-0 accent-red-500 disabled:opacity-30`}
    />
  );

  // Mini (piste armée, devant ses effets) : vumètre + retour casque + accès aux réglages.
  if (mini) {
    return (
      <div className="flex shrink-0 items-center gap-1" onClick={stop} onMouseDown={stop} onTouchStart={stop} data-nova-target="monitor-level">
        <div className="w-10 min-w-0" title="Entrée : niveau du micro">{trackId && <InputMeter trackId={trackId} compact />}</div>
        <button type="button" onClick={toggle} aria-pressed={on}
          aria-label={on ? 'Couper le retour casque' : 'Activer le retour casque'}
          title={on ? 'Retour de ta voix dans le casque : actif (clic pour couper)' : "Retour casque coupé (clic pour l'activer, avec un casque seulement)"}
          className={`shrink-0 h-5 w-6 rounded text-[11px] ${on ? 'bg-red-500 text-white' : 'bg-white/10 text-slate-500'}`}>🎧</button>
        {onExpand && (
          <button type="button" onClick={onExpand} aria-label="Réglages d'entrée (volume du retour, latence)"
            title="Réglages d'entrée : volume du retour casque, latence"
            className="shrink-0 h-5 w-5 rounded bg-white/5 text-[9px] text-slate-400 hover:text-white"><i className="fas fa-cog" /></button>
        )}
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex items-center gap-1.5" onClick={stop} onMouseDown={stop} onTouchStart={stop} data-nova-target="monitor-level">
        <div className="flex-1 min-w-0">{trackId && <InputMeter trackId={trackId} />}</div>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={on}
          aria-label={on ? 'Couper le retour casque' : 'Activer le retour casque'}
          title={on ? 'Retour de ta voix dans le casque : actif (clic pour couper)' : 'Retour casque coupé (clic pour l\'activer, avec un casque seulement)'}
          className={`shrink-0 h-5 w-6 rounded text-[11px] ${on ? 'bg-red-500 text-white' : 'bg-white/10 text-slate-500'}`}
        >
          🎧
        </button>
        {slider}
        <span className="w-8 text-right text-[9px] font-mono text-slate-300 tabular-nums">{Math.round(level * 100)}%</span>
        <span className="shrink-0 text-[9px] font-mono text-emerald-400" title={latTitle} data-nova-target="latency">
          {lat ? `${lat.ms}ms` : '…'}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {trackId && <InputMeter trackId={trackId} />}
      <div
        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${on ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-white/10 bg-black/20'}`}
        onClick={stop}
        onMouseDown={stop}
        onTouchStart={stop}
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
        {slider}
        <span className="w-9 text-right text-[10px] font-mono text-slate-300 tabular-nums">{Math.round(level * 100)}%</span>
      </div>
      {lat && (
        <p className="px-1 text-[10px] text-slate-400" title={latTitle} data-nova-target="latency">
          ⏱ Latence {lat.ms} ms · <span className="text-emerald-400">compensée</span> · {lat.mode === 'asio' ? 'carte son (ASIO), retour direct' : 'navigateur'}
          {lat.mode !== 'asio' && lat.ms > 110 && <span className="text-amber-300"> · élevée : casque Bluetooth ? Préfère un casque filaire</span>}
        </p>
      )}
    </div>
  );
};

export default MonitorControl;
