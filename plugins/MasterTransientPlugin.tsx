import React, { useEffect, useState } from 'react';
import { useV21Params } from './v21Ui';
import { MT_BANDS, MT_CENTERS, MT_DEFAULTS, MT_PRESETS, MT_SPECS, MT_TOGGLES, type MtSpec } from '../engine/masterTransientParams';
import { Faceplate, HwPresets, HwSection, HwWindow, Knob, PushButton, useHwHelp, type KnobProps } from './hw';
import { cancelUiFrame, requestUiFrame } from '../utils/uiFrame';

/**
 * Fenêtre de l'effet NOVA « Mastering Transient » : limiteur de mastering
 * multibande (26 bandes auditives) avec emphase des transitoires par bande et
 * clipper doux. Façade graphite « moderne » (kit plugins/hw) : boutons à arc
 * de valeur, modules à LED, écran de la courbe par bande (glisser sur les
 * barres), mesures par bande, écoute d'une bande seule.
 */
interface Props { node: any; initialParams: Record<string, any>; onParamsChange: (p: Record<string, any>) => void; trackId?: string }

const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const signed = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + fr(Math.abs(v), d);
const hz = (f: number) => (f >= 1000 ? `${fr(f / 1000, f >= 10000 ? 0 : 1)} k` : `${Math.round(f)}`);
const ACCENT = '#fb923c';

function fmt(s: MtSpec, v: number) {
  if (s.unit === '%') return `${Math.round(v)} %`;
  if (s.unit === 'ms') return `${fr(v, 2)} ms`;
  if (s.id === 'ceiling') return `${signed(v, 2)} dB`;
  return `${signed(v, s.step < 0.1 ? 2 : 1)} dB`;
}

/** Mesures du nœud, lues ~15 fois par seconde (seuls les composants qui les affichent se redessinent). */
function useMeters(node: any) {
  const [m, setM] = useState<any>(null);
  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      if (t - last > 66) { last = t; const mm = node?.getMeters?.(); if (mm) setM(mm); }
      raf = requestUiFrame(loop);
    };
    raf = requestUiFrame(loop);
    return () => cancelUiFrame(raf);
  }, [node]);
  return m;
}

/** Afficheurs : emphase des attaques et réduction du limiteur. */
const Readouts: React.FC<{ node: any }> = ({ node }) => {
  const meters = useMeters(node);
  const emph = meters ? meters.emphDb : 0, gr = meters ? meters.grDb : 0;
  return (
    <div className="flex flex-col gap-1.5" aria-live="off">
      <div className="flex items-center justify-between gap-3" title="Emphase la plus forte appliquée à une attaque, toutes bandes confondues">
        <span className="hw-silk hw-silk-soft" style={{ textAlign: 'left' }}>Emphase</span>
        <span className="hw-lcd hw-lcd-amber" data-nova-mt="emph">{emph > 0.05 ? `+${fr(emph)}` : '0,0'} dB</span>
      </div>
      <div className="flex items-center justify-between gap-3" title="Réduction de gain la plus forte du limiteur multibande">
        <span className="hw-silk hw-silk-soft" style={{ textAlign: 'left' }}>Réduction</span>
        <span className="hw-lcd" style={{ color: '#ff9b8a', textShadow: '0 0 6px rgba(255,120,100,.35)' }} data-nova-mt="gr">{gr > 0.05 ? `−${fr(gr)}` : '0,0'} dB</span>
      </div>
    </div>
  );
};

