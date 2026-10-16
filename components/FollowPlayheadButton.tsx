import React from 'react';

/**
 * « Suivre » : apparaît quand l'utilisateur a fait défiler l'arrangement à la main pendant
 * la lecture (hooks/useFollowPlayhead). Un clic, et la vue suit de nouveau la tête de
 * lecture ; le prochain Play le fait aussi tout seul.
 */
const FollowPlayheadButton: React.FC<{ suspended: boolean; onResume: () => void }> = ({ suspended, onResume }) => {
  if (!suspended) return null;
  return (
    <button type="button" onClick={onResume} data-testid="follow-playhead"
      title="Tu as fait défiler à la main : la vue ne suit plus la tête de lecture. Clique pour la suivre de nouveau (ou relance la lecture)."
      aria-label="Suivre la tête de lecture"
      className="h-8 px-2.5 shrink-0 rounded-lg border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500 hover:text-black text-[11px] font-bold flex items-center gap-1.5 transition-colors [@media(pointer:coarse)]:h-10">
      <i className="fas fa-location-crosshairs text-[11px]" aria-hidden="true"></i>
      <span>Suivre</span>
    </button>
  );
};

export default FollowPlayheadButton;
