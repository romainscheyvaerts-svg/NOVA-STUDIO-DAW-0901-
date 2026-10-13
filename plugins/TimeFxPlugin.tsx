import React from 'react';
import { DEFAULT_TIMEFX, TIMEFX_PRESETS, TIMEFX_SPECS } from '../engine/v21Params';
import { V21Knob, V21Presets, V21Shell, useV21Meter, useV21Params } from './v21Ui';
import { HwSection, SegmentMeter } from './hw';

/**
 * Fenêtre « Tape stop & half-time » (V21) : arrêt de bande, ralenti
 * half-time et stutter, comme Gross Beat (FL Studio), le Beat Repeat de Live
 * ou les effets trap. Les déclencheurs sont des interrupteurs automatisables :
 * on les place sur la piste d'automation (un tape stop pile avant le drop).
 *
 * Façade « matériel » (vague 2B) : pédale jaune, trois gros pads lumineux,
 * vitesse de lecture en LED, courbe d'arrêt sur un petit écran.
 */
const spec = (id: string) => TIMEFX_SPECS.find(s => s.id === id)!;
const ACCENT = '#b91c1c';
const PAD = '#ffb347';

const MODES: Record<string, string> = {
  live: 'Lecture normale', stopping: 'Arrêt en cours…', stopped: 'Arrêté', starting: 'Redémarrage…', half: 'Half-time', stutter: 'Stutter',
};

/** Courbe de vitesse du tape stop (même formule que le moteur). */
const curve = (u: number, c: number) => (c >= 0 ? 1 - Math.pow(u, 1 + 3 * c) : Math.pow(1 - u, 1 + 3 * -c));

const Trigger: React.FC<{ id: 'stop' | 'half' | 'stutter'; label: string; on: boolean; onToggle: () => void; hint: string }> = ({ id, label, on, onToggle, hint }) => (
  <button type="button" onClick={onToggle} aria-pressed={on} title={`${label} : ${hint}`} data-nova-trigger={id} className="hw-pad" style={{ ['--hw-pad-lit' as any]: PAD }}>
    {label}<small>{on ? 'en marche · relâcher' : 'déclencher'}</small>
  </button>
);

/** Mode en cours : seul cet afficheur suit les mesures. */
const ModeLcd: React.FC<{ node: any }> = ({ node }) => {
  const mode = useV21Meter(node, m => String(m?.mode || 'live'));
  return <span className="hw-lcd" aria-live="polite"><span data-nova-timefx="mode">{MODES[mode] || MODES.live}</span></span>;
};

