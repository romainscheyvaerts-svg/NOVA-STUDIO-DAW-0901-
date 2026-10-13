import React from 'react';
import { DEFAULT_DJFILTER, DEFAULT_LOFI, DJFILTER_PRESETS, DJFILTER_SPECS, LOFI_PRESETS, LOFI_SPECS } from '../engine/v21Params';
import { V21Knob, V21Presets, V21Shell, useV21Meter, useV21Params } from './v21Ui';
import { HwSection, Knob, PushButton, ToggleSwitch } from './hw';

/**
 * Fenêtres « Filtre DJ » et « Lo-fi / téléphone » (V21).
 *  - Filtre DJ : un seul bouton passe-bas ↔ passe-haut, comme une table de
 *    mixage DJ, l'Auto Filter de Live ou le DJ Filter de Logic.
 *  - Lo-fi : bande passante, saturation légère, bitcrush et souffle, comme
 *    Bitcrusher (Logic), Redux (Live) ou Lo-fi (FL Studio). La saturation
 *    riche reste dans « Saturation » (pas de doublon).
 *
 * Façades « matériel » (vague 2B) : Filtre DJ = gros bouton à cran central sur
 * aluminium bleu (table de mixage) ; Lo-fi = vieux poste olive, afficheur de la
 * bande passante.
 */
const dj = (id: string) => DJFILTER_SPECS.find(s => s.id === id)!;
const lf = (id: string) => LOFI_SPECS.find(s => s.id === id)!;

