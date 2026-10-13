import React, { useEffect, useRef } from 'react';
import { DEFAULT_GATEFX, GATEFX_PRESETS, GATEFX_SPECS, GATE_RATES, GATE_STEPS, gateSteps } from '../engine/v21Params';
import { V21Knob, V21Presets, V21Shell, useV21Params } from './v21Ui';
import { HwSection, PushButton } from './hw';

/**
 * Fenêtre « Gate rythmique » (V21) : un motif de 16 pas calé sur le tempo
 * coupe et rouvre le son (Gross Beat de FL Studio, Trance Gate, ShaperBox).
 * Un clic sur un pas l'ouvre ou le ferme ; Maj+clic = à moitié. Tous les
 * réglages (pas compris) sont automatisables. Aucune latence.
 *
 * Façade « matériel » (vague 2B) : boîte à rythmes grise, 16 touches de pas
 * colorées par temps, LED de lecture animée hors React.
 */
const spec = (id: string) => GATEFX_SPECS.find(s => s.id === id)!;
const ACCENT = '#ea580c';
/** Couleur des touches par temps (comme les boîtes à rythmes : 4 groupes de 4). */
const GROUP = ['#dc2626', '#ea580c', '#d97706', '#f5f5f4'];

export const NovaGateFxUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_GATEFX as Record<string, any>, initialParams || {}, node, onParamsChange);
  const d = DEFAULT_GATEFX as any as Record<string, number>;
  const steps = gateSteps(p);
  const len = Math.round(p.length || 16);
  const toggle = (i: number, half: boolean) => {
    const v = steps[i];
    const next = half ? (Math.abs(v - 0.5) < 0.01 ? 1 : 0.5) : (v >= 0.5 ? 0 : 1);
    set({ [`s${i + 1}`]: next });
  };

  // LED du pas joué : écrite directement dans le DOM (la façade ne se redessine pas à chaque pas).
  const gridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0, lastT = 0, cur = -2;
    const loop = (t: number) => {
      if (t - lastT > 33) {
        lastT = t;
        const m = node?.getMeters?.();
        const s = typeof m?.step === 'number' ? m.step : -1;
        if (s !== cur && gridRef.current) {
          const kids = gridRef.current.querySelectorAll<HTMLElement>('[data-gate-step]');
          kids.forEach((el, i) => { el.dataset.playing = i === s ? 'true' : 'false'; });
          cur = s;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node]);

  return (
    <V21Shell type="GATEFX" title="Gate rythmique" node={node} finish="concrete" kicker="Séquenceur de coupe · 16 pas" modelStyle="wide" width={660}
      uiAccent="#fb923c" uiAccentInk="#1c0c02" faceStyle={{ ['--hw-accent' as any]: ACCENT }}
      subtitle="Un motif de 16 pas calé sur le tempo hache le son : stutter, half, triolets, pompe. Clic sur un pas : ouvrir / fermer ; Maj+clic : à moitié. Astuce : automatise la profondeur pour n’allumer le gate que sur une mesure (avant le drop)."
      toolbar={<V21Presets presets={GATEFX_PRESETS} current={p} onApply={pr => set(pr.params as any)} />}>
      <HwSection title="Motif">
        <div ref={gridRef} className="grid grid-cols-4 sm:grid-cols-[repeat(16,minmax(0,1fr))] gap-1.5" role="group" aria-label="Motif du gate (16 pas)" data-nova-gate-steps>
          {Array.from({ length: GATE_STEPS }, (_, i) => {
            const v = steps[i];
            const inPattern = i < len;
            return (
              <button key={i} type="button" className="hw-step" aria-pressed={v >= 0.5} data-outside={inPattern ? undefined : 'true'}
                aria-label={`Pas ${i + 1} : ${v >= 0.99 ? 'ouvert' : v <= 0.01 ? 'fermé' : `${Math.round(v * 100)} %`}`}
                title={inPattern ? `Pas ${i + 1} (clic : ouvrir / fermer · Maj+clic : à moitié)` : `Pas ${i + 1} (hors du motif : longueur ${len})`} data-gate-step={i + 1}
                style={{ ['--hw-step' as any]: GROUP[Math.floor(i / 4) % 4] }}
                onClick={e => toggle(i, e.shiftKey)}>
                <span className="hw-step-fill" style={{ height: `${Math.round(v * 100)}%`, ...(i >= 12 ? { background: '#57534e' } : {}) }} />
                <span className="hw-step-led" />
                <span className="hw-step-num">{i + 1}</span>
              </button>
            );
          })}
        </div>
      </HwSection>
      <HwSection title="Division (calée sur le tempo)" className="mt-3">
        <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Division" data-nova-param="rate">
          {GATE_RATES.map(r => (
            <PushButton key={r.rate} role="radio" active={Math.round(p.rate) === r.rate} text={r.label} led={ACCENT} hint={r.hint} ariaLabel={r.label}
              dataAttrs={{ 'data-gate-rate': String(r.rate) }}
              onClick={() => set({ rate: r.rate, ...(r.rate === 3 || r.rate === 6 ? { length: 12 } : p.length === 12 ? { length: 16 } : {}) })} />
          ))}
        </div>
      </HwSection>
      <div className="hw-rule" />
      <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
        <V21Knob spec={spec('depth')} label="Profondeur" value={p.depth} defaultValue={d.depth} onChange={v => set({ depth: v })} size="M" cap="black"
          scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
        <V21Knob spec={spec('length')} label="Longueur" value={p.length} defaultValue={d.length} onChange={v => set({ length: v })} size="M" cap="black"
          scale={[{ v: 1, label: '1' }, { v: 8, label: '8' }, { v: 16, label: '16' }]} ticks={16} />
        <V21Knob spec={spec('attack')} label="Attaque" value={p.attack} defaultValue={d.attack} onChange={v => set({ attack: v })} size="M" cap="black" ticks={11} />
        <V21Knob spec={spec('release')} label="Relâchement" value={p.release} defaultValue={d.release} onChange={v => set({ release: v })} size="M" cap="black" curve="log" ticks={11} />
      </div>
    </V21Shell>
  );
};

export default NovaGateFxUI;
