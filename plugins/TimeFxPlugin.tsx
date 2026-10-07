import React from 'react';
import { DEFAULT_TIMEFX, TIMEFX_PRESETS, TIMEFX_SPECS } from '../engine/v21Params';
import { V21Presets, V21Shell, V21Slider, useV21Meters, useV21Params } from './v21Ui';

/**
 * Fenêtre « Tape stop & half-time » (V21) : arrêt de bande, ralenti
 * half-time et stutter, comme Gross Beat (FL Studio), le Beat Repeat de Live
 * ou les effets trap. Les déclencheurs sont des interrupteurs automatisables :
 * on les place sur la piste d'automation (un tape stop pile avant le drop).
 */
const spec = (id: string) => TIMEFX_SPECS.find(s => s.id === id)!;

const MODES: Record<string, string> = {
  live: 'Lecture normale', stopping: 'Arrêt en cours…', stopped: 'Arrêté', starting: 'Redémarrage…', half: 'Half-time', stutter: 'Stutter',
};

/** Courbe de vitesse du tape stop (même formule que le moteur). */
const curve = (u: number, c: number) => (c >= 0 ? 1 - Math.pow(u, 1 + 3 * c) : Math.pow(1 - u, 1 + 3 * -c));

const Trigger: React.FC<{ id: 'stop' | 'half' | 'stutter'; label: string; on: boolean; onToggle: () => void; hint: string }> = ({ id, label, on, onToggle, hint }) => (
  <button type="button" onClick={onToggle} aria-pressed={on} title={hint} data-nova-trigger={id}
    className={`h-14 rounded-xl text-[13px] font-black border transition-colors ${on ? 'bg-orange-400 text-black border-orange-300 shadow-[0_0_24px_rgba(251,146,60,0.45)]' : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'}`}>
    {label}<span className="block text-[9px] font-bold opacity-70">{on ? 'en marche · clic pour relâcher' : 'clic pour déclencher'}</span>
  </button>
);

export const NovaTimeFxUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_TIMEFX as Record<string, any>, initialParams || {}, node, onParamsChange);
  const m = useV21Meters(node);
  const speed = typeof m?.speed === 'number' ? m.speed : 1;
  const mode = MODES[m?.mode] || MODES.live;
  // Tracé de la courbe de vitesse (0 → durée de l'arrêt).
  const pts = Array.from({ length: 41 }, (_, i) => { const u = i / 40; return `${(u * 100).toFixed(1)},${(40 - curve(u, p.stopCurve) * 36 - 2).toFixed(1)}`; }).join(' ');

  return (
    <V21Shell type="TIMEFX" title="Tape stop & half-time" accent="text-orange-400" node={node} gradient="bg-gradient-to-b from-[#1d140c] to-[#0e0b08]"
      subtitle="Arrêt de bande, ralenti half-time et stutter calés sur le tempo (comme Gross Beat dans FL Studio ou le Beat Repeat de Live)">
      <V21Presets presets={TIMEFX_PRESETS} current={p} onApply={pr => set(pr.params as any)} color="bg-orange-400" />
      <div className="grid grid-cols-3 gap-2 mb-2">
        <Trigger id="stop" label="Tape stop" on={p.stop >= 0.5} onToggle={() => set({ stop: p.stop >= 0.5 ? 0 : 1 })} hint={spec('stop').hint} />
        <Trigger id="half" label="Half-time" on={p.half >= 0.5} onToggle={() => set({ half: p.half >= 0.5 ? 0 : 1 })} hint={spec('half').hint} />
        <Trigger id="stutter" label="Stutter" on={p.stutter >= 0.5} onToggle={() => set({ stutter: p.stutter >= 0.5 ? 0 : 1 })} hint={spec('stutter').hint} />
      </div>
      <div className="mb-4 flex items-center gap-3 text-[11px] text-slate-300" aria-live="polite">
        <span className="font-bold" data-nova-timefx="mode">{mode}</span>
        <div className="flex-1 h-2 rounded bg-black/50 border border-white/10 overflow-hidden" title="Vitesse de lecture (100 % = normale)">
          <div className="h-full bg-orange-400 transition-[width] duration-75" style={{ width: `${Math.round(Math.max(0, Math.min(1, speed)) * 100)}%` }} />
        </div>
        <span className="font-mono w-12 text-right">{Math.round(speed * 100)} %</span>
      </div>
      <p className="mb-4 text-[10px] text-slate-500">Astuce : passe la piste en écriture d'automation (Touch / Latch) et clique sur un bouton pendant la lecture, ou dessine l'interrupteur dans la piste d'automation pour le placer pile sur le temps. Rendu identique à l'export.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        <div className="sm:col-span-2 grid grid-cols-[1fr_120px] gap-4 items-center">
          <div className="space-y-3">
            <V21Slider spec={spec('stopBeats')} value={p.stopBeats} onChange={v => set({ stopBeats: v })} accent="accent-orange-400" />
            <V21Slider spec={spec('stopCurve')} value={p.stopCurve} onChange={v => set({ stopCurve: v })} accent="accent-orange-400" />
          </div>
          <svg viewBox="0 0 100 40" className="w-full h-20 rounded-lg bg-black/40 border border-white/10" aria-label="Courbe de vitesse du tape stop">
            <polyline points={pts} fill="none" stroke="#fb923c" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <text x="3" y="9" fontSize="6" fill="#94a3b8">vitesse</text>
            <text x="70" y="37" fontSize="6" fill="#94a3b8">temps →</text>
          </svg>
        </div>
        <V21Slider spec={spec('startBeats')} value={p.startBeats} onChange={v => set({ startBeats: v })} accent="accent-orange-400" />
        <V21Slider spec={spec('halfBeats')} value={p.halfBeats} onChange={v => set({ halfBeats: v })} accent="accent-orange-400" />
        <V21Slider spec={spec('stutterDiv')} value={p.stutterDiv} onChange={v => set({ stutterDiv: v })} accent="accent-orange-400" />
      </div>
    </V21Shell>
  );
};

export default NovaTimeFxUI;
