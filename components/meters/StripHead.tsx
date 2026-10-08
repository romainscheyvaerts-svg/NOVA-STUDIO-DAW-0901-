import React from 'react';
import { Track } from '../../types';
import { stripOf, TRIM_MAX_DB, TRIM_MIN_DB, WIDTH_PARAM } from '../../engine/meters/channelStrip';
import { useLiveParam } from '../../utils/automationLiveStore';
import { useKnobInteraction, KNOB_HINT } from '../../hooks/useKnobInteraction';
import { automationRecorder } from '../../services/AutomationManager';

/**
 * Tête de tranche de la console (R11) : Ø (polarité), mono, trim d'entrée et
 * largeur stéréo, sur UNE ligne (la console garde la hauteur de ses faders).
 * Tout agit AVANT les inserts, comme le trim et le Ø d'une console (et le
 * plugin Trim de Pro Tools) : le compresseur reçoit déjà le bon niveau et la
 * bonne polarité. Trim et largeur : glisser, molette, double-clic = neutre.
 */
const fmtTrim = (v: number) => (Math.abs(v) < 0.05 ? '0 dB' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1).replace('.', ',')}`);
const fmtWidth = (v: number) => (v <= 0.005 ? 'Mono' : `${Math.round(v * 100)} %`);

const DragField: React.FC<{
  label: string; value: number; min: number; max: number; def: number; text: string; color: string; help: string; testId: string;
  onChange: (v: number) => void; onStart?: () => void; onEnd?: () => void; disabled?: boolean;
}> = ({ label, value, min, max, def, text, color, help, testId, onChange, onStart, onEnd, disabled }) => {
  const k = useKnobInteraction(value, onChange, { min, max, defaultValue: def, sensitivity: 160, wheelStep: 0.01, onStart, onEnd, disabled });
  return (
    <div {...k.bind} ref={k.wheelRef} role="slider" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={text}
      data-testid={testId} title={`${help}\n${KNOB_HINT}`}
      className={`nova-hit-tactile flex-1 min-w-0 h-6 [@media(pointer:coarse)]:h-8 rounded bg-black/40 [[data-theme=light]_&]:bg-white border border-white/10 flex flex-col items-center justify-center leading-none cursor-ns-resize touch-none select-none ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-[7px] font-black uppercase text-slate-500">{label}</span>
      <span className="text-[9px] font-mono tabular-nums" style={{ color: Math.abs(value - def) > 1e-3 ? color : undefined }}>{text}</span>
    </div>
  );
};

export const StripHead: React.FC<{ track: Track; onUpdate: (t: Track) => void; compact?: boolean }> = ({ track, onUpdate }) => {
  const s = stripOf(track);
  const shownWidth = useLiveParam(track.id, WIDTH_PARAM, s.width);
  const btn = (on: boolean, color: string) =>
    `nova-hit-tactile h-6 [@media(pointer:coarse)]:h-8 shrink-0 px-1.5 rounded text-[10px] font-black border transition-colors ${on ? color : 'bg-white/[0.06] border-transparent text-slate-400 hover:text-white'}`;
  return (
    <div className="flex items-center gap-1" data-testid={`strip-head-${track.id}`}>
      <button type="button" aria-pressed={s.phase} data-testid={`strip-phase-${track.id}`}
        onClick={(e) => { e.stopPropagation(); onUpdate({ ...track, phaseInvert: !s.phase }); }}
        title={s.phase ? 'Polarité inversée (Ø) : clic pour revenir à la normale' : 'Inverser la polarité (Ø) des deux canaux : à essayer quand deux micros sur la même source sonnent creux'}
        aria-label={`Inverser la polarité : ${track.name}`}
        className={btn(s.phase, 'bg-violet-500 border-violet-400 text-white')}>Ø</button>
      <button type="button" aria-pressed={s.mono} data-testid={`strip-mono-${track.id}`}
        onClick={(e) => { e.stopPropagation(); onUpdate({ ...track, monoSum: !s.mono }); }}
        title={s.mono ? 'Somme mono enclenchée : clic pour revenir en stéréo' : 'Sommer en mono (G + D) : vérifier la compatibilité mono, ou centrer une prise stéréo'}
        aria-label={`Mono : ${track.name}`}
        className={btn(s.mono, 'bg-sky-500 border-sky-400 text-black')}>MONO</button>
      <DragField label="Trim" value={s.trimDb} min={TRIM_MIN_DB} max={TRIM_MAX_DB} def={0} text={fmtTrim(s.trimDb)} color="#a78bfa" testId={`strip-trim-${track.id}`}
        help="Trim d'entrée (−24 à +24 dB), avant les effets : ramène une prise trop faible ou trop forte au bon niveau pour le compresseur."
        onChange={(v) => onUpdate({ ...track, inputTrimDb: Math.round(v * 10) / 10 })} />
      <DragField label="Larg." value={s.mono ? 0 : shownWidth} min={0} max={2} def={1} text={fmtWidth(s.mono ? 0 : shownWidth)} color="#38bdf8" testId={`strip-width-${track.id}`}
        help="Largeur stéréo (milieu / côtés) : 0 % = mono, 100 % = inchangée, 200 % = très large. Automatisable (voie « Largeur stéréo »)."
        disabled={s.mono}
        onStart={() => automationRecorder.touch(track.id, WIDTH_PARAM)} onEnd={() => automationRecorder.release(track.id, WIDTH_PARAM)}
        onChange={(v) => onUpdate({ ...track, stereoWidth: Math.round(v * 100) / 100 })} />
    </div>
  );
};

export default StripHead;
