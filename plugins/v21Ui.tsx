import React, { useEffect, useRef, useState } from 'react';
import type { V21ParamSpec, V21Preset } from '../engine/v21Params';
import { panToText } from '../utils/db';
import { Faceplate, HwPresets, HwWindow, Knob, ToggleSwitch, type HwFinish, type KnobProps } from './hw';

/**
 * Briques communes des fenêtres V21 (Harmoniseur, Voix grave / aiguë, Tape
 * stop & half-time, Filtre DJ, Lo-fi, Gate rythmique, Gate) : tout en français,
 * gains en dB, préréglages en un clic. Depuis la vague 2B, ces fenêtres sont des
 * façades « matériel » (kit plugins/hw) : boutons rotatifs (V21Knob), aide dans
 * l'infobulle et la ligne d'info (le texte de chaque réglage cite l'équivalent
 * dans les autres DAW). Pas de bouton marche / arrêt interne : seul celui de la
 * barre de PluginEditor existe (règle de l'audit).
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
    case 'ms': return `${fr(v, v < 10 && !Number.isInteger(v) ? 1 : 0)} ms`;
    case 'pas': return `${Math.round(v)} pas`;
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

/**
 * Mesures du nœud (hauteur, vitesse…), lues ~15 fois par seconde. Redessine le
 * composant à chaque lecture : à réserver aux petits afficheurs ; pour une
 * valeur seule, préférer useV21Meter (ne redessine que si elle change).
 */
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

/**
 * Une mesure du nœud (nombre, texte, booléen), lue ~15 fois par seconde : le
 * composant ne se redessine que si la valeur change. À utiliser dans de petits
 * afficheurs (LED, LCD) pour que la façade entière ne se redessine pas.
 */
export function useV21Meter<T extends string | number | boolean | null | undefined>(node: any, pick: (m: any) => T, everyMs = 66): T {
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const [v, setV] = useState<T>(() => { try { return pick(node?.getMeters?.() || {}); } catch { return undefined as T; } });
  useEffect(() => {
    let raf = 0, lastT = 0;
    const loop = (t: number) => {
      if (t - lastT > everyMs) {
        lastT = t;
        let nv: T;
        try { nv = pickRef.current(node?.getMeters?.() || {}); } catch { nv = undefined as T; }
        setV(prev => (Object.is(prev, nv) ? prev : nv));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node, everyMs]);
  return v;
}

/**
 * Bouton rotatif d'un réglage V21 : bornes, pas, aide (infobulle + ligne
 * d'info) et texte de la valeur tirés de la fiche du réglage. Les options du
 * kit (taille, capuchon, graduations, courbe log…) passent telles quelles.
 */
export const V21Knob: React.FC<{ spec: V21ParamSpec; value: number; onChange: (v: number) => void; defaultValue?: number; label?: string } & Partial<Omit<KnobProps, 'value' | 'onChange' | 'min' | 'max' | 'label' | 'defaultValue'>>> = ({ spec, value, onChange, defaultValue, label, ...rest }) => (
  <Knob paramId={spec.id} label={label || spec.label} ariaLabel={spec.label} hint={spec.hint} min={spec.min} max={spec.max} step={spec.step}
    value={Number.isFinite(+value) ? +value : (defaultValue ?? spec.min)} defaultValue={defaultValue} onChange={onChange} format={v => formatV21(spec, v)}
    bipolar={spec.min < 0 && spec.max > 0} {...rest} />
);

/** Compatibilité : un ancien « curseur » V21 est désormais un bouton rotatif. */
export const V21Slider: React.FC<{ spec: V21ParamSpec; value: number; onChange: (v: number) => void; accent?: string; label?: string; compact?: boolean }> = ({ spec, value, onChange, label }) => (
  <V21Knob spec={spec} value={value} onChange={onChange} label={label} size="M" cap="black" ticks={11} />
);

/** Interrupteur à levier 2 positions pour un réglage oui / non. */
export const V21Toggle: React.FC<{ spec: V21ParamSpec; value: number; onChange: (v: number) => void; onLabel?: string; offLabel?: string; label?: string }> = ({ spec, value, onChange, onLabel = 'Oui', offLabel = 'Non', label }) => (
  <span data-nova-param={spec.id}>
    <ToggleSwitch label={label || spec.label} hint={spec.hint} value={value >= 0.5 ? 1 : 0} onChange={onChange}
      options={[{ v: 1, label: onLabel }, { v: 0, label: offLabel }]} />
  </span>
);

/**
 * Préréglages : un clic applique. Est surligné le dernier préréglage choisi
 * tant que ses réglages n'ont pas bougé. Rangée de la barre d'outils (HwPresets).
 */
export const V21Presets: React.FC<{ presets: V21Preset[]; current: Record<string, any>; onApply: (p: V21Preset) => void; color?: string }> = ({ presets, current, onApply }) => (
  <HwPresets presets={presets} current={current} onApply={onApply} />
);

/**
 * Cadre d'une fenêtre V21 : fenêtre « matériel » (barre d'outils, façade, ligne
 * d'info avec la latence), avertissement sans AudioWorklet. `subtitle` devient
 * le texte au repos de la ligne d'info.
 */
export const V21Shell: React.FC<{
  type: string; title: string; subtitle: string; node: any; children: React.ReactNode;
  /** Anciennes options (classes Tailwind) : ignorées depuis la façade « matériel ». */
  accent?: string; gradient?: string;
  finish?: HwFinish; kicker?: string; modelStyle?: 'sans' | 'serif' | 'wide';
  toolbar?: React.ReactNode; idleHelp?: React.ReactNode; width?: number; uiAccent?: string; uiAccentInk?: string;
  faceClassName?: string; faceStyle?: React.CSSProperties;
}> = ({ type, title, subtitle, node, children, finish = 'graphite', kicker, modelStyle, toolbar, idleHelp, width = 600, uiAccent, uiAccentInk, faceClassName, faceStyle }) => {
  const latencyMs = node?.latency ? node.latency * 1000 : 0;
  return (
    <HwWindow type={type} width={width} accent={uiAccent} accentInk={uiAccentInk} toolbar={toolbar} latencyMs={latencyMs} fallback={!!node?.isFallback?.()}
      idleHelp={idleHelp ?? <>{subtitle} <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish={finish} model={title} kicker={kicker} modelStyle={modelStyle} className={`hw-touch${faceClassName ? ` ${faceClassName}` : ''}`} style={faceStyle}>
        {children}
      </Faceplate>
    </HwWindow>
  );
};
