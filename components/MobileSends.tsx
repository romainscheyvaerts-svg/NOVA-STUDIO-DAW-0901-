import React, { useState } from 'react';
import type { Track, TrackSend } from '../types';
import SendFader from './SendFader';
import { FloatingMenu } from './TrackStructure';
import { sendTransferMenuItems } from '../utils/sendFader';
import { sendColor, sendLabel } from '../utils/sendLabels';
import { applyTracks } from '../utils/structureBus';
import { useLiveParam } from '../utils/automationLiveStore';

/**
 * Envois de la piste touchée, sur le téléphone (onglet Mixer) : chaque envoi
 * se règle au doigt comme un fader (components/SendFader), avec pré / post,
 * et un menu (⋯ ou appui long) pour le copier / déplacer vers une autre piste.
 */
const sameSend = (a: TrackSend, b: TrackSend) => a.id === b.id && (a.slot ?? null) === (b.slot ?? null);

const Row: React.FC<{ track: Track; send: TrackSend; all: Track[]; onUpdateTrack: (t: Track) => void }> = ({ track, send, all, onUpdateTrack }) => {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const level = useLiveParam(track.id, `send::${send.id}`, send.level);
  const bus = sendLabel(send.id, all);
  const patch = (p: Partial<TrackSend>) => onUpdateTrack({ ...track, sends: track.sends.map(s => (sameSend(s, send) ? { ...s, ...p } : s)) });
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <SendFader trackId={track.id} sendId={send.id} label={`Envoi vers ${bus}`} level={level} color={sendColor(send.id)} muted={!!send.isMuted} height={44}
          testId={`mobile-send-${track.id}-${send.id}`} onChange={(v) => patch({ level: v })} onMenu={(x, y) => setMenu({ x, y })} />
      </div>
      <button type="button" onClick={() => patch({ preFader: !send.preFader })} aria-pressed={!!send.preFader}
        aria-label={`Envoi vers ${bus} : ${send.preFader ? 'pré-fader (toucher pour le passer après le fader)' : 'post-fader (toucher pour le passer avant le fader)'}`}
        className={`h-11 w-12 shrink-0 rounded-lg text-[10px] font-black ${send.preFader ? 'bg-amber-400 text-black' : 'bg-white/10 text-slate-400'}`}>{send.preFader ? 'PRÉ' : 'POST'}</button>
      <button type="button" aria-label={`Plus d’options pour l’envoi vers ${bus}`} data-testid={`mobile-send-menu-${track.id}-${send.id}`}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left - 160, y: r.bottom + 4 }); }}
        className="h-11 w-11 shrink-0 rounded-lg bg-white/5 text-slate-300"><i className="fas fa-ellipsis-h text-sm" /></button>
      {menu && (
        <FloatingMenu x={menu.x} y={menu.y} title={`Envoi vers ${bus}`} onClose={() => setMenu(null)}
          items={[
            { label: 'Remettre à 0 dB', icon: 'fa-undo', onClick: () => patch({ level: 1 }) },
            { label: send.isMuted ? 'Rallumer l’envoi' : 'Couper l’envoi', icon: 'fa-volume-mute', onClick: () => patch({ isMuted: !send.isMuted }) },
            'separator',
            ...sendTransferMenuItems(track, send, all, bus, (fn, label) => applyTracks(fn, label)),
          ]} />
      )}
    </div>
  );
};

const MobileSends: React.FC<{ track: Track; tracks: Track[]; onUpdateTrack: (t: Track) => void }> = ({ track, tracks, onUpdateTrack }) => {
  if (track.id === 'master' || track.isVca) return null;
  const sends = track.sends || [];
  return (
    <div className="mb-3" data-testid={`mobile-sends-${track.id}`}>
      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Envois ({sends.length})</h4>
      {sends.length ? (
        <div className="space-y-2">
          {sends.map((s, i) => <Row key={`${s.id}-${s.slot ?? i}`} track={track} send={s} all={tracks} onUpdateTrack={onUpdateTrack} />)}
          <p className="text-[11px] text-slate-500">Glisse la barre comme un fader · double toucher : 0 dB · appui long ou ⋯ : copier vers une autre piste.</p>
        </div>
      ) : (
        <p className="text-[12px] text-slate-500">Aucun envoi sur cette piste : ajoute une réverbe ou un délai depuis la console du PC ou de la tablette (« Envois a-j »).</p>
      )}
    </div>
  );
};

export default MobileSends;