const hzText = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1).replace('.', ',')} kHz` : `${Math.round(hz)} Hz`);
const DJ_ACCENT = '#7dd3fc';
const LOFI_ACCENT = '#bef264';

/** Fréquence de coupure en cours : seul cet afficheur suit les mesures. */
const Cutoff: React.FC<{ node: any }> = ({ node }) => {
  const hz = useV21Meter(node, m => (m?.cutoff > 0 ? Math.round(m.cutoff) : 0));
  return <small>{hz > 0 ? hzText(hz) : ''}</small>;
};

export const NovaDjFilterUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_DJFILTER as Record<string, any>, initialParams || {}, node, onParamsChange);
  const d = DEFAULT_DJFILTER as any as Record<string, number>;
  const f = p.filter;
  const state = Math.abs(f) <= 0.02 ? 'Ouvert : aucun filtre' : f < 0 ? 'Passe-bas : les aigus s\'en vont' : 'Passe-haut : les basses s\'en vont';
  return (
    <V21Shell type="DJFILTER" title="Filtre DJ" node={node} finish="cobalt" kicker="Passe-bas ◀ · ▶ passe-haut" modelStyle="wide" width={540}
      uiAccent={DJ_ACCENT} uiAccentInk="#04121c" faceStyle={{ ['--hw-accent' as any]: DJ_ACCENT }}
      subtitle="Un seul bouton : tourne à gauche pour étouffer (passe-bas), à droite pour amincir (passe-haut), au centre rien ne change."
      toolbar={<V21Presets presets={DJFILTER_PRESETS} current={p} onApply={pr => set(pr.params as any)} />}>
      <div className="flex justify-center mb-2">
        <span className="hw-lcd" aria-live="polite"><span data-nova-djfilter="state">{state}</span>{Math.abs(f) > 0.02 && <Cutoff node={node} />}</span>
      </div>
      <div className="flex flex-col items-center" data-nova-param="filter">
        <Knob label="Filtre" ariaLabel="Filtre (passe-bas ↔ passe-haut)" hint={dj('filter').hint} min={-1} max={1} step={0.01}
          value={f} defaultValue={0} bipolar size="XL" cap="silver" arc={DJ_ACCENT}
          onChange={v => set({ filter: Math.abs(v) < 0.025 ? 0 : v })}
          format={v => (Math.abs(v) <= 0.02 ? 'Ouvert' : `${v < 0 ? 'Passe-bas' : 'Passe-haut'} ${Math.round(Math.abs(v) * 100)} %`)}
          scale={[{ v: -1, label: 'PB' }, { v: -0.5, label: '' }, { v: 0, label: '0' }, { v: 0.5, label: '' }, { v: 1, label: 'PH' }]} ticks={21} />
        <PushButton active={Math.abs(f) <= 0.02} onClick={() => set({ filter: 0 })} text="Centre" led={DJ_ACCENT} dark
          hint="Remettre au centre (aucun filtre)" valueText={Math.abs(f) <= 0.02 ? 'au centre' : 'filtre en marche'} className="mt-1" />
      </div>
      <div className="hw-rule" />
      <div className="flex flex-wrap items-center justify-around gap-x-3 gap-y-3">
        <V21Knob spec={dj('resonance')} label="Résonance" value={p.resonance} defaultValue={d.resonance} onChange={v => set({ resonance: v })} size="M" cap="black"
          scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
        <span data-nova-param="slope">
          <ToggleSwitch label="Pente" hint={dj('slope').hint} value={p.slope === 12 ? 12 : 24} onChange={v => set({ slope: v })}
            options={[{ v: 12, label: '12 dB/oct' }, { v: 24, label: '24 dB/oct (DJ)' }]} />
        </span>
        <V21Knob spec={dj('output')} label="Sortie" value={p.output} defaultValue={d.output} onChange={v => set({ output: v })} size="M" cap="black"
          scale={[{ v: -24, label: '-24' }, { v: 0, label: '0' }, { v: 12, label: '+12' }]} />
      </div>
    </V21Shell>
  );
};

export const NovaLofiUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_LOFI as Record<string, any>, initialParams || {}, node, onParamsChange);
  const d = DEFAULT_LOFI as any as Record<string, number>;
  const K = (id: string, label: string, o: Record<string, any> = {}) => (
    <V21Knob spec={lf(id)} label={label} value={p[id]} defaultValue={d[id]} onChange={v => set({ [id]: v })} size="M" cap="cream" ticks={11} {...o} />
  );
  return (
    <V21Shell type="LOFI" title="Lo-fi / téléphone" node={node} finish="avocado" kicker="Bande · grain · bits · souffle" modelStyle="serif" width={620}
      uiAccent={LOFI_ACCENT} uiAccentInk="#141c04" faceStyle={{ ['--hw-accent' as any]: LOFI_ACCENT }}
      subtitle="Téléphone, radio, cassette, bitcrush : on rétrécit la bande passante, on ajoute du grain, on réduit les bits et un peu de souffle."
      toolbar={<V21Presets presets={LOFI_PRESETS} current={p} onApply={pr => set(pr.params as any)} />}>
      <div className="flex justify-center mb-3">
        <span className="hw-lcd hw-lcd-amber" data-nova-lofi="band" style={{ whiteSpace: 'normal', textAlign: 'center' }}>
          Bande : {p.lowCut <= 25 ? 'graves intacts' : hzText(p.lowCut)} → {p.highCut >= 19500 ? 'aigus intacts' : hzText(p.highCut)}
          {' · '}{p.bits >= 16 && p.rate >= 44100 ? 'sans bitcrush' : `${p.bits >= 16 ? '16' : Math.round(p.bits)} bits, ${hzText(p.rate)}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <HwSection title="Bande passante" className="flex-[1_1_220px] min-w-0">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
            {K('lowCut', 'Coupe-bas', { curve: 'log', scale: [{ v: 20, label: '20' }, { v: 200, label: '200' }, { v: 2000, label: '2k' }], ticks: 0 })}
            {K('highCut', 'Coupe-haut', { curve: 'log', scale: [{ v: 1000, label: '1k' }, { v: 4000, label: '4k' }, { v: 20000, label: '20k' }], ticks: 0 })}
          </div>
        </HwSection>
        <HwSection title="Numérique" className="flex-[1_1_220px] min-w-0">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
            {K('bits', 'Bits', { scale: [{ v: 2, label: '2' }, { v: 8, label: '8' }, { v: 16, label: '16' }], ticks: 15 })}
            {K('rate', 'Échant.', { curve: 'log', scale: [{ v: 1000, label: '1k' }, { v: 8000, label: '8k' }, { v: 48000, label: '48k' }], ticks: 0 })}
          </div>
        </HwSection>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 mt-2">
        <HwSection title="Grain" className="flex-[1_1_220px] min-w-0">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
            {K('drive', 'Saturation')}
            {K('noise', 'Souffle')}
          </div>
        </HwSection>
        <HwSection title="Niveaux" className="flex-[1_1_220px] min-w-0">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
            {K('mix', 'Dosage', { scale: [{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }], ticks: 0 })}
            {K('output', 'Sortie', { scale: [{ v: -24, label: '-24' }, { v: 0, label: '0' }, { v: 12, label: '+12' }], ticks: 0 })}
          </div>
        </HwSection>
      </div>
    </V21Shell>
  );
};

export default NovaDjFilterUI;
