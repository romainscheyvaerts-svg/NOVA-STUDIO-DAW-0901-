import React, { useState } from 'react';
import type { Track } from '../types';
import { runEditCommand } from '../utils/editCommands';
import { countLabel, muteClickKind, soloClickKind, soloMuteMenu, soloMuteStatus } from '../utils/soloMute';
import { FloatingMenu, useLongPress } from './TrackStructure';

/**
 * Solo / muet de la console du téléphone et de la tablette, comme sur la
 * console PC (components/MixerView, commandes de hooks/useProToolsUtiles) :
 *  - toucher : solo / muet de la tranche ;
 *  - appui long (doigt) ou clic droit : menu « toutes les pistes en solo »,
 *    « effacer tous les solos », « solo safe », « couper / rendre le son à
 *    toutes les pistes » (au doigt, Alt+clic et Ctrl+clic n'existent pas) ;
 *  - clavier de tablette : Alt+clic = toutes les pistes, Ctrl+clic sur S = solo safe.
 */
/**
 * Appui long (doigt) et clic droit sur un S / M : menu « toutes les pistes », solo safe.
 * Partagé par la console du téléphone (ci-dessous) et la console PC au doigt (MixerView, tablette).
 */
export function useSoloMuteLongPress(track: Track, tracks: Track[]) {
  const isMaster = track.id === 'master';
  const [menu, setMenu] = useState<{ x: number; y: number; button: 'solo' | 'mute' } | null>(null);
  const openMenu = (button: 'solo' | 'mute') => (x: number, y: number) => { if (!isMaster) setMenu({ x, y, button }); };
  const { consumed: muteConsumed, ...muteLp } = useLongPress(openMenu('mute'));
  const { consumed: soloConsumed, ...soloLp } = useLongPress(openMenu('solo'));
  const items = menu ? soloMuteMenu(tracks, track.id, menu.button) : [];
  const ctx = (button: 'solo' | 'mute') => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); openMenu(button)(e.clientX, e.clientY); };
  const menuEl = menu && items.length > 0 ? (
    <FloatingMenu
      x={menu.x}
      y={menu.y}
      title={menu.button === 'solo' ? `Solo · ${track.name}` : `Muet · ${track.name}`}
      onClose={() => setMenu(null)}
      items={items.map(a => ({
        label: a.label,
        icon: a.kind === 'soloSafe' ? 'fa-shield-alt' : a.kind === 'soloAll' ? (a.on ? 'fa-headphones' : 'fa-volume-up') : (a.on ? 'fa-volume-mute' : 'fa-volume-up'),
        onClick: () => {
          if (a.kind === 'soloSafe') runEditCommand('soloSafe', { trackIds: [track.id] });
          else runEditCommand(a.kind, { on: a.on });
        },
      }))}
    />
  ) : null;
  return {
    /** À étaler sur le bouton M (rien sur le master). */
    muteProps: isMaster ? {} : { ...muteLp, onContextMenu: ctx('mute'), 'aria-haspopup': 'menu' as const },
    soloProps: isMaster ? {} : { ...soloLp, onContextMenu: ctx('solo'), 'aria-haspopup': 'menu' as const },
    /** Au début du onClick : vrai si l'appui long vient d'ouvrir le menu (le clic du lever est ignoré). */
    muteConsumed, soloConsumed,
    menuEl,
  };
}

