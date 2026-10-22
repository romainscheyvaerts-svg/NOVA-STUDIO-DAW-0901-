import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PluginInstance, Track, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { AutoTuneUI } from '../plugins/AutoTunePlugin';
import { AutotuneEngineNote } from './AutotuneVstPanel';
import { ProfessionalReverbUI } from '../plugins/ReverbPlugin';
import { VocalCompressorUI } from '../plugins/CompressorPlugin';
import { SyncDelayUI } from '../plugins/DelayPlugin';
import { VocalChorusUI } from '../plugins/ChorusPlugin';
import { StudioFlangerUI } from '../plugins/FlangerPlugin';
import { VocalDoublerUI } from '../plugins/DoublerPlugin';
import { StereoSpreaderUI } from '../plugins/StereoSpreaderPlugin';
import { VocalDeEsserUI } from '../plugins/DeEsserPlugin';
import { VocalDenoiserUI } from '../plugins/DenoiserPlugin';
import { ProEQ12UI } from '../plugins/ProEQ12Plugin';
import { VocalSaturatorUI } from '../plugins/VocalSaturatorPlugin';
import { MasterSyncUI } from '../plugins/MasterSyncPlugin';
import VSTPluginWindow from './VSTPluginWindow';
import { foldInternalPower } from '../utils/pluginUi';
import SamplerEditor from './SamplerEditor'; 
import DrumSamplerEditor from './DrumSamplerEditor';
import MelodicSamplerEditor from './MelodicSamplerEditor';
import DrumRack from './DrumRack';
import FitToWidth from './FitToWidth';
import { PluginName } from './PluginName';
import { getRegisteredPlugin } from '../engine/pluginRegistry';
import PresetMenu from './PresetMenu';
import SidechainPanel from './SidechainPanel';
import { supportsSidechain } from '../engine/sidechain';
import { getPluginWindowOffset, setPluginWindowOffset } from '../utils/pluginWindowPos';

interface PluginEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onUpdateParams: (params: Record<string, any>) => void;
  onClose: () => void;
  isMobile?: boolean; 
  track?: Track; // Needed for Drum Rack
  onUpdateTrack?: (track: Track) => void; // Needed for Drum Rack
  /** Gèle / dégèle la piste (effets VST3 du PC). */
  onToggleFreeze?: (trackId: string) => void;
  /** Active / désactive l'effet (bypass), comme le bouton de la fenêtre d'un plugin Pro Tools. */
  onToggleBypass?: (trackId: string, pluginId: string) => void;
  /** Ouvre un autre effet de la piste (flèches précédent / suivant). */
  onOpenPlugin?: (trackId: string, plugin: PluginInstance) => void;
  /** Toutes les pistes (side-chain : choix de la clé, R7). */
  allTracks?: Track[];
  /** Fenêtre gardée ouverte (punaise ou Maj+clic) : le prochain effet s'ouvre dans une autre fenêtre. */
  kept?: boolean;
  /** Position de départ (fenêtres en cascade). */
  initialOffset?: { x: number; y: number };
  /** Fenêtre de devant : la seule que ferme Échap (vrai par défaut). */
  escapeActive?: boolean;
  /** Nombre de fenêtres d'effet ouvertes (« Tout fermer » à partir de 2). */
  openCount?: number;
  /** Punaise : garder / ne plus garder la fenêtre ouverte (position actuelle transmise). */
  onToggleKeep?: (offset: { x: number; y: number }) => void;
  /** Fermer toutes les fenêtres d'effet (Maj+Échap). */
  onCloseAll?: () => void;
}


