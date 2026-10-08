import React from 'react';
import { DEFAULT_GATEFX, GATEFX_PRESETS, GATEFX_SPECS, GATE_RATES, GATE_STEPS, gateSteps } from '../engine/v21Params';
import { V21Presets, V21Shell, V21Slider, useV21Meters, useV21Params } from './v21Ui';

/**
 * Fenêtre « Gate rythmique » (V21) : un motif de 16 pas calé sur le tempo
 * coupe et rouvre le son (Gross Beat de FL Studio, Trance Gate, ShaperBox).
 * Un clic sur un pas l'ouvre ou le ferme ; Maj+clic = à moitié. Tous les
 * réglages (pas compris) sont automatisables. Aucune latence.
 */
const spec = (id: string) => GATEFX_SPECS.find(s => s.id === id)!;

export const NovaGateFxUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_GATEFX as Record<string, any>, initialParams || {}, node, onParamsChange);
  const m = useV21Meters(node);
  const steps = gateSteps(p);
  const len = Math.round(p.length || 16);
  const cur = typeof m?.step === 'number' ? m.step : -1;
  const toggle = (i: number, half: boolean) => {
    const v = steps[i];
    const next = half ? (Math.abs(v - 0.5) < 0.01 ? 1 : 0.5) : (v >= 0.5 ? 0 : 1);
    set({ [`s${i + 1}`]: next });
  };

  return (
    <V21Shell type="GATEFX" title="Gate rythmique" accent="text-fuchsia-400" node={node} gradient="bg-gradient-to-b from-[#1a0f1d] to-[#0c080e]"
      subtitle="Motif de 16 pas calé sur le tempo qui hache le son : stutter, half, triolets, pompe (comme Gross Beat dans FL Studio, le Trance Gate ou ShaperBox)">
      <V21Presets presets={GATEFX_PRESETS} current={p} onApply={pr => set(pr.params as any)} color="bg-fuchsia-400" />
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-bold text-slate-200">Motif</span>
        <span className="text-[10px] text-slate-500">Clic : ouvrir / fermer · Maj+clic : à moitié</span>
      </div>
      <div className="mb-4 grid grid-cols-8 sm:grid-cols-[repeat(16,minmax(0,1fr))] gap-1" role="group" aria-label="Motif du gate (16 pas)" data-nova-gate-steps>
        {Array.from({ length: GATE_STEPS }, (_, i) => {
          const v = steps[i];
          const inPattern = i < len;
          const playing = i === cur;
          return (
            <button key={i} type="button" aria-pressed={v >= 0.5} aria-label={`Pas ${i + 1} : ${v >= 0.99 ? 'ouvert' : v <= 0.01 ? 'fermé' : `${Math.round(v * 100)} %`}`}
              title={inPattern ? `Pas ${i + 1}` : `Pas ${i + 1} (hors du motif : longueur ${len})`} data-gate-step={i + 1}
              onClick={e => toggle(i, e.shiftKey)}
              className={`relative h-12 rounded-md border transition-colors ${inPattern ? '' : 'opacity-30'} ${playing ? 'ring-2 ring-white' : ''} ${i % 4 === 0 ? 'border-fuchsia-300/40' : 'border-white/10'} bg-black/40 overflow-hidden`}>
              <span className="absolute inset-x-0 bottom-0 bg-fuchsia-400" style={{ height: `${Math.round(v * 100)}%` }} />
              <span className="relative text-[9px] font-bold text-white/70">{i + 1}</span>
            </button>
          );
        })}
      </div>
      <div className="mb-4">
        <div className="text-[11px] font-bold text-slate-200 mb-1" title={spec('rate').hint}>Division (calée sur le tempo)</div>
        <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Division">
          {GATE_RATES.map(r => (
            <button key={r.rate} type="button" role="radio" aria-checked={Math.round(p.rate) === r.rate} title={r.hint} data-gate-rate={r.rate}
              onClick={() => set({ rate: r.rate, ...(r.rate === 3 || r.rate === 6 ? { length: 12 } : p.length === 12 ? { length: 16 } : {}) })}
              className={`h-10 rounded-lg text-[12px] font-black border ${Math.round(p.rate) === r.rate ? 'bg-fuchsia-400 text-black border-fuchsia-300' : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'}`}>{r.label}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        <V21Slider spec={spec('depth')} value={p.depth} onChange={v => set({ depth: v })} accent="accent-fuchsia-400" />
        <V21Slider spec={spec('length')} value={p.length} onChange={v => set({ length: v })} accent="accent-fuchsia-400" />
        <V21Slider spec={spec('attack')} value={p.attack} onChange={v => set({ attack: v })} accent="accent-fuchsia-400" />
        <V21Slider spec={spec('release')} value={p.release} onChange={v => set({ release: v })} accent="accent-fuchsia-400" />
      </div>
      <p className="mt-4 text-[10px] text-slate-500">Astuce : automatise la profondeur pour n’allumer le gate que sur une mesure (avant le drop), ou un pas pour faire évoluer le motif. Rendu identique à l’export, sans latence.</p>
    </V21Shell>
  );
};

export default NovaGateFxUI;
