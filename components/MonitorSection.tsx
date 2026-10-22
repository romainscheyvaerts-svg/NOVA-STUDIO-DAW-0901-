import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DIM_DB, MONITOR_VOL_MAX_DB, MONITOR_VOL_MIN_DB, SOLO_LISTEN_HELP, SOLO_LISTEN_LABEL,
  isMonitorNeutral, monitorBadges, monitorStore, useMonitor, type MonitorMatrix, type SoloListen,
} from '../utils/monitorSection';
import { audioEngine } from '../engine/AudioEngine';

/**
 * Section d'écoute (utils/monitorSection) : mono / côtés, Dim −20 dB, coupure,
 * volume d'écoute séparé du master, mode de solo (dans le mix, AFL, PFL).
 * Ce qu'on entend seulement : l'export n'est jamais touché.
 *
 * - MonitorBadges : pastilles visibles tant qu'un réglage est actif (même en
 *   mode simple), un clic l'éteint — pour ne jamais oublier un mono ou un Dim.
 * - MonitorButton : bouton « Écoute » de la barre (mode avancé) et son panneau.
 * - MasterMonitorStrip : la même chose en ligne compacte sur la tranche master.
 * - SoloListenChoice : le choix du mode de solo (panneau, réglages audio).
 */

const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} dB`;

/** Le bus d'écoute AFL / PFL est-il en train de remplacer le mix ? (événement du moteur, sans boucle). */
function useListening(): boolean {
  const m = useMonitor();
  const [on, setOn] = useState(() => { try { return audioEngine.isListenBusActive(); } catch { return false; } });
  useEffect(() => {
    const f = () => { try { setOn(audioEngine.isListenBusActive()); } catch { /* moteur absent */ } };
    window.addEventListener('nova:listen-bus', f);
    f();
    return () => window.removeEventListener('nova:listen-bus', f);
  }, [m.listen]);
  return on;
}

export const MonitorBadges: React.FC<{ className?: string }> = ({ className = '' }) => {
  const m = useMonitor();
  const listening = useListening();
  const badges = monitorBadges(m, m.listen, listening);
  if (!badges.length) return null;
  const off = (id: string) => {
    if (id === 'cut') monitorStore.set({ cut: false });
    else if (id === 'mono' || id === 'side') monitorStore.set({ matrix: 'stereo' });
    else if (id === 'dim') monitorStore.set({ dim: false });
    else if (id === 'vol') monitorStore.set({ volumeDb: 0 });
  };
  return (
    <div className={`flex items-center gap-1 ${className}`} role="status" aria-label="Réglages d'écoute actifs" data-testid="monitor-badges">
      {badges.map(b => {
        const clickable = b.id !== 'afl' && b.id !== 'pfl';
        const color = b.id === 'cut' ? 'bg-red-600 text-white border-red-400'
          : b.id === 'dim' || b.id === 'vol' ? 'bg-amber-400 text-black border-amber-300'
          : b.id === 'afl' || b.id === 'pfl' ? 'bg-emerald-400 text-black border-emerald-300'
          : 'bg-sky-400 text-black border-sky-300';
        return clickable ? (
          <button key={b.id} type="button" data-testid={`monitor-badge-${b.id}`} onClick={(e) => { e.stopPropagation(); off(b.id); }}
            title={`${b.title} Clic : revenir à la normale.`} aria-label={`${b.text} : clic pour revenir à la normale`}
            className={`nova-hit-tactile h-6 [@media(pointer:coarse)]:h-8 px-1.5 rounded-md border text-[9px] font-black whitespace-nowrap ${color}`}>{b.text}</button>
        ) : (
          <span key={b.id} data-testid={`monitor-badge-${b.id}`} title={b.title}
            className={`inline-flex items-center h-6 [@media(pointer:coarse)]:h-8 px-1.5 rounded-md border text-[9px] font-black whitespace-nowrap ${color}`}>{b.text}</span>
        );
      })}
    </div>
  );
};

const seg = (on: boolean, color: string) =>
  `nova-hit-tactile h-8 px-2 rounded-md text-[10px] font-black border transition-colors ${on ? color : 'bg-white/[0.05] border-white/10 text-slate-300 hover:text-white'}`;

const MATRIX: { id: MonitorMatrix; label: string; title: string }[] = [
  { id: 'stereo', label: 'Stéréo', title: 'Écoute normale, en stéréo.' },
  { id: 'mono', label: 'Mono', title: 'Écoute en mono : G + D à −6 dB (un son centré garde son niveau). Vérifie que rien ne disparaît sur un téléphone. Raccourci : Alt+M.' },
  { id: 'side', label: 'Côtés (S)', title: 'Écoute des côtés seuls (G − D) : ce qui disparaît en mono (réverbes, doublages, largeur).' },
];

export const MatrixButtons: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const m = useMonitor();
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Écoute stéréo, mono ou côtés">
      {MATRIX.map(x => (
        <button key={x.id} type="button" role="radio" aria-checked={m.matrix === x.id} data-testid={`monitor-matrix-${x.id}`}
          onClick={(e) => { e.stopPropagation(); monitorStore.set({ matrix: x.id }); }} title={`${x.title} L'export n'est pas touché.`}
          className={`${seg(m.matrix === x.id, x.id === 'stereo' ? 'bg-white/20 border-white/30 text-white' : 'bg-sky-400 border-sky-300 text-black')} ${compact ? 'flex-1 px-1' : ''}`}>
          {compact && x.id === 'side' ? 'S' : x.label}
        </button>
      ))}
    </div>
  );
};

export const DimCutButtons: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const m = useMonitor();
  return (
    <div className="flex gap-1">
      <button type="button" aria-pressed={m.dim} data-testid="monitor-dim" onClick={(e) => { e.stopPropagation(); monitorStore.toggleDim(); }}
        title={`Dim : baisse l'écoute de ${-DIM_DB} dB d'un clic (parler, téléphone), sans toucher au mix. Raccourci : Alt+D.`}
        className={`${seg(m.dim, 'bg-amber-400 border-amber-300 text-black')} ${compact ? 'flex-1 px-1' : ''}`}>Dim {DIM_DB}</button>
      <button type="button" aria-pressed={m.cut} data-testid="monitor-cut" onClick={(e) => { e.stopPropagation(); monitorStore.toggleCut(); }}
        title="Couper l'écoute (rien ne sort des enceintes ni du casque principal) ; le mix, les mètres et l'export continuent. Raccourci : Alt+X."
        className={`${seg(m.cut, 'bg-red-600 border-red-400 text-white')} ${compact ? 'flex-1 px-1' : ''}`}>{compact ? 'Couper' : "Couper l'écoute"}</button>
    </div>
  );
};

export const MonitorVolume: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const m = useMonitor();
  return (
    <label className="flex items-center gap-2 min-w-0" title="Volume d'écoute (enceintes / casque principal), séparé du fader master : l'export n'est pas touché. Double-clic : 0 dB.">
      <span className={`shrink-0 font-bold text-slate-400 ${compact ? 'text-[8px] uppercase' : 'text-[10px]'}`}>{compact ? 'Vol.' : "Volume d'écoute"}</span>
      <input type="range" min={MONITOR_VOL_MIN_DB} max={MONITOR_VOL_MAX_DB} step={0.5} value={m.volumeDb} data-testid="monitor-volume"
        aria-label="Volume d'écoute" aria-valuetext={fmtDb(m.volumeDb)}
        onChange={e => monitorStore.set({ volumeDb: parseFloat(e.target.value) })}
        onDoubleClick={() => monitorStore.set({ volumeDb: 0 })}
        className="min-w-0 flex-1 accent-amber-400" />
      <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-200">{fmtDb(m.volumeDb)}</span>
    </label>
  );
};

export const SoloListenChoice: React.FC<{ dense?: boolean }> = ({ dense }) => {
  const m = useMonitor();
  return (
    <div role="radiogroup" aria-label="Mode de solo" className={dense ? 'space-y-1' : 'space-y-1.5'} data-testid="solo-listen-choice">
      {(['sip', 'afl', 'pfl'] as SoloListen[]).map(id => (
        <button key={id} type="button" role="radio" aria-checked={m.listen === id} data-testid={`solo-listen-${id}`}
          onClick={(e) => { e.stopPropagation(); monitorStore.set({ listen: id }); }} title={SOLO_LISTEN_HELP[id]}
          className={`w-full text-left rounded-lg border px-2 ${dense ? 'py-1' : 'py-1.5'} transition-colors ${m.listen === id ? 'border-emerald-400/70 bg-emerald-400/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}>
          <span className={`block text-[11px] font-bold ${m.listen === id ? 'text-emerald-200' : 'text-slate-200'}`}>{m.listen === id ? '● ' : '○ '}{SOLO_LISTEN_LABEL[id]}</span>
          {!dense && <span className="block text-[10px] leading-snug text-slate-400">{SOLO_LISTEN_HELP[id]}</span>}
        </button>
      ))}
    </div>
  );
};

