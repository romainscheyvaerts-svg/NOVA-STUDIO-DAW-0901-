import React, { useEffect, useRef, useState } from 'react';
import type { V21ParamSpec, V21Preset } from '../engine/v21Params';
import { panToText } from '../utils/db';

/**
 * Briques communes des fenêtres V21 (Harmoniseur, Voix grave / aiguë, Tape
 * stop & half-time, Filtre DJ, Lo-fi) : tout en français, gains en dB,
 * curseurs larges (doigt et souris), préréglages en un clic, infobulles qui
 * citent l'équivalent dans Logic / FL / Live. Pas de bouton marche / arrêt
 * interne : seul celui de la barre de PluginEditor existe (règle de l'audit).
 */

const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const signed = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + fr(Math.abs(v), d);

/** Valeur lisible d'un réglage selon son unité. */
export function formatV21(spec: V21ParamSpec, v: number): string {
  switch (spec.unit) {
    case 'dB': return v <= -59.5 ? 'coupé' : `${signed(v)} dB`;
    case '%': return `${Math.round(v * 100)} %`;
    case 'demi-tons': return `${signed(v, Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1)} demi-ton${Math.abs(v) >= 2 ? 's' : ''}`;
    case 'temps': { const t = fr(v, Number.isInteger(v) ? 0 : 4); return `${t.includes(',') ? t.replace(/0+$/, '') : t} temps`; }
    case 'Hz': return v >= 1000 ? `${fr(v / 1000, v % 1000 === 0 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`;
    case 'bits': return `${Math.round(v)} bits`;
    case 'dB/oct': return `${Math.round(v)} dB/oct`;
    case 'degrés': return `${signed(v, 0)}`;
    case 'pan': return panToText(v) === 'C' ? 'Centre' : panToText(v);
    default: return spec.min < 0 ? signed(v, 2) : fr(v, 2);
  }
}

