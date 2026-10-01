import React from 'react';
import { VOCAL_MIX_STYLES } from '../utils/vocalPresets';

interface VocalToolsPanelProps {
  open: boolean;
  onClose: () => void;
  currentStyleId?: string;
  onApplyStyle: (styleId: string) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  canClean: boolean;
  onCleanSilences: () => void;
  autoClean: boolean;
  onAutoCleanChange: (on: boolean) => void;
  countIn: boolean;
  onCountInChange: (on: boolean) => void;
  monitoring: boolean;
  onMonitoringChange: (on: boolean) => void;
  onAskNova: () => void;
}

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }> = ({ checked, onChange, label, hint }) => (
  <div className="flex items-start gap-3 py-2.5 cursor-pointer select-none">
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`mt-0.5 relative shrink-0 w-11 h-6 rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-white/15'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
    <span className="min-w-0" onClick={() => onChange(!checked)}>
      <span className="block text-[13px] font-semibold text-white">{label}</span>
      {hint && <span className="block text-[11px] text-slate-400 mt-0.5">{hint}</span>}
    </span>
  </div>
);

/**
 * « Mix auto » : l'artiste choisit un style, l'entend tout de suite (bouton
 * Écouter dans le panneau) et peut en essayer un autre. Regroupe aussi les
 * outils d'enregistrement : nettoyage des blancs, décompte, retour casque.
 */
const VocalToolsPanel: React.FC<VocalToolsPanelProps> = (p) => {
  if (!p.open) return null;
  return (
    <div
      className="fixed inset-0 z-[550] flex items-end sm:items-center justify-center bg-black/50"
      onClick={p.onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="vocal-tools-title"
    >
      <div
        className="w-full sm:max-w-2xl max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#121418] border border-white/10 shadow-2xl pb-[env(safe-area-inset-bottom)]"
        onClick={e => e.stopPropagation()}
      >
        {/* En-tête */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3 border-b border-white/5">
          <div className="min-w-0 flex-1">
            <h2 id="vocal-tools-title" className="text-[17px] font-black text-white">🎚️ Mix auto de ta voix</h2>
            <p className="text-[12px] text-slate-400 mt-0.5">Choisis un style : effets, réverb et volume du beat se règlent tout seuls.</p>
          </div>
          <button
            type="button"
            onClick={p.onTogglePlay}
            className={`h-11 px-4 rounded-xl font-bold text-[12px] flex items-center gap-2 shrink-0 ${p.isPlaying ? 'bg-white text-black' : 'bg-cyan-500 text-black'}`}
            aria-label={p.isPlaying ? 'Pause' : 'Écouter'}
          >
            <i className={`fas ${p.isPlaying ? 'fa-pause' : 'fa-play'}`} />
            <span className="hidden sm:inline">{p.isPlaying ? 'Pause' : 'Écouter'}</span>
          </button>
          <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-11 h-11 rounded-xl bg-white/5 text-slate-300 hover:text-white shrink-0">
            <i className="fas fa-times" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {/* Styles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {VOCAL_MIX_STYLES.map(s => {
              const active = p.currentStyleId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => p.onApplyStyle(s.id)}
                  aria-pressed={active}
                  className={`text-left rounded-2xl p-3 border transition-all active:scale-[0.98] flex gap-3 ${active ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'}`}
                >
                  <span className="text-2xl leading-none mt-0.5">{s.emoji}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-[14px] font-bold text-white">{s.name}</span>
                      {active && <span className="text-[10px] font-black text-cyan-300 uppercase">✓ actif</span>}
                    </span>
                    <span className="block text-[11.5px] leading-snug text-slate-400 mt-0.5">{s.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500">
            Lance la lecture et change de style pour comparer. <b className="text-slate-300">Annuler</b> (Ctrl+Z) revient au réglage précédent.
          </p>

          <button
            type="button"
            onClick={p.onAskNova}
            className="w-full h-11 rounded-xl border border-cyan-500/40 text-cyan-300 font-bold text-[13px] hover:bg-cyan-500/10"
          >
            <i className="fas fa-wand-magic-sparkles mr-2" />Je ne sais pas lequel choisir : demander à Nova
          </button>

          {/* Outils */}
          <div className="border-t border-white/5 pt-4">
            <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-400 mb-2">Outils voix</h3>
            <button
              type="button"
              onClick={p.onCleanSilences}
              disabled={!p.canClean}
              className="w-full h-11 rounded-xl bg-white/5 text-white font-bold text-[13px] disabled:opacity-40 hover:bg-white/10"
            >
              🧹 Retirer les blancs de ma voix
            </button>
            {!p.canClean && <p className="text-[11px] text-slate-500 mt-1">Enregistre d'abord une prise.</p>}
            <div className="mt-2 divide-y divide-white/5">
              <Toggle
                checked={p.autoClean}
                onChange={p.onAutoCleanChange}
                label="Retirer les blancs automatiquement"
                hint="Après chaque prise, les passages sans voix sont enlevés (souffle, bruits de la pièce)."
              />
              <Toggle
                checked={p.countIn}
                onChange={p.onCountInChange}
                label="Décompte 4 temps avant d'enregistrer"
                hint="Le temps de te placer devant le micro."
              />
              <Toggle
                checked={p.monitoring}
                onChange={p.onMonitoringChange}
                label="M'entendre dans le casque"
                hint="Seulement avec un casque : sur haut-parleurs, le son siffle (larsen)."
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VocalToolsPanel;
