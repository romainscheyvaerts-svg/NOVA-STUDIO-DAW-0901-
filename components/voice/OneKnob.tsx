/**
 * Lot 8c — One Knob : un gros bouton par piste voix (0 à 100 %) et 8 macros
 * (utils/oneKnob). Deux formes :
 *  - `OneKnobStrip` : dans la tranche de la console (PC) et sur la console du téléphone :
 *    petit cadran (glisser, molette, flèches) + macro ; un appui ouvre la façade ;
 *  - `OneKnobWindow` : la façade (kit plugins/hw) : gros bouton, 8 macros, presets voix et
 *    « Décris ton son » dans la barre d'outils.
 * Chaque mouvement = une modification de la piste : les mouvements d'un même geste se
 * fondent en une étape d'annulation (Ctrl+Z).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OneKnobMacro, Track } from '../../types';
import { Faceplate, HwWindow, Knob, PushButton } from '../../plugins/hw';
import { applyOneKnob, knobAmount, knobMacro, macroDef, ONE_KNOB_MACROS, resetOneKnob, type OneKnobOptions } from '../../utils/oneKnob';
import { findVoicePreset, SEND_IDS } from '../../utils/voicePresets';
import VoicePresetsDialog from './VoicePresetsDialog';
import './oneKnob.css';

export interface OneKnobProps {
  track: Track;
  allTracks: Track[];
  onUpdate: (t: Track) => void;
  projectKey?: number | null;
  projectScale?: string | null;
}

const DRIVES_TEXT: Record<OneKnobMacro, string> = {
  presence: 'Égaliseur : présence 3,5 kHz +5 dB, boue −3 dB · réverbes en retrait',
  chaleur: 'Égaliseur : corps 200 Hz +3 dB, air −2 dB · saturation à bande',
  brillance: 'Égaliseur : air 12 kHz +3 dB, étagère 15 kHz +3 dB · de-esser suit',
  compression: '2 compresseurs 2:1 · 100 % = 5 dB au VU par étage, jamais plus',
  espace: 'Envois : réverbe courte, réverbe longue, écho',
  autotune: 'Nova Tune : de naturel (début) à robot (100 %)',
  largeur: 'Doubleur : copies désaccordées à gauche et à droite',
  saturation: 'Saturation à bande, niveau tenu',
};

/** Options des macros pour une piste (retours présents, tonalité). */
export const knobOptions = (allTracks: Track[], projectKey?: number | null, projectScale?: string | null): OneKnobOptions => ({
  returns: allTracks.filter(t => (Object.values(SEND_IDS) as string[]).includes(t.id)).map(t => t.id),
  projectKey, projectScale,
});

/** Tourne le bouton d'une piste à partir de la DERNIÈRE version de la piste (gestes rapides). */
function useKnobTurn({ track, allTracks, onUpdate, projectKey, projectScale }: OneKnobProps) {
  const latest = useRef(track);
  useEffect(() => { latest.current = track; }, [track]);
  const opts = useMemo(() => knobOptions(allTracks, projectKey, projectScale), [allTracks, projectKey, projectScale]);
  const turn = useCallback((macro: OneKnobMacro, amount: number) => {
    const next = applyOneKnob(latest.current, macro, amount, opts).track;
    latest.current = next;
    onUpdate(next);
  }, [opts, onUpdate]);
  const reset = useCallback(() => { const next = resetOneKnob(latest.current, opts); latest.current = next; onUpdate(next); }, [opts, onUpdate]);
  return { turn, reset };
}

// ---------------------------------------------------------------------------
// Façade (kit hw)
// ---------------------------------------------------------------------------

