import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Track } from '../types';
import { novaBridge, BridgePlugin } from '../services/NovaBridge';
import { closeInstrumentEditor, openInstrumentEditor } from '../services/VstInstrument';
import { useBridgeState } from '../hooks/useNovaBridge';
import { useInstrumentStatus } from '../utils/instrumentStore';
import { BridgeConnectPanel, VST_BRIDGE_DOWNLOAD_URL } from './VstBrowserTab';
import { isNovaDesktop } from '../utils/desktopApp';

/**
 * Choix du son d'une piste MIDI (mode instru) : synthé Nova ou instrument VST3
 * du PC (pont VST). Affiché dans la barre du piano roll.
 */
const VstInstrumentPicker: React.FC<{
  track: Track;
  /** Son plus à jour avec les notes (signalé seulement si le pont ne peut pas le refaire). */
  stale?: boolean;
  onChoose: (p: BridgePlugin) => void;
  onUseSynth: () => void;
  onRetry: () => void;
  onError: (msg: string) => void;
}> = ({ track, stale, onChoose, onUseSynth, onRetry, onError }) => {
  const bridge = useBridgeState();
  const status = useInstrumentStatus(track.id);
  const [open, setOpen] = useState(false);
  const [plugins, setPlugins] = useState<BridgePlugin[]>(() => novaBridge.getCachedInstruments());
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inst = track.vstInstrument;
  const connected = bridge.status === 'connected';
  const ready = connected && bridge.instruments;
  const pending = bridge.instrumentsPending;

  // Liste à l'ouverture, puis toutes les 3 s tant que le pont lit les plugins.
  useEffect(() => {
    if (!open || !ready) return;
    let live = true;
    const load = () => {
      setListing(true);
      novaBridge.listPlugins().then(() => { if (live) setPlugins(novaBridge.getCachedInstruments()); })
        .catch(() => { /* l'état du pont l'affiche */ })
        .finally(() => { if (live) setListing(false); });
    };
    load();
    const id = pending ? window.setInterval(load, 3000) : null;
    return () => { live = false; if (id) window.clearInterval(id); };
  }, [open, ready, !!pending]);

  // Clic hors du panneau : fermeture.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter(p => !q || p.name.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q)).slice(0, 200);
  }, [plugins, query]);

  // Plugins pas lus car ils demandent une activation : peut-être des instruments.
  const toActivate = useMemo(() => {
    const q = query.trim().toLowerCase();
    return novaBridge.getCachedToActivate()
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q)).slice(0, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, query]);

  const busy = status.loading || status.rendering;
  const label = inst ? inst.name : 'Synthé Nova';

  const editor = async () => {
    try {
      if (status.editorOpen) await closeInstrumentEditor(track.id);
      else await openInstrumentEditor(track);
    } catch (e: any) {
      onError(e?.message || 'Fenêtre du plugin impossible à ouvrir');
    }
  };

  return (
    <div className="relative" ref={boxRef} data-vst-instrument-picker>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Son de la piste : synthé Nova ou instrument VST de ton PC"
        className={`h-8 px-3 rounded-lg border flex items-center gap-2 text-[10px] font-bold max-w-[220px] ${inst ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200' : 'bg-white/5 border-white/10 text-slate-300 hover:text-white'}`}
      >
        <i className={`fas ${inst ? 'fa-plug' : 'fa-wave-square'} text-[9px]`}></i>
        <span className="truncate">{label}</span>
        {busy && <span className="text-fuchsia-300 font-normal whitespace-nowrap" role="status"><i className="fas fa-circle-notch fa-spin mr-1"></i>{status.loading ? 'chargement…' : 'rendu…'}</span>}
        {!busy && status.error && <i className="fas fa-exclamation-triangle text-amber-400" title={status.error}></i>}
        {!busy && !status.error && stale && !ready && <i className="fas fa-exclamation-triangle text-amber-400" title="Notes modifiées : connecte le pont VST pour mettre le son à jour"></i>}
        <i className="fas fa-chevron-down text-[8px] opacity-60"></i>
      </button>

      {open && (
        // Fixe : la barre du piano roll défile en largeur et couperait un panneau absolu.
        <div role="dialog" aria-label="Son de la piste" className="fixed w-80 max-w-[calc(100vw-32px)] max-h-[70vh] overflow-y-auto bg-[#1a1c22] border border-white/20 rounded-xl shadow-2xl z-[300] p-3 space-y-3 text-left"
          style={(() => { const r = boxRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 8, left: Math.max(16, Math.min(r.left, window.innerWidth - 336)) } : { top: 64, left: 16 }; })()}>
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Son de la piste</div>

          <button type="button" onClick={() => { if (inst) onUseSynth(); setOpen(false); }}
            className={`w-full p-2.5 rounded-lg border flex items-center gap-2 text-xs ${!inst ? 'border-cyan-500/40 bg-cyan-500/10 text-white' : 'border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/[0.05]'}`}>
            <i className="fas fa-wave-square text-cyan-400 w-4"></i>
            <span className="flex-1 text-left font-bold">Synthé Nova</span>
            {!inst && <i className="fas fa-check text-cyan-400"></i>}
          </button>

          {inst && (
            <div className="p-2.5 rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 space-y-2">
              <div className="flex items-center gap-2">
                <i className="fas fa-plug text-fuchsia-300 w-4 text-xs"></i>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-white truncate">{inst.name}</div>
                  <div className="text-[10px] text-slate-400 truncate">{inst.vendor || 'Instrument VST du PC'}</div>
                </div>
                <i className="fas fa-check text-fuchsia-300"></i>
              </div>
              {status.error && <p className="text-[11px] text-amber-300" role="status">Rendu impossible : {status.error}. Le synthé Nova joue tes notes en attendant.</p>}
              {!status.error && stale && !ready && <p className="text-[11px] text-amber-300">Tes notes ont changé : connecte le pont VST pour mettre le son à jour.</p>}
              {status.editorOpen && <p className="text-[11px] text-fuchsia-100">Fenêtre ouverte sur ton PC : choisis ton son, il s'applique tout seul à la piste.</p>}
              {ready && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => { void editor(); }} disabled={status.loading}
                    className="flex-1 h-9 rounded-lg bg-fuchsia-500 text-black text-[11px] font-black hover:bg-fuchsia-400 disabled:opacity-60">
                    {status.editorOpen ? "J'ai fini" : 'Choisir le son'}
                  </button>
                  {status.error && (
                    <button type="button" onClick={onRetry} className="h-9 px-3 rounded-lg bg-white/10 text-white text-[11px] font-bold hover:bg-white/20">Réessayer</button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="pt-1 border-t border-white/10 space-y-2">
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 pt-2">Instrument VST du PC</div>
            {!connected && (
              <>
                <p className="text-[11px] text-slate-400">Joue tes notes avec tes instruments VST3 (Serum, Vital, Kontakt…). Le son est gardé dans le projet : il marche aussi sur ton téléphone.</p>
                <BridgeConnectPanel compact />
              </>
            )}
            {connected && !bridge.instruments && (
              <p role="status" className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                {isNovaDesktop()
                  ? 'Ton pont VST est trop ancien pour les instruments : mets à jour Nova Studio.'
                  : <>Ton pont VST est trop ancien pour les instruments : mets à jour le pont VST. <a href={VST_BRIDGE_DOWNLOAD_URL} download className="text-cyan-400 underline">Télécharger NovaVSTBridge.exe</a>, ferme l'ancien, lance le nouveau puis reconnecte-toi.</>}
              </p>
            )}
            {ready && (
              <>
                <input
                  type="text" value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Chercher un instrument…" aria-label="Chercher un instrument VST"
                  className="w-full h-9 bg-black/40 border border-white/10 rounded-lg px-3 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-fuchsia-500/40"
                />
                {pending && (
                  <p className="text-[10px] text-slate-400" role="status">
                    <i className="fas fa-circle-notch fa-spin mr-1"></i>
                    Recherche des instruments sur ton PC{pending[1] ? ` (${pending[0]}/${pending[1]})` : ''}… (une seule fois)
                  </p>
                )}
                <div className="space-y-1">
                  {filtered.map(p => (
                    <button key={p.id} type="button" data-vst-instrument={p.name}
                      onClick={() => { onChoose(p); setOpen(false); }}
                      className={`w-full p-2 rounded-lg border flex items-center gap-2 text-left ${inst?.path === p.path && (inst?.pluginName || null) === (p.pluginName || null) ? 'border-fuchsia-500/40 bg-fuchsia-500/10' : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.05]'}`}>
                      <i className="fas fa-keyboard text-fuchsia-300 text-[10px] w-4"></i>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-bold text-white truncate">{p.name}</span>
                        <span className="block text-[9px] text-slate-500 truncate">{p.vendor || 'VST3'}{p.license === 'nag' ? ' · fenêtre de licence à chaque ouverture' : p.license ? ' · activation à faire' : ''}</span>
                      </span>
                    </button>
                  ))}
                  {filtered.length === 0 && (
                    <p className="text-[11px] text-slate-500 py-3 text-center">
                      {listing || pending ? 'Recherche des instruments…' : query ? 'Aucun instrument ne correspond.' : 'Aucun instrument VST3 trouvé sur ce PC.'}
                    </p>
                  )}
                </div>
                {toActivate.length > 0 && (
                  <div className="space-y-1 pt-2 border-t border-white/10">
                    <div className="text-[9px] font-black uppercase tracking-widest text-amber-300/80 pt-1">À activer ({toActivate.length})</div>
                    <p className="text-[10px] text-slate-400">Ces plugins demandent une activation de licence avant d'être lus. Choisis-en un : sa fenêtre d'activation s'ouvre sur ton PC.</p>
                    {toActivate.map(p => (
                      <button key={p.id} type="button" data-vst-to-activate={p.name}
                        onClick={() => { onChoose(p); setOpen(false); }}
                        className="w-full p-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] hover:bg-amber-500/10 flex items-center gap-2 text-left">
                        <i className="fas fa-key text-amber-300 text-[10px] w-4"></i>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-bold text-white truncate">{p.name}</span>
                          <span className="block text-[9px] text-slate-500 truncate">{p.vendor || 'VST3'}{p.license === 'nag' ? ' · fenêtre de licence à chaque ouverture' : ''}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default VstInstrumentPicker;
