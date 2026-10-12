import React from 'react';
import { PROJECT_RATES, ProjectRate, RATE_HINT, rateChangeMessage, rateLabel } from '../utils/projectRate';

/**
 * Fréquence d'échantillonnage du projet (utils/projectRate) : le choix (création
 * d'un projet, d'un projet depuis un modèle, réglages de la session) et
 * l'avertissement avant de convertir un projet existant.
 */

export const ProjectRatePicker: React.FC<{
  value: ProjectRate;
  onChange: (r: ProjectRate) => void;
  disabled?: boolean;
  /** Libellé visible (sinon seulement pour les lecteurs d'écran). */
  label?: string;
  className?: string;
  testId?: string;
  /** Fond sombre (accueil, modèles) ou thème du studio. */
  tone?: 'dark' | 'studio';
}> = ({ value, onChange, disabled, label, className = '', testId = 'project-rate', tone = 'studio' }) => (
  <label className={`flex items-center gap-2 ${className}`} onClick={e => e.stopPropagation()}>
    {label ? <span className={tone === 'dark' ? 'text-[11px] font-bold text-slate-300' : 'text-[11px] font-bold text-nv-muted'}>{label}</span>
      : <span className="sr-only">Fréquence d'échantillonnage du projet</span>}
    <select value={value} disabled={disabled} data-testid={testId}
      onChange={e => onChange(Number(e.target.value) as ProjectRate)}
      title={RATE_HINT[value]}
      className={tone === 'dark'
        ? 'h-9 rounded-lg border border-white/10 bg-black/40 px-2 text-[12px] font-bold text-white'
        : 'h-9 rounded-lg border border-nv-line bg-nv-bg px-2 text-[12px] font-bold text-nv-ink'}>
      {PROJECT_RATES.map(r => <option key={r} value={r}>{rateLabel(r)}{r === 48000 ? ' (recommandé)' : ''}</option>)}
    </select>
  </label>
);

/** Avertissement avant de changer la fréquence d'un projet existant : convertir les clips, ou annuler. */
export const ProjectRateConfirm: React.FC<{
  from: ProjectRate; to: ProjectRate; buffers: number; seconds: number;
  onConfirm: () => void; onCancel: () => void;
}> = ({ from, to, buffers, seconds, onConfirm, onCancel }) => {
  React.useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="rate-confirm-title" data-testid="rate-confirm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-nv-surface p-5 shadow-2xl">
        <h3 id="rate-confirm-title" className="text-[16px] font-black text-nv-ink">Changer la fréquence du projet ?</h3>
        <p className="mt-1 text-[12px] font-bold text-amber-300">{rateLabel(from)} → {rateLabel(to)}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-nv-muted">{rateChangeMessage({ from, to, buffers, seconds })}</p>
        <p className="mt-2 text-[11px] text-nv-muted">{RATE_HINT[to]}.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" autoFocus onClick={onConfirm} data-testid="rate-confirm-ok"
            className="nova-hit-tactile h-10 rounded-lg bg-nv-accent px-3 text-[12px] font-black text-black">
            {buffers ? `Rééchantillonner les clips et passer en ${rateLabel(to)}` : `Passer en ${rateLabel(to)}`}
          </button>
          <button type="button" onClick={onCancel} data-testid="rate-confirm-cancel"
            className="nova-hit-tactile h-10 rounded-lg border border-nv-line px-3 text-[12px] font-bold text-nv-ink hover:bg-white/5">
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
};

/** Demande de changement (réglages de session) : App ouvre l'avertissement. */
export const requestProjectRate = (rate: ProjectRate) => {
  try { window.dispatchEvent(new CustomEvent('nova:request-samplerate', { detail: { rate } })); } catch { /* hors navigateur */ }
};
