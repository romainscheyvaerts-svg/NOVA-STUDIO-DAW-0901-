import React from 'react';
import { themeStore, useTheme, ThemePref } from '../utils/themeStore';

const OPTIONS: { id: ThemePref; label: string; icon: string; hint: string }[] = [
  { id: 'dark', label: 'Sombre', icon: 'fa-moon', hint: 'Thème sombre' },
  { id: 'light', label: 'Clair', icon: 'fa-sun', hint: 'Thème clair (fond blanc)' },
  { id: 'system', label: 'Auto', icon: 'fa-circle-half-stroke', hint: "Automatique : suit le réglage de l'appareil" },
];

/**
 * Choix du thème en trois boutons (Sombre / Clair / Auto), en haut du menu ☰
 * sur PC, tablette et téléphone. Le choix est mémorisé sur l'appareil.
 */
const ThemeSwitch: React.FC = () => {
  const { pref, theme } = useTheme();
  return (
    <div className="space-y-1.5" data-nova-theme-switch="">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold text-slate-400">Thème</span>
        {pref === 'system' && <span className="text-[11px] text-slate-500">actuellement {theme === 'light' ? 'clair' : 'sombre'}</span>}
      </div>
      <div role="radiogroup" aria-label="Thème de l'interface" className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-white/[0.05]">
        {OPTIONS.map((o) => {
          const on = pref === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={o.hint}
              onClick={() => themeStore.setPref(o.id)}
              className={`min-h-11 rounded-lg flex items-center justify-center gap-2 text-[13px] font-semibold transition-colors duration-150 ${on ? 'bg-nv-raised text-nv-ink shadow-sm ring-1 ring-nv-accent/50' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
            >
              <i className={`fas ${o.icon} text-[12px] ${on ? 'text-nv-accent-ink' : ''}`} aria-hidden="true"></i>
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ThemeSwitch;

/** Bouton rond soleil / lune (accueil, barre large) : bascule clair ⇄ sombre. */
export const ThemeToggleButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { theme } = useTheme();
  const toLight = theme === 'dark';
  return (
    <button
      type="button"
      onClick={() => themeStore.toggle()}
      title={toLight ? 'Passer au thème clair' : 'Passer au thème sombre'}
      aria-label={toLight ? 'Passer au thème clair' : 'Passer au thème sombre'}
      className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-white/[0.06] hover:bg-white/10 text-slate-300 hover:text-white transition-colors duration-150 ${className}`}
    >
      <i className={`fas ${toLight ? 'fa-sun' : 'fa-moon'} text-[14px]`} aria-hidden="true"></i>
    </button>
  );
};
