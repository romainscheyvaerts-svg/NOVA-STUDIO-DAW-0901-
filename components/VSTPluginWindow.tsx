import React, { useState } from 'react';
import { PluginInstance, Track } from '../types';
import { useBridgeState, useVstNodeInfo } from '../hooks/useNovaBridge';
import { liveVstNodes } from '../engine/VSTPluginNode';
import { isFreezeStale, isPluginBaked } from '../utils/freeze';
import { BridgeConnectPanel } from './VstBrowserTab';
import { SidechainPanel } from './SidechainPanel';

interface VSTPluginWindowProps {
  plugin: PluginInstance;
  onClose: () => void;
  trackId?: string;
  track?: Track;
  /** Gèle / dégèle la piste (handleFreezeTrack). */
  onToggleFreeze?: (trackId: string) => void;
  /** Presets du plugin (R4) : état lu par le pont, rechargé et vérifié. */
  presetSlot?: React.ReactNode;
  /** Barre « Clé » (R10) : pistes de la session et mises à jour. */
  tracks?: Track[];
  onUpdateTrack?: (t: Track) => void;
  onUpdateParams?: (p: Record<string, any>) => void;
}

/**
 * Panneau d'un effet VST3 du PC. L'interface du plugin s'ouvre dans sa propre
 * fenêtre sur le PC (pont VST) ; ici : état, latence, bouton d'ouverture.
 * Sans pont (téléphone) : l'effet est déjà rendu dans l'audio de la piste.
 */
const VSTPluginWindow: React.FC<VSTPluginWindowProps> = ({ plugin, onClose, trackId, track, onToggleFreeze, presetSlot, tracks, onUpdateTrack, onUpdateParams }) => {
  const bridge = useBridgeState();
  const info = useVstNodeInfo(plugin.id);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const index = track ? track.plugins.findIndex(p => p.id === plugin.id) : -1;
  const baked = !!track && index >= 0 && isPluginBaked(track, index);
  const stale = !!track && baked && isFreezeStale(track);
  const vendor = plugin.params?.vendor;

  const openEditor = async () => {
    setOpenError(null);
    setOpening(true);
    try {
      await liveVstNodes.get(plugin.id)?.openEditor();
    } catch (e: any) {
      setOpenError(e?.message || "La fenêtre du plugin n'a pas pu s'ouvrir.");
    } finally {
      setOpening(false);
    }
  };

  let body: React.ReactNode;
  if (baked) {
    body = (
      <div className="space-y-3">
        <div className="inline-flex items-center gap-2 px-2 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-[11px] font-bold">
          <i className="fas fa-snowflake"></i> Rendu (VST du PC)
        </div>
        <p className="text-xs text-slate-300">
          Cet effet est déjà inclus dans l'audio de la piste : tu l'entends partout, même sur ton téléphone.
          Pour le régler, ouvre le projet sur ton PC avec le pont VST, puis « Dégeler ».
        </p>
        {stale && (
          <p role="status" className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
            <i className="fas fa-exclamation-triangle mr-1"></i>
            Les prises ont changé depuis ce rendu. Il sera refait à la prochaine sauvegarde sur ton PC (pont VST connecté).
          </p>
        )}
        {bridge.status === 'connected' && trackId && onToggleFreeze && (
          <button onClick={() => onToggleFreeze(trackId)} className="w-full h-10 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-black uppercase tracking-wide">
            <i className="fas fa-fire mr-2"></i>Dégeler la piste
          </button>
        )}
      </div>
    );
  } else if (bridge.status !== 'connected') {
    body = (
      <div className="space-y-3">
        <p className="text-xs text-slate-400">Sans le pont, cet effet est contourné : la piste sonne sans lui.</p>
        <BridgeConnectPanel compact />
      </div>
    );
  } else if (!plugin.isEnabled) {
    body = <p className="text-xs text-slate-400">Effet désactivé. Réactive-le avec le bouton d'alimentation de l'effet.</p>;
  } else if (!info || info.status === 'loading' || info.status === 'offline') {
    body = <p className="text-xs text-slate-300"><i className="fas fa-circle-notch animate-spin mr-2"></i>Chargement du plugin sur ton PC…</p>;
  } else if (info.status === 'error') {
    body = (
      <p role="alert" className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
        Le pont n'a pas pu charger ce plugin : {info.error}. Certains plugins protégés (iLok) ne fonctionnent pas avec le pont.
      </p>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-xs text-emerald-300"><i className="fas fa-circle text-[6px] mr-2 align-middle"></i>Actif · retard compensé à la lecture ({info.latencyMs} ms)</p>
        <button
          onClick={openEditor}
          disabled={opening}
          className="w-full h-11 rounded-xl bg-cyan-500 text-black text-xs font-black uppercase tracking-wide hover:bg-cyan-400 disabled:opacity-60"
        >
          <i className="fas fa-external-link-alt mr-2"></i>{opening ? 'Ouverture…' : 'Ouvrir la fenêtre du plugin'}
        </button>
        <p className="text-[11px] text-slate-500">La fenêtre s'ouvre sur ton PC. Tes réglages sont enregistrés dans le projet quand tu la fermes.</p>
        {track?.isTrackArmed && (
          <p className="text-[11px] text-slate-400">Piste armée : l'effet est contourné pendant l'enregistrement pour que ton retour casque reste sans retard.</p>
        )}
        {info.underruns > 0 && (
          <p className="text-[11px] text-amber-300">Le pont a pris du retard ({info.underruns} coupures). Ferme les programmes inutiles si le son craque.</p>
        )}
        {openError && <p role="alert" className="text-[11px] text-red-300">{openError}</p>}
      </div>
    );
  }

  return (
    <div className="w-[min(92vw,380px)] bg-[#0f1115] border border-white/10 rounded-2xl p-4 space-y-4" data-vst-window={plugin.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">VST3 de ton PC</div>
          <div className="text-sm font-black text-white truncate">{plugin.params?.name || plugin.name}</div>
          {vendor && <div className="text-[10px] text-slate-500 truncate">{vendor}</div>}
        </div>
        <button onClick={onClose} aria-label="Fermer" className="w-9 h-9 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 shrink-0">
          <i className="fas fa-times"></i>
        </button>
      </div>
      {presetSlot && <div className="flex items-center gap-1 rounded-xl bg-white/[0.03] border border-white/10 p-1">{presetSlot}</div>}
      {/* Side-chain (R10) : même barre « Clé » que les effets NOVA (source, prise avant / après fader, filtre). */}
      {!baked && track && tracks && onUpdateTrack && onUpdateParams && (
        <div className="-mx-4 overflow-hidden rounded-xl border border-white/10">
          <SidechainPanel plugin={track.plugins.find(p => p.id === plugin.id) || plugin} track={track} tracks={tracks}
            onUpdateTrack={onUpdateTrack} onUpdateParams={onUpdateParams} compact vstKey={info?.sidechain ?? null} />
        </div>
      )}
      {body}
    </div>
  );
};

export default VSTPluginWindow;
