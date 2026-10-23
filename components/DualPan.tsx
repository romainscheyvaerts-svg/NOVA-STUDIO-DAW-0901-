import React, { useRef, useState } from 'react';
import type { Track } from '../types';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { automationRecorder } from '../services/AutomationManager';
import { getLive, liveKey, useLiveView } from '../utils/automationLiveStore';
import {
  isStereoTrack, PAN_L, PAN_LAWS, PAN_R, panShort, parsePanText, stereoPanOf, withStereoPan, type PanLaw,
} from '../utils/panLaw';
import { requestPanLaw, usePanLaw } from '../utils/panLawStore';
import ToolbarMenu, { MenuSection, menuRowClass } from './ToolbarMenu';

/**
 * Double pan des pistes stéréo (22/10/2026), comme sur les consoles de studio : un bouton
 * « G » (où va le canal gauche) et un bouton « D » (où va le canal droit), chacun placé par
 * la loi de pan du projet. Par défaut G 100 / D 100 : le son d'origine.
 *
 * Gestes communs (hooks/useKnobInteraction) : glisser, Maj ou Ctrl = fin, molette,
 * double-clic ou Alt+clic = valeur par défaut (G 100 / D 100). Saisie : clic sur la valeur
 * (« 100G », « 30D », « C »). Menu ▾ : lien (même sens / miroir), format mono / stéréo,
 * loi de pan du projet. Automation : voies « Pan G » et « Pan D ».
 */

/** Doigt (tablette, téléphone) : zones de toucher de 44 px. */
const coarsePointer = () => {
  try { return window.matchMedia('(pointer: coarse)').matches || document.body?.dataset.viewMode === 'TABLET'; } catch { return false; }
};

const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const snap = (v: number) => (Math.abs(v) < 0.005 ? 0 : clamp(v));

/** Nouveau G / D quand un côté bouge, selon le lien (même sens : l'écart est gardé ; miroir : symétrique). */
export function linkedPan(l: number, r: number, side: 'l' | 'r', v: number, link?: Track['panLink']): { l: number; r: number } {
  if (!link) return side === 'l' ? { l: v, r } : { l, r: v };
  const cur = side === 'l' ? l : r;
  const other = side === 'l' ? r : l;
  let d = v - cur;
  if (link === 'same') d = Math.max(-1 - Math.min(cur, other), Math.min(1 - Math.max(cur, other), d));
  else d = Math.max(Math.max(-1 - cur, other - 1), Math.min(Math.min(1 - cur, other + 1), d));
  const nc = clamp(cur + d), no = clamp(link === 'same' ? other + d : other - d);
  return side === 'l' ? { l: nc, r: no } : { l: no, r: nc };
}

interface KnobProps {
  track: Track;
  side: 'l' | 'r';
  value: number;
  size: number;
  onChange: (v: number) => void;
  showValue: boolean;
}

