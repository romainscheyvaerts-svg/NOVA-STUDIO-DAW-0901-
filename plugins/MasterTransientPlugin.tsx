import React, { useEffect, useState } from 'react';
import { V21Presets, V21Shell, useV21Params } from './v21Ui';
import { MT_BANDS, MT_CENTERS, MT_DEFAULTS, MT_PRESETS, MT_SPECS, MT_TOGGLES, type MtSpec } from '../engine/masterTransientParams';

/**
 * Fenêtre de l'effet NOVA « Mastering Transient » : limiteur de mastering
 * multibande (26 bandes auditives) avec emphase des transitoires par bande et
 * clipper doux. Tout en français, curseurs larges, courbe par bande éditable
 * (glisser sur les barres), mesures par bande, écoute d'une bande seule.
 */
interface Props { node: any; initialParams: Record<string, any>; onParamsChange: (p: Record<string, any>) => void; trackId?: string }

const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const signed = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + fr(Math.abs(v), d);
const hz = (f: number) => (f >= 1000 ? `${fr(f / 1000, f >= 10000 ? 0 : 1)} k` : `${Math.round(f)}`);

function fmt(s: MtSpec, v: number) {
  if (s.unit === '%') return `${Math.round(v)} %`;
  if (s.unit === 'ms') return `${fr(v, 2)} ms`;
  if (s.id === 'ceiling') return `${signed(v, 2)} dB`;
  return `${signed(v, s.step < 0.1 ? 2 : 1)} dB`;
}

const Slider: React.FC<{ spec: MtSpec; value: number; onChange: (v: number) => void }> = ({ spec, value, onChange }) => (
  <label className="block min-w-0" title={spec.hint} data-nova-param={spec.id}>
    <div className="flex items-baseline justify-between gap-2 mb-0.5">
      <span className="text-[11px] font-bold text-slate-200 truncate">{spec.label}</span>
      <span className="shrink-0 text-[12px] font-mono font-black text-white tabular-nums">{fmt(spec, value)}</span>
    </div>
    <input type="range" aria-label={spec.label} min={spec.min} max={spec.max} step={spec.step} value={value}
      onChange={e => onChange(parseFloat(e.target.value))} className="w-full h-8 cursor-pointer accent-orange-400" />
  </label>
);

function useMeters(node: any) {
  const [m, setM] = useState<any>(null);
  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      if (t - last > 66) { last = t; const mm = node?.getMeters?.(); if (mm) setM(mm); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node]);
  return m;
}