/** Courbe par bande : 26 barres verticales éditables (glisser), mesure en direct superposée. */
const BandCurve: React.FC<{ mode: 'bt' | 'bg'; p: Record<string, number>; set: (patch: Record<string, number>) => void; node: any; solo: number; setSolo: (b: number) => void }> = ({ mode, p, set, node, solo, setSolo }) => {
  const meters = useMeters(node);
  const min = mode === 'bt' ? 0 : -6, max = mode === 'bt' ? 200 : 6;
  const H = 108;
  const [drag, setDrag] = useState(false);
  const help = useHwHelp(`mt-curve-${mode}`, mode === 'bt' ? 'Emphase par bande' : 'Gain par bande',
    mode === 'bt' ? "Glisse sur les barres pour dessiner : 100 % = emphase globale, 0 % = aucune, 200 % = double. Trait blanc : emphase en cours."
      : "Égaliseur de mastering ±6 dB par bande. Trait rouge : réduction du limiteur en cours.", undefined);
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
      <div className="hw-screen">
        <div className="hw-screen-glass select-none touch-none" style={{ height: H }}
          role="group" aria-label={mode === 'bt' ? "Emphase par bande (glisser pour dessiner)" : 'Gain par bande (glisser pour dessiner)'}
          onPointerDown={e => { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); setDrag(true); help.show(); apply(e); }}
          onPointerMove={e => { if (drag) apply(e); }}
          onPointerUp={() => setDrag(false)} onPointerCancel={() => setDrag(false)} data-nova-bandcurve={mode}
          onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave}>
          {mode === 'bt'
            ? <div className="absolute left-0 right-0 border-t border-dashed" style={{ borderColor: 'rgba(255,255,255,.22)', bottom: `${(100 - min) / (max - min) * 100}%` }} title="100 %" />
            : <div className="absolute left-0 right-0 border-t border-dashed" style={{ borderColor: 'rgba(255,255,255,.22)', bottom: '50%' }} title="0 dB" />}
          <div className="absolute inset-0 flex items-end gap-[2px] px-1 pb-0">
            {Array.from({ length: MT_BANDS }, (_, b) => {
              const v = +p[`${mode}${b + 1}`];
              const frac = (v - min) / (max - min);
              const zero = mode === 'bt' ? 0 : 0.5;
              const lo = Math.min(frac, zero), hi = Math.max(frac, zero);
              const lv = live[b] || 0;
              return (
                <div key={b} className="relative flex-1 h-full" title={`Bande ${b + 1} · ${hz(MT_CENTERS[b])} Hz : ${mode === 'bt' ? `${Math.round(v)} %` : `${signed(v)} dB`}`}>
                  <div className="absolute left-0 right-0 rounded-sm"
                    style={{ bottom: `${lo * 100}%`, height: `${Math.max(1, (hi - lo) * 100)}%`, background: solo === b ? '#fcd34d' : mode === 'bt' ? 'linear-gradient(180deg, #fdba74, #ea580c)' : 'linear-gradient(180deg, #7dd3fc, #0284c7)', boxShadow: '0 0 6px rgba(251,146,60,.25)' }} />
                  {lv > 0.05 && <div className="absolute left-0 right-0 h-[3px]"
                    style={{ background: mode === 'bt' ? '#fff' : '#f87171', bottom: `${Math.min(100, (mode === 'bt' ? lv / 14 : 0.5 - lv / 12) * 100)}%` }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex gap-[2px] px-2 mt-1 font-mono" style={{ fontSize: 8.5, color: 'var(--hw-ink-soft)' }}>
        {Array.from({ length: MT_BANDS }, (_, b) => (
          <button key={b} type="button" onClick={() => setSolo(solo === b ? -1 : b)} aria-pressed={solo === b}
            title={solo === b ? `Arrêter l'écoute de la bande ${b + 1}` : `Écouter la bande ${b + 1} seule (${hz(MT_CENTERS[b])} Hz)`}
            className="flex-1 min-w-0 h-5 rounded whitespace-nowrap overflow-visible text-left"
            style={solo === b ? { background: '#fcd34d', color: '#000', fontWeight: 900 } : undefined}>
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
  const solo = Math.round(+p.soloBand);
  const sp = (id: string) => MT_SPECS.find(s => s.id === id)!;
  const SHORT: Record<string, string> = {
    emphasis: 'Emphase', adaptive: 'Adaptative', limitGain: 'Gain', speed: 'Vitesse', adaptiveGain: 'Écart', adaptiveSpeed: 'Adaptatif',
    ceiling: 'Plafond', clipDrive: 'Poussée', clipShape: 'Forme', inputGain: 'Entrée', outputGain: 'Sortie',
  };
  /** Bouton « module » à LED (dans l'en-tête de sa section, comme le IN d'un rack). */
  const mod = (id: string) => {
    const t = MT_TOGGLES.find(x => x.id === id)!;
    const on = +p[id] >= 0.5;
    return (
      <span data-nova-param={id}>
        <PushButton active={on} onClick={() => set({ [id]: on ? 0 : 1 })} text={t.label} led={ACCENT} dark hint={t.hint}
          valueText={on ? 'actif' : 'coupé'} className="hw-push-sm" />
      </span>
    );
  };
  const K = (id: string, o: Partial<KnobProps> = {}) => {
    const s = sp(id);
    return (
      <Knob key={id} paramId={id} label={SHORT[id] || s.label} ariaLabel={s.label} hint={s.hint} min={s.min} max={s.max} step={s.step}
        value={+p[id]} defaultValue={MT_DEFAULTS[id]} onChange={v => set({ [id]: v })} format={v => fmt(s, v)}
        size="M" cap="graphite" arc={ACCENT} ticks={11} bipolar={s.min < 0 && s.max > 0} {...o} />
    );
  };

  return (
    <HwWindow type="MASTERTRANSIENT" width={780} accent={ACCENT} accentInk="#1a0c02" latencyMs={node?.latency ? node.latency * 1000 : 0}
      fallback={!!node?.isFallback?.()}
      toolbar={<HwPresets presets={MT_PRESETS as any[]} current={p} onApply={pr => set(pr.params as any)} />}
      idleHelp={<>Limiteur de mastering multibande (26 bandes auditives) avec emphase des attaques par bande et clipper doux. Modèle mesuré en laboratoire. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="graphite" model="Mastering Transient" kicker="Limiteur multibande · 26 bandes" modelStyle="wide" style={{ ['--hw-accent' as any]: ACCENT }}>
        <HwSection title="Transitoires" aside={mod('transientOn')}>
          <div className="flex flex-wrap items-center justify-around gap-x-4 gap-y-2">
            {K('emphasis', { scale: [{ v: 0, label: '0' }, { v: 50, label: '50' }, { v: 100, label: '100' }] })}
            {K('adaptive')}
            <Readouts node={node} />
          </div>
        </HwSection>

        <div className="mt-2 mb-1 hw-screen-tabs" role="tablist" aria-label="Courbe par bande">
          {([['bt', 'Emphase par bande (%)'], ['bg', 'Gain par bande (dB)']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className="hw-screen-tab">{label}</button>
          ))}
          <button type="button" onClick={() => {
            const patch: Record<string, number> = {};
            for (let b = 1; b <= MT_BANDS; b++) patch[`${tab}${b}`] = tab === 'bt' ? 100 : 0;
            set(patch);
          }} className="hw-screen-tab" style={{ marginLeft: 'auto' }}
            title={tab === 'bt' ? 'Toutes les bandes à 100 %' : 'Toutes les bandes à 0 dB'}>Remettre à plat</button>
        </div>
        <BandCurve mode={tab} p={p} set={set} node={node} solo={solo} setSolo={b => set({ soloBand: b })} />
        <p className="mt-1 mb-2 text-[10px] leading-snug" style={{ color: solo >= 0 ? '#fcd34d' : 'var(--hw-ink-soft)' }} role="status">
          {solo >= 0 ? `Écoute de la bande ${solo + 1} seule (${hz(MT_CENTERS[solo])} Hz) : clique à nouveau pour revenir.` : 'Clique une fréquence pour écouter la bande seule.'}
        </p>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <HwSection title="Limiteur" className="flex-[5_1_320px] min-w-0" aside={<span className="flex gap-2">{mod('truePeak')}{mod('limiterOn')}</span>}>
            <div className="flex flex-wrap items-start justify-around gap-x-1 gap-y-2">
              {K('limitGain')}{K('speed')}{K('adaptiveGain')}{K('adaptiveSpeed')}{K('ceiling')}
            </div>
          </HwSection>
          <HwSection title="Clipper et niveaux" className="flex-[4_1_260px] min-w-0" aside={mod('clipperOn')}>
            <div className="flex flex-wrap items-start justify-around gap-x-1 gap-y-2">
              {K('clipDrive')}{K('clipShape')}{K('inputGain')}{K('outputGain')}
            </div>
          </HwSection>
        </div>
      </Faceplate>
    </HwWindow>
  );
};

export default NovaMasterTransientUI;
