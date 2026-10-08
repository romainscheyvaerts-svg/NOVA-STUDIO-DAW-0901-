import React from 'react';
import { requestSampler } from '../utils/samplerPanelStore';
import { TrackType, PluginType } from '../types';
import { findVocalMixStyle } from '../utils/vocalPresets';
import { dockItem } from '../utils/dockFit';

interface TrackCreationBarProps {
  onCreateTrack: (type: TrackType, name?: string, initialPluginType?: PluginType) => void;
  /** « + Piste voix » : piste insérée sous la sélection, sélectionnée, armée et montrée. */
  onAddVoiceTrack?: () => void;
  /** Ouvre le panneau « Mix auto » (styles de mix, outils voix). */
  onOpenVocalTools?: () => void;
  currentStyleId?: string;
  /** Ouvre / ferme le prompteur de paroles. */
  onOpenLyrics?: () => void;
  lyricsOpen?: boolean;
  /**
   * Mode instru (mélodie du studio) ou rôle beatmaker : outils de composition
   * (piste MIDI + piano roll, batterie). Jamais en mode voix, pour ne pas
   * embrouiller l'artiste qui essaie une instru.
   */
  beatmaking?: boolean;
  onNewMidiTrack?: () => void;
  onOpenDrums?: () => void;
  /** Crée / ouvre la piste 808 (piano roll). */
  onOpen808?: () => void;
  /**
   * Ordinateur / tablette : la barre est posée dans le bandeau du bas du
   * studio (sous la grille) au lieu de flotter au milieu des clips.
   */
  docked?: boolean;
}

/**
 * Le DAW sert à essayer sa voix sur les instrus du studio : on n'y compose
 * pas. La barre flottante propose donc les deux gestes utiles : ajouter une
 * piste voix et choisir un style de mix.
 */
const TrackCreationBar: React.FC<TrackCreationBarProps> = ({ onCreateTrack, onAddVoiceTrack, onOpenVocalTools, currentStyleId, onOpenLyrics, lyricsOpen, beatmaking, onNewMidiTrack, onOpenDrums, onOpen808, docked }) => {
  const style = findVocalMixStyle(currentStyleId);
  return (
    <div data-dock-scroll={docked ? '' : undefined} className={docked
      ? 'flex items-center gap-2 max-w-full overflow-x-auto scrollbar-hide' 
      : 'fixed bottom-20 left-1/2 -translate-x-1/2 z-[150] flex items-center gap-1 sm:gap-2 max-w-[calc(100vw-1rem)] overflow-x-auto scrollbar-hide'}>
      <button
        type="button"
        onClick={() => (onAddVoiceTrack ? onAddVoiceTrack() : onCreateTrack(TrackType.AUDIO, 'VOIX'))}
        aria-label="Ajouter une piste voix"
        {...(docked ? dockItem(6) : {})}
        title="Ajouter une piste voix sous la piste sélectionnée : elle est armée, ta prochaine prise part dessus"
        className="shrink-0 h-12 pl-3 pr-4 sm:pl-4 sm:pr-5 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 bg-nv-raised border border-white/20 text-white/80 hover:text-white hover:border-cyan-500/50 whitespace-nowrap"
      >
        <i className="fas fa-plus text-sm"></i>
        <i className="fas fa-microphone text-sm text-cyan-400"></i>
        <span data-dock-label className="text-xs font-bold">Piste voix</span>
      </button>
      {beatmaking && onOpenDrums && (
        <button type="button" onClick={onOpenDrums} aria-label="Batterie" {...(docked ? dockItem(4) : {})} title="Boîte à rythmes : pas, sons, mix de chaque pad"
          className="shrink-0 h-12 px-3 sm:px-4 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap border bg-nv-raised border-orange-400/40 text-orange-200 hover:text-white">
          <span className="text-base leading-none">🥁</span><span data-dock-label className="text-xs font-bold">Batterie</span>
        </button>
      )}
      {beatmaking && onOpen808 && (
        <button type="button" onClick={onOpen808} aria-label="Basse 808" {...(docked ? dockItem(4) : {})} title="Basse 808 : joue-la au piano roll, accordée sur la tonalité, avec glissés"
          className="shrink-0 h-12 px-3 sm:px-4 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap border bg-nv-raised border-fuchsia-400/40 text-fuchsia-200 hover:text-white">
          <span className="text-base leading-none">🔊</span><span data-dock-label className="text-xs font-bold">808</span>
        </button>
      )}
      {beatmaking && (
        <button type="button" onClick={() => requestSampler({ kind: 'new' })} data-testid="new-sampler-track" {...(docked ? dockItem(3) : {})}
          title="Nouvelle piste Sampler : ton son (fichier, micro, clip) ou un instrument NOVA (piano, Rhodes, guitare, cordes, cloches, nappe) sur tout le clavier — comme le Sampler de FL, Simpler de Live ou Quick Sampler de Logic"
          aria-label="Nouvelle piste Sampler"
          className="shrink-0 h-12 min-w-[48px] px-3 xl:px-4 rounded-full shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95 whitespace-nowrap border bg-nv-raised border-amber-400/40 text-amber-200 hover:text-white">
          <span className="text-base leading-none">🎛️</span><span data-dock-label className={docked ? 'text-xs font-bold' : 'hidden xl:inline text-xs font-bold'}>Sampler</span>
        </button>
      )}
      {beatmaking && onNewMidiTrack && (
        <button type="button" onClick={onNewMidiTrack} aria-label="Nouvelle piste MIDI" {...(docked ? dockItem(4) : {})} title="Nouvelle piste MIDI (synthé, basse…) et son piano roll"
          className="shrink-0 h-12 px-3 sm:px-4 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap border bg-nv-raised border-violet-400/40 text-violet-200 hover:text-white">
          <span className="text-base leading-none">🎹</span><span data-dock-label className="text-xs font-bold"><span className={docked ? '' : 'hidden xl:inline'}>Piste </span>MIDI</span>
        </button>
      )}
      {onOpenLyrics && (
        <button
          type="button"
          onClick={onOpenLyrics}
          aria-pressed={!!lyricsOpen}
          data-nova-target="lyrics"
          aria-label="Paroles"
          {...(docked ? dockItem(5) : {})}
          title="Tes paroles en prompteur qui défile pendant la prise"
          className={`shrink-0 h-12 px-3 sm:px-4 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap border ${lyricsOpen ? 'bg-white text-black border-white' : 'bg-nv-raised border-white/20 text-white/80 hover:text-white'}`}
        >
          <span className="text-base leading-none">📝</span>
          <span data-dock-label className="text-xs font-bold">Paroles</span>
        </button>
      )}
      {onOpenVocalTools && (
        <button
          type="button"
          onClick={onOpenVocalTools}
          data-nova-target="mix-auto"
          aria-label={style ? `Mix auto : ${style.name}` : 'Mix auto'}
          {...(docked ? dockItem(7) : {})}
          title="Choisir un style de mix pour ta voix"
          className="shrink-0 h-12 pl-3 pr-4 sm:pl-4 sm:pr-5 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 bg-cyan-500 text-black hover:bg-cyan-400 whitespace-nowrap"
        >
          <span className="text-base leading-none">{style ? style.emoji : '🎚️'}</span>
          <span data-dock-label className="text-xs font-black">{style ? style.name : 'Mix auto'}</span>
        </button>
      )}
    </div>
  );
};

export default TrackCreationBar;
