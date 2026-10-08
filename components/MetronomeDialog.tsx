import React, { useEffect } from 'react';
import type { MetronomeSettings, PunchSettings } from '../types';
import { METRONOME_SOUNDS, metronomeService } from '../services/MetronomeService';
import { COUNT_IN_CHOICES, resolveCountIn, planCountIn } from '../utils/countIn';
import { tempoMapStore, segmentAtTime } from '../utils/tempoMap';
import { ROLL_CHOICES_BARS, ROLL_CHOICES_SEC, rollBars } from '../utils/punch';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: MetronomeSettings;
  onChange: (patch: Partial<MetronomeSettings>) => void;
  /** Décompte actif (même interrupteur que l'outil voix). */
  countInEnabled: boolean;
  onCountInEnabled: (on: boolean) => void;
  punch?: PunchSettings;
  onUpdatePunch?: (patch: Partial<PunchSettings>) => void;
  bpm: number;
  /** Position où commencera la prise (tempo / mesure du décompte). */
  getRecordStart?: () => number;
}

const fmt = (v: number, d = 1) => v.toFixed(d).replace('.', ',');

/**
 * Fenêtre du métronome et du décompte (R2) : Pro Tools « Click/Countoff Options »,
 * Logic « Métronome », Ableton « Metronome Settings », FL « Metronome ».
 */
