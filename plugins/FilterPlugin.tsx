import React from 'react';
import { DEFAULT_DJFILTER, DEFAULT_LOFI, DJFILTER_PRESETS, DJFILTER_SPECS, LOFI_PRESETS, LOFI_SPECS } from '../engine/v21Params';
import { V21Presets, V21Shell, V21Slider, useV21Meters, useV21Params } from './v21Ui';

/**
 * Fenêtres « Filtre DJ » et « Lo-fi / téléphone » (V21).
 *  - Filtre DJ : un seul bouton passe-bas ↔ passe-haut, comme une table de
 *    mixage DJ, l'Auto Filter de Live ou le DJ Filter de Logic.
 *  - Lo-fi : bande passante, saturation légère, bitcrush et souffle, comme
 *    Bitcrusher (Logic), Redux (Live) ou Lo-fi (FL Studio). La saturation
 *    riche reste dans « Saturation » (pas de doublon).
 */
const dj = (id: string) => DJFILTER_SPECS.find(s => s.id === id)!;
const lf = (id: string) => LOFI_SPECS.find(s => s.id === id)!;

const hzText = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1).replace('.', ',')} kHz` : `${Math.round(hz)} Hz`);

export const NovaDjFilterUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_DJFILTER as Record<string, any>, initialParams || {}, node, onParamsChange);
  const m = useV21Meters(node);
  const f = p.filter;
  const state = Math.abs(f) <= 0.02 ? 'Ouvert : aucun filtre' : f < 0 ? 'Passe-bas : les aigus s\'en vont' : 'Passe-haut : les basses s\'en vont';
  const cut = m?.cutoff > 0 ? hzText(m.cutoff) : '';
  return (
    <V21Shell type="DJFILTER" title="Filtre DJ" accent="text-sky-400" node={node} gradient="bg-gradient-to-b from-[#0c1622] to-[#090c10]"
      subtitle="Un seul bouton : passe-bas à gauche, passe-haut à droite (comme le filtre d'une table DJ, l'Auto Filter de Live ou le DJ Filter de Logic)">
      <V21Presets presets={DJFILTER_PRESETS} current={p} onApply={pr => set(pr.params as any)} color="bg-sky-400" />
      <div className="mb-4 rounded-xl bg-white/[0.04] border border-white/10 p-3" title={dj('filter').hint} data-nova-param="filter">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[12px] font-black text-white" data-nova-djfilter="state">{state}</span>
          <span className="text-[12px] font-mono text-sky-300">{cut}</span>
        </div>
        <input type="range" aria-label="Filtre (passe-bas ↔ passe-haut)" min={-1} max={1} step={0.01} value={f}
          onChange={e => { const v = parseFloat(e.target.value); set({ filter: Math.abs(v) < 0.025 ? 0 : v }); }}
          className="w-full h-10 cursor-pointer accent-sky-400" />
        <div className="flex justify-between text-[10px] font-bold text-slate-400"><span>◀ Passe-bas</span>
          <button type="button" onClick={() => set({ filter: 0 })} className="px-2 rounded bg-white/5 hover:bg-white/10 text-slate-200" title="Remettre au centre (aucun filtre)">Centre</button>
          <span>Passe-haut ▶</span></div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        <V21Slider spec={dj('resonance')} value={p.resonance} onChange={v => set({ resonance: v })} accent="accent-sky-400" />
        <div title={dj('slope').hint}>
          <div className="text-[11px] font-bold text-slate-200 mb-1">Pente</div>
          <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Pente">
            {[12, 24].map(s => (
              <button key={s} type="button" role="radio" aria-checked={p.slope === s} onClick={() => set({ slope: s })}
                className={`h-9 rounded-lg text-[11px] font-black border ${p.slope === s ? 'bg-sky-400 text-black border-sky-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>{s} dB/oct{s === 24 ? ' (DJ)' : ''}</button>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 leading-snug mt-1">{dj('slope').hint}</p>
        </div>
        <V21Slider spec={dj('output')} value={p.output} onChange={v => set({ output: v })} accent="accent-sky-400" />
      </div>
    </V21Shell>
  );
};

export const NovaLofiUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_LOFI as Record<string, any>, initialParams || {}, node, onParamsChange);
  return (
    <V21Shell type="LOFI" title="Lo-fi / téléphone" accent="text-lime-400" node={node} gradient="bg-gradient-to-b from-[#121a0c] to-[#0a0d08]"
      subtitle="Téléphone, radio, cassette, bitcrush (comme le Bitcrusher de Logic, Redux de Live ou Lo-fi de FL Studio)">
      <V21Presets presets={LOFI_PRESETS} current={p} onApply={pr => set(pr.params as any)} color="bg-lime-400" />
      <div className="mb-4 rounded-xl bg-white/[0.04] border border-white/10 px-3 py-2 text-[11px] text-slate-300" data-nova-lofi="band">
        Bande passante : <b className="text-lime-300">{p.lowCut <= 25 ? 'graves intacts' : hzText(p.lowCut)}</b> → <b className="text-lime-300">{p.highCut >= 19500 ? 'aigus intacts' : hzText(p.highCut)}</b>
        {' · '}{p.bits >= 16 && p.rate >= 44100 ? 'sans bitcrush' : `${p.bits >= 16 ? '16' : Math.round(p.bits)} bits, ${hzText(p.rate)}`}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        {['lowCut', 'highCut', 'drive', 'bits', 'rate', 'noise', 'mix', 'output'].map(id => (
          <V21Slider key={id} spec={lf(id)} value={p[id]} onChange={v => set({ [id]: v })} accent="accent-lime-400" />
        ))}
      </div>
    </V21Shell>
  );
};

export default NovaDjFilterUI;
