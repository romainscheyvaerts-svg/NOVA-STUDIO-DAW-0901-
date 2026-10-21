import React, { useEffect } from 'react';
import type { Track } from '../types';
import { RATE_LABEL, SHAPE_LABEL, defaultModulator, type Modulator, type LfoRate, type LfoShape, type LfoPolarity } from '../utils/modulators';
import { automationParamLabel } from '../utils/automationLabels';
import { isMuteParam } from '../utils/muteAutomation';

interface Props {
  track: Track;
  allTracks: Track[];
  onChange: (mods: Modulator[]) => void;
  onClose: () => void;
}

const RATES: LfoRate[] = ['4/1', '2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/4T', '1/8T', '1/16T'];
const SHAPES: LfoShape[] = ['sine', 'triangle', 'square', 'saw', 'random'];
const POLARITY: { id: LfoPolarity; label: string }[] = [
  { id: 'bi', label: 'Autour de la valeur' }, { id: 'up', label: 'Au-dessus' }, { id: 'down', label: 'En dessous' },
];

/**
 * L3 · Modulateurs de la piste (utils/modulators) : LFO calés sur le tempo,
 * branchés sur une voie d'automation (volume, panoramique, envoi, réglage d'un
 * effet). Ils s'ajoutent à l'automation dessinée, en lecture et à l'export.
 */
const ModulatorsPanel: React.FC<Props> = ({ track, allTracks, onChange, onClose }) => {
  const mods = track.modulators || [];
  const targets = (track.automationLanes || []).filter(l => !isMuteParam(l.parameterName)).map(l => ({ id: l.parameterName, label: automationParamLabel(l.parameterName, allTracks) }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const set = (id: string, patch: Partial<Modulator>) => onChange(mods.map(m => (m.id === id ? { ...m, ...patch } : m)));
  const chip = (on: boolean) => `nova-hit min-h-9 px-2.5 rounded-lg border text-[12px] font-bold ${on ? 'bg-cyan-500 text-black border-cyan-400' : 'border-nv-line/15 text-nv-ink hover:bg-nv-raised'}`;
  const field = 'min-h-9 bg-nv-well/40 border border-nv-line/15 rounded-lg px-2 text-[12px] text-nv-ink font-bold outline-none focus:border-nv-accent';
  const lbl = 'text-[11px] font-bold text-nv-muted block mb-1';
  const firstFree = targets.find(t => !mods.some(m => m.target === t.id)) || targets[0];

  return (
    <div className="fixed inset-0 z-[1250] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="mod-title" data-testid="modulators-panel" onMouseDown={e => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line/15 bg-nv-surface text-nv-ink shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-nv-line/15">
          <div className="min-w-0">
            <h2 id="mod-title" className="text-[14px] font-black uppercase tracking-widest truncate">Modulateurs · {track.name}</h2>
            <p className="text-[12px] text-nv-muted">Un LFO calé sur le tempo fait bouger un réglage tout seul. Il s’ajoute à l’automation, en lecture et à l’export.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="nova-hit w-9 h-9 rounded-full text-nv-muted hover:text-nv-ink flex items-center justify-center shrink-0"><i className="fas fa-times" aria-hidden="true"></i></button>
        </div>

        <div className="p-5 space-y-4">
          {!targets.length && (
            <p className="text-[12px] text-amber-300 rounded-xl border border-dashed border-amber-500/30 p-3">Cette piste n’a pas encore de voie d’automation : affiche l’automation (mode avancé) et ajoute le réglage à faire bouger, puis reviens ici.</p>
          )}
          {targets.length > 0 && !mods.length && (
            <p className="text-[12px] text-nv-muted rounded-xl border border-dashed border-nv-line/20 p-3" data-testid="mod-empty">
              Aucun modulateur. Ajoute un <b>LFO</b> pour un trémolo sur le volume, un panoramique qui tourne, ou un filtre qui s’ouvre à chaque mesure.
            </p>
          )}

          {mods.map(m => (
            <section key={m.id} data-testid="mod-slot" className={`rounded-2xl border p-3 space-y-3 ${m.on ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-nv-line/15 opacity-80'}`}>
              <div className="flex items-center gap-2">
                <i className="fas fa-wave-square text-nv-accent w-4" aria-hidden="true"></i>
                <select value={m.target} onChange={e => set(m.id, { target: e.target.value })} className={`${field} flex-1 min-w-0`} aria-label="Réglage piloté" data-testid="mod-target">
                  {targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  {!targets.some(t => t.id === m.target) && <option value={m.target}>{automationParamLabel(m.target, allTracks)} (voie retirée)</option>}
                </select>
                <label className="flex items-center gap-1.5 text-[12px] font-bold cursor-pointer shrink-0">
                  <input type="checkbox" className="w-5 h-5" checked={m.on} onChange={e => set(m.id, { on: e.target.checked })} data-testid="mod-on" />
                  {m.on ? 'Actif' : 'Coupé'}
                </label>
                <button type="button" onClick={() => onChange(mods.filter(x => x.id !== m.id))} aria-label="Retirer le modulateur" title="Retirer" className="nova-hit w-9 h-9 rounded-lg text-red-400 hover:bg-nv-raised shrink-0"><i className="fas fa-trash" aria-hidden="true"></i></button>
              </div>
              <div><span className={lbl}>Forme</span>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Forme du LFO">
                  {SHAPES.map(s => <button key={s} type="button" role="radio" aria-checked={m.shape === s} onClick={() => set(m.id, { shape: s })} className={chip(m.shape === s)} data-testid={`mod-shape-${s}`}>{SHAPE_LABEL[s]}</button>)}
                </div></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="block"><span className={lbl}>Période (calée sur le tempo)</span>
                  <select value={m.rate} onChange={e => set(m.id, { rate: e.target.value as LfoRate })} className={`${field} w-full`} data-testid="mod-rate">
                    {RATES.map(r => <option key={r} value={r}>{RATE_LABEL[r]}</option>)}
                  </select></label>
                <label className="block"><span className={lbl}>Sens</span>
                  <select value={m.polarity} onChange={e => set(m.id, { polarity: e.target.value as LfoPolarity })} className={`${field} w-full`}>
                    {POLARITY.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select></label>
              </div>
              <label className="block"><span className={lbl}>Amplitude : {Math.round(m.depth * 100)} % de la plage</span>
                <input type="range" min={0} max={100} step={1} value={Math.round(m.depth * 100)} onChange={e => set(m.id, { depth: Number(e.target.value) / 100 })} className="w-full" data-testid="mod-depth" /></label>
              <label className="block"><span className={lbl}>Départ dans la période : {Math.round(m.phase * 360)}°</span>
                <input type="range" min={0} max={100} step={1} value={Math.round(m.phase * 100)} onChange={e => set(m.id, { phase: Number(e.target.value) / 100 })} className="w-full" /></label>
            </section>
          ))}

          <button type="button" disabled={!targets.length || mods.length >= 16} onClick={() => firstFree && onChange([...mods, defaultModulator(firstFree.id)])} data-testid="mod-add"
            className="nova-hit w-full min-h-11 rounded-xl border border-nv-line/15 text-[13px] font-black disabled:opacity-40 hover:bg-nv-raised">
            <i className="fas fa-plus mr-1.5" aria-hidden="true"></i>Ajouter un LFO
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModulatorsPanel;