const PanSideKnob: React.FC<KnobProps> = ({ track, side, value, size, onChange, showValue }) => {
  const param = side === 'l' ? PAN_L : PAN_R;
  const letter = side === 'l' ? 'G' : 'D';
  const def = side === 'l' ? -1 : 1;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Pendant la lecture, l'aiguille suit la voie « Pan G » / « Pan D » (seul ce bouton se redessine).
  const deg = useLiveView(track.id, param, value, v => Math.round(v * 135));
  const text = useLiveView(track.id, param, value, panShort);
  const knob = useKnobInteraction(value, v => onChange(snap(v)), {
    min: -1, max: 1, sensitivity: 200, defaultValue: def,
    valueNow: () => getLive(liveKey(track.id, param)) ?? value,
    onStart: () => automationRecorder.touch(track.id, param), onEnd: () => automationRecorder.release(track.id, param),
  });
  const [editing, setEditing] = useState(false);
  const done = useRef(false);
  const commit = (txt: string) => {
    if (done.current) return;
    done.current = true; setEditing(false);
    const v = parsePanText(txt);
    if (v !== null) onChange(v);
  };
  const name = side === 'l' ? 'canal gauche' : 'canal droit';
  const hit = coarsePointer() ? Math.max(44, size) : size;
  return (
    <div className="flex flex-col items-center gap-0.5">
      {/* Zone de toucher : 44 px au doigt (tablette, téléphone), le bouton visible garde sa taille. */}
      <div
        {...knob.bind}
        ref={el => { hostRef.current = el; knob.bind.ref(el); }}
        role="slider"
        aria-label={`Pan ${letter} (${name}) de ${track.name}`}
        aria-valuemin={-1} aria-valuemax={1} aria-valuenow={Number(value.toFixed(3))} aria-valuetext={text}
        title={`Pan ${letter} : position du ${name} (${text}). Glisser (Maj = fin), molette, double-clic ou Alt+clic = ${side === 'l' ? '100G' : '100D'}`}
        data-testid={`pan-${side === 'l' ? 'g' : 'd'}-${track.id}`}
        className="group/pk relative shrink-0 flex items-center justify-center cursor-ns-resize touch-none"
        style={{ width: hit, height: hit }}
      >
        <div className="relative rounded-full bg-nv-raised border border-white/10 shadow-sm group-hover/pk:border-cyan-500/40 transition-colors pointer-events-none" style={{ width: size, height: size }}>
          <span className="absolute inset-x-0 text-center text-[8px] font-black leading-none text-slate-500 select-none" style={{ bottom: Math.max(2, size * 0.1) }} aria-hidden="true">{letter}</span>
          <div className="absolute left-1/2 -ml-px w-0.5 rounded-full bg-cyan-400" style={{ height: size * 0.36, top: size * 0.12, transformOrigin: `50% ${size * 0.38}px`, transform: `rotate(${deg}deg)` }} />
        </div>
      </div>
      {showValue && (editing ? (
        <input autoFocus defaultValue={text} aria-label={`Pan ${letter} de ${track.name} : taper la valeur (100G, 30D, C)`}
          data-testid={`pan-${side === 'l' ? 'g' : 'd'}-input-${track.id}`}
          onFocus={e => e.currentTarget.select()}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); } if (e.key === 'Escape') { e.preventDefault(); done.current = true; setEditing(false); } }}
          onBlur={e => commit(e.currentTarget.value)}
          className="w-10 rounded border border-cyan-500/60 bg-black/70 px-0.5 text-center text-[9px] font-mono font-bold text-white outline-none" />
      ) : (
        <button type="button" onClick={() => { done.current = false; setEditing(true); }}
          title={`Clic pour taper le pan ${letter} (ex. 100G, 30D, C), puis Entrée`}
          data-testid={`pan-${side === 'l' ? 'g' : 'd'}-value-${track.id}`}
          // Au doigt (tablette) : 28 px de haut au lieu de 19 (audit tactile : cible trop petite).
          className={`min-w-[34px] rounded bg-black/50 px-1 font-mono font-bold tabular-nums text-slate-200 hover:text-white cursor-text ${coarsePointer() ? 'min-h-[28px] text-[11px]' : 'text-[9px]'}`}>{text}</button>
      ))}
    </div>
  );
};

