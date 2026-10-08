import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Track } from '../types';
import { dspMonitor, DspState, safeModeStore } from '../engine/dspMonitor';
import { pickAutoFreeze, rankHeavyTracks, SafetyContext } from '../utils/dspLoad';
import { novaBridge, BridgeState } from '../services/NovaBridge';
import { audioEngine } from '../engine/AudioEngine';
import { barItem } from '../utils/barFit';

/**
 * Compteur « CPU » de la barre de transport (comme la fenêtre Performance de
 * Pro Tools) : charge audio en barres vertes / orange / rouges, état du pont VST
 * dans la MÊME puce (point vert « VST », ou prise orange en reconnexion : la barre
 * débordait avec deux puces),
 * et en surcharge confirmée une alerte qui PROPOSE une solution (geler la piste la
 * plus lourde, tampon de lecture plus grand). Le mode sécurité (gel automatique)
 * est réglé ici et appliqué par l'appli (App, gel par handleFreezeTrack).
 */

const LEVEL_UI = {
  ok: { color: '#22c55e', label: 'normale' },
  charge: { color: '#f59e0b', label: 'élevée' },
  surcharge: { color: '#ef4444', label: 'surcharge' },
} as const;

const ALERT_EVERY_MS = 60_000;

const useDsp = (): DspState => {
  const [s, setS] = useState<DspState>(() => dspMonitor.getState());
  useEffect(() => dspMonitor.subscribe(setS), []);
  return s;
};

export const useSafeMode = () => useSyncExternalStore(safeModeStore.subscribe, safeModeStore.get, safeModeStore.get);

const useBridge = (): BridgeState => {
  const [s, setS] = useState<BridgeState>(() => novaBridge.getBridgeState());
  useEffect(() => novaBridge.subscribe(setS), []);
  return s;
};

/** Tampon de lecture plus grand (planificateur), mémorisé comme dans les réglages audio. */
export function useBiggerBuffer() {
  const [mode, setMode] = useState(() => audioEngine.getLatencyMode());
  const apply = () => {
    audioEngine.setLatencyMode('high');
    try { localStorage.setItem('nova_audio_latency', 'high'); } catch { /* stockage indisponible */ }
    setMode('high');
  };
  return { isMax: mode === 'high', apply };
}

interface Props {
  tracks: Track[];
  onFreezeTrack?: (trackId: string) => void;
  safety: SafetyContext;
  compact?: boolean;
}

const Bars: React.FC<{ value: number; color: string }> = ({ value, color }) => (
  <span className="flex items-end gap-[2px] h-3" aria-hidden="true">
    {[20, 40, 60, 80, 95].map((th, i) => (
      <span key={i} className="w-[3px] rounded-[1px]" style={{ height: `${4 + i * 2}px`, backgroundColor: value >= th || (i === 0 && value > 0) ? color : 'rgba(148,163,184,0.25)' }} />
    ))}
  </span>
);

