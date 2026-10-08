import React, { useEffect, useRef, useState } from 'react';
import { ANALOG_SPECS, AnalogParamSpec, AnalogKindSpec } from '../engine/analogCompParams';
import { ANALOG_PROFILES } from '../engine/analogProfiles';
import { V21Presets, V21Shell, useV21Params } from './v21Ui';
import { calibrateNovaOnTrack, CalibrationResult } from '../utils/grCalibration';

/**
 * Fenêtre des compresseurs « analogiques » NOVA (Opto Vintage, FET 76,
 * Leveler 2A, Vox Strip) : tout en français, au tutoiement, curseurs larges,
 * VU de réduction de gain (balistique VU, 300 ms) avec la cible du calage,
 * et le bouton « Caler sur ma voix » (règles de mix maison : 5 dB max au VU
 * sur la voix, 2 dB sur le Leveler de bus).
 */
interface Props { node: any; initialParams: Record<string, any>; onParamsChange: (p: Record<string, any>) => void; trackId?: string }

const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const signed = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + fr(Math.abs(v), d);
const msText = (ms: number) => (ms >= 1000 ? `${fr(ms / 1000, ms >= 10000 ? 0 : 1)} s` : `${fr(ms, ms < 10 ? 1 : 0)} ms`);

function interp(x: number, xs: number[], ys: number[]) {
  if (!xs?.length) return NaN;
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[ys.length - 1];
}

