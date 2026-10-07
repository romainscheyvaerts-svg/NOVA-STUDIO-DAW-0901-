import React from 'react';
import { DEFAULT_HARMONIZER, HARMONIZER_PRESETS, HARMONIZER_SPECS, HARMONY_INTERVALS } from '../engine/v21Params';
import { createHarmonyMath } from '../engine/psolaCore';
import { NOTE_NAMES_FR, SCALE_CHOICES, noteNameFr, scaleIntervals } from '../utils/scales';
import { V21Presets, V21Shell, V21Slider, V21Toggle, useV21Meters, useV21Params } from './v21Ui';

/**
 * Fenêtre de l'Harmoniseur NOVA (V21) : 1 à 4 voix d'harmonie dans la gamme
 * du projet, comme les harmonies du Vocal Transformer de Logic, le Pitcher de
 * FL Studio ou un harmoniseur TC-Helicon. Formants préservés.
 */
const spec = (id: string) => HARMONIZER_SPECS.find(s => s.id === id)!;
const math = createHarmonyMath();

export const NovaHarmonizerUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_HARMONIZER as Record<string, any>, initialParams || {}, node, onParamsChange);
  const m = useV21Meters(node);
  const n = Math.max(1, Math.min(4, Math.round(p.voices)));
  const sung: number = m?.pitch?.note || 0;
  const scale = scaleIntervals(p.scale);
  const chromatic = (p.scale || 'CHROMATIC').toUpperCase() === 'CHROMATIC';
  const harmonyOf = (deg: number) => (sung > 0 ? noteNameFr(sung + math.shiftFor(sung, p.rootKey, scale, deg)) : '—');

  return (
    <V21Shell type="HARMONIZER" title="Harmoniseur" accent="text-fuchsia-400" node={node} gradient="bg-gradient-to-b from-[#1a1020] to-[#0d0b10]"
      subtitle="Ajoute 1 à 4 voix d'harmonie dans la gamme, timbre naturel (comme les harmonies du Vocal Transformer de Logic ou le Pitcher de FL Studio)">
      <V21Presets presets={HARMONIZER_PRESETS} current={p} onApply={pr => set(pr.params as any)} color="bg-fuchsia-400" />

      {/* Tonalité */}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end mb-3" title="Gamme utilisée pour calculer les harmonies. NOVA prend celle du projet (détectée sur le beat) ; change-la si besoin.">
        <label className="block">
          <span className="text-[11px] font-bold text-slate-200">Tonique</span>
          <select aria-label="Tonique" value={p.rootKey} onChange={e => set({ rootKey: +e.target.value })}
            className="mt-1 w-full h-9 rounded-lg bg-white/5 border border-white/10 text-[12px] font-bold text-white px-2">
            {NOTE_NAMES_FR.map((nm, i) => <option key={i} value={i} className="bg-[#1a1020]">{nm}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-bold text-slate-200">Gamme</span>
          <select aria-label="Gamme" value={(p.scale || 'CHROMATIC').toUpperCase()} onChange={e => set({ scale: e.target.value })}
            className="mt-1 w-full h-9 rounded-lg bg-white/5 border border-white/10 text-[12px] font-bold text-white px-2">
            {SCALE_CHOICES.map(s => <option key={s.id} value={s.id} className="bg-[#1a1020]">{s.label}</option>)}
          </select>
        </label>
        <div className="text-right text-[10px] text-slate-500 pb-1" aria-live="polite" title="Note chantée en ce moment (détection de hauteur)">
          Note chantée<br /><b className="text-[13px] font-mono text-fuchsia-300" data-nova-harmonizer="note">{sung > 0 ? noteNameFr(sung) : '—'}</b>
        </div>
      </div>
      {chromatic && <p className="mb-3 text-[10px] text-amber-300">Tonalité inconnue : les intervalles sont fixes (tierce majeure, quinte…). Choisis la gamme du morceau pour des harmonies toujours justes.</p>}

      {/* Voix */}
      <div className="mb-2 flex items-center gap-2" title={spec('voices').hint}>
        <span className="text-[11px] font-bold text-slate-200">Voix</span>
        <div className="grid grid-cols-4 gap-1 flex-1" role="radiogroup" aria-label="Nombre de voix">
          {[1, 2, 3, 4].map(v => (
            <button key={v} type="button" role="radio" aria-checked={n === v} onClick={() => set({ voices: v })}
              className={`h-9 rounded-lg text-[12px] font-black border ${n === v ? 'bg-fuchsia-400 text-black border-fuchsia-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>{v}</button>
          ))}
        </div>
      </div>
      <div className="space-y-2 mb-4">
        {[1, 2, 3, 4].slice(0, n).map(i => {
          const deg = Math.round(p[`v${i}Deg`]);
          return (
            <div key={i} className="rounded-xl bg-white/[0.04] border border-white/10 p-2.5" data-nova-voice={i}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="flex items-center gap-2 min-w-0" title={spec(`v${i}Deg`).hint}>
                  <span className="text-[11px] font-black text-fuchsia-300 shrink-0">Voix {i}</span>
                  <select aria-label={`Intervalle de la voix ${i}`} value={deg} onChange={e => set({ [`v${i}Deg`]: +e.target.value })}
                    className="h-8 min-w-0 rounded-lg bg-white/5 border border-white/10 text-[12px] font-bold text-white px-2">
                    {HARMONY_INTERVALS.map(iv => <option key={iv.deg} value={iv.deg} className="bg-[#1a1020]">{iv.label}</option>)}
                  </select>
                </label>
                <span className="shrink-0 text-[11px] font-mono text-slate-300" title="Note jouée par cette voix en ce moment">→ {harmonyOf(deg)}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <V21Slider compact spec={spec(`v${i}Level`)} label="Niveau" value={p[`v${i}Level`]} onChange={v => set({ [`v${i}Level`]: v })} accent="accent-fuchsia-400" />
                <V21Slider compact spec={spec(`v${i}Pan`)} label="Panoramique" value={p[`v${i}Pan`]} onChange={v => set({ [`v${i}Pan`]: v })} accent="accent-fuchsia-400" />
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        <V21Slider spec={spec('dry')} value={p.dry} onChange={v => set({ dry: v })} accent="accent-fuchsia-400" />
        <V21Slider spec={spec('humanize')} value={p.humanize} onChange={v => set({ humanize: v })} accent="accent-fuchsia-400" />
        <V21Slider spec={spec('formant')} value={p.formant} onChange={v => set({ formant: v })} accent="accent-fuchsia-400" />
        <V21Toggle spec={spec('preserve')} value={p.preserve} onChange={v => set({ preserve: v })} onLabel="Préservés" offLabel="Chipmunk" />
      </div>
    </V21Shell>
  );
};

export default NovaHarmonizerUI;
