import React from 'react';
import { DEFAULT_HARMONIZER, HARMONIZER_PRESETS, HARMONIZER_SPECS, HARMONY_INTERVALS } from '../engine/v21Params';
import { createHarmonyMath } from '../engine/psolaCore';
import { NOTE_NAMES_FR, SCALE_CHOICES, noteNameFr, scaleIntervals } from '../utils/scales';
import { V21Knob, V21Presets, V21Shell, useV21Meter, useV21Params } from './v21Ui';
import { useProjectChords } from '../utils/chordTrack';
import { chordNameFr, chordOfCode, chordSymbol } from '../utils/chordDetect';
import { HwLcdSelect, HwSection, Led, PushButton, ToggleSwitch } from './hw';

/**
 * Fenêtre de l'Harmoniseur NOVA (V21) : 1 à 4 voix d'harmonie dans la gamme
 * du projet, comme les harmonies du Vocal Transformer de Logic, le Pitcher de
 * FL Studio ou un harmoniseur TC-Helicon. Formants préservés.
 *
 * Façade « matériel » (vague 2B) : rack indigo à 4 tranches de voix, afficheurs
 * LCD (tonalité, intervalles, notes jouées), boutons rotatifs du kit plugins/hw.
 */
const spec = (id: string) => HARMONIZER_SPECS.find(s => s.id === id)!;
const math = createHarmonyMath();
const ACCENT = '#f0abfc';

const FOLLOW_HINT = "Les voix se calent sur les notes de l'accord en cours (couloir d'accords de l'arrangement) au lieu de la gamme seule : sur un La chanté en La mineur, la tierce donne Do, la quinte Mi ; sur Fa majeur, la voix passe sur les notes de Fa. Le changement d'accord tombe pile sur le temps, en lecture comme à l'export.";

/** Note chantée : seul cet afficheur suit les mesures. */
const SungNote: React.FC<{ node: any }> = ({ node }) => {
  const sung = useV21Meter(node, m => +(m?.pitch?.note || 0));
  return <span className="hw-lcd" title="Note chantée en ce moment (détection de hauteur)"><small>chantée</small><b data-nova-harmonizer="note">{sung > 0 ? noteNameFr(sung) : '—'}</b></span>;
};

/** Accord en cours (piste d'accords) : suit les mesures. */
const ChordNow: React.FC<{ node: any; count: number }> = ({ node, count }) => {
  const code = useV21Meter(node, m => +(m?.chord || 0));
  const c = chordOfCode(code);
  if (c) return <span className="hw-lcd"><small>accord</small><b data-nova-harmonizer="chord">{`${chordSymbol(c.root, c.quality)} (${chordNameFr(c.root, c.quality)})`}</b></span>;
  return <span className="hw-lcd"><small>{count} accord{count > 1 ? 's' : ''} · lance la lecture</small></span>;
};

/** Note jouée par une voix : suit les mesures. */
const VoiceNote: React.FC<{ node: any; deg: number; rootKey: number; scale: number[]; follow: boolean }> = ({ node, deg, rootKey, scale, follow }) => {
  const sung = useV21Meter(node, m => +(m?.pitch?.note || 0));
  const chord = useV21Meter(node, m => (follow ? +(m?.chord || 0) : 0));
  return <span className="hw-lcd" title="Note jouée par cette voix en ce moment" style={{ justifyContent: 'center' }}>→ {sung > 0 ? noteNameFr(sung + math.shiftFor(sung, rootKey, scale, deg, chord)) : '—'}</span>;
};

