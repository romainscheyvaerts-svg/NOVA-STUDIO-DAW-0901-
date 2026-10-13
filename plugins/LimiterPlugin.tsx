import React, { useState } from 'react';
import type { LimiterNode, LimiterParams } from '../engine/LimiterNode';
import { DEFAULT_LIMITER_PARAMS } from '../engine/LimiterNode';
import { Faceplate, HwSection, HwWindow, Knob, PushButton, SegmentMeter, type KnobProps } from './hw';

/**
 * Fenêtre du limiteur / maximiseur NOVA (V15), pour le master ou la 808,
 * dessinée comme un maximiseur matériel (kit plugins/hw) : façade bleu acier,
 * gros boutons Entrée et Plafond, suréchantillonnage en boutons-poussoirs à
 * LED, échelles de LED de réduction et de crête de sortie (animées hors React).
 */
interface Props {
  node: LimiterNode;
  initialParams: Partial<LimiterParams>;
  onParamsChange: (p: Partial<LimiterParams>) => void;
}

const fmt = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d).replace('.', ',');
const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const ACCENT = '#fbbf24';

const HINTS = {
  inputGain: "Pousse le son dans le limiteur : plus fort, sans jamais dépasser le plafond.",
  ceiling: "Niveau maximal de sortie. −1 dBTP est la valeur sûre pour Spotify, Apple Music et YouTube.",
  release: "Vitesse à laquelle le son revient après une crête. Court = plus fort mais pompe ; long = plus doux.",
  lookahead: "Le limiteur voit les crêtes arriver et baisse le gain en douceur. Plus long = plus transparent, un peu plus de latence.",
  oversample: "Suréchantillonnage de la détection : à 4× et 8×, les crêtes entre les échantillons (crête vraie, dBTP) sont prises en compte, comme le mesurent les plateformes.",
};

