import React from 'react';
import { DEFAULT_VOICESHIFT, VOICESHIFT_PRESETS, VOICESHIFT_SPECS } from '../engine/v21Params';
import { noteNameFr } from '../utils/scales';
import { V21Knob, V21Presets, V21Shell, useV21Meter, useV21Params } from './v21Ui';
import { HwSection, PushButton, ToggleSwitch } from './hw';

/**
 * Fenêtre « Voix grave / aiguë » (V21) : hauteur et formant séparés, comme le
 * Vocal Transformer de Logic ou Little AlterBoy. Voix de démon, chipmunk,
 * ou formant seul (même notes, autre timbre).
 *
 * Façade « matériel » (vague 2B) : petite pédale vermillon, gros bouton de
 * hauteur, raccourcis à LED, afficheur « note chantée → note entendue ».
 */
const spec = (id: string) => VOICESHIFT_SPECS.find(s => s.id === id)!;
const ACCENT = '#fde047';

/** Note chantée → note entendue : seul cet afficheur suit les mesures. */
const Notes: React.FC<{ node: any; pitch: number }> = ({ node, pitch }) => {
  const sung = useV21Meter(node, m => +(m?.pitch?.note || 0));
  const out = sung > 0 ? noteNameFr(Math.round(sung + pitch)) : '—';
  return (
    <span className="hw-lcd" title="Note chantée → note entendue">
      <small>chantée</small>{sung > 0 ? noteNameFr(sung) : '—'}<small>→ entendue</small><b>{out}</b>
    </span>
  );
};

export const NovaVoiceShifterUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_VOICESHIFT as Record<string, any>, initialParams || {}, node, onParamsChange);
  const d = DEFAULT_VOICESHIFT as any as Record<string, number>;
  const linked = p.link >= 0.5;
  const desc = Math.abs(p.pitch) < 0.05
    ? (Math.abs(p.formant) < 0.05 ? 'Aucun changement : choisis un préréglage ou bouge la hauteur.' : 'Formant seul : mêmes notes, autre timbre.')
    : `${p.pitch < 0 ? 'Plus grave' : 'Plus aiguë'} de ${Math.abs(p.pitch).toFixed(1).replace('.', ',').replace(/,0$/, '')} demi-ton${Math.abs(p.pitch) >= 2 ? 's' : ''}${linked ? ', timbre lié (bande accélérée / ralentie)' : ', timbre naturel'}.`;
  const SHORT = [
    { v: -12, t: '−8ve', h: 'Une octave plus bas' }, { v: -7, t: '−7', h: '7 demi-tons plus bas (une quinte)' }, { v: -5, t: '−5', h: '5 demi-tons plus bas (une quarte)' },
    { v: 0, t: '0', h: "Hauteur d'origine" }, { v: 12, t: '+8ve', h: 'Une octave plus haut' },
  ];

  return (
    <V21Shell type="VOICESHIFT" title="Voix grave / aiguë" node={node} finish="vermilion" kicker="Hauteur et formant séparés" modelStyle="serif" width={560}
      uiAccent={ACCENT} uiAccentInk="#1d1600" faceStyle={{ ['--hw-accent' as any]: ACCENT }}
      subtitle="Voix de démon, chipmunk, ou timbre seul : la hauteur change les notes, le formant change le timbre (grosse ou fine voix)."
      toolbar={<V21Presets presets={VOICESHIFT_PRESETS} current={p} onApply={pr => set(pr.params as any)} />}>
      <div className="flex flex-col items-center gap-1.5 mb-2">
        <Notes node={node} pitch={+p.pitch || 0} />
        <span className="hw-silk hw-silk-soft" data-nova-voiceshift="desc" style={{ textTransform: 'none', letterSpacing: '0.02em', fontSize: 11 }}>{desc}</span>
      </div>
      <div className="flex flex-wrap items-center justify-around gap-x-4 gap-y-3">
        <V21Knob spec={spec('pitch')} label="Hauteur" value={p.pitch} defaultValue={d.pitch} onChange={v => set({ pitch: v })} size="XL" cap="cream" arc={ACCENT}
          scale={[{ v: -24, label: '-24' }, { v: -12, label: '-12' }, { v: 0, label: '0' }, { v: 12, label: '+12' }, { v: 24, label: '+24' }]} ticks={49} />
        <V21Knob spec={spec('formant')} label="Formant" value={p.formant} defaultValue={d.formant} onChange={v => set({ formant: v })} size="L" cap="cream"
          scale={[{ v: -12, label: 'Gros' }, { v: 0, label: '0' }, { v: 12, label: 'Fin' }]} ticks={25} />
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-2" role="group" aria-label="Raccourcis de hauteur">
        {SHORT.map(s => (
          <PushButton key={s.v} active={Math.abs(p.pitch - s.v) < 0.05} onClick={() => set({ pitch: s.v })} text={s.t} led={ACCENT} dark hint={s.h} ariaLabel={s.h}
            valueText={Math.abs(p.pitch - s.v) < 0.05 ? 'choisi' : undefined} />
        ))}
      </div>
      <HwSection title="Sortie" className="mt-3">
        <div className="flex flex-wrap items-center justify-around gap-x-3 gap-y-3">
          <span data-nova-param="link">
            <ToggleSwitch label="Timbre" hint={spec('link').hint} value={linked ? 1 : 0} onChange={v => set({ link: v })}
              options={[{ v: 0, label: 'Naturel' }, { v: 1, label: 'Lié (chipmunk)' }]} />
          </span>
          <V21Knob spec={spec('mix')} label="Dosage" value={p.mix} defaultValue={d.mix} onChange={v => set({ mix: v })} size="M" cap="black"
            scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
          <V21Knob spec={spec('output')} label="Sortie" value={p.output} defaultValue={d.output} onChange={v => set({ output: v })} size="M" cap="black"
            scale={[{ v: -24, label: '-24' }, { v: 0, label: '0' }, { v: 12, label: '+12' }]} />
        </div>
      </HwSection>
    </V21Shell>
  );
};

export default NovaVoiceShifterUI;
