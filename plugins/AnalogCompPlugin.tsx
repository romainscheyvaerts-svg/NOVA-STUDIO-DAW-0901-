import React, { useState } from 'react';
import { ANALOG_SPECS, AnalogParamSpec, AnalogKindSpec } from '../engine/analogCompParams';
import { ANALOG_PROFILES } from '../engine/analogProfiles';
import { useV21Params } from './v21Ui';
import { calibrateNovaOnTrack, CalibrationResult } from '../utils/grCalibration';
import { Faceplate, HwPresets, HwSection, HwWindow, Knob, PushButton, ToggleSwitch, VuMeter, type KnobProps } from './hw';

/**
 * Fenêtres des compresseurs « analogiques » NOVA (Opto Vintage, FET 76,
 * Leveler 2A, Vox Strip), dessinées comme du matériel (kit plugins/hw) :
 * façade propre à chaque modèle, boutons rotatifs gradués, VU-mètre à aiguille
 * de réduction de gain (balistique VU, 300 ms) avec la cible du calage, et le
 * bouton « Caler sur ma voix » (règles de mix maison : 5 dB max au VU sur la
 * voix, 2 dB sur le Leveler de bus). Aide : infobulles + ligne d'info en bas.
 * Seule l'apparence a changé : mêmes réglages, mêmes préréglages, même son.
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
    case 'gain': return v <= 0 ? 'coupé' : `${fr(v, 0)} · ${signed(interp(v, prof.gainKnob, prof.gainDb))} dB`;
    case 'gainIn': return `${fr(v)} · ${signed(interp(v, prof.inKnob, prof.inGainDb))} dB`;
    case 'dB10': return `${signed(v)}`;
    case 'loF': case 'midF': case 'hiF': {
      const fl: number[] = prof[spec.unit] || [];
      const hz = fl[Math.round(v)] ?? 0;
      return hz >= 1000 ? `${fr(hz / 1000, hz % 1000 ? 1 : 0)} kHz` : `${Math.round(hz)} Hz`;
    }
    case 'pos': {
      if (spec.id === 'input' && prof.inGainDb) return `${fr(v)} · gain ${signed(interp(v, prof.inKnob, prof.inGainDb))} dB`;
      if (spec.id === 'output' && prof.outGainDb) return `${fr(v)} · ${signed(interp(v, prof.outKnob, prof.outGainDb))} dB`;
      const knob = spec.id === 'attack' ? prof.attKnob : (prof.relKnob || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const t = spec.id === 'attack' ? prof.attT63Ms : spec.id === 'release' ? prof.relT63Ms : null;
      const ms = t ? interp(v, knob, t) : NaN;
      return Number.isFinite(ms) ? `${fr(v)} · ≈ ${msText(ms)}` : fr(v);
    }
    default: return fr(v, spec.step >= 1 ? 0 : 1);
  }
}

const GR_HINT = "Réduction de gain avec la balistique d'un VU-mètre (≈ 300 ms) : c'est elle que règle « Caler sur ma voix ». Le repère « cible » montre la réduction visée.";

/** VU de réduction de gain : aiguille à la balistique VU (≈ 300 ms), repère de la cible, maximum tenu. */
export const GrVuMeter: React.FC<{ node: any; target: number; color?: string; tint?: 'cream' | 'amber' | 'white'; style?: React.CSSProperties; className?: string }> = ({ node, target, tint, style, className }) => (
  <VuMeter read={() => node?.getMeters?.()?.grNowDb || 0} mode="gr" target={target} caption="Réduction de gain" readout tint={tint}
    hint={GR_HINT} dataAttrs={{ 'data-nova-gr-vu': '' }} style={style} className={className} />
);

const SUBTITLE: Record<string, string> = {
  OPTO_VINTAGE: "Compresseur optique à lampes, inspiré d'un classique danois des studios : doux, transparent, idéal sur la voix (règle maison : 2:1, 5 dB max au VU).",
  FET76: "Compresseur à transistor FET, inspiré d'un limiteur américain classique : attaque ultra-rapide, du mordant (règle maison : 5 dB max au VU sur les bus).",
  LEVELER2A: "Niveleur optique à lampes, inspiré d'un classique des années 60 : lent, très musical (règle maison : 2 dB max au VU sur les bus).",
  VOXSTRIP: "Tranche voix à lampes inspirée d'un channel strip américain : préampli, compresseur optique, égaliseur passif et transformateur (règle maison : 5 dB max au VU).",
};

