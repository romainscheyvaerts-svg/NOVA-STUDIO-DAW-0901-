import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { catalogStatus, formatWait, outageMessage } from '../utils/catalogStatus';

interface Action { label: string; icon: string; onClick: () => void }

interface Props {
  /** Nouvel essai (appelé automatiquement à la fin du délai, ou par le bouton). */
  onRetry: () => void;
  /** Ce qui reste utilisable sans le catalogue (projets, fichiers de l'appareil). */
  actions?: Action[];
  /** Bandeau discret au-dessus de la dernière liste connue (au lieu du panneau plein). */
  compact?: boolean;
}

/**
 * Catalogue indisponible (quota Supabase dépassé, panne, hors ligne) : un message
 * clair au lieu de « Catalogue injoignable », ce qui reste utilisable, et un nouvel
 * essai automatique après un délai croissant (jamais de rafale de requêtes).
 */
const CatalogUnavailable: React.FC<Props> = ({ onRetry, actions = [], compact = false }) => {
  const outage = useSyncExternalStore(catalogStatus.subscribe, catalogStatus.get, catalogStatus.get);
  const [now, setNow] = useState(Date.now());
  const retried = useRef<number>(-1);

  useEffect(() => {
    if (!outage) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [outage]);

  const wait = outage ? Math.max(0, outage.retryAt - now) : 0;

  // Fin du délai : un seul nouvel essai automatique par échec (le suivant attendra plus longtemps).
  useEffect(() => {
    if (outage && wait === 0 && retried.current !== outage.attempts) {
      retried.current = outage.attempts;
      onRetry();
    }
  }, [outage, wait, onRetry]);

  if (compact && !outage) return null;
  const { title, hint } = outageMessage(outage);

  if (compact) {
    return (
      <div role="status" data-testid="catalogue-indisponible-bandeau"
        className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2 text-[12px] text-amber-100">
        <i className="fas fa-triangle-exclamation text-amber-300" aria-hidden="true"></i>
        <span className="font-semibold">{title}</span>
        <span className="text-amber-100/80">Voici la dernière liste connue ; les beats déjà écoutés restent disponibles.</span>
        {wait > 0 && <span className="ml-auto text-[11px] text-amber-200/70">Nouvel essai dans {formatWait(wait)}</span>}
      </div>
    );
  }

  return (
    <div role="status" data-testid="catalogue-indisponible"
      className="flex flex-col items-center justify-center h-full text-center px-4">
      <div className="w-14 h-14 rounded-2xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center mb-4">
        <i className="fas fa-cloud-bolt text-2xl text-amber-300" aria-hidden="true"></i>
      </div>
      <p className="text-sm font-bold text-white">{title}</p>
      <p className="text-[13px] mt-1 text-slate-300 max-w-sm">{hint}</p>
      {actions.length > 0 && (
        <div className="mt-5 flex flex-col sm:flex-row flex-wrap items-stretch justify-center gap-2 w-full max-w-xl">
          {actions.map(a => (
            <button key={a.label} type="button" onClick={a.onClick}
              className="min-h-11 px-4 py-2 rounded-xl text-[12px] font-bold bg-white/[0.06] border border-white/10 text-slate-100 hover:bg-white/10 hover:border-cyan-400/40 transition-colors">
              <i className={`fas ${a.icon} mr-2 text-cyan-300`} aria-hidden="true"></i>{a.label}
            </button>
          ))}
        </div>
      )}
      <button type="button" onClick={() => { if (wait === 0) onRetry(); }} disabled={wait > 0}
        className="mt-4 min-h-10 px-4 py-2 rounded-lg text-xs font-bold border border-white/10 text-slate-300 enabled:hover:bg-white/10 disabled:opacity-60 disabled:cursor-not-allowed">
        {wait > 0 ? `Nouvel essai automatique dans ${formatWait(wait)}` : 'Réessayer'}
      </button>
    </div>
  );
};

export default CatalogUnavailable;
