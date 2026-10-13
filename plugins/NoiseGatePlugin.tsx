import React from 'react';
import { DEFAULT_GATE, GATE_PRESETS, GATE_SPECS } from '../engine/v21Params';
import { V21Knob, V21Presets, V21Shell, useV21Meter, useV21Params } from './v21Ui';
import { HwSection, Led } from './hw';

/**
 * Fenêtre « Gate » (R7) : porte de bruit / expandeur. La détection suit le son
 * ou une clé externe (side-chain, choisie dans la barre « Clé » au-dessus) :
 * un pad ou une 808 hachés au rythme du kick ou des charleys. Aucune latence.
 *
 * Façade « matériel » (vague 2B) : module de rack vert anodisé, gros voyant
 * « ouvert », boutons rotatifs du kit plugins/hw.
 */
const spec = (id: string) => GATE_SPECS.find(s => s.id === id)!;
const ACCENT = '#4ade80';

/** Voyant de la porte : seul ce petit bloc suit les mesures (la façade ne se redessine pas). */
const GateState: React.FC<{ node: any }> = ({ node }) => {
  const open = useV21Meter(node, m => !!m?.open);
  const keyed = useV21Meter(node, m => !!m?.keyOn);
  return (
    <div className="flex items-center gap-2.5 min-w-0" aria-live="polite" title="Ouvert : le son passe. Fermé : il est baissé de la valeur de « Plage ».">
      <Led on={open} color={ACCENT} large />
      <span className="hw-lcd" style={{ minWidth: 0 }}>
        <span data-nova-gate-state={open ? 'open' : 'closed'}>{open ? 'Ouvert' : 'Fermé'}</span>
        <small>{keyed ? 'clé externe' : 'son de la piste'}</small>
      </span>
    </div>
  );
};

export const NovaNoiseGateUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_GATE as Record<string, any>, initialParams || {}, node, onParamsChange);
  const d = DEFAULT_GATE as any as Record<string, number>;
  return (
    <V21Shell type="GATE" title="Gate" node={node} finish="jade" kicker="Porte de bruit · expandeur · clé externe" modelStyle="wide" width={560}
      uiAccent={ACCENT} uiAccentInk="#04150c" faceStyle={{ ['--hw-accent' as any]: ACCENT }}
      subtitle="Coupe le son sous le seuil. Avec une clé (barre « Clé » au-dessus), il s’ouvre au rythme d’une autre piste : mets-le sur un pad ou une 808 et choisis le kick ou les charleys, le son ne passe que sur les coups."
      toolbar={<V21Presets presets={GATE_PRESETS} current={p} onApply={pr => set(pr.params as any)} />}>
      <div className="mb-3"><GateState node={node} /></div>
      <div className="flex flex-wrap items-start justify-around gap-x-3 gap-y-3">
        <V21Knob spec={spec('threshold')} label="Seuil" value={p.threshold} defaultValue={d.threshold} onChange={v => set({ threshold: v })} size="L" cap="silver"
          scale={[{ v: -80, label: '-80' }, { v: -60, label: '-60' }, { v: -40, label: '-40' }, { v: -20, label: '-20' }, { v: 0, label: '0' }]} />
        <V21Knob spec={spec('range')} label="Plage" value={p.range} defaultValue={d.range} onChange={v => set({ range: v })} size="M" cap="silver"
          scale={[{ v: 0, label: '0' }, { v: 40, label: '40' }, { v: 80, label: '80' }]} />
      </div>
      <HwSection title="Temps" className="mt-3">
        <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
          <V21Knob spec={spec('attack')} label="Ouverture" value={p.attack} defaultValue={d.attack} onChange={v => set({ attack: v })} size="M" cap="black" ticks={11} />
          <V21Knob spec={spec('hold')} label="Maintien" value={p.hold} defaultValue={d.hold} onChange={v => set({ hold: v })} size="M" cap="black" ticks={11} />
          <V21Knob spec={spec('release')} label="Fermeture" value={p.release} defaultValue={d.release} onChange={v => set({ release: v })} size="M" cap="black" curve="log" ticks={11} />
        </div>
      </HwSection>
    </V21Shell>
  );
};

export default NovaNoiseGateUI;