export const OneKnobWindow: React.FC<OneKnobProps & { onPresets: (describe: boolean) => void }> = (props) => {
  const { track, onPresets } = props;
  const [macro, setMacro] = useState<OneKnobMacro>(knobMacro(track));
  const { turn, reset } = useKnobTurn(props);
  const amount = Math.round(knobAmount(track, macro) * 100);
  const def = macroDef(macro);
  const preset = findVoicePreset(track.voiceChain?.presetId);
  const anyOn = ONE_KNOB_MACROS.some(m => knobAmount(track, m.id) > 0);
  const toolbar = (
    <div className="hw-toolbar-row">
      <button type="button" className="hw-cta" onClick={() => onPresets(false)} data-testid="one-knob-presets"
        title="Bibliothèque de presets voix (par rôle et par style), faits avec les effets NOVA et calés sur ta prise">
        <i className="fas fa-layer-group" aria-hidden="true" /> Presets voix
      </button>
      <button type="button" className="hw-chip" onClick={() => onPresets(true)} data-testid="one-knob-describe" title="Écris le son que tu veux : NOVA propose la chaîne">
        <i className="fas fa-pen-nib" aria-hidden="true" /> Décris ton son
      </button>
      <button type="button" className="hw-chip" onClick={reset} disabled={!anyOn} data-testid="one-knob-reset" title="Remet les 8 macros à 0 % : la chaîne d’avant le One Knob">
        Tout à 0 %
      </button>
    </div>
  );
  return (
    <HwWindow type="ONEKNOB" width={560} accent="#c4a1ff" accentInk="#1b1822" toolbar={toolbar}
      idleHelp={<>Choisis une macro, puis tourne : <b>0 %</b> = ta chaîne telle quelle. Chaque macro garde sa position ; {preset ? <>chaîne : <b>{preset.name}</b></> : 'pas de preset posé'}.</>}>
      <Faceplate finish="black" className="hw-finish-onyx" model="One Knob" kicker={`Macro voix · ${props.track.name}`} modelStyle="wide">
        <div className="ok-layout">
          <div className="ok-macros" role="radiogroup" aria-label="Macro du gros bouton" data-testid="one-knob-macros">
            {ONE_KNOB_MACROS.map(m => {
              const a = Math.round(knobAmount(track, m.id) * 100);
              return (
                <PushButton key={m.id} role="radio" active={macro === m.id} onClick={() => setMacro(m.id)} text={m.name} label={a ? `${a} %` : '—'}
                  led={a > 0 ? '#c4a1ff' : '#5b5568'} hint={m.hint} ariaLabel={`${m.name} (${a} %)`} valueText={`${a} %`} dataAttrs={{ 'data-macro': m.id }} />
              );
            })}
          </div>
          <div className="ok-center">
            <Knob value={amount} min={0} max={100} step={1} defaultValue={0} size="XL" cap="black" arc="#c4a1ff" paramId="amount"
              label={def.name} ariaLabel={`One Knob : ${def.name}`} hint={def.hint} format={v => `${Math.round(v)} %`}
              scale={[0, 20, 40, 60, 80, 100].map(v => ({ v, label: String(v) }))} onChange={v => turn(macro, v / 100)} nativeInput />
            <div className="ok-readout" data-testid="one-knob-readout" aria-live="polite">{def.name} {amount} %</div>
            <div className="ok-drives">{DRIVES_TEXT[macro]}</div>
          </div>
        </div>
      </Faceplate>
    </HwWindow>
  );
};

// ---------------------------------------------------------------------------
// Fenêtre (portail) : façade + presets voix
// ---------------------------------------------------------------------------

export const OneKnobModal: React.FC<OneKnobProps & { onClose: () => void; startWith?: 'knob' | 'presets' | 'describe'; onNotify?: (text: string) => void }> = (props) => {
  const { onClose, startWith = 'knob', onNotify } = props;
  const [presets, setPresets] = useState<null | { describe: boolean }>(startWith === 'knob' ? null : { describe: startWith === 'describe' });
  useEffect(() => {
    if (presets) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, presets]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[710] flex items-end sm:items-center justify-center bg-black/55 p-0 sm:p-4" onClick={onClose} data-testid="one-knob-modal">
        <div className="nova-sombre relative max-h-[94vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`One Knob : ${props.track.name}`}>
          <button type="button" onClick={onClose} aria-label="Fermer le One Knob" className="absolute right-2 top-2 z-10 h-10 w-10 rounded-full text-slate-300 hover:bg-white/10"><i className="fas fa-times" /></button>
          <OneKnobWindow {...props} onPresets={describe => setPresets({ describe })} />
        </div>
      </div>
      {presets && (
        <VoicePresetsDialog track={props.track} allTracks={props.allTracks} projectKey={props.projectKey} projectScale={props.projectScale}
          describeFirst={presets.describe} onClose={() => setPresets(null)}
          onApply={(t, msg) => { props.onUpdate(t); (onNotify || notifyApp)(msg); }} />
      )}
    </>,
    document.body,
  );
};

// ---------------------------------------------------------------------------
// Tranche de la console / téléphone
// ---------------------------------------------------------------------------

