import React from 'react';
import { DEFAULT_GATE, GATE_PRESETS, GATE_SPECS } from '../engine/v21Params';
import { V21Presets, V21Shell, V21Slider, useV21Meters, useV21Params } from './v21Ui';

/**
 * Fenêtre « Gate » (R7) : porte de bruit / expandeur. La détection suit le son
 * ou une clé externe (side-chain, choisie dans la barre « Clé » au-dessus) :
 * un pad ou une 808 hachés au rythme du kick ou des charleys. Aucune latence.
 */
const spec = (id: string) => GATE_SPECS.find(s => s.id === id)!;

export const NovaNoiseGateUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_GATE as Record<string, any>, initialParams || {}, node, onParamsChange);
  const m = useV21Meters(node);
  const open = !!m?.open;
  const keyed = !!m?.keyOn;
  return (
    <V21Shell type="GATE" title="Gate" accent="text-emerald-400" node={node} gradient="bg-gradient-to-b from-[#0d1a14] to-[#080c0a]"
      subtitle="Porte de bruit / expandeur : coupe le son sous le seuil. Avec une clé, il s’ouvre au rythme d’une autre piste (Dyn3 Expander/Gate de Pro Tools, Gate d’Ableton)">
      <div className="mb-3 flex items-center gap-2" aria-live="polite">
        <span className={`inline-block w-3 h-3 rounded-full ${open ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-slate-600'}`} />
        <span className="text-[11px] font-bold text-slate-200" data-nova-gate-state={open ? 'open' : 'closed'}>{open ? 'Ouvert : le son passe' : 'Fermé'}</span>
        <span className="text-[10px] text-slate-500">· détection sur {keyed ? 'la clé externe' : 'le son de la piste'}</span>
      </div>
      <V21Presets presets={GATE_PRESETS} current={p} onApply={pr => set(pr.params as any)} color="bg-emerald-400" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        <V21Slider spec={spec('threshold')} value={p.threshold} onChange={v => set({ threshold: v })} accent="accent-emerald-400" />
        <V21Slider spec={spec('range')} value={p.range} onChange={v => set({ range: v })} accent="accent-emerald-400" />
        <V21Slider spec={spec('attack')} value={p.attack} onChange={v => set({ attack: v })} accent="accent-emerald-400" />
        <V21Slider spec={spec('hold')} value={p.hold} onChange={v => set({ hold: v })} accent="accent-emerald-400" />
        <V21Slider spec={spec('release')} value={p.release} onChange={v => set({ release: v })} accent="accent-emerald-400" />
      </div>
      <p className="mt-4 text-[10px] text-slate-500">Astuce trap : mets le Gate sur un pad ou une 808, choisis le kick (ou les charleys) comme clé en haut de la fenêtre : le son ne passe que sur les coups. Seuil, plage et temps sont automatisables.</p>
    </V21Shell>
  );
};

export default NovaNoiseGateUI;