const DspMeter: React.FC<Props> = ({ tracks, onFreezeTrack, safety, compact = false }) => {
  const s = useDsp();
  const safe = useSafeMode();
  const bridge = useBridge();
  const buffer = useBiggerBuffer();
  const [open, setOpen] = useState(false);
  const [alert, setAlert] = useState<DspState | null>(null);
  const lastAlertRef = useRef(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const safetyRef = useRef(safety);
  safetyRef.current = safety;

  // Alerte : au plus une par minute, seulement si le mode sécurité ne peut pas agir lui-même.
  useEffect(() => dspMonitor.onEpisode(e => {
    if (e.type === 'recovered') { setAlert(null); return; }
    const now = Date.now();
    if (now - lastAlertRef.current < ALERT_EVERY_MS) return;
    if (safeModeStore.get() && pickAutoFreeze(tracksRef.current, safetyRef.current)) return; // le mode sécurité s'en charge
    lastAlertRef.current = now;
    setAlert(e.state);
  }), []);

  const heavy = useMemo(() => rankHeavyTracks(tracks, 3), [tracks]);
  const freezable = useMemo(() => (alert || open ? pickAutoFreeze(tracks, safety) : null), [tracks, safety, alert, open]);
  const ui = LEVEL_UI[s.level];
  const pct = s.dsp;
  const bridgeLabel = bridge.status === 'connected'
    ? `Pont VST connecté : ${bridge.pluginCount} plugin${bridge.pluginCount > 1 ? 's' : ''} du PC disponibles`
    : bridge.status === 'reconnecting' ? `Pont VST : reconnexion… (essai ${bridge.attempt || 1})` : '';
  const label = `Charge audio : ${pct} % (${ui.label})${s.underrunsPerMin ? `, ${s.underrunsPerMin} craquement${s.underrunsPerMin > 1 ? 's' : ''} par minute` : ''}${bridgeLabel ? `. ${bridgeLabel}` : ''}`;

  const rect = btnRef.current?.getBoundingClientRect();
  const panelStyle: React.CSSProperties = rect
    ? { top: rect.bottom + 8, left: Math.max(8, Math.min(window.innerWidth - 328, rect.left + rect.width / 2 - 160)) }
    : { top: 64, left: 8 };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid="dsp-meter"
        data-level={s.level}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={label}
        title={`${label}. Clic : détails, pistes les plus lourdes, mode sécurité${bridge.status === 'reconnecting' ? ', réessayer le pont VST' : ''}.`}
        className={`nova-hit-tactile flex shrink-0 whitespace-nowrap h-8 items-center gap-1.5 rounded-lg px-2 border transition-colors ${s.level === 'surcharge' ? 'border-red-500/50 bg-red-500/15' : bridge.status === 'reconnecting' ? 'border-amber-500/50 bg-amber-500/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
      >
        {!compact && <span {...barItem('libelle-cpu', 7)} className="text-[9px] font-black uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>CPU</span>}
        <Bars value={pct} color={ui.color} />
        {!compact && <span className="mono nova-chiffres text-[10px] font-bold w-7 text-right" style={{ color: ui.color }}>{pct}%</span>}
        {safe && <i className="fas fa-life-ring text-[9px] text-cyan-300" aria-label="Mode sécurité actif"></i>}
        {bridge.status === 'connected' && (
          <span data-testid="bridge-status" data-bridge="connected" className="flex items-center gap-1 border-l border-white/10 pl-1.5 text-[9px] font-black text-emerald-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden="true"></span>{!compact && 'VST'}
          </span>
        )}
        {bridge.status === 'reconnecting' && (
          <span data-testid="bridge-status" data-bridge="reconnecting" className="flex items-center border-l border-white/10 pl-1.5 text-amber-300">
            <i className="fas fa-plug-circle-exclamation text-[10px] animate-pulse" aria-hidden="true"></i>
          </span>
        )}
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[700]" onClick={() => setOpen(false)}>
          <div role="dialog" aria-label="Charge du processeur" data-testid="dsp-panel" onClick={e => e.stopPropagation()}
            className="fixed w-[320px] rounded-2xl border border-white/10 bg-[#14161b] p-4 shadow-2xl text-[12px] text-slate-200" style={panelStyle}>
            <div className="flex items-center justify-between mb-3">
              <p className="font-black text-white text-[13px]">Charge du processeur</p>
              <button type="button" onClick={() => setOpen(false)} aria-label="Fermer" className="w-8 h-8 rounded-lg hover:bg-white/10 text-slate-400"><i className="fas fa-times"></i></button>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 mb-3">
              <dt className="text-slate-400">Audio</dt><dd className="font-bold" style={{ color: ui.color }}>{pct} % · {ui.label}</dd>
              <dt className="text-slate-400">Interface</dt><dd className="font-bold">{s.ui} %</dd>
              <dt className="text-slate-400">Craquements / min</dt><dd className={`font-bold ${s.underrunsPerMin ? 'text-red-300' : ''}`}>{s.underrunsPerMin}</dd>
              <dt className="text-slate-400">Sons en retard</dt><dd className="font-bold">{s.lateEvents}</dd>
            </dl>
            {s.source === 'none' && <p className="text-[11px] text-slate-500 mb-3">Mesure disponible pendant la lecture.</p>}
            {bridgeLabel && (
              <div className={`mb-3 flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 ${bridge.status === 'reconnecting' ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}>
                <span className="text-[11px] font-bold">{bridgeLabel}{bridge.status === 'reconnecting' ? ' NOVA se reconnecte toute seule.' : ''}</span>
                {bridge.status === 'reconnecting' && (
                  <button type="button" onClick={() => { void novaBridge.retryNow(); }} data-testid="bridge-retry"
                    className="h-8 shrink-0 px-2.5 rounded-md bg-amber-400 text-black text-[11px] font-black">Réessayer</button>
                )}
              </div>
            )}
            {heavy.length > 0 && (
              <div className="mb-3">
                <p className="text-[11px] font-bold text-slate-400 mb-1.5">Pistes les plus lourdes</p>
                <ul className="space-y-1">
                  {heavy.map(h => (
                    <li key={h.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{h.name}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-slate-500 mono">{Math.round(h.costMs)} ms/s</span>
                        {onFreezeTrack && <button type="button" onClick={() => onFreezeTrack(h.id)} className="h-7 px-2 rounded-md bg-cyan-500/15 text-cyan-200 text-[11px] font-bold hover:bg-cyan-500/25">Geler</button>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <label className="flex items-start gap-2.5 py-2 border-t border-white/10 cursor-pointer">
              <input type="checkbox" role="switch" checked={safe} onChange={e => safeModeStore.set(e.target.checked)} data-testid="safe-mode" className="mt-0.5 w-4 h-4 accent-cyan-400" />
              <span>
                <span className="block font-bold text-white">Mode sécurité</span>
                <span className="block text-[11px] text-slate-400">En surcharge, NOVA gèle tout seul la piste la plus lourde (jamais pendant une prise, jamais le beat ni une piste armée). Tu peux la dégeler quand tu veux.</span>
              </span>
            </label>
            <button type="button" disabled={buffer.isMax} onClick={buffer.apply} data-testid="bigger-buffer"
              className="mt-2 w-full h-9 rounded-lg border border-white/15 text-[12px] font-bold text-white hover:bg-white/5 disabled:opacity-50">
              {buffer.isMax ? 'Tampon de lecture déjà au maximum' : 'Tampon de lecture plus grand'}
            </button>
            <p className="mt-1.5 text-[10px] text-slate-500">Plus de marge pour programmer les sons (moins de trous) ; l'appui sur Lecture réagit un peu plus tard.</p>
          </div>
        </div>,
        document.body,
      )}

      {alert && createPortal(
        <div role="alert" data-testid="dsp-alert" className="fixed z-[690] top-[72px] left-1/2 -translate-x-1/2 w-[min(440px,calc(100vw-24px))] rounded-2xl border border-red-500/40 bg-[#1a1114] p-4 shadow-2xl text-[12px] text-slate-200">
          <p className="font-black text-white text-[13px] mb-1">⚠ L'ordinateur n'arrive plus à suivre</p>
          <p className="text-slate-300 mb-3">
            {alert.underrunsPerMin > 0 ? `${alert.underrunsPerMin} craquement${alert.underrunsPerMin > 1 ? 's' : ''} sur la dernière minute. ` : 'Des sons partent en retard. '}
            {freezable ? `Geler « ${freezable.name} » (la piste la plus lourde) libère le processeur sans changer le son.` : 'Un tampon de lecture plus grand donne plus de marge.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {freezable && onFreezeTrack && (
              <button type="button" data-testid="dsp-alert-freeze" onClick={() => { onFreezeTrack(freezable.id); setAlert(null); }}
                className="h-10 px-3 rounded-xl bg-cyan-400 text-black font-black text-[12px]">Geler « {freezable.name} »</button>
            )}
            {!buffer.isMax && (
              <button type="button" data-testid="dsp-alert-buffer" onClick={() => { buffer.apply(); setAlert(null); }}
                className="h-10 px-3 rounded-xl border border-white/20 text-white font-bold text-[12px]">Tampon plus grand</button>
            )}
            {!safe && (
              <button type="button" data-testid="dsp-alert-safe" onClick={() => { safeModeStore.set(true); setAlert(null); }}
                className="h-10 px-3 rounded-xl border border-white/20 text-white font-bold text-[12px]">Activer le mode sécurité</button>
            )}
            <button type="button" onClick={() => setAlert(null)} className="h-10 px-3 rounded-xl text-slate-400 text-[12px] underline">Ignorer</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default DspMeter;