/** Message dans la barre d'avis du studio (même canal que les Track Presets). */
const notifyApp = (text: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: text })); } catch { /* hors navigateur */ } };

const ARC = (pct: number) => {
  const r = 15, c = 2 * Math.PI * r, sweep = 0.75;
  return { r, dash: `${c * sweep * pct} ${c}`, base: `${c * sweep} ${c}` };
};

export const OneKnobStrip: React.FC<OneKnobProps & { compact?: boolean; onNotify?: (text: string) => void }> = (props) => {
  const { track, compact } = props;
  const [open, setOpen] = useState<null | 'knob' | 'presets' | 'describe'>(null);
  const macro = knobMacro(track);
  const amount = knobAmount(track, macro);
  const { turn } = useKnobTurn(props);
  const drag = useRef<{ id: number; y: number; v: number; moved: boolean } | null>(null);
  const def = macroDef(macro);
  const pct = Math.round(amount * 100);
  const arc = ARC(amount);
  const preset = findVoicePreset(track.voiceChain?.presetId);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
    drag.current = { id: e.pointerId, y: e.clientY, v: amount, moved: false };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = d.y - e.clientY;
    if (!d.moved && Math.abs(dy) < 3) return;
    d.moved = true; d.y = e.clientY;
    d.v = Math.max(0, Math.min(1, d.v + (dy / 160) * (e.shiftKey ? 0.1 : 1)));
    turn(macro, Math.round(d.v * 100) / 100);
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.id === e.pointerId && !d.moved) setOpen('knob');
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.01 : 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); turn(macro, Math.min(1, amount + step)); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); turn(macro, Math.max(0, amount - step)); }
    else if (e.key === 'Home' || e.key === 'Delete') { e.preventDefault(); turn(macro, 0); }
    else if (e.key === 'End') { e.preventDefault(); turn(macro, 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen('knob'); }
  };
  const onWheel = (e: React.WheelEvent) => { if (!e.deltaY) return; turn(macro, Math.max(0, Math.min(1, amount + (e.deltaY < 0 ? 0.02 : -0.02)))); };

  return (
    <div className={`ok-strip ${compact ? '' : 'w-full'}`} data-testid={`one-knob-strip-${track.id}`}>
      <div role="slider" tabIndex={0} aria-label={`One Knob ${track.name} : ${def.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
        aria-valuetext={`${def.name} ${pct} %`} title={`One Knob — ${def.name} ${pct} % : glisse vers le haut ou le bas, molette, flèches. Appui : ouvrir les 8 macros, les presets voix et « Décris ton son ».`}
        data-no-longpress className="ok-strip-knob nova-hit-tactile shrink-0 cursor-ns-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; }} onKeyDown={onKey} onWheel={onWheel}>
        <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
          <g transform="rotate(135 20 20)">
            <circle cx="20" cy="20" r={arc.r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="4" strokeDasharray={arc.base} strokeLinecap="round" />
            {amount > 0 && <circle cx="20" cy="20" r={arc.r} fill="none" stroke="#a78bfa" strokeWidth="4" strokeDasharray={arc.dash} strokeLinecap="round" />}
          </g>
          <circle cx="20" cy="20" r="9" fill="#1b1822" />
          <line x1="20" y1="20" x2={20 + 8 * Math.cos(((135 + 270 * amount) * Math.PI) / 180)} y2={20 + 8 * Math.sin(((135 + 270 * amount) * Math.PI) / 180)} stroke="#f3eefc" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <button type="button" onClick={() => setOpen('knob')} data-testid={`one-knob-open-${track.id}`}
        title={`Ouvrir le One Knob de ${track.name}${preset ? ` (preset : ${preset.name})` : ''}`}
        className="nova-hit-tactile min-h-[40px] [@media(pointer:coarse)]:min-h-[44px] min-w-0 flex-1 rounded border border-violet-400/30 bg-violet-500/10 px-1.5 py-1 text-left leading-tight hover:bg-violet-500/20">
        <span className="block truncate text-[9px] font-black uppercase tracking-wide text-violet-500">One Knob</span>
        <span className="block truncate text-[10px] font-bold text-nv-ink">{def.name} {pct} %</span>
      </button>
      {open && <OneKnobModal {...props} startWith={open} onClose={() => setOpen(null)} />}
    </div>
  );
};

export default OneKnobStrip;