/** Panneau complet (popover de la barre). */
export const MonitorPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const m = useMonitor();
  return (
    <div className="space-y-3" data-testid="monitor-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-black uppercase tracking-wider text-slate-200">Écoute</span>
        <span className="text-[10px] text-slate-400">Ce que tu entends seulement : l'export ne change jamais.</span>
      </div>
      <MatrixButtons />
      <DimCutButtons />
      <MonitorVolume />
      <div className="h-px bg-white/10" />
      <div className="text-[10px] font-black uppercase tracking-wider text-slate-300">Mode de solo</div>
      <SoloListenChoice dense />
      <div className="flex justify-between gap-2 pt-1">
        <button type="button" disabled={isMonitorNeutral(m)} data-testid="monitor-reset" onClick={() => monitorStore.reset()}
          className="h-8 rounded-md border border-white/10 px-2 text-[10px] font-bold text-slate-200 hover:bg-white/10 disabled:opacity-40"
          title="Stéréo, sans Dim ni coupure, volume d'écoute à 0 dB (le mode de solo est gardé).">Tout remettre à zéro</button>
        <button type="button" onClick={onClose} className="h-8 rounded-md bg-white/10 px-3 text-[10px] font-bold text-white hover:bg-white/20">Fermer</button>
      </div>
    </div>
  );
};