/** Valeur lisible d'un réglage. */
export function formatAnalog(kind: string, spec: AnalogParamSpec, v: number): string {
  const prof = ANALOG_PROFILES[kind] || {};
  if (spec.choices) return spec.choices.find(c => c.v === v)?.label || String(v);
  switch (spec.unit) {
    case 'dBFS': return `${signed(v)} dBFS`;
    case 'dB': return `${signed(v)} dB`;
    case ':1': return `${fr(v)}:1`;
    case '%': return `${Math.round(v)} %`;
    case 'pos': {
      if (spec.id === 'input' && prof.inGainDb) return `${fr(v)} · gain ${signed(interp(v, prof.inKnob, prof.inGainDb))} dB`;
      if (spec.id === 'output' && prof.outGainDb) return `${fr(v)} · ${signed(interp(v, prof.outKnob, prof.outGainDb))} dB`;
      const knob = spec.id === 'attack' ? prof.attKnob : (prof.relKnob || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const t = spec.id === 'attack' ? prof.attT63Ms : spec.id === 'release' ? prof.relT63Ms : null;
      const ms = t ? interp(v, knob, t) : NaN;
      return Number.isFinite(ms) ? `${fr(v)} · ≈ ${msText(ms)}` : fr(v);
    }
    default: return fr(v);
  }
}

const Slider: React.FC<{ kind: string; spec: AnalogParamSpec; value: number; onChange: (v: number) => void; accent: string }> = ({ kind, spec, value, onChange, accent }) => (
  <label className="block min-w-0" title={spec.hint} data-nova-param={spec.id}>
    <div className="flex items-baseline justify-between gap-2 mb-0.5">
      <span className="text-[11px] font-bold text-slate-200 truncate">{spec.label}</span>
      <span className="shrink-0 text-[12px] font-mono font-black text-white tabular-nums">{formatAnalog(kind, spec, value)}</span>
    </div>
    <input type="range" aria-label={spec.label} min={spec.min} max={spec.max} step={spec.step} value={value}
      onChange={e => onChange(parseFloat(e.target.value))} className={`w-full h-8 cursor-pointer ${accent}`} />
    <p className="text-[10px] text-slate-500 leading-snug">{spec.hint}</p>
  </label>
);

const Choice: React.FC<{ spec: AnalogParamSpec; value: number; onChange: (v: number) => void; active: string }> = ({ spec, value, onChange, active }) => (
  <div title={spec.hint} data-nova-param={spec.id}>
    <div className="text-[11px] font-bold text-slate-200 mb-1">{spec.label}</div>
    <div className={`grid gap-1`} style={{ gridTemplateColumns: `repeat(${spec.choices!.length}, minmax(0, 1fr))` }} role="radiogroup" aria-label={spec.label}>
      {spec.choices!.map(c => (
        <button key={c.v} type="button" role="radio" aria-checked={value === c.v} onClick={() => onChange(c.v)} title={c.hint || spec.hint}
          className={`h-9 rounded-lg text-[11px] font-black border ${value === c.v ? `${active} text-black border-transparent` : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>
          {c.label}
        </button>
      ))}
    </div>
  </div>
);

/** VU de réduction de gain : aiguille à la balistique VU (≈ 300 ms), repère de la cible, maximum tenu. */
export const GrVuMeter: React.FC<{ node: any; target: number; color: string }> = ({ node, target, color }) => {
  const [vu, setVu] = useState(0);
  const [hold, setHold] = useState(0);
  const st = useRef({ v: 0, d: 0, t: 0, hold: 0, holdAt: 0 });
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      const s = st.current;
      const dt = s.t ? Math.min(0.1, (t - s.t) / 1000) : 0;
      s.t = t;
      const m = node?.getMeters?.();
      const g = m ? Math.max(0, m.grNowDb || 0) : 0;
      // 2e ordre critique, constante 45 ms : 99 % en ~300 ms (VU)
      if (dt > 0) {
        const tau = 0.045;
        const a = (g - s.v) / (tau * tau) - 2 * s.d / tau;
        s.d += a * dt; s.v += s.d * dt;
        if (s.v < 0) { s.v = 0; s.d = 0; }
      }
      if (s.v > s.hold || t - s.holdAt > 3000) { s.hold = s.v; s.holdAt = t; }
      setVu(s.v); setHold(s.hold);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node]);
  const max = 20;
  const pct = (x: number) => `${Math.min(100, (x / max) * 100)}%`;
  return (
    <div className="mb-4" data-nova-gr-vu title="Réduction de gain (dB) avec la balistique d'un VU-mètre : c'est elle que règle « Caler sur ma voix ».">
      <div className="flex items-baseline justify-between text-[11px] mb-1">
        <span className="font-bold text-slate-200">Réduction de gain (VU)</span>
        <span className="font-mono font-black text-white tabular-nums">{fr(vu)} dB <span className="text-slate-400 font-normal">· max {fr(hold)} dB</span></span>
      </div>
      <div className="relative h-4 rounded-full bg-white/10 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${color} rounded-full transition-none`} style={{ width: pct(vu) }} />
        <div className="absolute inset-y-0 w-0.5 bg-white/80" style={{ left: pct(target) }} title={`Cible du calage : ${fr(target, 0)} dB`} />
      </div>
      <div className="flex justify-between text-[9px] text-slate-500 mt-0.5 font-mono"><span>0</span><span>5</span><span>10</span><span>15</span><span>20 dB</span></div>
    </div>
  );
};

const THEME: Record<string, { gradient: string; accent: string; range: string; btn: string; bar: string }> = {
  OPTO_VINTAGE: { gradient: 'bg-gradient-to-b from-[#10192b] to-[#0b0f17]', accent: 'text-sky-300', range: 'accent-sky-400', btn: 'bg-sky-400', bar: 'bg-sky-400' },
  FET76: { gradient: 'bg-gradient-to-b from-[#1a1a1d] to-[#0c0c0e]', accent: 'text-zinc-200', range: 'accent-zinc-300', btn: 'bg-zinc-200', bar: 'bg-amber-300' },
  LEVELER2A: { gradient: 'bg-gradient-to-b from-[#1d1c19] to-[#0f0e0c]', accent: 'text-amber-200', range: 'accent-amber-300', btn: 'bg-amber-300', bar: 'bg-amber-300' },
  VOXSTRIP: { gradient: 'bg-gradient-to-b from-[#1b1420] to-[#0e0b10]', accent: 'text-fuchsia-300', range: 'accent-fuchsia-400', btn: 'bg-fuchsia-400', bar: 'bg-fuchsia-400' },
};

const SUBTITLE: Record<string, string> = {
  OPTO_VINTAGE: "Compresseur optique à lampes, inspiré d'un classique danois des studios : doux, transparent, idéal sur la voix (règle maison : 2:1, 5 dB max au VU).",
  FET76: "Compresseur à transistor FET, inspiré d'un limiteur américain classique : attaque ultra-rapide, du mordant (règle maison : 5 dB max au VU sur les bus).",
  LEVELER2A: "Niveleur optique à lampes, inspiré d'un classique des années 60 : lent, très musical (règle maison : 2 dB max au VU sur les bus).",
  VOXSTRIP: "Tranche voix à lampes inspirée d'un channel strip américain : compresseur optique, égaliseur passif et de-esser (règle maison : 5 dB max au VU).",
};

export const NovaAnalogCompUI: React.FC<Props & { kind: string }> = ({ kind, node, initialParams, onParamsChange, trackId }) => {
  const spec: AnalogKindSpec = ANALOG_SPECS[kind];
  const th = THEME[kind] || THEME.OPTO_VINTAGE;
  const [p, set] = useV21Params<Record<string, any>>({ ...spec.defaults }, initialParams, node, onParamsChange);
  const [cal, setCal] = useState<{ busy: boolean; msg: string; res?: CalibrationResult | null }>({ busy: false, msg: '' });

  const calibrate = async () => {
    if (!trackId) { setCal({ busy: false, msg: "Ouvre l'effet depuis une piste pour le caler sur sa voix." }); return; }
    setCal({ busy: true, msg: 'Écoute de ta piste et réglage du seuil…' });
    try {
      const res = await calibrateNovaOnTrack(kind, { ...p }, trackId);
      if (!res) { setCal({ busy: false, msg: "Pas d'audio sur cette piste : enregistre ou importe d'abord ta voix." }); return; }
      set({ [spec.driveParam]: res.value });
      setCal({ busy: false, res, msg: res.reached
        ? `Calé : ${formatAnalog(kind, spec.specs.find(s => s.id === spec.driveParam)!, res.value)} → ${fr(res.grDb)} dB max au VU (cible ${fr(spec.targetGrDb, 0)} dB).`
        : `Cible de ${fr(spec.targetGrDb, 0)} dB impossible à atteindre ici (${fr(res.grDb)} dB au mieux) : ${res.why || 'le son est trop faible ou trop fort pour ce réglage'}.` });
    } catch (e: any) {
      setCal({ busy: false, msg: `Calage impossible : ${e?.message || e}` });
    }
  };

  const sliders = spec.specs.filter(s => !s.choices);
  const choices = spec.specs.filter(s => s.choices);
  return (
    <V21Shell type={kind} title={spec.name} accent={th.accent} subtitle={SUBTITLE[kind] || ''} node={node} gradient={th.gradient}>
      <V21Presets presets={spec.presets as any} current={p} onApply={pr => set(pr.params)} color={th.btn} />
      <GrVuMeter node={node} target={spec.targetGrDb} color={th.bar} />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button type="button" onClick={calibrate} disabled={cal.busy} data-nova-calibrate
          title={`NOVA écoute la piste et règle « ${spec.specs.find(s => s.id === spec.driveParam)?.label} » pour que la réduction max au VU soit de ${spec.targetGrDb} dB (règle de mix maison).`}
          className={`h-10 px-4 rounded-xl text-[12px] font-black ${cal.busy ? 'bg-white/10 text-slate-400' : `${th.btn} text-black hover:brightness-110`}`}>
          <i className={`fas ${cal.busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'} mr-2`} aria-hidden="true"></i>
          {cal.busy ? 'Calage…' : 'Caler sur ma voix'}
        </button>
        <span className="text-[11px] text-slate-400" aria-live="polite">{cal.msg || `Cible : ${spec.targetGrDb} dB de réduction max au VU.`}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        {sliders.map(s => <Slider key={s.id} kind={kind} spec={s} value={+p[s.id]} onChange={v => set({ [s.id]: v })} accent={th.range} />)}
      </div>
      {choices.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3 mt-4">
          {choices.map(s => <Choice key={s.id} spec={s} value={+p[s.id]} onChange={v => set({ [s.id]: v })} active={th.btn} />)}
        </div>
      )}
      <p className="mt-4 text-[10px] text-slate-500 leading-snug">Modèle NOVA mesuré en laboratoire (réponse, courbe de compression, temps, harmoniques) : un son d'inspiration vintage, sans le matériel.</p>
    </V21Shell>
  );
};

export const NovaOptoVintageUI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="OPTO_VINTAGE" {...props} />;
export const NovaFet76UI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="FET76" {...props} />;
export const NovaLeveler2AUI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="LEVELER2A" {...props} />;
export const NovaVoxStripUI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="VOXSTRIP" {...props} />;
