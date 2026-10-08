import React, { ErrorInfo, ReactNode } from 'react';
import { logClientError } from '../utils/errorLog';
import { openFeedback } from '../services/feedback';

/**
 * Isolation des erreurs par zone du studio (console, arrangement, fenêtre
 * d'effet…). Avant, une seule erreur d'affichage n'importe où remplaçait TOUT
 * le studio par l'écran « Nova a rencontré un problème » : le transport et la
 * console disparaissaient. Ici seul le panneau fautif est remplacé par un
 * message ; le son (moteur hors React) et le reste de l'interface continuent.
 *
 * Injection de pannes (tests de bout en bout) : si
 * `globalThis.__novaFaults` (Set) contient le nom du panneau, un enfant sonde
 * lève une erreur au rendu. Coût nul sinon.
 */

interface Props {
  /** Nom lisible, en français, avec son article : « la console de mixage ». */
  name: string;
  children?: ReactNode;
  /** Affichage réduit (barre, petit panneau). */
  compact?: boolean;
  /** Fermer le panneau (proposé après des plantages répétés). */
  onClose?: () => void;
  /** Fenêtre flottante (modale, panneau superposé) : le message flotte aussi, au-dessus du studio. */
  overlay?: boolean;
}

interface State {
  error: Error | null;
  /** Clé des enfants : l'incrémenter les remonte de zéro. */
  generation: number;
  /** Instants des derniers plantages (fenêtre de 30 s). */
  crashes: number[];
}

const REPEAT_WINDOW_MS = 30_000;
const REPEAT_COUNT = 3;

/** Panne injectée (tests) : lève au rendu si le panneau est dans __novaFaults. */
const FaultProbe: React.FC<{ name: string }> = ({ name }) => {
  const faults = (globalThis as any).__novaFaults as Set<string> | undefined;
  if (faults && typeof faults.has === 'function' && faults.has(name)) {
    throw new Error(`Panne injectée (test) : ${name}`);
  }
  return null;
};

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export class PanelBoundary extends React.Component<Props, State> {
  state: State = { error: null, generation: 0, crashes: [] };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Panneau] ${this.props.name} :`, error, info?.componentStack);
    logClientError(error, `panneau:${this.props.name}`);
    const now = Date.now();
    this.setState(s => ({ crashes: [...s.crashes.filter(t => now - t < REPEAT_WINDOW_MS), now] }));
    try { window.dispatchEvent(new CustomEvent('nova:panel-crash', { detail: { name: this.props.name, message: String(error?.message || error) } })); } catch { /* hors navigateur */ }
  }

  relaunch = () => {
    this.setState(s => ({ error: null, generation: s.generation + 1 }));
  };

  close = () => {
    this.setState(s => ({ error: null, generation: s.generation + 1, crashes: [] }));
    this.props.onClose?.();
  };

  render(): ReactNode {
    const { name, compact, onClose, overlay, children } = this.props;
    const { error, generation, crashes } = this.state;
    if (!error) {
      return (
        <React.Fragment key={generation}>
          <FaultProbe name={name} />
          {children}
        </React.Fragment>
      );
    }
    const repeated = crashes.length >= REPEAT_COUNT;
    const title = `${capitalize(name)} a rencontré un problème.`;
    const card = (
      <div
        role="alert"
        data-panel-crash={name}
        className={`${compact ? 'p-2 gap-2 flex-row' : 'p-5 gap-3 flex-col'} flex items-center justify-center text-center rounded-xl border border-amber-400/30 bg-amber-400/[0.06] text-slate-200 min-h-0 m-1`}
      >
        <div className={compact ? 'text-left' : ''}>
          <p className={`${compact ? 'text-[12px]' : 'text-sm'} font-bold text-amber-200`}>⚠️ {title}</p>
          <p className={`${compact ? 'text-[11px]' : 'text-[12px]'} text-slate-400`}>
            Le son et le reste du studio continuent.{repeated ? ' Ce panneau plante à répétition.' : ''}
          </p>
          {!compact && <p className="mt-1 text-[10px] text-slate-500 break-words max-w-md">{String(error.message || error).slice(0, 160)}</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <button type="button" onClick={this.relaunch} className="min-h-9 px-3 rounded-lg bg-amber-300 text-black text-[12px] font-black">
            Relancer ce panneau
          </button>
          {repeated && onClose && (
            <button type="button" onClick={this.close} className="min-h-9 px-3 rounded-lg border border-white/15 text-[12px] font-bold text-white">
              Fermer ce panneau
            </button>
          )}
          <button
            type="button"
            onClick={() => openFeedback({ category: 'bug', title: `Panneau en panne : ${name}` })}
            className="min-h-9 px-2 text-[12px] text-cyan-300 underline"
          >
            Signaler
          </button>
        </div>
      </div>
    );
    if (!overlay) return card;
    return (
      <div className="fixed inset-x-0 bottom-20 z-[900] flex justify-center px-4 pointer-events-none">
        <div className="pointer-events-auto max-w-lg w-full rounded-xl bg-nv-surface shadow-2xl">{card}</div>
      </div>
    );
  }
}

export default PanelBoundary;