export const NovaLimiterUI: React.FC<Props> = ({ node, initialParams, onParamsChange }) => {
  const [p, setP] = useState<LimiterParams>({ ...DEFAULT_LIMITER_PARAMS, ...initialParams });

  const set = (patch: Partial<LimiterParams>) => {
    setP(prev => ({ ...prev, ...patch }));
    node?.updateParams?.(patch);
    onParamsChange(patch);
  };

  const latencyMs = node ? node.latency * 1000 : 0;
  const knob = (id: 'inputGain' | 'ceiling' | 'release' | 'lookahead', label: string, ariaLabel: string, o: Pick<KnobProps, 'min' | 'max'> & Partial<KnobProps>) => (
    <span data-nova-limiter={id}>
      <Knob paramId={id} label={label} ariaLabel={ariaLabel} hint={HINTS[id]} value={p[id]} defaultValue={DEFAULT_LIMITER_PARAMS[id]}
        onChange={v => set({ [id]: v } as Partial<LimiterParams>)} cap="silver" arc={ACCENT} {...o} />
    </span>
  );
  return (
    <HwWindow type="LIMITER" width={600} accent={ACCENT} accentInk="#1a1102" latencyMs={latencyMs} fallback={!!node?.isFallback?.()}
      idleHelp={<>Maximiseur à plafond en crête vraie, pour le master ou la 808 (comme Maximus dans FL Studio ou le Limiter de Live). <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s'affiche ici.</span></>}>
      <Faceplate finish="steel" model="Nova Limiter" kicker="Maximiseur · crête vraie" modelStyle="wide" style={{ ['--hw-accent' as any]: ACCENT }}>
        <div className="flex flex-wrap sm:flex-nowrap items-stretch justify-center gap-4">
          <div className="w-full sm:w-auto sm:flex-1 min-w-0">
            <div className="flex flex-wrap items-start justify-around gap-x-3 gap-y-2">
              {knob('inputGain', 'Entrée', "Gain d'entrée", { size: 'L', min: 0, max: 24, step: 0.1, format: (v: number) => `${fmt(v)} dB`,
                scale: [{ v: 0, label: '0' }, { v: 6, label: '6' }, { v: 12, label: '12' }, { v: 18, label: '18' }, { v: 24, label: '24' }] })}
              {knob('ceiling', 'Plafond', 'Plafond (crête vraie)', { size: 'L', min: -6, max: 0, step: 0.1, format: (v: number) => `${fmt(v)} dBTP`,
                scale: [{ v: -6, label: '−6' }, { v: -3, label: '−3' }, { v: -1, label: '−1' }, { v: 0, label: '0' }] })}
            </div>
            <HwSection title="Temps" className="mt-2">
              <div className="flex flex-wrap items-start justify-around gap-x-3 gap-y-2">
                {knob('release', 'Relâchement', 'Relâchement', { size: 'M', min: 10, max: 1000, step: 1, curve: 'log', format: (v: number) => `${fr(v, 0)} ms`,
                  scale: [{ v: 10, label: '10' }, { v: 100, label: '100' }, { v: 1000, label: '1k' }] })}
                {knob('lookahead', 'Anticipation', 'Anticipation', { size: 'M', min: 0.5, max: 10, step: 0.1, format: (v: number) => `${fr(v)} ms`,
                  scale: [{ v: 0.5, label: '0,5' }, { v: 5, label: '5' }, { v: 10, label: '10' }] })}
              </div>
            </HwSection>
            <HwSection title="Suréchantillonnage (crête vraie)" className="mt-2">
              <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Suréchantillonnage" title={HINTS.oversample} data-nova-limiter="oversample">
                {[1, 2, 4, 8].map(o => (
                  <PushButton key={o} role="radio" active={p.oversample === o} onClick={() => set({ oversample: o })} text={`${o}×`} led="#38bdf8"
                    ariaLabel={`${o}×`} hint={`${HINTS.oversample}${o === 4 ? ' 4× : recommandé.' : ''}`} dark />
                ))}
              </div>
              {p.oversample === 1 && <p className="mt-2 text-center text-[10px] font-bold" style={{ color: '#fca5a5' }} role="status">Crête échantillon seulement : un MP3 ou une plateforme peut dépasser le plafond.</p>}
            </HwSection>
          </div>

          {/* Mesures : échelles de LED (animées hors React) */}
          <div className="flex sm:flex-col items-center justify-center gap-5 sm:gap-3 sm:pl-4 sm:border-l" style={{ borderColor: 'var(--hw-rule)' }} aria-label="Mesures du limiteur">
            <SegmentMeter label="Réduction" orientation="vertical" reverse max={12} segments={24} length={150} fallPerSec={20} holdMs={1500}
              read={() => node?.getMeters?.()?.grDb || 0} colorAt={() => '#fbbf24'} hint="Réduction de gain en cours (dB)"
              scale={[{ v: 0, label: '0' }, { v: 6, label: '6' }, { v: 12, label: '12' }]}
              format={(_v, h) => `${h < 0.05 ? '0,0' : `−${fr(h)}`} dB`} readoutAttrs={{ 'data-nova-limiter': 'gr' }} />
            <SegmentMeter label="Sortie" orientation="vertical" min={-30} max={0} segments={20} length={110} holdMs={1200} fallPerSec={30}
              read={() => { const m = node?.getMeters?.(); return m ? m.outPeakDb : -120; }} marker={p.ceiling}
              colorAt={v => (v > p.ceiling + 0.05 ? '#ef4444' : v > -6 ? '#facc15' : '#4ade80')} hint="Crête de sortie (dB) ; trait blanc : plafond"
              scale={[{ v: -30, label: '−30' }, { v: -12, label: '−12' }, { v: 0, label: '0' }]}
              format={v => (v > -29.9 ? `${fmt(v)} dB` : '— dB')} />
          </div>
        </div>
      </Faceplate>
    </HwWindow>
  );
};

export default NovaLimiterUI;