const PluginEditor: React.FC<PluginEditorProps> = ({ plugin, trackId, onClose, onUpdateParams, isMobile, track, onUpdateTrack, onToggleFreeze, onToggleBypass, onOpenPlugin, allTracks, kept = false, initialOffset, escapeActive = true, openCount = 1, onToggleKeep, onCloseAll }) => {
  // Rappel STABLE vers le projet : App en recrée un à chaque rendu ; les effets qui
  // remontent leurs réglages dans un useEffect([params, onParamsChange]) bouclaient
  // à l'infini (Saturation : « Maximum update depth exceeded », NOVA planté).
  const updateRef = useRef(onUpdateParams);
  updateRef.current = onUpdateParams;
  const stableUpdateParams = useCallback((p: Record<string, any>) => updateRef.current(p), []);
  // État à jour de l'effet (actif / bypass) et voisins dans la chaîne de la piste.
  const live = track?.plugins.find(p => p.id === plugin.id) || plugin;
  const chain = (track?.plugins || []).filter(p => p.type !== 'MELODIC_SAMPLER' && p.type !== 'DRUM_SAMPLER' && p.type !== 'SAMPLER');
  const pos = chain.findIndex(p => p.id === plugin.id);
  const prev = pos > 0 ? chain[pos - 1] : null;
  const next = pos >= 0 && pos < chain.length - 1 ? chain[pos + 1] : null;
  // Échap ferme la fenêtre de devant (sauf pendant une saisie) ; Maj+Échap ferme toutes les fenêtres d'effet.
  // Écouté à la capture : traité une seule fois, avant le « Échap ferme la fenêtre du dessus » général
  // de l'appli (qui, avec plusieurs fenêtres, se rejouait sur la suivante). Un menu ou une boîte de
  // dialogue ouverts par-dessus gardent leur Échap.
  useEffect(() => {
    if (!escapeActive) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Escape' || e.defaultPrevented || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
      if (t?.closest?.('[role="menu"], [role="dialog"], [aria-modal="true"], [role="listbox"]')) return;
      if (Array.from(document.querySelectorAll('[role="menu"], [aria-modal="true"]')).some(el => el.getClientRects().length > 0)) return;
      e.preventDefault();
      if (e.shiftKey && onCloseAll) onCloseAll(); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, onCloseAll, escapeActive]);
  // Déplacement par la barre du haut (G18 : fenêtre flottante). La fenêtre du moment garde sa
  // place d'un effet à l'autre ; les fenêtres gardées ouvertes ont chacune la leur (cascade).
  const [offset, setOffset] = useState(initialOffset || getPluginWindowOffset());
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, o = offset;
    const move = (ev: PointerEvent) => {
      const next = { x: o.x + ev.clientX - sx, y: Math.max(-window.innerHeight / 2 + 80, o.y + ev.clientY - sy) };
      if (!kept) setPluginWindowOffset(next);
      setOffset(next);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [nodeInstance, setNodeInstance] = useState<any>(null);
  // Toujours à l'écran (cascade, écran plus petit, façade qui grandit) : la barre reste sous la barre
  // de transport, le bas et les côtés ne sortent pas de l'écran.
  const shellRef = useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (isMobile) return;
    const el = shellRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let dx = 0, dy = 0;
    if (r.bottom > vh - 4) dy = vh - 4 - r.bottom;
    if (r.top + dy < 120) dy = 120 - r.top;
    if (r.right > vw - 4) dx = vw - 4 - r.right;
    if (r.left + dx < 4) dx = 4 - r.left;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) setOffset(o => ({ x: o.x + dx, y: o.y + dy }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeInstance]);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Polling effect to wait for DSP node creation
  useEffect(() => {
    // Skip polling for special plugin types that don't need DSP nodes
    if (['VST3', 'SAMPLER', 'DRUM_SAMPLER', 'MELODIC_SAMPLER', 'DRUM_RACK_UI'].includes(plugin.type)) {
      return;
    }

    let attempts = 0;
    const maxAttempts = 30; // 3 seconds timeout (30 * 100ms)
    let timer: any;

    const pollForNode = async () => {
      const node = audioEngine.getPluginNodeInstance(trackId, plugin.id);
      if (node) {
        // Check for async initialization promise
        if (node.ready && typeof node.ready.then === 'function') {
          try {
            await node.ready;
            setNodeInstance(node);
          } catch (err) {
            console.error(`[PluginEditor] Async init failed for ${plugin.name}`, err);
            setError("Le processeur DSP du plugin a échoué à s'initialiser.");
          }
        } else {
          setNodeInstance(node);
        }
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          setError("Timeout du moteur de plugin. Le noeud DSP n'a pas pu être créé.");
        } else {
          timer = setTimeout(pollForNode, 100);
        }
      }
    };

    pollForNode();
    return () => clearTimeout(timer);
  }, [trackId, plugin.id, plugin.type, plugin.name, retryCount]);

  // Un seul interrupteur (G17) : l'ancien marche / arrêt interne de l'effet est
  // masqué ; s'il était coupé, on le rallume dedans et on passe l'effet en
  // bypass dans la barre (même résultat à l'oreille, un seul endroit pour le changer).
  // Presets / Comparer (R4) : après un chargement, l'interface de l'effet repart des
  // réglages à jour (uiKey) ; entre deux chargements elle garde son propre état.
  const [uiKey, setUiKey] = useState(0);
  const liveParamsRef = useRef(live.params);
  liveParamsRef.current = live.params;
  const hostParams = React.useMemo(() => {
    const src = (uiKey === 0 ? plugin.params : liveParamsRef.current) as any;
    return (src?.isEnabled === false ? { ...src, isEnabled: true } : src) as any;
  }, [plugin.params, uiKey]);
  const presetMenu = (simple?: boolean) => (
    <PresetMenu plugin={live} simple={simple} onApply={p => stableUpdateParams(p)} onReloaded={() => setUiKey(k => k + 1)} />
  );
  const folded = useRef(false);
  useEffect(() => {
    if (!nodeInstance || folded.current) return;
    folded.current = true;
    const f = foldInternalPower(plugin.params as any, live.isEnabled);
    if (!f) return;
    try { nodeInstance.updateParams?.({ isEnabled: true }); } catch { /* nœud sans réglage isEnabled */ }
    stableUpdateParams(f.params);
    if (f.toggleBypass) onToggleBypass?.(trackId, plugin.id);
  }, [nodeInstance]);

  const handleRetry = () => {
    setError(null);
    setNodeInstance(null);
    setRetryCount(prev => prev + 1);
  };
  
  // Téléphone : les éditeurs ont des largeurs fixes (480-900 px) et leur bouton
  // de fermeture finissait hors écran, sans autre moyen de sortir. Plein écran
  // défilable, barre de fermeture fixe, contenu ajusté à la largeur.
  const mobileShell = (content: React.ReactNode) => (
      <div className="nova-sombre fixed inset-0 z-[300] overflow-y-auto bg-nv-bg pt-14 pb-8">
          <div className="fixed top-0 left-0 right-0 z-[310] h-12 bg-black/90 backdrop-blur-xl border-b border-white/10 flex items-center justify-between pl-4 pr-1">
              <span className="flex min-w-0 items-center gap-2">
                {onToggleBypass && plugin.type !== 'VST3' && (
                  <button type="button" onClick={() => onToggleBypass(trackId, plugin.id)} aria-pressed={live.isEnabled}
                    aria-label={live.isEnabled ? "Désactiver l'effet" : "Activer l'effet"}
                    className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center ${live.isEnabled ? 'bg-cyan-500/25 text-cyan-300' : 'bg-white/5 text-slate-500'}`}>
                    <i className="fas fa-power-off text-xs" />
                  </button>
                )}
                <span className="min-w-0 truncate text-[13px] font-bold text-white"><PluginName plugin={live} showDetail /></span>
                {!live.isEnabled && <span className="shrink-0 rounded bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-300">Bypass</span>}
                {!['SAMPLER', 'DRUM_SAMPLER', 'MELODIC_SAMPLER', 'DRUM_RACK_UI'].includes(plugin.type) && presetMenu(true)}
              </span>
              <button onClick={onClose} aria-label="Fermer" className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10">
                  <i className="fas fa-times"></i>
              </button>
          </div>
          <FitToWidth>{content}</FitToWidth>
      </div>
  );

  // --- SPECIAL CASE: VST3 EXTERNALS ---
  if (plugin.type === 'VST3') {
      const vstWindow = <VSTPluginWindow plugin={plugin} onClose={onClose} trackId={trackId} track={track} onToggleFreeze={onToggleFreeze} presetSlot={isMobile ? undefined : presetMenu()}
        tracks={allTracks} onUpdateTrack={onUpdateTrack} onUpdateParams={stableUpdateParams} />;
      if (isMobile) return mobileShell(vstWindow);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="nova-sombre pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-lg">
                  {vstWindow}
              </div>
          </div>
      );
  }

  // --- SPECIAL CASE: INSTRUMENTS ---
  if (plugin.type === 'SAMPLER') {
      if (isMobile) return mobileShell(<SamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="nova-sombre pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px]">
                  <SamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />
              </div>
          </div>
      );
  }

  if (plugin.type === 'DRUM_SAMPLER') {
      if (isMobile) return mobileShell(<DrumSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="nova-sombre pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px]">
                  <DrumSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />
              </div>
          </div>
      );
  }

  if (plugin.type === 'MELODIC_SAMPLER') {
      if (isMobile) return mobileShell(<MelodicSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="nova-sombre pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px]">
                  <MelodicSamplerEditor plugin={plugin} trackId={trackId} onClose={onClose} />
              </div>
          </div>
      );
  }

  if (plugin.type === 'DRUM_RACK_UI') {
      if (!track || !onUpdateTrack) {
          return <div className="p-10 text-white bg-red-900 rounded">Error: Track Data Missing</div>;
      }
      if (isMobile) return mobileShell(<DrumRack track={track} onUpdateTrack={onUpdateTrack} onClose={onClose} />);
      return (
          <div className="fixed inset-0 flex items-center justify-center z-[300] pointer-events-none">
              <div className="nova-sombre pointer-events-auto shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-[40px] relative">
                  {/* « Fermer » est dans la barre d'outils de la façade (plus de bouton posé par-dessus). */}
                  <DrumRack track={track} onUpdateTrack={onUpdateTrack} onClose={onClose} />
              </div>
          </div>
      );
  }

  // Error state with retry button
  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-[300]">
        <div className="nova-sombre bg-nv-surface border border-red-500/30 p-10 rounded-[32px] text-center w-80 shadow-2xl relative">
          <button aria-label="Fermer" title="Fermer" onClick={onClose} className="absolute top-4 right-4 text-white"><i className="fas fa-times"></i></button>
          <i className="fas fa-bug text-4xl text-red-500 mb-4"></i>
          <p className="text-red-400 font-bold text-xs mb-4">{error}</p>
          <button
            onClick={handleRetry}
            className="px-6 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-white transition-all"
          >
            Réessayer
          </button>
        </div>
      </div>
    );
  }

  // Loading state with spinner
  if (!nodeInstance) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-[300]">
        <div className="nova-sombre bg-nv-surface border border-white/10 p-10 rounded-[32px] text-center w-80 shadow-2xl relative">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin mb-4 mx-auto"></div>
            <p className="text-slate-500 font-black uppercase text-[10px] tracking-widest animate-pulse">Initialisation DSP...</p>
          </div>
          <button aria-label="Fermer" title="Fermer" onClick={onClose} className="absolute top-4 right-4 text-slate-500 hover:text-white"><i className="fas fa-times"></i></button>
        </div>
      </div>
    );
  }

  const renderPluginUI = () => {
    switch(plugin.type) {
      case 'AUTOTUNE': return <><AutotuneEngineNote pluginId={plugin.id} /><AutoTuneUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} /></>;
      case 'REVERB': return <ProfessionalReverbUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'COMPRESSOR': return <VocalCompressorUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'DELAY': return <SyncDelayUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'CHORUS': return <VocalChorusUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'FLANGER': return <StudioFlangerUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'DOUBLER': return <VocalDoublerUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'STEREOSPREADER': return <StereoSpreaderUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'DEESSER': return <VocalDeEsserUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'DENOISER': return <VocalDenoiserUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'PROEQ12': return <ProEQ12UI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams}
        trackKind={trackId === 'master' ? 'master' : (track?.type === TrackType.BUS || track?.type === TrackType.SEND) ? 'bus' : track ? 'piste' : undefined} />;
      case 'VOCALSATURATOR': return <VocalSaturatorUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      case 'MASTERSYNC': return <MasterSyncUI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} />;
      default: {
        const reg = getRegisteredPlugin(plugin.type);
        if (reg) { const UI = reg.ui; return <UI node={nodeInstance} initialParams={hostParams} onParamsChange={stableUpdateParams} trackId={trackId} />; }
        return <div className="p-20 text-white">Plugin UI Not Found</div>;
      }
    }
  };

  // Side-chain (R7) : barre « Clé » au-dessus de la fenêtre du Compresseur, des 4 compresseurs analogiques, du Gate, du Gate rythmique et du De-esser.
  const sidechainBar = (compact?: boolean) => (track && onUpdateTrack && allTracks && supportsSidechain(plugin.type)
    ? <SidechainPanel plugin={live} track={track} tracks={allTracks} onUpdateTrack={onUpdateTrack} onUpdateParams={stableUpdateParams} onReloaded={() => setUiKey(k => k + 1)} compact={compact} />
    : null);

  if (isMobile) {
    return mobileShell(
      <div className="nova-sombre nova-hosted-plugin shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden rounded-none">
        {sidechainBar(true)}
        <div key={uiKey}>{renderPluginUI()}</div>
      </div>
    );
  }

  return (
    <div ref={shellRef} className={`nova-sombre relative group/plugin ${isMobile ? 'w-full h-full flex flex-col items-center justify-center pt-16' : ''}`}
      style={isMobile ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` }}>
      {/* Header Bar (poignée de déplacement) */}
      <div onPointerDown={isMobile ? undefined : startDrag} title={isMobile ? undefined : 'Glisse la barre pour déplacer la fenêtre'}
        className={`absolute left-0 right-0 h-12 bg-black/90 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-6 z-50 shadow-2xl ${isMobile ? 'top-0 fixed' : '-top-14 rounded-full border border-white/10 cursor-move'}`}>
         <div className="flex min-w-0 items-center gap-3">
            {onToggleBypass && (
              <button type="button" onClick={() => onToggleBypass(trackId, plugin.id)} aria-pressed={live.isEnabled}
                title={live.isEnabled ? "Effet actif : clic pour le désactiver (bypass)" : "Effet désactivé (bypass) : clic pour le réactiver"}
                aria-label={live.isEnabled ? "Désactiver l'effet" : "Activer l'effet"}
                className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center transition-colors ${live.isEnabled ? 'bg-cyan-500/25 text-cyan-300 hover:bg-cyan-500/40' : 'bg-white/5 text-slate-500 hover:text-white'}`}>
                <i className="fas fa-power-off text-[10px]" />
              </button>
            )}
            {/* Barre étroite (petite façade, boutons en plus) : nom et piste se raccourcissent au lieu de se chevaucher. */}
            <span className="block min-w-[5.5rem] truncate text-[12px] font-bold text-white"><PluginName plugin={live} showDetail /></span>
            {track && <span className="hidden sm:block min-w-0 truncate text-[11px] text-slate-400" title={`sur ${track.name}`}>sur <b className="text-slate-200">{track.name}</b>{chain.length > 1 && pos >= 0 ? ` · ${pos + 1}/${chain.length}` : ''}</span>}
            {!live.isEnabled && <span className="shrink-0 rounded bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-300">Bypass</span>}
         </div>
         <div className="flex shrink-0 items-center gap-1">
         {presetMenu()}
         {onOpenPlugin && chain.length > 1 && (
           <>
             <button type="button" disabled={!prev} onClick={() => prev && onOpenPlugin(trackId, prev)} aria-label="Effet précédent" title={prev ? `Effet précédent : ${prev.name || prev.type}` : 'Premier effet de la piste'}
               className="w-8 h-8 rounded-full bg-white/5 text-slate-300 hover:bg-white/15 disabled:opacity-30 flex items-center justify-center"><i className="fas fa-chevron-left text-xs" /></button>
             <button type="button" disabled={!next} onClick={() => next && onOpenPlugin(trackId, next)} aria-label="Effet suivant" title={next ? `Effet suivant : ${next.name || next.type}` : 'Dernier effet de la piste'}
               className="w-8 h-8 rounded-full bg-white/5 text-slate-300 hover:bg-white/15 disabled:opacity-30 flex items-center justify-center"><i className="fas fa-chevron-right text-xs" /></button>
           </>
         )}
         {onToggleKeep && (
           <button type="button" onClick={() => onToggleKeep(offsetRef.current)} aria-pressed={kept} data-testid="plugin-keep"
             aria-label={kept ? 'Ne plus garder cette fenêtre ouverte' : 'Garder cette fenêtre ouverte'}
             title={kept ? 'Fenêtre gardée ouverte : clic pour qu’elle redevienne la fenêtre du moment' : 'Garder cette fenêtre ouverte : le prochain effet s’ouvrira à côté (Maj+clic sur un effet fait pareil)'}
             className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${kept ? 'bg-cyan-500/30 text-cyan-200' : 'bg-white/5 text-slate-400 hover:bg-white/15 hover:text-white'}`}>
             <i className="fas fa-thumbtack text-xs" aria-hidden="true" />
           </button>
         )}
         {onCloseAll && openCount > 1 && (
           <button type="button" onClick={onCloseAll} data-testid="plugin-close-all" title={`Tout fermer : les ${openCount} fenêtres d’effet (Maj+Échap)`}
             aria-label="Tout fermer"
             className="h-8 shrink-0 whitespace-nowrap rounded-full bg-white/5 px-2.5 text-[11px] font-bold text-slate-300 hover:bg-white/15 hover:text-white"><i className="fas fa-times mr-1 text-[10px]" aria-hidden="true" />{openCount}</button>
         )}
         <button aria-label="Fermer" title="Fermer (Échap)" onClick={onClose} className="nova-hit w-8 h-8 rounded-full bg-white/5 hover:bg-red-500 text-slate-500 hover:text-white transition-all flex items-center justify-center">
            <i className="fas fa-times text-xs"></i>
         </button>
         </div>
      </div>
      
      {/* Container */}
      {/* La fenêtre ne dépasse jamais l'écran (la barre du haut reste visible), le contenu défile : sur un écran
          de 900 px, le bas de l'Égaliseur (canal, aide) était coupé et inatteignable (audit mix 22/10). */}
      <div data-plugin-body="" className={`nova-hosted-plugin shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden ${isMobile ? 'rounded-none scale-[0.85] origin-top' : 'rounded-[40px] max-h-[calc(100dvh-8.5rem)] overflow-y-auto overscroll-contain'}`}>
        {sidechainBar()}
        <div key={uiKey}>{renderPluginUI()}</div>
      </div>
    </div>
  );
};
export default PluginEditor;
