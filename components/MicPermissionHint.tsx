import React from 'react';
import { useMicAsk } from '../utils/micPermission';

/**
 * Bulle affichée PENDANT que le navigateur demande le micro (premier REC) : elle dit quoi
 * cliquer et à quoi sert le micro. Rien à fermer : elle part quand le navigateur a répondu.
 * Placée en haut, sous la fenêtre du navigateur (bureau : en haut à gauche ; téléphone :
 * en haut ou en bas selon le navigateur), sans rien recouvrir d'utile pendant ces secondes.
 */
const MicPermissionHint: React.FC = () => {
  const ask = useMicAsk();
  if (!ask) return null;
  return (
    <div role="status" aria-live="polite" data-testid="mic-permission-hint"
      className="fixed left-1/2 top-20 z-[1300] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border border-cyan-400/50 bg-nv-surface px-4 py-3 shadow-2xl">
      <p className="text-[14px] font-black text-nv-ink">🎤 Ton navigateur te demande le micro</p>
      <p className="mt-1 text-[12.5px] leading-snug text-nv-muted">
        Clique sur <b className="text-nv-ink">« Autoriser »</b> dans la fenêtre du navigateur : le micro sert seulement à
        enregistrer ta voix dans Nova. Tu ne le feras qu'une fois sur cet appareil.
      </p>
    </div>
  );
};

export default MicPermissionHint;
