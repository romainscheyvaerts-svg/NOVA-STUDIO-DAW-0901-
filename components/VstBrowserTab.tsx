import React, { useEffect, useMemo, useState } from 'react';
import { ARA_BADGE_TOOLTIP, araPluginKey } from '../utils/araEdit';
import { PluginType } from '../types';
import { novaBridge, BridgePlugin } from '../services/NovaBridge';
import { useBridgeState } from '../hooks/useNovaBridge';
import DesktopAppDownload from './DesktopAppDownload';
import { isNovaDesktop } from '../utils/desktopApp';
import { AutotuneVstSettings } from './AutotuneVstPanel';

/** Exécutable du pont (asset de release GitHub, comme le pont ASIO). */
export const VST_BRIDGE_DOWNLOAD_URL = '/downloads/NovaVSTBridge.exe';

/** Métadonnées enregistrées dans plugin.params à l'ajout d'un VST3. */
export const vstMetadata = (p: BridgePlugin) => ({
  name: p.name, vendor: p.vendor, uid: p.uid, localPath: p.path, pluginName: p.pluginName || undefined,
});

/** Bloc « pont pas lancé » : explications simples + bouton de connexion. */
export const BridgeConnectPanel: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const bridge = useBridgeState();
  const desktop = isNovaDesktop();
  return (
    <div className="space-y-3 text-slate-300">
      {!compact && (
        <div>
          <h3 className="text-sm font-black text-white">Tes plugins VST</h3>
          <p className="text-xs text-slate-400 mt-1">Utilise les effets VST3 installés sur ton PC (Windows), directement sur tes pistes.</p>
        </div>
      )}
      {desktop ? (
        <p className="text-xs text-slate-300">Le pont VST est intégré à Nova Studio et démarre avec l'application : clique sur « Connecter le pont VST ».</p>
      ) : (
        <ol className="text-xs space-y-1.5 list-decimal pl-4 text-slate-300">
          <li>Lance <b>NovaVSTBridge.exe</b> sur ton PC et garde sa fenêtre ouverte.</li>
          <li>Clique sur « Connecter le pont VST ».</li>
        </ol>
      )}
      <button
        onClick={() => { void (bridge.status === 'reconnecting' ? novaBridge.retryNow() : novaBridge.connect()); }}
        disabled={bridge.status === 'connecting'}
        className="w-full h-11 rounded-xl bg-cyan-500 text-black text-xs font-black uppercase tracking-wide hover:bg-cyan-400 disabled:opacity-60 transition-colors"
      >
        {bridge.status === 'connecting' ? 'Connexion…' : bridge.status === 'reconnecting' ? `Reconnexion au pont… (essai ${bridge.attempt || 1}) · réessayer` : 'Connecter le pont VST'}
      </button>
      {bridge.status === 'unavailable' && (
        <p role="status" className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          {desktop
            ? 'Pont VST pas encore prêt (il démarre avec Nova Studio). Réessaie dans quelques secondes ; sinon, ferme et relance Nova Studio.'
            : 'Pont VST introuvable. Vérifie que NovaVSTBridge.exe est lancé sur ce PC, puis réessaie.'}
        </p>
      )}
      {bridge.status === 'idle' && bridge.error && (
        <p role="status" className="text-xs text-amber-300">{bridge.error}</p>
      )}
      {!desktop && <DesktopAppDownload compact />}
      {(!desktop || !compact) && <p className="text-[11px] text-slate-500 leading-relaxed">
        {!desktop && <>Pas encore installé ? <a href={VST_BRIDGE_DOWNLOAD_URL} download className="text-cyan-400 underline">Télécharger NovaVSTBridge.exe</a> (Windows).</>}
        {!compact && <> À la sauvegarde, les effets VST sont rendus dans l'audio : ton projet continue sur ton téléphone.</>}
      </p>}
    </div>
  );
};

