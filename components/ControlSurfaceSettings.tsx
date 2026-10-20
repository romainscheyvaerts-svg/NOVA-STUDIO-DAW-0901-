import React, { useState, useSyncExternalStore } from 'react';
import { controlSurface, SurfaceStatus } from '../services/ControlSurface';

/**
 * Préférences › Surfaces de contrôle : Mackie Control (MCU) ou HUI par Web MIDI.
 * Ports d'entrée / de sortie, protocole, détection, état de la connexion.
 */
const STATUS_UI: Record<SurfaceStatus, { label: string; dot: string; text: string }> = {
  off: { label: 'Désactivée', dot: 'bg-slate-500', text: 'text-slate-400' },
  unsupported: { label: 'MIDI indisponible', dot: 'bg-red-500', text: 'text-red-300' },
  denied: { label: 'MIDI refusé', dot: 'bg-red-500', text: 'text-red-300' },
  'needs-click': { label: 'À autoriser', dot: 'bg-amber-400', text: 'text-amber-300' },
  opening: { label: 'Ouverture…', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
  'no-ports': { label: 'Introuvable', dot: 'bg-amber-400', text: 'text-amber-300' },
  waiting: { label: 'En attente', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
  connected: { label: 'Connectée', dot: 'bg-green-500', text: 'text-green-300' },
};

const sel = 'w-full h-10 bg-nv-surface border border-white/10 rounded-xl px-3 text-[11px] font-medium text-white focus:border-cyan-500 outline-none transition-all hover:bg-nv-raised disabled:opacity-50';

export const ControlSurfaceSettings: React.FC = () => {
  const snap = useSyncExternalStore(cb => controlSurface.subscribe(cb), () => controlSurface.getSnapshot(), () => controlSurface.getSnapshot());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ui = STATUS_UI[snap.status];
  const { config } = snap;
  const listed = snap.inputs.length + snap.outputs.length > 0;

  const run = async (fn: () => Promise<unknown> | unknown) => {
    setBusy(true); setNote(null);
    try { const r = await fn(); if (typeof r === 'string') setNote(r); } finally { setBusy(false); }
  };

  const inputOptions = [...snap.inputs];
  if (config.inputName && !inputOptions.some(p => p.name === config.inputName)) inputOptions.unshift({ id: '__saved_in', name: config.inputName, state: 'disconnected' });
  const outputOptions = [...snap.outputs];
  if (config.outputName && !outputOptions.some(p => p.name === config.outputName)) outputOptions.unshift({ id: '__saved_out', name: config.outputName, state: 'disconnected' });

  const firstTrack = snap.bank + 1;
  const lastTrack = Math.min(snap.trackCount, snap.bank + 8);

  return (
    <section id="nova-surfaces-controle" aria-labelledby="nova-surfaces-titre" className="space-y-4" data-control-surface-settings="">
      <div className="flex items-center justify-between">
        <span id="nova-surfaces-titre" className="text-[10px] font-black text-cyan-400 uppercase tracking-widest bg-cyan-500/10 px-2 py-0.5 rounded">Surfaces de contrôle</span>
        <span className={`flex items-center gap-1.5 text-[10px] font-bold ${ui.text}`} data-surface-status={snap.status} role="status" aria-live="polite">
          <span className={`w-2 h-2 rounded-full ${ui.dot}`} aria-hidden="true" />{ui.label}
        </span>
      </div>
      <p className="text-[10px] text-slate-400 leading-relaxed">
        Pilote NOVA avec une surface Mackie Control (X-Touch, X-Touch One, FaderPort, Icon, SSL UF8…) ou HUI :
        faders motorisés, mute / solo / rec, banques de 8, transport, molette, afficheurs et vumètres.
        Mets la surface en mode <strong className="text-slate-200">MC / Mackie Control</strong> (ou HUI) avant de la connecter.
      </p>

      {!snap.supported ? (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-200" role="alert">
          Ce navigateur ne gère pas le MIDI (Web MIDI). Utilise Chrome ou Edge, ou l’appli Nova Studio.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="space-y-1.5 block">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Protocole</span>
              <select className={sel} value={config.protocol} disabled={busy} aria-label="Protocole de la surface"
                onChange={e => run(() => controlSurface.setProtocol(e.target.value === 'hui' ? 'hui' : 'mcu'))}>
                <option value="mcu">Mackie Control (MCU)</option>
                <option value="hui">HUI</option>
              </select>
            </label>
            <label className="space-y-1.5 block">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Entrée MIDI (surface → NOVA)</span>
              <select className={sel} value={config.inputName || ''} disabled={busy || !listed} aria-label="Port d'entrée MIDI de la surface"
                onChange={e => run(() => controlSurface.setPorts(e.target.value || null, config.outputName))}>
                <option value="">{listed ? '— Choisir —' : 'Clique sur « Lister les ports »'}</option>
                {inputOptions.map(p => <option key={p.id} value={p.name}>{p.name}{p.state === 'disconnected' ? ' (débranchée)' : ''}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 block">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Sortie MIDI (NOVA → surface)</span>
              <select className={sel} value={config.outputName || ''} disabled={busy || !listed} aria-label="Port de sortie MIDI de la surface"
                onChange={e => run(() => controlSurface.setPorts(config.inputName, e.target.value || null))}>
                <option value="">{listed ? '— Choisir —' : 'Clique sur « Lister les ports »'}</option>
                {outputOptions.map(p => <option key={p.id} value={p.name}>{p.name}{p.state === 'disconnected' ? ' (débranchée)' : ''}</option>)}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!listed && (
              <button type="button" disabled={busy} onClick={() => run(() => controlSurface.refreshPorts())}
                className="px-3 py-2 rounded-lg text-[10px] font-bold bg-white/10 text-white hover:bg-white/20 disabled:opacity-50">
                Lister les ports
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => run(() => controlSurface.detect())}
              className="px-3 py-2 rounded-lg text-[10px] font-bold bg-white/10 text-white hover:bg-white/20 disabled:opacity-50"
              title="Cherche une surface connue parmi les ports MIDI (X-Touch, FaderPort, Icon, UF8, Mackie…)">
              <i className="fas fa-search mr-1.5" aria-hidden="true" />Détecter
            </button>
            {config.enabled ? (
              <>
                <button type="button" disabled={busy} onClick={() => run(() => controlSurface.connect())}
                  className="px-3 py-2 rounded-lg text-[10px] font-bold bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50">
                  {snap.status === 'connected' ? 'Reconnecter' : snap.status === 'denied' ? 'Réessayer' : 'Connecter'}
                </button>
                <button type="button" disabled={busy} onClick={() => run(() => controlSurface.disable())}
                  className="px-3 py-2 rounded-lg text-[10px] font-bold bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-50">
                  Désactiver
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => run(() => controlSurface.enable())}
                className="px-3 py-2 rounded-lg text-[10px] font-bold bg-cyan-500 text-black hover:bg-cyan-400 disabled:opacity-50">
                Activer la surface
              </button>
            )}
          </div>

          {(snap.message || note) && (
            <p className={`text-[10px] leading-relaxed ${snap.status === 'denied' || snap.status === 'unsupported' ? 'text-red-300' : 'text-slate-300'}`} data-surface-message="">
              {note && note !== snap.message ? <>{note}<br /></> : null}{snap.message}
            </p>
          )}
          {snap.sysex === false && config.enabled && (
            <p className="text-[10px] text-amber-300">
              Le navigateur a refusé le SysEx : les faders et boutons marchent, mais les noms de pistes ne s’affichent pas sur la surface.
            </p>
          )}
          {snap.status === 'connected' && snap.trackCount > 0 && (
            <p className="text-[10px] text-slate-400" data-surface-bank="">
              Banque : pistes {firstTrack} à {lastTrack} sur {snap.trackCount}. BANK ◀ ▶ : 8 pistes ; CHANNEL ◀ ▶ : une piste.
            </p>
          )}
        </>
      )}
    </section>
  );
};

export default ControlSurfaceSettings;