/** Courbe par bande : 26 barres verticales éditables (glisser), mesure en direct superposée. */
const BandCurve: React.FC<{ mode: 'bt' | 'bg'; p: Record<string, number>; set: (patch: Record<string, number>) => void; meters: any; solo: number; setSolo: (b: number) => void }> = ({ mode, p, set, meters, solo, setSolo }) => {
  const min = mode === 'bt' ? 0 : -6, max = mode === 'bt' ? 200 : 6;
  const H = 120;
  const [drag, setDrag] = useState(false);
  const valueAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const b = Math.max(0, Math.min(MT_BANDS - 1, Math.floor((e.clientX - r.left) / r.width * MT_BANDS)));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    let v = min + y * (max - min);
    v = mode === 'bt' ? Math.round(v) : Math.round(v * 10) / 10;
    return { b, v };
  };
  const apply = (e: React.PointerEvent<HTMLDivElement>) => { const { b, v } = valueAt(e); set({ [`${mode}${b + 1}`]: v }); };
  const live: number[] = meters ? (mode === 'bt' ? meters.bandEmphDb : meters.bandGrDb) || [] : [];
  return (
    <div>
      <div className="relative rounded-xl bg-black/40 border border-white/10 select-none touch-none" style={{ height: H }}
        role="group" aria-label={mode === 'bt' ? "Emphase par bande (glisser pour dessiner)" : 'Gain par bande (glisser pour dessiner)'}
        onPointerDown={e => { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); setDrag(true); apply(e); }}
        onPointerMove={e => { if (drag) apply(e); }}
        onPointerUp={() => setDrag(false)} onPointerCancel={() => setDrag(false)} data-nova-bandcurve={mode}>
        {mode === 'bt'
          ? <div className="absolute left-0 right-0 border-t border-dashed border-white/25" style={{ bottom: `${(100 - min) / (max - min) * 100}%` }} title="100 %" />
          : <div className="absolute left-0 right-0 border-t border-dashed border-white/25" style={{ bottom: '50%' }} title="0 dB" />}
        <div className="absolute inset-0 flex items-end gap-[2px] px-1 pb-0">
          {Array.from({ length: MT_BANDS }, (_, b) => {
            const v = +p[`${mode}${b + 1}`];
            const frac = (v - min) / (max - min);
            const zero = mode === 'bt' ? 0 : 0.5;
            const lo = Math.min(frac, zero), hi = Math.max(frac, zero);
            const lv = live[b] || 0;
            return (
              <div key={b} className="relative flex-1 h-full" title={`Bande ${b + 1} · ${hz(MT_CENTERS[b])} Hz : ${mode === 'bt' ? `${Math.round(v)} %` : `${signed(v)} dB`}`}>
                <div className={`absolute left-0 right-0 rounded-sm ${solo === b ? 'bg-amber-300' : mode === 'bt' ? 'bg-orange-400/80' : 'bg-sky-400/80'}`}
                  style={{ bottom: `${lo * 100}%`, height: `${Math.max(1, (hi - lo) * 100)}%` }} />
                {lv > 0.05 && <div className={`absolute left-0 right-0 h-[3px] ${mode === 'bt' ? 'bg-white' : 'bg-red-400'}`}
                  style={{ bottom: `${Math.min(100, (mode === 'bt' ? lv / 14 : 0.5 - lv / 12) * 100)}%` }} />}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex gap-[2px] px-1 mt-1 text-[8px] text-slate-500 font-mono">
        {Array.from({ length: MT_BANDS }, (_, b) => (
          <button key={b} type="button" onClick={() => setSolo(solo === b ? -1 : b)} aria-pressed={solo === b}
            title={solo === b ? `Arrêter l'écoute de la bande ${b + 1}` : `Écouter la bande ${b + 1} seule (${hz(MT_CENTERS[b])} Hz)`}
            className={`flex-1 min-w-0 h-5 rounded whitespace-nowrap overflow-visible text-left ${solo === b ? 'bg-amber-300 text-black font-black' : 'hover:bg-white/10'}`}>
            {b % 5 === 0 ? hz(MT_CENTERS[b]).replace(' ', '') : ''}
          </button>
        ))}
      </div>
    </div>
  );
};

export const NovaMasterTransientUI: React.FC<Props> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params<Record<string, any>>({ ...MT_DEFAULTS }, initialParams, node, onParamsChange);
  const [tab, setTab] = useState<'bt' | 'bg'>('bt');
  const meters = useMeters(node);
  const main = MT_SPECS.filter(s => ['emphasis', 'adaptive'].includes(s.id));
  const lim = MT_SPECS.filter(s => ['limitGain', 'speed', 'adaptiveGain', 'adaptiveSpeed', 'ceiling'].includes(s.id));
  const rest = MT_SPECS.filter(s => ['clipDrive', 'clipShape', 'inputGain', 'outputGain'].includes(s.id));
  const solo = Math.round(+p.soloBand);
  const emph = meters ? meters.emphDb : 0, gr = meters ? meters.grDb : 0;
  return (
    <V21Shell type="MASTERTRANSIENT" title="Mastering Transient" accent="text-orange-300" node={node} gradient="bg-gradient-to-b from-[#1e1610] to-[#0e0b09]"
      subtitle="Limiteur de mastering multibande (26 bandes auditives) avec emphase des attaques par bande et clipper doux. Modèle mesuré en laboratoire.">
      <V21Presets presets={MT_PRESETS as any} current={p} onApply={pr => set(pr.params as any)} color="bg-orange-400" />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-4" role="group" aria-label="Modules">
        {MT_TOGGLES.map(t => {
          const on = +p[t.id] >= 0.5;
          return (
            <button key={t.id} type="button" title={t.hint} aria-pressed={on} onClick={() => set({ [t.id]: on ? 0 : 1 })} data-nova-param={t.id}
              className={`h-9 rounded-lg text-[11px] font-black border ${on ? 'bg-orange-400 text-black border-orange-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>
              {t.label} {on ? '· oui' : '· non'}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 text-[11px]" aria-live="off">
        <div className="rounded-xl bg-white/5 border border-white/10 px-3 py-2" title="Emphase la plus forte appliquée à une attaque, toutes bandes confondues">
          <div className="text-slate-400">Emphase des attaques</div>
          <div className="font-mono font-black text-orange-300 text-[15px]" data-nova-mt="emph">{emph > 0.05 ? `+${fr(emph)}` : '0,0'} dB</div>
        </div>
        <div className="rounded-xl bg-white/5 border border-white/10 px-3 py-2" title="Réduction de gain la plus forte du limiteur multibande">
          <div className="text-slate-400">Réduction du limiteur</div>
          <div className="font-mono font-black text-red-300 text-[15px]" data-nova-mt="gr">{gr > 0.05 ? `−${fr(gr)}` : '0,0'} dB</div>
        </div>
      </div>

      <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Transitoires</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2 mb-3">
        {main.map(s => <Slider key={s.id} spec={s} value={+p[s.id]} onChange={v => set({ [s.id]: v })} />)}
      </div>

      <div className="flex items-center gap-1.5 mb-1.5" role="tablist" aria-label="Courbe par bande">
        {([['bt', 'Emphase par bande (%)'], ['bg', 'Gain par bande (dB)']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${tab === id ? 'bg-orange-400 text-black border-transparent' : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'}`}>{label}</button>
        ))}
        <button type="button" onClick={() => {
          const patch: Record<string, number> = {};
          for (let b = 1; b <= MT_BANDS; b++) patch[`${tab}${b}`] = tab === 'bt' ? 100 : 0;
          set(patch);
        }} className="ml-auto px-2 py-1 rounded-lg text-[10px] font-bold bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10"
          title={tab === 'bt' ? 'Toutes les bandes à 100 %' : 'Toutes les bandes à 0 dB'}>Remettre à plat</button>
      </div>
      <BandCurve mode={tab} p={p} set={set} meters={meters} solo={solo} setSolo={b => set({ soloBand: b })} />
      <p className="text-[10px] text-slate-500 mt-1 mb-4 leading-snug">
        {tab === 'bt' ? "Glisse sur les barres pour dessiner : 100 % = emphase globale, 0 % = aucune, 200 % = double. Trait blanc : emphase en cours." : "Égaliseur de mastering ±6 dB par bande. Trait rouge : réduction du limiteur en cours."}
        {solo >= 0 ? ` Écoute de la bande ${solo + 1} seule (${hz(MT_CENTERS[solo])} Hz) : clique à nouveau pour revenir.` : ' Clique une fréquence pour écouter la bande seule.'}
      </p>

      <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Limiteur multibande</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2 mb-4">
        {lim.map(s => <Slider key={s.id} spec={s} value={+p[s.id]} onChange={v => set({ [s.id]: v })} />)}
      </div>
      <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Clipper et niveaux</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2">
        {rest.map(s => <Slider key={s.id} spec={s} value={+p[s.id]} onChange={v => set({ [s.id]: v })} />)}
      </div>
      <p className="mt-4 text-[10px] text-slate-500 leading-snug">Modèle NOVA mesuré en laboratoire (réponse aux attaques bande par bande, loi d'emphase, limiteur) : le caractère d'un limiteur de mastering moderne, sans plugin tiers.</p>
    </V21Shell>
  );
};

export default NovaMasterTransientUI;
