import React from 'react';
import type { PunchSettings, ViewType } from '../types';
import ToolbarMenu, { MenuSection, menuRowClass, MenuSwitch } from './ToolbarMenu';
import PunchControls from './PunchControls';
import PracticeSpeed from './PracticeSpeed';
import { MonitorPanel } from './MonitorSection';
import ThemeSwitch from './ThemeSwitch';
import { barItem } from '../utils/barFit';
import { isMonitorNeutral, useMonitor } from '../utils/monitorSection';
import { practiceLabel, usePracticeSpeed } from '../utils/practiceSpeed';
import { useChordLaneShown } from './ChordLane';
import { chordLaneStore } from '../utils/chordTrack';
import { PanLawPicker } from './DualPan';

/**
 * Barre du haut, mode avancé, allégée (22/10/2026, « trop de boutons ») :
 *  - « Options ▾ » : punch (pré / post-roll, QuickPunch, crossfade), clic et décompte,
 *    vitesse de lecture, section d'écoute (mono, Dim, volume, solo AFL / PFL), voix et flow,
 *    loi de pan du projet (−3 / −4,5 / −6 / 0 dB).
 *    Un réglage actif reste signalé : PUNCH / QP et la vitesse ralentie restent dans la barre,
 *    les pastilles d'écoute aussi (MonitorBadges), et une pastille s'allume sur « Options ».
 *  - « Vue ▾ » : Pistes / Console / Automation (la vue en cours est écrite sur le bouton),
 *    navigateur, piste d'accords, thème, mode d'affichage.
 * Contenus montés seulement à l'ouverture.
 */

interface OptionsProps {
  punch?: PunchSettings;
  bpm: number;
  isPunchActive: boolean;
  onTogglePunch?: () => void;
  onUpdatePunch?: (patch: Partial<PunchSettings>) => void;
  onToggleQuickPunch?: () => void;
  onOpenMetronome?: () => void;
  onOpenWarmup?: () => void;
}

export const TransportOptionsMenu: React.FC<OptionsProps> = ({ punch, bpm, isPunchActive, onTogglePunch, onUpdatePunch, onToggleQuickPunch, onOpenMetronome, onOpenWarmup }) => {
  const monitor = useMonitor();
  const speed = usePracticeSpeed();
  const monitorOn = !isMonitorNeutral(monitor) || monitor.listen !== 'sip';
  const slow = speed < 0.999;
  const lit = [isPunchActive && 'punch', punch?.quickPunch && 'QuickPunch', slow && `lecture à ${practiceLabel(speed)}`, monitorOn && 'écoute modifiée'].filter(Boolean) as string[];
  return (
    <ToolbarMenu testId="transport-options" menuLabel="Options de lecture et d'enregistrement" width={330}
      ariaLabel="Options de lecture et d'enregistrement"
      title={`Options : punch et pré-roll, clic et décompte, vitesse de lecture, écoute (mono, Dim, AFL / PFL), voix et flow, loi de pan${lit.length ? `\nActif : ${lit.join(', ')}` : ''}`}
      triggerProps={barItem('options', 34)}
      triggerClassName={`nova-hit-tactile relative hidden md:flex h-8 px-2 rounded-lg items-center gap-1 border text-[10px] font-bold tracking-wide transition-all ${lit.length ? 'border-amber-400/50 text-amber-200 [[data-theme=light]_&]:text-amber-700' : 'border-white/10 text-slate-400 hover:text-white hover:bg-white/10'}`}
      triggerStyle={{ backgroundColor: 'var(--bg-item)' }}
      label={<>
        <i className="fas fa-sliders-h text-[10px]" aria-hidden="true" />
        <span className="hidden xl:inline">Options</span>
        <i className="fas fa-chevron-down text-[8px] opacity-70" aria-hidden="true" />
        {lit.length > 0 && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-black/60" data-testid="transport-options-lit" aria-hidden="true" />}
      </>}>
      {(close) => (<>
        {onTogglePunch && (
          <MenuSection title="Punch (remplacer un passage)" first>
            <PunchControls inline punch={punch} bpm={bpm} isPunchActive={isPunchActive} onTogglePunch={onTogglePunch}
              onUpdatePunch={onUpdatePunch} onToggleQuickPunch={onToggleQuickPunch} />
          </MenuSection>
        )}
        <MenuSection title="Prise" first={!onTogglePunch}>
          {onOpenMetronome && (
            <button type="button" data-testid="open-metronome" aria-label="Réglages du métronome et du décompte"
              title="Clic et décompte : son, volume, accent, prise seulement, sortie, décompte en mesures ou en temps, pré-roll (Click/Countoff Options). Aussi : clic droit sur le métronome."
              onClick={() => { close(); onOpenMetronome(); }} className={menuRowClass(false)}>
              <i className="fas fa-drum w-5 text-center text-[11px]" aria-hidden="true" /><span>Clic et décompte…</span>
            </button>
          )}
          {onOpenWarmup && (
            <button type="button" data-testid="open-warmup" aria-label="Voix et flow : échauffement et accordeur"
              title="Voix et flow : échauffement de la voix et du flow (80 → 140 BPM), accordeur, progrès"
              onClick={() => { close(); onOpenWarmup(); }} className={menuRowClass(false)}>
              <i className="fas fa-microphone-alt w-5 text-center text-[11px]" aria-hidden="true" /><span>Voix et flow (échauffement, accordeur)…</span>
            </button>
          )}
        </MenuSection>
        <MenuSection title="Vitesse de lecture">
          <PracticeSpeed inline className="px-1" />
        </MenuSection>
        <MenuSection title="Écoute (hors export)">
          <div className="px-1"><MonitorPanel onClose={close} /></div>
        </MenuSection>
        {/* Loi de pan du projet (22/10/2026) : sauvegardée avec le projet, même loi partout. */}
        <MenuSection title="Mixage : loi de pan du projet">
          <PanLawPicker />
        </MenuSection>
      </>)}
    </ToolbarMenu>
  );
};

const VIEWS: { id: ViewType; label: string; icon: string; key: string }[] = [
  { id: 'ARRANGEMENT', label: 'Pistes', icon: 'fa-grip-horizontal', key: '' },
  { id: 'MIXER', label: 'Console', icon: 'fa-sliders-h', key: 'Ctrl+=' },
  { id: 'AUTOMATION', label: 'Auto', icon: 'fa-project-diagram', key: '' },
];

interface ViewProps {
  currentView: ViewType;
  onChangeView: (v: ViewType) => void;
  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** Mode d'affichage PC / tablette / téléphone (passé par l'appli). */
  displayMode?: React.ReactNode;
}