export const NovaTimeFxUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_TIMEFX as Record<string, any>, initialParams || {}, node, onParamsChange);
  const d = DEFAULT_TIMEFX as any as Record<string, number>;
  // Tracé de la courbe de vitesse (0 → durée de l'arrêt).
  const pts = Array.from({ length: 41 }, (_, i) => { const u = i / 40; return `${(u * 100).toFixed(1)},${(40 - curve(u, p.stopCurve) * 36 - 2).toFixed(1)}`; }).join(' ');

  return (
    <V21Shell type="TIMEFX" title="Tape stop & half-time" node={node} finish="mustard" kicker="Arrêt de bande · ralenti · stutter" modelStyle="wide" width={600}
      uiAccent="#f59e0b" uiAccentInk="#1d1203" faceStyle={{ ['--hw-accent' as any]: ACCENT }}
      subtitle="Calé sur le tempo. Astuce : passe la piste en écriture d'automation (Touch / Latch) et appuie sur un pad pendant la lecture, ou dessine l'interrupteur dans la piste d'automation pour le placer pile sur le temps. Rendu identique à l'export."
      toolbar={<V21Presets presets={TIMEFX_PRESETS} current={p} onApply={pr => set(pr.params as any)} />}>
      <div className="grid grid-cols-3 gap-2.5 mb-3">
        <Trigger id="stop" label="Tape stop" on={p.stop >= 0.5} onToggle={() => set({ stop: p.stop >= 0.5 ? 0 : 1 })} hint={spec('stop').hint} />
        <Trigger id="half" label="Half-time" on={p.half >= 0.5} onToggle={() => set({ half: p.half >= 0.5 ? 0 : 1 })} hint={spec('half').hint} />
        <Trigger id="stutter" label="Stutter" on={p.stutter >= 0.5} onToggle={() => set({ stutter: p.stutter >= 0.5 ? 0 : 1 })} hint={spec('stutter').hint} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-1">
        <ModeLcd node={node} />
        <div className="flex-1 min-w-[160px]">
          <SegmentMeter read={() => { const s = node?.getMeters?.()?.speed; return (typeof s === 'number' ? s : 1) * 100; }} max={100} segments={20} holdMs={0}
            colorAt={v => (v > 85 ? '#16a34a' : v > 40 ? '#f59e0b' : '#dc2626')} label="Vitesse" hint="Vitesse de lecture (100 % = normale)"
            scale={[{ v: 0, label: '0' }, { v: 50, label: '50' }, { v: 100, label: '100 %' }]} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 mt-2">
        <HwSection title="Tape stop" className="flex-[3_1_300px] min-w-0">
          <div className="flex flex-wrap items-center justify-around gap-x-2 gap-y-2">
            <V21Knob spec={spec('stopBeats')} label="Durée" value={p.stopBeats} defaultValue={d.stopBeats} onChange={v => set({ stopBeats: v })} size="M" cap="black" curve="log"
              scale={[{ v: 0.125, label: '⅛' }, { v: 1, label: '1' }, { v: 8, label: '8' }]} ticks={0} />
            <V21Knob spec={spec('stopCurve')} label="Courbe" value={p.stopCurve} defaultValue={d.stopCurve} onChange={v => set({ stopCurve: v })} size="M" cap="black" ticks={11} />
            <div className="hw-screen" style={{ width: 120 }} title="Courbe de vitesse du tape stop">
              <div className="hw-screen-glass">
                <svg viewBox="0 0 100 40" className="w-full block" style={{ height: 56 }} aria-label="Courbe de vitesse du tape stop">
                  <polyline points={pts} fill="none" stroke="#fb923c" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  <text x="3" y="9" fontSize="6.5" fill="#cbd5e1">vitesse</text>
                  <text x="66" y="37" fontSize="6.5" fill="#cbd5e1">temps →</text>
                </svg>
              </div>
            </div>
            <V21Knob spec={spec('startBeats')} label="Redémarrage" value={p.startBeats} defaultValue={d.startBeats} onChange={v => set({ startBeats: v })} size="M" cap="black"
              scale={[{ v: 0, label: '0' }, { v: 2, label: '2' }, { v: 4, label: '4' }]} ticks={0} />
          </div>
        </HwSection>
        <HwSection title="Half-time · stutter" className="flex-[2_1_200px] min-w-0">
          <div className="flex flex-wrap items-center justify-around gap-x-2 gap-y-2">
            <V21Knob spec={spec('halfBeats')} label="Cycle" value={p.halfBeats} defaultValue={d.halfBeats} onChange={v => set({ halfBeats: v })} size="M" cap="black"
              scale={[{ v: 1, label: '1' }, { v: 4, label: '4' }, { v: 8, label: '8' }]} ticks={8} />
            <V21Knob spec={spec('stutterDiv')} label="Répétition" value={p.stutterDiv} defaultValue={d.stutterDiv} onChange={v => set({ stutterDiv: v })} size="M" cap="black" curve="log"
              scale={[{ v: 0.0625, label: '1/16' }, { v: 0.25, label: '¼' }, { v: 2, label: '2' }]} ticks={0} />
          </div>
        </HwSection>
      </div>
    </V21Shell>
  );
};

export default NovaTimeFxUI;