const UI_ACCENT: Record<string, [string, string]> = {
  OPTO_VINTAGE: ['#f0b35a', '#1d1206'],
  FET76: ['#e4e4e7', '#0b0b0c'],
  LEVELER2A: ['#9ec5e8', '#08131d'],
  VOXSTRIP: ['#e3b65c', '#2a0d12'],
};

/** Graduations chiffrées : valeurs du réglage → étiquettes. */
const marks = (vals: number[], fmt: (v: number) => string = v => String(v)) => vals.map(v => ({ v, label: fmt(v) }));
const sgn = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');

export const NovaAnalogCompUI: React.FC<Props & { kind: string }> = ({ kind, node, initialParams, onParamsChange, trackId }) => {
  const spec: AnalogKindSpec = ANALOG_SPECS[kind] || ANALOG_SPECS.OPTO_VINTAGE;
  const [p, set] = useV21Params<Record<string, any>>({ ...spec.defaults }, initialParams, node, onParamsChange);
  const [cal, setCal] = useState<{ busy: boolean; msg: string; res?: CalibrationResult | null }>({ busy: false, msg: '' });
  const sp = (id: string) => spec.specs.find(s => s.id === id)!;
  const driveSpec = sp(spec.driveParam);

  const calibrate = async () => {
    if (!trackId) { setCal({ busy: false, msg: "Ouvre l'effet depuis une piste pour le caler sur sa voix." }); return; }
    setCal({ busy: true, msg: 'Écoute de ta piste et réglage du seuil…' });
    try {
      const res = await calibrateNovaOnTrack(kind, { ...p }, trackId);
      if (!res) { setCal({ busy: false, msg: "Pas d'audio sur cette piste : enregistre ou importe d'abord ta voix." }); return; }
      set({ [spec.driveParam]: res.value });
      setCal({ busy: false, res, msg: res.reached
        ? `Calé : ${formatAnalog(kind, driveSpec, res.value)} → ${fr(res.grDb)} dB max au VU (cible ${fr(spec.targetGrDb, 0)} dB).`
        : `Cible de ${fr(spec.targetGrDb, 0)} dB impossible à atteindre ici (${fr(res.grDb)} dB au mieux) : ${res.why || 'le son est trop faible ou trop fort pour ce réglage'}.` });
    } catch (e: any) {
      setCal({ busy: false, msg: `Calage impossible : ${e?.message || e}` });
    }
  };

  /** Bouton rotatif d'un réglage continu (ou à crans pour un réglage « choix »). */
  const K = (id: string, label: string, o: Partial<KnobProps> = {}) => {
    const s = sp(id);
    if (!s) return null;
    return (
      <Knob key={id} paramId={id} label={label} ariaLabel={s.label} hint={s.hint}
        min={s.min} max={s.max} step={s.step} value={+p[id]} defaultValue={spec.defaults[id]}
        detents={s.choices ? s.choices.map(c => ({ v: c.v })) : undefined}
        onChange={v => set({ [id]: v })} format={v => formatAnalog(kind, s, v)} {...o} />
    );
  };
  /** Interrupteur à levier d'un réglage « choix ». */
  const T = (id: string, label: string) => {
    const s = sp(id);
    if (!s?.choices) return null;
    return <ToggleSwitch key={id} paramId={id} label={label} hint={s.hint} value={+p[id]} onChange={v => set({ [id]: v })}
      options={s.choices.map(c => ({ v: c.v, label: c.label, hint: c.hint }))} />;
  };

  /** Bouton « en service » (LED verte) d'un module de la tranche (compresseur, égaliseur). */
  const inBtn = (id: string) => {
    const s = sp(id);
    const on = +p[id] === 1;
    return (
      <span data-nova-param={id}>
        <PushButton active={on} onClick={() => set({ [id]: on ? 0 : 1 })} text="Actif" valueText={on ? 'actif' : 'contourné'} led="#3ddc84" ariaLabel={s.label}
          hint={s.hint} className="hw-push-sm" />
      </span>
    );
  };
  const vu = (style?: React.CSSProperties, tint?: 'cream' | 'amber' | 'white') => <GrVuMeter node={node} target={spec.targetGrDb} style={style} tint={tint} />;

  const toolbar = (
    <>
      <HwPresets presets={spec.presets} current={p} onApply={pr => set(pr.params)} />
      <div className="hw-toolbar-row">
        <button type="button" onClick={calibrate} disabled={cal.busy} data-nova-calibrate className="hw-cta"
          title={`NOVA écoute la piste et règle « ${driveSpec?.label} » pour que la réduction max au VU soit de ${spec.targetGrDb} dB (règle de mix maison).`}>
          <i className={`fas ${cal.busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`} aria-hidden="true"></i>
          {cal.busy ? 'Calage…' : 'Caler sur ma voix'}
        </button>
        <span className="hw-cta-msg" aria-live="polite">{cal.msg || `Cible : ${spec.targetGrDb} dB de réduction max au VU (réglage « ${driveSpec?.label} »).`}</span>
      </div>
    </>
  );

  let face: React.ReactNode;
  if (kind === 'FET76') {
    // Façade noire : grosses commandes d'entrée et de sortie autour du VU, rangée de boutons de taux.
    const ratio = sp('ratio');
    face = (
      <Faceplate finish="black" model="FET 76" kicker="Limiteur à transistor FET" modelStyle="wide">
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
          <div className="order-2 sm:order-1">{K('input', 'Entrée', { size: 'L', cap: 'silver', scale: marks([-60, -48, -36, -24, -12, 0], v => String(Math.abs(v))) })}</div>
          <div className="order-1 sm:order-2">{vu({ width: 236 }, 'white')}</div>
          <div className="order-3">{K('output', 'Sortie', { size: 'L', cap: 'silver', scale: marks([-60, -48, -36, -24, -12, 0], v => String(Math.abs(v))) })}</div>
        </div>
        <div className="hw-well mt-4 px-3 py-3" data-nova-param="ratio">
          <div className="grid grid-cols-3 justify-items-center gap-x-2 gap-y-3 sm:flex sm:items-end sm:justify-center sm:gap-x-2.5" role="radiogroup" aria-label={ratio.label} title={ratio.hint}>
            <span className="hw-silk col-span-3 sm:mr-1 sm:self-center">Taux</span>
            {ratio.choices!.map(c => (
              <PushButton key={c.v} role="radio" active={+p.ratio === c.v} onClick={() => set({ ratio: c.v })} text={c.label} led="#ff4b2b"
                ariaLabel={`Taux ${c.label}`} hint={c.hint || ratio.hint} />
            ))}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-start justify-center gap-x-6 gap-y-3">
          {K('attack', 'Attaque', { size: 'M', cap: 'black', scale: marks([1, 3, 5, 7]) })}
          {K('release', 'Relâchement', { size: 'M', cap: 'black', scale: marks([1, 3, 5, 7]) })}
          {K('mix', 'Mélange', { size: 'M', cap: 'black', scale: marks([0, 50, 100]) })}
          <div className="self-center pt-3" data-nova-param="slo">
            <PushButton active={+p.slo === 1} onClick={() => set({ slo: +p.slo === 1 ? 0 : 1 })} text="SLO" label="Attaque lente" led="#ffb020" hint={sp('slo').hint} />
          </div>
        </div>
      </Faceplate>
    );
  } else if (kind === 'LEVELER2A') {
    // Façade gris argent : un VU, deux très gros boutons (gain et réduction).
    face = (
      <Faceplate finish="silver" model="Leveler 2A" kicker="Niveleur optique à lampes" modelStyle="serif">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
          <div className="order-2 sm:order-1 flex items-center">{T('limit', 'Mode')}</div>
          <div className="order-1 sm:order-2">{vu({ width: 250 })}</div>
          <div className="order-3 flex items-start gap-3">
            {K('emphasis', 'Aigus (dét.)', { size: 'S', cap: 'black', ticks: 11 })}
            {K('mix', 'Mélange', { size: 'S', cap: 'black', ticks: 11 })}
          </div>
        </div>
        <div className="hw-rule" />
        <div className="flex items-start justify-around gap-2">
          {K('gain', 'Gain', { size: 'XL', cap: 'black', scale: marks([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) })}
          {K('peakReduction', 'Réduction', { size: 'XL', cap: 'black', scale: marks([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) })}
        </div>
      </Faceplate>
    );
  } else if (kind === 'VOXSTRIP') {
    // Tranche verticale : préampli → compresseur → égaliseur → sortie.
    face = (
      <Faceplate finish="burgundy" model="Vox Strip" kicker="Tranche voix à lampes" modelStyle="wide">
        <HwSection title="Préampli">
          <div className="flex items-center justify-around gap-3">
            {K('input', 'Entrée', { size: 'M', cap: 'chicken', scale: marks([2, 4, 6, 8, 10]) })}
            {T('lowCut', 'Coupe-bas')}
          </div>
        </HwSection>
        <HwSection title="Compresseur" className="mt-2" aside={inBtn('compOn')}>
          <div className="flex flex-wrap sm:flex-nowrap items-center justify-around gap-x-2 gap-y-2">
            <div className="w-full sm:w-auto flex justify-center">{vu({ width: 'min(100%, 188px)' })}</div>
            {K('compThresh', 'Compression', { size: 'L', cap: 'chicken', scale: marks([0, 2, 4, 6, 8, 10]) })}
            <div className="flex sm:flex-col items-center gap-x-4 gap-y-1">
              {K('attack', 'Attaque', { size: 'S', cap: 'black', sweep: 120 })}
              {K('release', 'Relâchement', { size: 'S', cap: 'black', sweep: 120 })}
            </div>
          </div>
        </HwSection>
        <HwSection title="Égaliseur" className="mt-2" aside={inBtn('eqOn')}>
          <div className="grid grid-cols-3 gap-1 justify-items-center">
            {([['loPeak', 'Grave', 'loFreq', [0, 5, 10]], ['midDip', 'Médium', 'midFreq', [-10, -5, 0]], ['hiPeak', 'Aigu', 'hiFreq', [0, 5, 10]]] as [string, string, string, number[]][]).map(([g, lab, f, sc]) => (
              <div key={g} className="flex flex-col sm:flex-row items-center sm:items-end gap-x-1">
                {K(g, lab, { size: 'M', cap: 'cream', scale: marks(sc, sgn) })}
                {K(f, 'Fréq.', { size: 'S', cap: 'black', ariaLabel: sp(f).label })}
              </div>
            ))}
          </div>
        </HwSection>
        <HwSection title="Sortie" className="mt-2">
          <div className="flex items-center justify-around gap-2">
            {K('output', 'Sortie', { size: 'M', cap: 'chicken', scale: marks([-30, -15, 0, 12], sgn) })}
            {K('mix', 'Mélange', { size: 'S', cap: 'black', ticks: 11 })}
            {T('transformer', 'Transfo')}
          </div>
        </HwSection>
      </Faceplate>
    );
  } else {
    // Opto Vintage : façade claire et chaude, gros VU central.
    face = (
      <Faceplate finish="cream" model="Opto Vintage" kicker="Compresseur optique à lampes" modelStyle="serif">
        <div className="flex justify-center">{vu({ width: 'min(100%, 300px)' }, 'amber')}</div>
        <div className="mt-4 flex flex-wrap items-start justify-center gap-x-4 gap-y-2">
          <div className="sm:order-1">{K('threshold', 'Seuil', { size: 'L', cap: 'cream', scale: marks([-60, -40, -20, 0, 20], sgn) })}</div>
          <div className="order-3 sm:order-2 w-full sm:w-auto flex items-start justify-center gap-1">
            {K('ratio', 'Taux', { size: 'M', cap: 'cream', scale: marks([2, 4, 6, 8, 10]) })}
            {K('attack', 'Attaque', { size: 'M', cap: 'cream', scale: marks([0, 5, 10]) })}
            {K('release', 'Relâchement', { size: 'M', cap: 'cream', scale: marks([0, 5, 10]) })}
          </div>
          <div className="order-2 sm:order-3">{K('output', 'Sortie', { size: 'L', cap: 'cream', scale: marks([-18, -5, 5, 15, 28], sgn) })}</div>
        </div>
        <div className="hw-rule" />
        <div className="flex flex-wrap items-start justify-around gap-x-3 gap-y-3">
          {T('mode', 'Temps')}
          {T('scLowCut', 'Détection')}
          {T('vintage', 'Génération')}
          {K('mix', 'Mélange', { size: 'S', cap: 'cream', ticks: 11 })}
        </div>
      </Faceplate>
    );
  }

  const [accent, accentInk] = UI_ACCENT[kind] || UI_ACCENT.OPTO_VINTAGE;
  return (
    <HwWindow type={kind} width={kind === 'VOXSTRIP' ? 530 : 640} accent={accent} accentInk={accentInk} toolbar={toolbar}
      latencyMs={node?.latency ? node.latency * 1000 : 0} fallback={!!node?.isFallback?.()}
      idleHelp={<>{SUBTITLE[kind] || ''} <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      {face}
    </HwWindow>
  );
};

export const NovaOptoVintageUI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="OPTO_VINTAGE" {...props} />;
export const NovaFet76UI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="FET76" {...props} />;
export const NovaLeveler2AUI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="LEVELER2A" {...props} />;
export const NovaVoxStripUI: React.FC<Props> = (props) => <NovaAnalogCompUI kind="VOXSTRIP" {...props} />;