export const MobileSoloMuteButtons: React.FC<{ track: Track; tracks: Track[]; onUpdateTrack: (t: Track) => void }> = ({ track, tracks, onUpdateTrack }) => {
  const isMaster = track.id === 'master';
  const { muteProps, soloProps, muteConsumed, soloConsumed, menuEl } = useSoloMuteLongPress(track, tracks);

  const onMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (muteConsumed()) return;
    if (!isMaster && muteClickKind(e) === 'all') { runEditCommand('muteAll', { on: !track.isMuted }); return; }
    onUpdateTrack({ ...track, isMuted: !track.isMuted });
  };
  const onSolo = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (soloConsumed()) return;
    const k = soloClickKind(e);
    if (k === 'all') { runEditCommand('soloAll', { on: !track.isSolo }); return; }
    if (k === 'safe') { runEditCommand('soloSafe', { trackIds: [track.id] }); return; }
    onUpdateTrack({ ...track, isSolo: !track.isSolo });
  };

  return (
    <div className="flex gap-1.5 w-full">
      <button
        type="button"
        {...muteProps}
        aria-pressed={!!track.isMuted}
        aria-label={`Mute ${track.name}`}
        data-testid={`tel-mute-${track.id}`}
        title={isMaster ? 'Couper le son du master' : 'Toucher : couper cette piste · appui long : toutes les pistes (Alt+clic au clavier)'}
        onClick={onMute}
        className={`nova-hit flex-1 h-11 rounded-lg text-xs font-black select-none touch-manipulation ${track.isMuted ? 'bg-orange-500 text-white' : 'bg-white/5 text-slate-300'}`}
      >
        M
      </button>
      {!isMaster && (
        <button
          type="button"
          {...soloProps}
          aria-pressed={!!track.isSolo}
          aria-label={`Solo ${track.name}${track.soloSafe ? ' (solo safe)' : ''}`}
          data-testid={`tel-solo-${track.id}`}
          data-solo-safe={track.soloSafe ? '1' : undefined}
          title={`${track.soloSafe ? 'Solo safe : reste audible quand une autre piste est en solo. ' : ''}Toucher : n'écouter que cette piste · appui long : tous les solos, solo safe (Alt+clic / Ctrl+clic au clavier)`}
          onClick={onSolo}
          className={`nova-hit relative flex-1 h-11 rounded-lg text-xs font-black select-none touch-manipulation border ${track.isSolo ? 'bg-yellow-500 text-black border-yellow-400' : track.soloSafe ? 'bg-white/5 border-dashed border-cyan-400/70 text-cyan-300' : 'bg-white/5 border-transparent text-slate-300'}`}
        >
          {track.soloSafe && <i className="fas fa-shield-alt mr-0.5 text-[9px]" aria-hidden="true" />}S
        </button>
      )}
      {menuEl}
    </div>
  );
};

/**
 * Compteurs en tête de la console du téléphone : « 2 en solo », « 1 muette »,
 * chacun efface tout d'un toucher (Pro Tools : indicateurs globaux de solo et
 * de mute). Rien en cours : une ligne d'aide discrète (le geste caché est dit).
 */
export const MobileSoloMuteBar: React.FC<{ tracks: Track[] }> = ({ tracks }) => {
  const st = soloMuteStatus(tracks);
  const names = (l: Track[]) => l.slice(0, 4).map(t => t.name).join(', ') + (l.length > 4 ? '…' : '');
  if (!st.soloed.length && !st.muted.length) {
    return (
      <p className="text-[11px] text-slate-400 px-1" data-testid="tel-solo-mute-vide">
        Aucun solo, aucune piste muette. <span className="text-slate-500">Appui long sur S ou M : toutes les pistes d’un coup.</span>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Solos et mutes en cours" data-testid="tel-solo-mute-compteurs">
      {st.soloed.length > 0 && (
        <button type="button" data-testid="tel-clear-solos" onClick={() => runEditCommand('soloAll', { on: false })}
          title={`En solo : ${names(st.soloed)}`}
          aria-label={`Effacer les solos : ${countLabel(st.soloed.length, 'piste', 'pistes')} en solo`}
          className="min-h-11 px-3 rounded-xl bg-amber-400 text-black text-[12px] font-black flex items-center gap-2 border border-amber-300">
          <i className="fas fa-headphones text-[11px]" aria-hidden="true" />
          <span className="tabular-nums">{st.soloed.length} en solo</span>
          <span className="font-semibold opacity-80">· tout réentendre</span>
          <i className="fas fa-times text-[10px] opacity-70" aria-hidden="true" />
        </button>
      )}
      {st.muted.length > 0 && (
        <button type="button" data-testid="tel-clear-mutes" onClick={() => runEditCommand('muteAll', { on: false })}
          title={`Muettes : ${names(st.muted)}`}
          aria-label={`Effacer les mutes : ${countLabel(st.muted.length, 'piste muette', 'pistes muettes')}`}
          className="min-h-11 px-3 rounded-xl bg-red-600 text-white text-[12px] font-black flex items-center gap-2 border border-red-500">
          <i className="fas fa-volume-mute text-[11px]" aria-hidden="true" />
          <span className="tabular-nums">{countLabel(st.muted.length, 'muette', 'muettes')}</span>
          <span className="font-semibold opacity-85">· rendre le son</span>
          <i className="fas fa-times text-[10px] opacity-70" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