/** Choix de la loi de pan du projet (menus). */
export const PanLawPicker: React.FC<{ onPicked?: () => void }> = ({ onPicked }) => {
  const law = usePanLaw();
  const info = PAN_LAWS.find(x => x.law === law) || PAN_LAWS[0];
  return (
    <div className="px-1" data-testid="pan-law-picker">
      <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Loi de pan du projet">
        {PAN_LAWS.map(x => (
          <button key={x.law} type="button" role="radio" aria-checked={x.law === law} data-testid={`pan-law-${x.law}`}
            title={`${x.label} : ${x.hint}`}
            onClick={() => { requestPanLaw(x.law as PanLaw); onPicked?.(); }}
            className={`min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-md border text-[11px] font-bold tabular-nums ${x.law === law ? 'border-cyan-400/70 bg-cyan-500/15 text-cyan-200 [[data-theme=light]_&]:text-cyan-800' : 'border-white/10 text-slate-300 hover:bg-white/5'}`}>
            {x.law === 0 ? '0 dB' : `${String(x.law).replace('.', ',').replace('-', '−')}`}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-slate-400"><b className="text-slate-200">{info.label}.</b> {info.hint} Même loi en lecture, à l’export et au casque.</p>
    </div>
  );
};

/** Menu ▾ du pan : lien, format de la piste, loi du projet. */
export const PanMenu: React.FC<{ track: Track; onUpdate: (t: Track) => void; compact?: boolean }> = ({ track, onUpdate, compact }) => {
  const stereo = isStereoTrack(track);
  const autoStereo = isStereoTrack({ ...track, panFormat: undefined });
  const setFormat = (f: Track['panFormat']) => {
    const next = { ...track } as Track;
    if (f) next.panFormat = f; else delete next.panFormat;
    onUpdate(next);
  };
  const setLink = (link: Track['panLink']) => {
    const next = { ...track } as Track;
    if (link) next.panLink = link; else delete next.panLink;
    onUpdate(next);
  };
  return (
    <ToolbarMenu testId={`pan-menu-${track.id}`} menuLabel={`Pan de ${track.name}`} width={290}
      ariaLabel={`Réglages du pan de ${track.name} (lien, mono / stéréo, loi de pan)`}
      title="Pan : lier G et D, piste mono ou stéréo, loi de pan du projet"
      triggerClassName={`nova-hit-tactile shrink-0 flex items-center justify-center rounded text-slate-500 hover:text-white hover:bg-white/10 ${compact ? 'w-4 h-5' : 'w-5 h-5'}`}
      label={<i className="fas fa-chevron-down text-[8px]" aria-hidden="true" />}>
      {(close) => (<>
        {stereo && (
          <MenuSection title="Lien G / D" first>
            {([[undefined, 'Indépendants', 'Chaque bouton règle son canal.'], ['same', 'Liés (même sens)', 'Les deux bougent ensemble, l’écart est gardé : déplacer toute l’image.'], ['mirror', 'Liés en miroir', 'L’un vers le centre, l’autre aussi : resserrer ou élargir l’image.']] as [Track['panLink'], string, string][]).map(([v, label, hint]) => (
              <button key={label} type="button" role="menuitemradio" aria-checked={track.panLink === v} title={hint}
                onClick={() => { setLink(v); close(); }} className={menuRowClass(track.panLink === v)} data-testid={`pan-link-${v || 'none'}`}>
                <span>{label}</span>{track.panLink === v && <i className="fas fa-check ml-auto text-[10px]" aria-hidden="true" />}
              </button>
            ))}
            <button type="button" onClick={() => { const n = withStereoPan(track, -1, 1); onUpdate(n); close(); }} className={menuRowClass(false)} data-testid="pan-reset-stereo">
              <span>Remettre G 100 / D 100 (son d’origine)</span>
            </button>
          </MenuSection>
        )}
        <MenuSection title="Format de la piste" first={!stereo}>
          {([[undefined, `Automatique (${autoStereo ? 'stéréo' : 'mono'} d’après le son)`], ['mono', 'Mono : un seul pan'], ['stereo', 'Stéréo : pan G et pan D']] as [Track['panFormat'], string][]).map(([v, label]) => (
            <button key={label} type="button" role="menuitemradio" aria-checked={track.panFormat === v}
              onClick={() => { setFormat(v); close(); }} className={menuRowClass(track.panFormat === v)} data-testid={`pan-format-${v || 'auto'}`}>
              <span>{label}</span>{track.panFormat === v && <i className="fas fa-check ml-auto text-[10px]" aria-hidden="true" />}
            </button>
          ))}
        </MenuSection>
        <MenuSection title="Loi de pan du projet">
          <PanLawPicker />
        </MenuSection>
      </>)}
    </ToolbarMenu>
  );
};

/**
 * Double pan d'une piste stéréo. `variant` : « strip » (tranche de console : boutons, valeurs
 * à taper, menu) ou « header » (en-tête de piste : deux petits boutons et le menu).
 */
export const DualPan: React.FC<{ track: Track; onUpdate: (t: Track) => void; variant?: 'strip' | 'header' }> = ({ track, onUpdate, variant = 'strip' }) => {
  const sp = stereoPanOf(track);
  const set = (side: 'l' | 'r', v: number) => {
    const n = linkedPan(sp.l, sp.r, side, v, track.panLink);
    onUpdate(withStereoPan(track, n.l, n.r));
  };
  const strip = variant === 'strip';
  const size = strip ? 34 : 26;
  return (
    <div className={`flex ${strip ? 'flex-col items-center' : 'items-center'} gap-0.5`} data-testid={`dual-pan-${track.id}`}>
      {strip && (
        <div className="flex items-center gap-0.5 h-4">
          <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest">Pan G · D{track.panLink ? (track.panLink === 'mirror' ? ' ⇄' : ' ⇉') : ''}</span>
          <PanMenu track={track} onUpdate={onUpdate} compact />
        </div>
      )}
      <div className={`flex items-start ${strip ? 'gap-2' : 'gap-1'} nova-hit-gap`}>
        <PanSideKnob track={track} side="l" value={sp.l} size={size} onChange={v => set('l', v)} showValue={strip} />
        <PanSideKnob track={track} side="r" value={sp.r} size={size} onChange={v => set('r', v)} showValue={strip} />
        {!strip && <PanMenu track={track} onUpdate={onUpdate} compact />}
      </div>
    </div>
  );
};

export default DualPan;