/** Réglages locaux de la fenêtre, recalés quand le projet change (annuler / rétablir). */
export function useV21Params<T extends Record<string, any>>(defaults: T, initial: Partial<T>, node: any, onParamsChange: (p: Record<string, any>) => void) {
  const [p, setP] = useState<T>({ ...defaults, ...initial });
  const initKey = JSON.stringify(initial || {});
  const last = useRef(initKey);
  useEffect(() => {
    if (initKey === last.current) return;
    last.current = initKey;
    setP(prev => ({ ...prev, ...(initial || {}) }));
  }, [initKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<T>) => {
    setP(prev => ({ ...prev, ...patch }));
    node?.updateParams?.(patch);
    onParamsChange(patch as Record<string, any>);
  };
  return [p, set] as const;
}

/** Mesures du nœud (hauteur, vitesse…), lues ~15 fois par seconde. */
export function useV21Meters(node: any) {
  const [m, setM] = useState<any>({});
  useEffect(() => {
    let raf = 0, lastT = 0;
    const loop = (t: number) => {
      if (t - lastT > 66) { lastT = t; const mm = node?.getMeters?.(); if (mm) setM(mm); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node]);
  return m;
}

export const V21Slider: React.FC<{ spec: V21ParamSpec; value: number; onChange: (v: number) => void; accent?: string; label?: string; compact?: boolean }> = ({ spec, value, onChange, accent = 'accent-cyan-400', label, compact }) => (
  <label className="block min-w-0" title={spec.hint} data-nova-param={spec.id}>
    <div className="flex items-baseline justify-between gap-2 mb-0.5">
      <span className="text-[11px] font-bold text-slate-200 truncate">{label || spec.label}</span>
      <span className="shrink-0 text-[12px] font-mono font-black text-white tabular-nums">{formatV21(spec, value)}</span>
    </div>
    <input type="range" aria-label={label || spec.label} min={spec.min} max={spec.max} step={spec.step} value={value}
      onChange={e => onChange(parseFloat(e.target.value))}
      className={`w-full h-8 cursor-pointer ${accent}`} />
    {!compact && <p className="text-[10px] text-slate-500 leading-snug">{spec.hint}</p>}
  </label>
);

export const V21Toggle: React.FC<{ spec: V21ParamSpec; value: number; onChange: (v: number) => void; onLabel?: string; offLabel?: string }> = ({ spec, value, onChange, onLabel = 'Oui', offLabel = 'Non' }) => (
  <div title={spec.hint} data-nova-param={spec.id}>
    <div className="text-[11px] font-bold text-slate-200 mb-1">{spec.label}</div>
    <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label={spec.label}>
      {[1, 0].map(v => (
        <button key={v} type="button" role="radio" aria-checked={(value >= 0.5 ? 1 : 0) === v} onClick={() => onChange(v)}
          className={`h-9 rounded-lg text-[11px] font-black border ${(value >= 0.5 ? 1 : 0) === v ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>
          {v ? onLabel : offLabel}
        </button>
      ))}
    </div>
  </div>
);

/**
 * Préréglages : un clic applique. Est surligné le dernier préréglage choisi
 * tant que ses réglages n'ont pas bougé (certains préréglages ne règlent
 * qu'une partie de l'effet : plusieurs pourraient « correspondre » à la fois).
 */
export const V21Presets: React.FC<{ presets: V21Preset[]; current: Record<string, any>; onApply: (p: V21Preset) => void; color?: string }> = ({ presets, current, onApply, color = 'bg-cyan-400' }) => {
  const matches = (pr: V21Preset) => Object.entries(pr.params).every(([k, v]) => typeof v === 'number' ? Math.abs((+current[k] || 0) - v) < 1e-6 : current[k] === v);
  const [lastId, setLastId] = useState<string | null>(() => presets.find(matches)?.id || null);
  return (
    <div className="mb-4" data-nova-presets>
      <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Préréglages</div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map(pr => {
          const active = lastId === pr.id && matches(pr);
          return (
            <button key={pr.id} type="button" title={pr.hint} aria-pressed={active} onClick={() => { setLastId(pr.id); onApply(pr); }} data-nova-preset={pr.id}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${active ? `${color} text-black border-transparent` : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'}`}>
              {pr.name}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** Cadre d'une fenêtre V21 : titre, équivalents, latence, avertissement sans AudioWorklet. */
export const V21Shell: React.FC<{ type: string; title: string; accent: string; subtitle: string; node: any; gradient: string; children: React.ReactNode }> = ({ type, title, accent, subtitle, node, gradient, children }) => {
  const latencyMs = node?.latency ? node.latency * 1000 : 0;
  return (
    // Tablette / PC : hauteur plafonnée, le contenu défile (la barre du haut — fermer, marche / arrêt — reste visible).
    // Téléphone : la fenêtre est déjà plein écran et défile d'un bloc. Largeur liée à l'écran (pas « max-w-full ») :
    // dans FitToWidth (largeur au contenu + zoom), un max-w-full faisait boucler le calcul jusqu'à un zoom ≈ 0 (fenêtre vide).
    <div data-nova-plugin={type} className={`w-[min(600px,calc(100vw-16px))] ${gradient} p-5 sm:p-6 text-white sm:max-h-[calc(100dvh-8rem)] sm:overflow-y-auto overscroll-contain`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-black tracking-tight">{title} <span className={accent}>· NOVA</span></h2>
          <p className="text-[11px] text-slate-400 leading-snug">{subtitle}</p>
        </div>
        <div className="shrink-0 text-right text-[10px] text-slate-500" title="Retard ajouté par l'effet, compensé automatiquement à la lecture et à l'export (PDC)">
          Latence<br /><b className="text-slate-300 font-mono">{latencyMs ? `${fr(latencyMs)} ms` : 'aucune'}</b>
        </div>
      </div>
      {children}
      {node?.isFallback?.() && <p className="mt-4 text-[11px] text-red-300">Ce navigateur ne peut pas charger l'effet : il est contourné (aucun traitement).</p>}
    </div>
  );
};
