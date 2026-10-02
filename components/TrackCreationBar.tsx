import React from 'react';
import { TrackType, PluginType } from '../types';
import { findVocalMixStyle } from '../utils/vocalPresets';

interface TrackCreationBarProps {
  onCreateTrack: (type: TrackType, name?: string, initialPluginType?: PluginType) => void;
  /** Ouvre le panneau « Mix auto » (styles de mix, outils voix). */
  onOpenVocalTools?: () => void;
  currentStyleId?: string;
  /** Ouvre / ferme le prompteur de paroles. */
  onOpenLyrics?: () => void;
  lyricsOpen?: boolean;
}

/**
 * Le DAW sert à essayer sa voix sur les instrus du studio : on n'y compose
 * pas. La barre flottante propose donc les deux gestes utiles : ajouter une
 * piste voix et choisir un style de mix.
 */
const TrackCreationBar: React.FC<TrackCreationBarProps> = ({ onCreateTrack, onOpenVocalTools, currentStyleId, onOpenLyrics, lyricsOpen }) => {
  const style = findVocalMixStyle(currentStyleId);
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[150] flex items-center gap-1 sm:gap-2 max-w-[calc(100vw-1rem)] overflow-x-auto scrollbar-hide">
      <button
        type="button"
        onClick={() => onCreateTrack(TrackType.AUDIO, 'VOIX')}
        aria-label="Ajouter une piste voix"
        title="Ajouter une piste voix"
        className="shrink-0 h-12 pl-3 pr-4 sm:pl-4 sm:pr-5 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 bg-[#1a1c21] border border-white/20 text-white/80 hover:text-white hover:border-cyan-500/50 whitespace-nowrap"
      >
        <i className="fas fa-plus text-sm"></i>
        <i className="fas fa-microphone text-sm text-cyan-400"></i>
        <span className="text-xs font-bold">Piste voix</span>
      </button>
      {onOpenLyrics && (
        <button
          type="button"
          onClick={onOpenLyrics}
          aria-pressed={!!lyricsOpen}
          data-nova-target="lyrics"
          title="Tes paroles en prompteur qui défile pendant la prise"
          className={`shrink-0 h-12 px-3 sm:px-4 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap border ${lyricsOpen ? 'bg-white text-black border-white' : 'bg-[#1a1c21] border-white/20 text-white/80 hover:text-white'}`}
        >
          <span className="text-base leading-none">📝</span>
          <span className="text-xs font-bold">Paroles</span>
        </button>
      )}
      {onOpenVocalTools && (
        <button
          type="button"
          onClick={onOpenVocalTools}
          data-nova-target="mix-auto"
          title="Choisir un style de mix pour ta voix"
          className="shrink-0 h-12 pl-3 pr-4 sm:pl-4 sm:pr-5 rounded-full shadow-lg flex items-center gap-2 transition-all active:scale-95 bg-cyan-500 text-black hover:bg-cyan-400 whitespace-nowrap"
        >
          <span className="text-base leading-none">{style ? style.emoji : '🎚️'}</span>
          <span className="text-xs font-black">{style ? style.name : 'Mix auto'}</span>
        </button>
      )}
    </div>
  );
};

export default TrackCreationBar;