/** Bouton « Écoute » de la barre et son panneau (posé au-dessus de tout, sans pousser la barre). */
export const MonitorButton: React.FC<{ barProps?: Record<string, unknown> }> = ({ barProps }) => {
  const m = useMonitor();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 6, left, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    // Échap ferme le panneau SEULEMENT (sinon le raccourci global « Stop » arrêtait la lecture en même temps).
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const active = !isMonitorNeutral(m) || m.listen !== 'sip';
  return (
    <>
      <button ref={btn} type="button" {...(barProps || {})} data-testid="open-monitor" aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen(o => !o)}
        title="Écoute : mono, côtés, Dim −20 dB, couper, volume d'écoute, solo AFL / PFL. Rien de tout ça ne change l'export."
        aria-label="Section d'écoute (mono, Dim, volume d'écoute, mode de solo)"
        className={`nova-hit-tactile h-8 px-2 rounded-lg flex items-center gap-1 border transition-all ${active ? 'border-sky-400/60 bg-sky-400/15 text-sky-200' : 'border-white/10 bg-white/[0.05] text-slate-400 hover:text-white hover:bg-white/10'}`}>
        <i className="fas fa-headphones-alt text-[10px]" aria-hidden="true" />
        <span className="text-[10px] font-bold tracking-wide">Écoute</span>
      </button>
      {open && pos && createPortal(
        <div ref={panel} role="dialog" aria-label="Section d'écoute"
          className="fixed z-[200] rounded-xl border border-white/10 bg-nv-surface p-3 shadow-2xl shadow-black/60 [[data-theme=light]_&]:bg-white"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: `calc(100vh - ${pos.top + 8}px)`, overflowY: 'auto' }}>
          <MonitorPanel onClose={() => setOpen(false)} />
        </div>, document.body)}
    </>
  );
};

/** Tranche master de la console : écoute en une ligne (mono, côtés, Dim, couper) + volume d'écoute. */
export const MasterMonitorStrip: React.FC = () => (
  <div className="mt-2 space-y-1 rounded-lg border border-white/10 bg-black/20 p-1.5" data-testid="master-monitor" onClick={e => e.stopPropagation()}>
    <div className="text-[8px] font-black uppercase tracking-wider text-slate-500" title="Ce que tu entends seulement : l'export ne change jamais.">Écoute (hors export)</div>
    <MatrixButtons compact />
    <DimCutButtons compact />
    <MonitorVolume compact />
  </div>
);

export default MonitorButton;
