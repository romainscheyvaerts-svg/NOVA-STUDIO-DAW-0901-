import React from 'react';
import { DEFAULT_VOICESHIFT, VOICESHIFT_PRESETS, VOICESHIFT_SPECS } from '../engine/v21Params';
import { noteNameFr } from '../utils/scales';
import { V21Presets, V21Shell, V21Slider, V21Toggle, useV21Meters, useV21Params } from './v21Ui';

/**
 * Fenêtre « Voix grave / aiguë » (V21) : hauteur et formant séparés, comme le
 * Vocal Transformer de Logic ou Little AlterBoy. Voix de démon, chipmunk,
 * ou formant seul (même notes, autre timbre).
 */
const spec = (id: string) => VOICESHIFT_SPECS.find(s => s.id === id)!;

export const NovaVoiceShifterUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_VOICESHIFT as Record<string, any>, initialParams || {}, node, onParamsChange);
  const m = useV21Meters(node);
  const sung: number = m?.pitch?.note || 0;
  const out = sung > 0 ? noteNameFr(Math.round(sung + p.pitch)) : '—';
  const linked = p.link >= 0.5;
  const desc = Math.abs(p.pitch) < 0.05
    ? (Math.abs(p.formant) < 0.05 ? 'Aucun changement : choisis un préréglage ou bouge la hauteur.' : 'Formant seul : mêmes notes, autre timbre.')
    : `${p.pitch < 0 ? 'Plus grave' : 'Plus aiguë'} de ${Math.abs(p.pitch).toFixed(1).replace('.', ',').replace(/,0$/, '')} demi-ton${Math.abs(p.pitch) >= 2 ? 's' : ''}${linked ? ', timbre lié (bande accélérée / ralentie)' : ', timbre naturel'}.`;

  return (
    <V21Shell type="VOICESHIFT" title="Voix grave / aiguë" accent="text-violet-400" node={node} gradient="bg-gradient-to-b from-[#15122a] to-nv-bg"
      subtitle="Hauteur et formant séparés : voix de démon, chipmunk ou timbre seul (comme le Vocal Transformer de Logic ou Little AlterBoy)">
      <V21Presets presets={VOICESHIFT_PRESETS} current={p} onApply={pr => set(pr.params as any)} color="bg-violet-400" />
      <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] border border-white/10 px-3 py-2">
        <p className="text-[11px] text-slate-300" data-nova-voiceshift="desc">{desc}</p>
        <div className="shrink-0 text-right text-[10px] text-slate-500" title="Note chantée → note entendue">
          {sung > 0 ? noteNameFr(sung) : '—'} → <b className="text-[13px] font-mono text-violet-300">{out}</b>
        </div>
      </div>
      <div className="space-y-3">
        <V21Slider spec={spec('pitch')} value={p.pitch} onChange={v => set({ pitch: v })} accent="accent-violet-400" />
        <div className="grid grid-cols-5 gap-1" aria-label="Raccourcis de hauteur">
          {[-12, -7, -5, 0, 12].map(v => (
            <button key={v} type="button" onClick={() => set({ pitch: v })} title={v === -12 ? 'Une octave plus bas' : v === 12 ? 'Une octave plus haut' : v === 0 ? 'Hauteur d\'origine' : `${v} demi-tons`}
              className={`h-8 rounded-lg text-[11px] font-black border ${Math.abs(p.pitch - v) < 0.05 ? 'bg-violet-400 text-black border-violet-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>
              {v === 0 ? '0' : v === -12 ? '−8ve' : v === 12 ? '+8ve' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`}
            </button>
          ))}
        </div>
        <V21Slider spec={spec('formant')} value={p.formant} onChange={v => set({ formant: v })} accent="accent-violet-400" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
          <V21Toggle spec={spec('link')} value={p.link} onChange={v => set({ link: v })} onLabel="Lié (chipmunk)" offLabel="Naturel" />
          <V21Slider spec={spec('mix')} value={p.mix} onChange={v => set({ mix: v })} accent="accent-violet-400" />
        </div>
        <V21Slider spec={spec('output')} value={p.output} onChange={v => set({ output: v })} accent="accent-violet-400" />
      </div>
    </V21Shell>
  );
};

export default NovaVoiceShifterUI;
