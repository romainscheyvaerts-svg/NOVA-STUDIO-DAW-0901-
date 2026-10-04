import React from 'react';
import { MobileTab } from '../types';
import { useSimpleMode } from '../utils/simpleMode';

interface MobileBottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  /** Point sur l'onglet Nova : un message t'attend (bilan de prise, conseil). */
  novaBadge?: boolean;
  /** Mode simple : « Paroles » ouvre le prompteur (pas un onglet). */
  onToggleLyrics?: () => void;
  lyricsOpen?: boolean;
}

/**
 * Barre de navigation mobile en bas d'écran
 * Inspiré de Logic Pro iPad
 */
const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ activeTab, onTabChange, novaBadge, onToggleLyrics, lyricsOpen }) => {
  const { simple } = useSimpleMode();
  // Mode simple : ce qui sert à poser sa voix. Pistes, Mixer et FX en mode avancé.
  const simpleTabs: { id: MobileTab | 'LYRICS'; icon: string; label: string }[] = [
    { id: 'ARRANGEMENT', icon: 'fa-wave-square', label: 'Morceau' },
    { id: 'BROWSER', icon: 'fa-music', label: 'Sons' },
    { id: 'LYRICS', icon: 'fa-align-left', label: 'Paroles' },
    { id: 'NOVA', icon: 'fa-wand-magic-sparkles', label: 'Nova' },
  ];
  const fullTabs: { id: MobileTab | 'LYRICS'; icon: string; label: string }[] = [
    { id: 'ARRANGEMENT', icon: 'fa-wave-square', label: 'Morceau' },
    { id: 'TRACKS', icon: 'fa-bars-staggered', label: 'Pistes' },
    { id: 'MIXER', icon: 'fa-sliders', label: 'Mixer' },
    { id: 'PLUGINS', icon: 'fa-plug', label: 'FX' },
    { id: 'BROWSER', icon: 'fa-folder-open', label: 'Sons' },
    { id: 'NOVA', icon: 'fa-wand-magic-sparkles', label: 'Nova' },
  ];
  const tabs = simple ? simpleTabs : fullTabs;
  // Paroles ouvertes : c'est la feuille qui est au premier plan, pas l'onglet dessous.
  const isActive = (id: MobileTab | 'LYRICS') => id === 'LYRICS' ? !!lyricsOpen : activeTab === id && !(lyricsOpen && tabs.some(t => t.id === 'LYRICS'));

  return (
    <div role="navigation" aria-label="Onglets du studio" className="fixed bottom-0 left-0 right-0 z-[100] bg-[#08090b]/[0.98] backdrop-blur-xl border-t border-white/10 safe-area-inset-bottom">
      <div className="flex items-center justify-around h-16 px-2">
        {tabs.map(tab => (
          <button
            key={tab.id}
            // Un autre onglet ferme la feuille « Mes paroles » : elle restait par-dessus Sons / Nova.
            onClick={() => { if (tab.id === 'LYRICS') onToggleLyrics?.(); else { if (lyricsOpen) onToggleLyrics?.(); onTabChange(tab.id); } }}
            aria-pressed={tab.id === 'LYRICS' ? !!lyricsOpen : undefined}
            aria-current={tab.id !== 'LYRICS' && activeTab === tab.id ? 'page' : undefined}
            className={`flex flex-col items-center justify-center flex-1 h-full transition-all relative ${
              isActive(tab.id)
                ? 'text-cyan-400'
                : 'text-slate-400 hover:text-slate-300 active:text-slate-200'
            }`}
          >
            <i className={`fas ${tab.icon} text-xl mb-1 transition-transform ${
              isActive(tab.id) ? 'scale-110' : 'scale-100'
            }`}></i>
            <span className={`text-[11px] font-semibold tracking-wide transition-all ${
              isActive(tab.id) ? 'opacity-100' : 'opacity-70'
            }`}>
              {tab.label}
            </span>
            {isActive(tab.id) && (
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-1 bg-cyan-400 rounded-full"></div>
            )}
            {tab.id === 'NOVA' && novaBadge && activeTab !== 'NOVA' && (
              <span className="absolute top-2 right-[calc(50%-18px)] w-2.5 h-2.5 rounded-full bg-red-500 ring-2 ring-[#0c0d10]" aria-label="Nouveau message de Nova" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileBottomNav;