export const NovaHarmonizerUI: React.FC<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [p, set] = useV21Params(DEFAULT_HARMONIZER as Record<string, any>, initialParams || {}, node, onParamsChange);
  const d = DEFAULT_HARMONIZER as any as Record<string, number>;
  const n = Math.max(1, Math.min(4, Math.round(p.voices)));
  const scale = scaleIntervals(p.scale);
  const chromatic = (p.scale || 'CHROMATIC').toUpperCase() === 'CHROMATIC';
  // Piste d'accords : les voix se calent sur l'accord en cours (lecture et export).
  const chords = useProjectChords();
  const hasChords = chords.length > 0;
  const follow = p.followChords === undefined || +p.followChords >= 0.5;
  const followText = !hasChords ? "Aucun accord dans le projet : pose-les dans le couloir d'accords (sous la règle) ou détecte-les sur le beat, les voix les suivront."
    : !follow ? 'Désactivé : les voix suivent la gamme seule.' : 'Les voix se calent sur l’accord en cours.';

  return (
    <V21Shell type="HARMONIZER" title="Harmoniseur" node={node} finish="indigo" kicker="1 à 4 voix dans la gamme · formants préservés" modelStyle="serif" width={700}
      uiAccent={ACCENT} uiAccentInk="#1f0524" faceStyle={{ ['--hw-accent' as any]: ACCENT }}
      subtitle="Ajoute 1 à 4 voix d'harmonie dans la gamme du projet, au timbre naturel. NOVA prend la tonalité détectée sur le beat ; change-la si besoin."
      toolbar={<V21Presets presets={HARMONIZER_PRESETS} current={p} onApply={pr => set(pr.params as any)} />}>
      <HwSection title="Tonalité">
        <div className="flex flex-wrap items-end justify-center gap-x-3 gap-y-2">
          <HwLcdSelect label="Tonique" ariaLabel="Tonique" hint="Tonalité utilisée pour calculer les harmonies (celle du projet par défaut)." paramId="rootKey" width={84}
            value={p.rootKey} options={NOTE_NAMES_FR.map((nm, i) => ({ v: i, label: nm }))} onChange={v => set({ rootKey: +v })} />
          <HwLcdSelect label="Gamme" ariaLabel="Gamme" hint="Gamme utilisée pour calculer les harmonies. NOVA prend celle du projet (détectée sur le beat) ; change-la si besoin." paramId="scale" width={170}
            value={(p.scale || 'CHROMATIC').toUpperCase()} options={SCALE_CHOICES.map(s => ({ v: s.id, label: s.label }))} onChange={v => set({ scale: v })} />
          <SungNote node={node} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          <PushButton role="checkbox" active={follow} onClick={() => set({ followChords: follow ? 0 : 1 })} text="Suivre les accords" led={ACCENT} dark
            ariaLabel="Suivre la piste d'accords" hint={`${FOLLOW_HINT} ${followText}`} valueText={follow ? 'activé' : 'désactivé'}
            dataAttrs={{ 'data-nova-harmonizer': 'follow-chords' }} />
          {hasChords && follow
            ? <ChordNow node={node} count={chords.length} />
            : <span className="hw-silk hw-silk-soft" style={{ textTransform: 'none', letterSpacing: '0.02em', fontSize: 10.5, maxWidth: 330, textAlign: 'left' }}>{followText}</span>}
        </div>
        {chromatic && !(follow && hasChords) && (
          <div className="mt-2 flex items-center justify-center gap-2" title="Choisis la gamme du morceau, ou pose les accords, pour des harmonies toujours justes.">
            <Led on color="#fbbf24" />
            <span className="hw-silk" style={{ textTransform: 'none', letterSpacing: '0.02em', fontSize: 10.5 }}>Tonalité inconnue : intervalles fixes (tierce majeure, quinte…)</span>
          </div>
        )}
      </HwSection>

      <HwSection title="Voix" className="mt-3" aside={
        <span className="flex gap-1.5" role="radiogroup" aria-label="Nombre de voix" data-nova-param="voices">
          {[1, 2, 3, 4].map(v => (
            <PushButton key={v} role="radio" active={n === v} onClick={() => set({ voices: v })} text={String(v)} led={ACCENT} dark className="hw-push-sm"
              ariaLabel={`${v} voix`} hint={spec('voices').hint} />
          ))}
        </span>
      }>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[1, 2, 3, 4].map(i => {
            const deg = Math.round(p[`v${i}Deg`]);
            const on = i <= n;
            return (
              <div key={i} className="hw-well flex flex-col items-center gap-1.5 px-1.5 py-2 min-w-0" data-nova-voice={on ? i : undefined}
                style={on ? undefined : { opacity: 0.4 }} aria-disabled={!on}>
                <div className="flex items-center gap-1.5"><Led on={on} color={ACCENT} /><span className="hw-silk">Voix {i}</span></div>
                <HwLcdSelect ariaLabel={`Intervalle de la voix ${i}`} hint={spec(`v${i}Deg`).hint} paramId={`v${i}Deg`} width="100%" amber disabled={!on}
                  value={deg} options={HARMONY_INTERVALS.map(iv => ({ v: iv.deg, label: iv.short }))} onChange={v => set({ [`v${i}Deg`]: +v })} />
                <div className="flex items-start justify-center gap-0.5">
                  <V21Knob spec={spec(`v${i}Level`)} label="Niveau" value={p[`v${i}Level`]} defaultValue={d[`v${i}Level`]} onChange={v => set({ [`v${i}Level`]: v })}
                    size="S" cap="silver" ticks={7} disabled={!on} />
                  <V21Knob spec={spec(`v${i}Pan`)} label="Pan" value={p[`v${i}Pan`]} defaultValue={d[`v${i}Pan`]} onChange={v => set({ [`v${i}Pan`]: v })}
                    size="S" cap="silver" ticks={7} disabled={!on} />
                </div>
                {on && <VoiceNote node={node} deg={deg} rootKey={p.rootKey} scale={scale} follow={follow && hasChords} />}
              </div>
            );
          })}
        </div>
      </HwSection>

      <div className="hw-rule" />
      <div className="flex flex-wrap items-center justify-around gap-x-3 gap-y-3">
        <V21Knob spec={spec('dry')} label="Voix principale" value={p.dry} defaultValue={d.dry} onChange={v => set({ dry: v })} size="M" cap="silver"
          scale={[{ v: -60, label: '-60' }, { v: -24, label: '-24' }, { v: 0, label: '0' }, { v: 6, label: '+6' }]} />
        <V21Knob spec={spec('humanize')} label="Humanisation" value={p.humanize} defaultValue={d.humanize} onChange={v => set({ humanize: v })} size="M" cap="silver"
          scale={[{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }]} />
        <V21Knob spec={spec('formant')} label="Formant" value={p.formant} defaultValue={d.formant} onChange={v => set({ formant: v })} size="M" cap="silver"
          scale={[{ v: -12, label: '-12' }, { v: 0, label: '0' }, { v: 12, label: '+12' }]} />
        <span data-nova-param="preserve">
          <ToggleSwitch label="Formants" hint={spec('preserve').hint} value={p.preserve >= 0.5 ? 1 : 0} onChange={v => set({ preserve: v })}
            options={[{ v: 1, label: 'Préservés' }, { v: 0, label: 'Chipmunk' }]} />
        </span>
      </div>
    </V21Shell>
  );
};

export default NovaHarmonizerUI;