/** Onglet « VST » du navigateur (ordinateur seulement). */
const VstBrowserTab: React.FC<{
  onAddPlugin: (trackId: string, type: PluginType, metadata: any, options?: { openUI: boolean }) => void;
  selectedTrackId: string | null;
}> = ({ onAddPlugin, selectedTrackId }) => {
  const bridge = useBridgeState();
  const [plugins, setPlugins] = useState<BridgePlugin[]>(() => novaBridge.getCachedPlugins());
  const [searchTerm, setSearchTerm] = useState('');
  const [showInstruments, setShowInstruments] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const connected = bridge.status === 'connected';

  // Liste demandée une fois connecté (jamais de connexion automatique).
  const refresh = (rescan = false) => {
    setLoadingList(true);
    return novaBridge.listPlugins(rescan)
      .then(setPlugins)
      .catch(() => { /* l'état du pont l'affiche */ })
      .finally(() => setLoadingList(false));
  };
  useEffect(() => { if (connected) void refresh(); }, [connected]);

  const handleDragStart = (e: React.DragEvent, p: BridgePlugin) => {
    e.dataTransfer.setData('pluginType', 'VST3');
    e.dataTransfer.setData('pluginName', p.name);
    e.dataTransfer.setData('pluginVendor', p.vendor);
    e.dataTransfer.setData('application/nova-plugin', 'true');
    e.dataTransfer.setData('pluginMetadata', JSON.stringify(vstMetadata(p)));
  };

  const add = (p: BridgePlugin) => {
    // Melodyne / VocAlign (ARA) : en insert ils ne font rien (Melodyne laisse passer le son,
    // VocAlign rend du silence). Ils s'ouvrent sur un clip, comme dans Pro Tools.
    const ara = araPluginKey(p.path || p.name);
    if (ara) {
      const msg = ara === 'melodyne'
        ? '🎛️ Melodyne s’utilise sur un clip : clic droit sur ta voix → « Ouvrir dans Melodyne (ARA) ».'
        : '🎙️ VocAlign s’utilise sur les clips : clic droit sur un double → « Aligner avec VocAlign… ».';
      try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: msg })); } catch { /* hors navigateur */ }
      return;
    }
    onAddPlugin(selectedTrackId || 'track-rec-main', 'VST3', vstMetadata(p), { openUI: true });
  };

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return plugins
      .filter(p => showInstruments || p.category !== 'Instrument')
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q));
  }, [plugins, searchTerm, showInstruments]);

  if (!connected) return <div className="p-4"><BridgeConnectPanel /></div>;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest">
        <span className="text-emerald-400 font-black"><i className="fas fa-circle text-[6px] mr-1 align-middle"></i>Pont VST connecté</span>
        <button onClick={() => { void refresh(true); }} className="text-slate-500 hover:text-white p-1" title="Chercher à nouveau les plugins installés" aria-label="Chercher à nouveau les plugins installés">
          <i className={`fas fa-sync-alt ${loadingList ? 'animate-spin' : ''}`}></i>
        </button>
      </div>
      <AutotuneVstSettings />
      <div className="relative">
        <i className="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-xs text-slate-600"></i>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Chercher un plugin..."
          aria-label="Chercher un plugin VST"
          className="w-full h-10 bg-black/40 border border-white/10 rounded-xl pl-10 pr-4 text-xs font-medium text-white placeholder:text-slate-700 focus:outline-none focus:border-cyan-500/30 transition-all"
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>Clique pour l'ajouter sur la piste choisie.</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showInstruments} onChange={e => setShowInstruments(e.target.checked)} />
          Instruments
        </label>
      </div>
      {filtered.slice(0, 300).map(p => (
        <div
          key={p.id}
          draggable
          onDragStart={(e) => handleDragStart(e, p)}
          onClick={() => add(p)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(p); }}
          role="button"
          tabIndex={0}
          data-vst-plugin={p.name}
          className="w-full p-3 bg-white/[0.02] border border-white/5 rounded-lg flex items-center space-x-3 transition-all cursor-pointer active:cursor-grabbing hover:bg-white/[0.04]"
        >
          <div className="w-8 h-8 rounded-md bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20 text-xs shrink-0"><i className="fas fa-plug"></i></div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-white truncate">{p.name}{araPluginKey(p.path || p.name) && (
              <span title={ARA_BADGE_TOOLTIP} data-testid="ara-badge" className="ml-1.5 rounded border border-fuchsia-400/50 bg-fuchsia-500/15 px-1 py-px align-middle text-[9px] font-black tracking-wider text-fuchsia-200">ARA</span>
            )}</div>
            <div className="text-[9px] text-slate-500 truncate">{p.vendor || 'VST3'}{p.category === 'Instrument' ? ' · instrument' : ''}{araPluginKey(p.path || p.name) ? ' · sur un clip (clic droit)' : ''}{p.license === 'nag' ? ' · fenêtre de licence à chaque ouverture' : (p.license || p.scanStatus === 'activation') ? ' · activation de licence à faire' : ''}</div>
          </div>
        </div>
      ))}
      {filtered.length === 0 && (
        <div className="text-center py-10 opacity-60">
          <i className="fas fa-plug text-2xl text-slate-600 mb-2"></i>
          <p className="text-[11px] text-slate-500">{loadingList ? 'Recherche des plugins…' : 'Aucun plugin VST3 trouvé.'}</p>
        </div>
      )}
    </div>
  );
};

export default VstBrowserTab;
