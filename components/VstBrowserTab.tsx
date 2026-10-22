import React, { useEffect, useMemo, useState } from 'react';
import { ARA_BADGE_TOOLTIP, araPluginKey } from '../utils/araEdit';
import { araInsertMetadata } from '../utils/araInsert';
import { PluginType } from '../types';
import { novaBridge, BridgePlugin } from '../services/NovaBridge';
import { useBridgeState } from '../hooks/useNovaBridge';
import DesktopAppDownload from './DesktopAppDownload';
import { isNovaDesktop } from '../utils/desktopApp';
import { AutotuneVstSettings } from './AutotuneVstPanel';
import { groupVstPlugins, variantLabel } from '../utils/vstGroups';
import { vstMetadata } from '../utils/vstMenu';
import { fxPrefs, useFxPrefs, vstFxId } from '../utils/fxFavorites';

/** Exécutable du pont (asset de release GitHub, comme le pont ASIO). */
export const VST_BRIDGE_DOWNLOAD_URL = '/downloads/NovaVSTBridge.exe';

/** Métadonnées enregistrées dans plugin.params à l'ajout d'un VST3 (utils/vstMenu). */
export { vstMetadata };

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
        // Appli Windows : tout est intégré, rien à lancer. Pas de mot technique (« pont ») :
        // la partie qui fait tourner les plugins démarre et redémarre toute seule.
        <div role="status" data-testid="vst-desktop-starting" className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-3 text-xs text-slate-300 space-y-1">
          <p className="font-bold text-cyan-100"><i className="fas fa-circle-notch fa-spin mr-1.5" aria-hidden="true"></i>
            {(bridge.attempt || 0) > 0 && bridge.error ? 'Tes plugins redémarrent…' : 'Préparation de tes plugins…'}
          </p>
          <p>{(bridge.attempt || 0) > 0 && bridge.error
            ? "Un plugin s'est arrêté : Nova relance tout seul la partie qui fait tourner tes plugins. Ton projet n'est pas touché."
            : 'Nova démarre la partie qui fait tourner tes plugins VST (Waves, Antares…). Rien à installer : ça prend quelques secondes.'}</p>
        </div>
      ) : (
        <ol className="text-xs space-y-1.5 list-decimal pl-4 text-slate-300">
          <li>Lance <b>NovaVSTBridge.exe</b> sur ton PC et garde sa fenêtre ouverte.</li>
          <li>Clique sur « Connecter le pont VST ».</li>
        </ol>
      )}
      <button
        onClick={() => { void (bridge.status === 'reconnecting' ? novaBridge.retryNow() : novaBridge.connect()); }}
        data-testid="vst-connect"
        disabled={bridge.status === 'connecting'}
        className="w-full h-11 rounded-xl bg-cyan-500 text-black text-xs font-black uppercase tracking-wide hover:bg-cyan-400 disabled:opacity-60 transition-colors"
      >
        {desktop
          ? (bridge.status === 'connecting' ? 'Connexion…' : 'Réessayer maintenant')
          : bridge.status === 'connecting' ? 'Connexion…' : bridge.status === 'reconnecting' ? `Reconnexion au pont… (essai ${bridge.attempt || 1}) · réessayer` : 'Connecter le pont VST'}
      </button>
      {desktop && (bridge.attempt || 0) >= 6 && (
        <p role="status" className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          Toujours pas prêt après {bridge.attempt} essais : ferme Nova Studio et rouvre-le. Si ça recommence, lance « Diagnostic plugins Nova » depuis la clé USB.
        </p>
      )}
      {bridge.status === 'unavailable' && (
        <p role="status" className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          {desktop
            ? 'Tes plugins ne sont pas encore prêts (ils démarrent avec Nova Studio). Réessaie dans quelques secondes ; sinon, ferme et relance Nova Studio.'
            : 'Pont VST introuvable. Vérifie que NovaVSTBridge.exe est lancé sur ce PC, puis réessaie.'}
        </p>
      )}
      {!desktop && bridge.status === 'idle' && bridge.error && (
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
/** Groupe de plugins (WaveShell de Waves) que le pont n'a pas encore pu déplier. */
export const isUnreadShell = (p: BridgePlugin): boolean => !p.shell && !p.pluginName && /shell/i.test(p.name);
export const unreadShellText = (reading: boolean) => reading
  ? 'Groupe de plugins Waves : Nova est en train de le lire, ses plugins vont apparaître un par un dans la liste.'
  : "Groupe de plugins Waves pas encore lu : Nova réessaie à chaque ouverture. Vérifie que Waves Central est installé et que tes licences Waves sont sur ce PC, puis rouvre Nova Studio.";

const VstBrowserTab: React.FC<{
  onAddPlugin: (trackId: string, type: PluginType, metadata: any, options?: { openUI: boolean }) => void;
  selectedTrackId: string | null;
}> = ({ onAddPlugin, selectedTrackId }) => {
  const bridge = useBridgeState();
  const [plugins, setPlugins] = useState<BridgePlugin[]>(() => novaBridge.getCachedPlugins());
  const [searchTerm, setSearchTerm] = useState('');
  const [showInstruments, setShowInstruments] = useState(false);
  // Favoris / récents (partagés avec le menu « Ajouter un effet » des tranches).
  const prefs = useFxPrefs();
  const [only, setOnly] = useState<'all' | 'fav' | 'recent'>('all');
  const [loadingList, setLoadingList] = useState(false);
  const connected = bridge.status === 'connected';

  // Liste demandée une fois connecté ; pendant la lecture des plugins par le pont (1re fois
  // sur un PC : Waves, Antares…), novaBridge la relit tout seul et elle se complète ici.
  const refresh = (rescan = false) => {
    setLoadingList(true);
    return novaBridge.listPlugins(rescan)
      .then(setPlugins)
      .catch(() => { /* l'état du pont l'affiche */ })
      .finally(() => setLoadingList(false));
  };
  useEffect(() => { if (connected) void refresh(); }, [connected]);
  useEffect(() => { setPlugins(novaBridge.getCachedPlugins()); }, [bridge.pluginsRev]);
  const lecture = connected ? bridge.instrumentsPending : null;

  const handleDragStart = (e: React.DragEvent, p: BridgePlugin) => {
    e.dataTransfer.setData('pluginType', 'VST3');
    e.dataTransfer.setData('pluginName', p.name);
    e.dataTransfer.setData('pluginVendor', p.vendor);
    e.dataTransfer.setData('application/nova-plugin', 'true');
    e.dataTransfer.setData('pluginMetadata', JSON.stringify(vstMetadata(p)));
  };

  const add = (p: BridgePlugin) => {
    // Groupe (WaveShell de Waves) pas encore déplié : il ne se charge pas tel quel.
    if (!isUnreadShell(p)) fxPrefs.noteUsed(vstFxId(p));
    if (isUnreadShell(p)) {
      try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: unreadShellText(!!lecture) })); } catch { /* hors navigateur */ }
      return;
    }
    // Melodyne / VocAlign (ARA) : insert de piste comme dans Pro Tools (pont v12) : tous les clips
    // de la piste sont confiés au plugin, son éditeur s'ancre en bas de la fenêtre Édition.
    const ara = araInsertMetadata(p);
    if (ara) {
      if (!bridge.araInsert) {
        const msg = 'Mets à jour Nova Studio pour Windows pour poser Melodyne / VocAlign en insert (ARA). En attendant : clic droit sur un clip → « Ouvrir dans Melodyne (ARA) ».';
        try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: msg })); } catch { /* hors navigateur */ }
        return;
      }
      onAddPlugin(selectedTrackId || 'track-rec-main', 'VST3', ara, { openUI: true });
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
  // Une ligne par plugin (les variantes Waves mono / stéréo… regroupées), toute la liste affichée.
  const allRows = useMemo(() => groupVstPlugins(filtered), [filtered]);
  // Une ligne est favorite / récente si l'une de ses variantes l'est.
  const rowIds = (r: { main: BridgePlugin; variants: BridgePlugin[] }) => [r.main, ...r.variants].map(vstFxId);
  const rows = useMemo(() => {
    if (only === 'all') return allRows;
    const ids = only === 'fav' ? prefs.favorites : prefs.recents;
    const hit = allRows.filter(r => rowIds(r).some(id => ids.includes(id)));
    // Récents : du plus récent au plus ancien.
    return only === 'recent' ? hit.sort((a, b) => Math.min(...rowIds(a).map(i => ids.indexOf(i)).filter(i => i >= 0)) - Math.min(...rowIds(b).map(i => ids.indexOf(i)).filter(i => i >= 0))) : hit;
  }, [allRows, only, prefs]);

  if (!connected) return <div className="p-4"><BridgeConnectPanel /></div>;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest">
        <span className="text-emerald-400 font-black"><i className="fas fa-circle text-[6px] mr-1 align-middle"></i>{isNovaDesktop() ? 'Plugins prêts' : 'Pont VST connecté'}</span>
        <button onClick={() => { void refresh(true); }} className="text-slate-500 hover:text-white p-1" title="Chercher à nouveau les plugins installés" aria-label="Chercher à nouveau les plugins installés">
          <i className={`fas fa-sync-alt ${loadingList ? 'animate-spin' : ''}`}></i>
        </button>
      </div>
      {lecture && (
        <div role="status" data-testid="vst-probe-progress" className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-3 text-[11px] text-cyan-100">
          <p className="font-bold"><i className="fas fa-circle-notch fa-spin mr-1.5" aria-hidden="true"></i>Lecture des plugins de ce PC : {lecture[0]} / {lecture[1]}</p>
          <p className="mt-1 text-cyan-200/80">Première fois seulement. Les plugins (Waves, Antares…) apparaissent au fur et à mesure, tu peux déjà travailler.</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
            <div className="h-full bg-cyan-400 transition-all" style={{ width: `${lecture[1] ? Math.round((lecture[0] / lecture[1]) * 100) : 0}%` }} />
          </div>
        </div>
      )}
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
      <div className="flex gap-1" role="group" aria-label="Afficher">
        {([['all', 'Tous'], ['fav', '★ Favoris'], ['recent', 'Récents']] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setOnly(k)} aria-pressed={only === k} data-testid={`vst-only-${k}`}
            className={`h-7 rounded-full px-2.5 text-[10px] font-bold border ${only === k ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-400 hover:text-white'}`}>{label}</button>
        ))}
      </div>
      {rows.length > 0 && (
        <p data-testid="vst-count" className="text-[10px] text-slate-500">{rows.length} plugin{rows.length > 1 ? 's' : ''}{searchTerm.trim() ? ' trouvés' : ''}</p>
      )}
      {rows.length === 0 && only !== 'all' && filtered.length > 0 && (
        <p className="text-[11px] text-slate-500">{only === 'fav' ? 'Aucun favori : clique sur l’étoile d’un plugin pour le retrouver ici (et en tête du menu « Ajouter un effet » des tranches).' : 'Aucun plugin utilisé récemment.'}</p>
      )}
      {rows.map(({ key, name, main: p, variants }) => (
        <div
          key={key}
          draggable
          onDragStart={(e) => handleDragStart(e, p)}
          onClick={() => add(p)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(p); }}
          role="button"
          tabIndex={0}
          data-vst-plugin={p.name}
          style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 58px' }}
          className="w-full p-3 bg-white/[0.02] border border-white/5 rounded-lg flex items-center space-x-3 transition-all cursor-pointer active:cursor-grabbing hover:bg-white/[0.04]"
        >
          <div className="w-8 h-8 rounded-md bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20 text-xs shrink-0"><i className="fas fa-plug"></i></div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-bold text-white truncate">{name}{araPluginKey(p.path || p.name) && (
              <span title={ARA_BADGE_TOOLTIP} data-testid="ara-badge" className="ml-1.5 rounded border border-fuchsia-400/50 bg-fuchsia-500/15 px-1 py-px align-middle text-[9px] font-black tracking-wider text-fuchsia-200">ARA</span>
            )}</div>
            <div className="text-[9px] text-slate-500 truncate">{isUnreadShell(p) ? (lecture ? 'Groupe Waves : lecture en cours…' : 'Groupe Waves pas encore lu (clique pour savoir pourquoi)') : null}{isUnreadShell(p) ? null : (p.vendor || 'VST3')}{p.category === 'Instrument' ? ' · instrument' : ''}{araPluginKey(p.path || p.name) ? ' · insert de piste ARA' : ''}{p.license === 'nag' ? ' · fenêtre de licence à chaque ouverture' : (p.license || p.scanStatus === 'activation') ? ' · activation de licence à faire' : ''}{!variants.length && p.channels ? ` · ${p.channels === 'mono' ? 'mono' : p.channels === 'stereo' ? 'stéréo' : 'mono → stéréo'}` : ''}{p.unstable ? ' · instable sur le pont (fait planter le pont : isolé, non chargé)' : ''}</div>
            {variants.length > 1 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {variants.map(v => (
                  <button key={v.id} type="button" draggable data-vst-variant={v.name}
                    onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, v); }}
                    onClick={(e) => { e.stopPropagation(); add(v); }}
                    title={`Ajouter ${v.name} sur la piste choisie`}
                    className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold border transition-colors ${v === p ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'}`}>
                    {variantLabel(v, name)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {(() => { const fav = rowIds({ main: p, variants }).some(id => prefs.favorites.includes(id)); return (
            <button type="button" onClick={(e) => { e.stopPropagation(); const ids = rowIds({ main: p, variants }); const on = ids.filter(id => prefs.favorites.includes(id)); if (on.length) on.forEach(id => fxPrefs.toggleFavorite(id)); else fxPrefs.toggleFavorite(vstFxId(p)); }}
              onKeyDown={(e) => e.stopPropagation()} aria-pressed={fav} data-vst-star={name}
              aria-label={fav ? `Retirer ${name} des favoris` : `Mettre ${name} en favori`} title={fav ? 'Retirer des favoris' : 'Mettre en favori (en tête du menu « Ajouter un effet » des tranches)'}
              className={`w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-xs ${fav ? 'text-amber-300' : 'text-slate-600 hover:text-amber-200'}`}>
              <i className={`${fav ? 'fas' : 'far'} fa-star`} aria-hidden="true" />
            </button>
          ); })()}
        </div>
      ))}
      {filtered.length === 0 && (
        <div className="text-center py-10 opacity-60">
          <i className="fas fa-plug text-2xl text-slate-600 mb-2"></i>
          <p className="text-[11px] text-slate-500">{loadingList || lecture ? 'Recherche des plugins…' : 'Aucun plugin VST3 trouvé.'}</p>
          {!loadingList && !lecture && !searchTerm.trim() && (
            <p className="mt-1 text-[10px] text-slate-500">Nova lit les plugins VST3 (dossier C:\Program Files\Common Files\VST3). Les plugins installés seulement en AAX n'y sont pas : réinstalle-les en cochant VST3.</p>
          )}
        </div>
      )}
    </div>
  );
};

export default VstBrowserTab;