const MetronomeDialog: React.FC<Props> = ({ open, onClose, settings, onChange, countInEnabled, onCountInEnabled, punch, onUpdatePunch, bpm, getRecordStart }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;

  const ci = resolveCountIn(settings, countInEnabled);
  const unit = settings.countInUnit ?? 'bars';
  const at = getRecordStart?.() ?? 0;
  const seg = segmentAtTime(tempoMapStore.get(), at);
  const plan = planCountIn(tempoMapStore.get(), at, ci);
  const preOn = punch?.preRollOn ?? false;
  const preSec = typeof punch?.preRollSec === 'number' ? punch.preRollSec : null;
  const preBars = rollBars(punch, 'pre', bpm);
  const chip = (on: boolean) => `nova-hit min-h-10 px-3 rounded-lg border text-[12px] font-bold transition-colors ${on ? 'bg-cyan-500 text-black border-cyan-400' : 'border-nv-line/15 text-nv-ink hover:bg-nv-raised'}`;
  const sec = 'text-[10px] font-black text-nv-accent uppercase tracking-widest block border-b border-nv-line/15 pb-1';

  return (
    <div className="fixed inset-0 z-[1250] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="metro-title" data-testid="metronome-dialog" onMouseDown={e => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line/15 bg-nv-surface text-nv-ink shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-nv-line/15">
          <div>
            <h2 id="metro-title" className="text-[14px] font-black uppercase tracking-widest">Métronome et décompte</h2>
            <p className="text-[12px] text-nv-muted">Le clic suit la piste tempo : {seg.bpm} BPM, {seg.num}/{seg.den} à l'endroit de la prise.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="nova-hit w-9 h-9 rounded-full text-nv-muted hover:text-nv-ink flex items-center justify-center"><i className="fas fa-times" aria-hidden="true"></i></button>
        </div>

        <div className="p-5 space-y-6">
          {/* CLIC */}
          <section className="space-y-3">
            <span className={sec}>Clic</span>
            <label className="flex items-center justify-between gap-3 text-[13px] font-bold">
              <span>Clic activé <span className="font-normal text-nv-muted">(pavé 7, comme Pro Tools)</span></span>
              <input type="checkbox" checked={settings.enabled} onChange={e => onChange({ enabled: e.target.checked })} className="w-5 h-5" data-testid="metro-enabled" />
            </label>
            <div>
              <span className="text-[11px] font-bold text-nv-muted">Son</span>
              <div className="mt-1 grid grid-cols-3 sm:grid-cols-5 gap-1.5" role="radiogroup" aria-label="Son du clic">
                {METRONOME_SOUNDS.map(s => (
                  <button key={s.id} type="button" role="radio" aria-checked={settings.sound === s.id} title={`${s.hint}. Toucher pour l'entendre.`}
                    data-testid={`metro-sound-${s.id}`}
                    onClick={() => { onChange({ sound: s.id }); setTimeout(() => metronomeService.playPreviewClick(true), 30); }}
                    className={chip(settings.sound === s.id)}>{s.label}</button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="flex justify-between text-[11px] font-bold text-nv-muted"><span>Volume</span><span className="font-mono">{Math.round(settings.volume * 100)} %</span></span>
              <input type="range" min={0} max={1} step={0.01} value={settings.volume} onChange={e => onChange({ volume: Number(e.target.value) })} className="w-full h-8" aria-label="Volume du clic" />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-[12px] font-bold" title="Le premier temps de chaque mesure plus fort et plus aigu (Pro Tools : Accented ; Logic : Mesure / Temps)">
                <input type="checkbox" checked={settings.accentDownbeat} onChange={e => onChange({ accentDownbeat: e.target.checked })} className="w-5 h-5" />
                Accent sur le 1er temps
              </label>
              <label className="block" title="Écart de volume entre le 1er temps et les autres">
                <span className="text-[11px] font-bold text-nv-muted">Force de l'accent</span>
                <input type="range" min={0} max={1} step={0.05} value={settings.accentLevel ?? 0.6} disabled={!settings.accentDownbeat}
                  onChange={e => onChange({ accentLevel: Number(e.target.value) })} className="w-full h-8" aria-label="Force de l'accent" />
              </label>
            </div>
            <div>
              <span className="text-[11px] font-bold text-nv-muted">Quand</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Quand le clic sonne">
                <button type="button" role="radio" aria-checked={settings.mode !== 'record'} onClick={() => onChange({ mode: 'always' })} className={chip(settings.mode !== 'record')}
                  title="Le clic sonne à la lecture et pendant la prise (Logic : clic en lecture)">Lecture et prise</button>
                <button type="button" role="radio" aria-checked={settings.mode === 'record'} onClick={() => onChange({ mode: 'record' })} className={chip(settings.mode === 'record')}
                  data-testid="metro-mode-record" title="Le clic ne sonne que pendant l'enregistrement (Pro Tools : Only During Record)">Prise seulement</button>
              </div>
            </div>
            <div>
              <span className="text-[11px] font-bold text-nv-muted">Sortie</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Sortie du clic">
                <button type="button" role="radio" aria-checked={settings.output !== 'system'} onClick={() => onChange({ output: 'main' })} className={chip(settings.output !== 'system')}
                  title="Avec la musique : par la carte son de NOVA (ASIO compris), jamais dans le fichier exporté">Comme la musique</button>
                <button type="button" role="radio" aria-checked={settings.output === 'system'} onClick={() => onChange({ output: 'system' })} className={chip(settings.output === 'system')}
                  title="Par la sortie son de l'ordinateur (Pro Tools : sortie du clic séparée)">Sortie de l'ordinateur</button>
              </div>
            </div>
          </section>

          {/* DÉCOMPTE */}
          <section className="space-y-3">
            <span className={sec}>Décompte avant la prise</span>
            <label className="flex items-center justify-between gap-3 text-[13px] font-bold">
              <span>Décompte <span className="font-normal text-nv-muted">(Pro Tools : Count Off)</span></span>
              <input type="checkbox" checked={countInEnabled} onChange={e => onCountInEnabled(e.target.checked)} className="w-5 h-5" data-testid="metro-countin-on" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-[11px] font-bold text-nv-muted">Longueur</span>
                <div className="mt-1 grid grid-cols-4 gap-1" role="radiogroup" aria-label="Longueur du décompte">
                  {COUNT_IN_CHOICES.map(n => (
                    <button key={n} type="button" role="radio" aria-checked={ci.count === n} disabled={!countInEnabled} data-testid={`metro-countin-${n}`}
                      onClick={() => onChange({ countIn: n, countInUnit: unit })} className={chip(countInEnabled && ci.count === n)}>{n}</button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-[11px] font-bold text-nv-muted">En</span>
                <div className="mt-1 grid grid-cols-2 gap-1" role="radiogroup" aria-label="Unité du décompte">
                  <button type="button" role="radio" aria-checked={unit === 'bars'} disabled={!countInEnabled} onClick={() => onChange({ countInUnit: 'bars', countIn: ci.count })} className={chip(countInEnabled && unit === 'bars')}>Mesures</button>
                  <button type="button" role="radio" aria-checked={unit === 'beats'} disabled={!countInEnabled} data-testid="metro-countin-beats" onClick={() => onChange({ countInUnit: 'beats', countIn: ci.count })} className={chip(countInEnabled && unit === 'beats')}>Temps</button>
                </div>
              </div>
            </div>
            <p className="text-[12px] text-nv-muted" data-testid="metro-countin-summary">
              {ci.count === 0 ? 'Pas de décompte : la prise part tout de suite.'
                : `${plan.clicks.length} clic${plan.clicks.length > 1 ? 's' : ''} à ${seg.bpm} BPM (${seg.num}/${seg.den}), soit ${fmt(plan.duration)} s avant la prise.`}
            </p>
          </section>

          {/* PRÉ-ROLL */}
          {onUpdatePunch && (
            <section className="space-y-2">
              <span className={sec}>Pré-roll</span>
              <p className="text-[12px] text-nv-muted">La lecture repart un peu avant l'endroit de la prise pour te caler ; seul ce qui suit est gardé (Pro Tools : Pre-Roll).</p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => onUpdatePunch({ preRollOn: false })} className={chip(!preOn)}>Aucun</button>
                {ROLL_CHOICES_BARS.filter(b => b > 0).map(b => (
                  <button key={`b${b}`} type="button" onClick={() => onUpdatePunch({ preRollOn: true, preRollBars: b, preRollSec: undefined })} className={chip(preOn && preSec === null && preBars === b)}>{b === 0.5 ? '½' : b} mes.</button>
                ))}
                {ROLL_CHOICES_SEC.map(s => (
                  <button key={`s${s}`} type="button" onClick={() => onUpdatePunch({ preRollOn: true, preRollSec: s })} className={chip(preOn && preSec === s)}>{s} s</button>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="p-5 pt-0">
          <button type="button" onClick={() => metronomeService.playPreviewClick(true)} className="w-full min-h-11 rounded-xl border border-nv-line/15 text-[13px] font-bold hover:bg-nv-raised">
            <i className="fas fa-volume-up mr-2" aria-hidden="true"></i>Écouter le clic
          </button>
        </div>
      </div>
    </div>
  );
};

export default MetronomeDialog;