export const ViewMenu: React.FC<ViewProps> = ({ currentView, onChangeView, isSidebarOpen, onToggleSidebar, displayMode }) => {
  const chords = useChordLaneShown();
  // Pistes / Console : la vue de chaque instant reste en deux boutons (Ctrl+= bascule) ; « Auto » n'apparaît
  // dans la barre que quand elle est affichée. Le reste (automation, navigateur, accords, thème, affichage) : « ▾ ».
  const seg = (on: boolean) => `px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${on ? 'text-black' : 'text-slate-500 hover:text-white'}`;
  const segStyle = (on: boolean): React.CSSProperties => ({ backgroundColor: on ? 'var(--accent-neon)' : 'transparent', color: on ? '#000' : 'var(--text-secondary)' });
  const shown = VIEWS.filter(v => v.id !== 'AUTOMATION' || currentView === 'AUTOMATION');
  return (
    <div {...barItem('vues', 26)} className="hidden md:flex items-center gap-0.5 rounded-xl p-1" style={{ backgroundColor: 'var(--bg-item)' }}>
      {shown.map(v => (
        <button key={v.id} type="button" onClick={() => onChangeView(v.id)} aria-pressed={currentView === v.id}
          title={v.key ? `${v.label} (${v.key})` : v.label} className={seg(currentView === v.id)} style={segStyle(currentView === v.id)}>{v.label}</button>
      ))}
    <ToolbarMenu testId="view-menu" menuLabel="Vue" width={300} alignRight
      ariaLabel="Vue : automation, navigateur, piste d'accords, thème, affichage"
      title="Vue : automation, navigateur, piste d'accords, thème, mode d'affichage"
      triggerClassName="h-7 w-6 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10"
      label={<i className="fas fa-chevron-down text-[9px]" aria-hidden="true" />}>
      {(close) => (<>
        <MenuSection title="Vue" first>
          <button type="button" onClick={() => { onChangeView(currentView === 'AUTOMATION' ? 'ARRANGEMENT' : 'AUTOMATION'); close(); }} aria-pressed={currentView === 'AUTOMATION'}
            title="Éditeur d'automation (toutes les courbes)" className={menuRowClass(currentView === 'AUTOMATION')}>
            <i className="fas fa-project-diagram w-5 text-center text-[11px]" aria-hidden="true" /><span>Automation</span><MenuSwitch on={currentView === 'AUTOMATION'} />
          </button>
        </MenuSection>
        <MenuSection title="Afficher">
          {onToggleSidebar && (
            <button type="button" role="menuitemcheckbox" aria-checked={!!isSidebarOpen} aria-pressed={!!isSidebarOpen}
              aria-label={isSidebarOpen ? 'Masquer le navigateur' : 'Afficher le navigateur'} title="Navigateur : beats, sons, effets, VST"
              onClick={() => { onToggleSidebar(); close(); }} className={menuRowClass(!!isSidebarOpen)}>
              <i className="fas fa-columns w-5 text-center text-[11px]" aria-hidden="true" /><span>Navigateur (beats, sons, effets)</span><MenuSwitch on={!!isSidebarOpen} />
            </button>
          )}
          <button type="button" role="menuitemcheckbox" aria-checked={chords} aria-pressed={chords} data-testid="chord-lane-toggle"
            title={`${chords ? 'Masquer' : 'Afficher'} la piste d’accords, sous la règle de l’arrangement`}
            onClick={() => chordLaneStore.set(!chords)} className={menuRowClass(chords)}>
            <i className="fas fa-guitar w-5 text-center text-[11px]" aria-hidden="true" /><span>Piste d’accords</span><MenuSwitch on={chords} />
          </button>
        </MenuSection>
        <div className="mt-2 border-t border-white/5 pt-2"><ThemeSwitch /></div>
        {displayMode && (
          <MenuSection title="Mode d'affichage">
            <div className="group vm-labeled [&>div]:ml-0 [&>div]:border-0 [&>div]:pl-0">{displayMode}</div>
          </MenuSection>
        )}
      </>)}
    </ToolbarMenu>
    </div>
  );
};
