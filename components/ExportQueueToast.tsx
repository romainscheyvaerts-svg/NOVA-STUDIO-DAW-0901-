import React, { useEffect, useState } from 'react';
import { exportQueue, canRevealDownloads, revealDownload, type ExportJob } from '../services/ExportQueue';

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? (v < 0 ? '−' : '') + Math.abs(v).toFixed(d).replace('.', ',') : '—');

/** Rapport de fin : loudness et crête vraie, cible atteinte ou pas. */
export function reportLine(job: ExportJob): string {
  const r = job.result?.report;
  if (!r) return '';
  const files = job.result!.files.length;
  const head = files > 1 ? `${files} fichiers · ` : '';
  if (!Number.isFinite(r.lufs)) return `${head}crête vraie max ${fmt(r.truePeak)} dBTP`;
  const t = r.target;
  const cible = t && Number.isFinite(t.lufs)
    ? (t.limitedByPeak ? ` · cible ${t.label} (${fmt(t.lufs, 0)} LUFS) non atteinte : crêtes trop hautes, passe le Master Nova` : ` · cible ${t.label} atteinte`)
    : '';
  return `${head}${fmt(r.lufs)} LUFS · crête vraie ${fmt(r.truePeak)} dBTP · LRA ${fmt(r.lra)} LU${cible}`;
}

/**
 * Notifications de la file d'exports (bas de l'écran) : progression, puis
 * « Ouvrir le dossier » (appli Windows) ou « Télécharger » (site, téléphone).
 */
const ExportQueueToast: React.FC = () => {
  const [jobs, setJobs] = useState<ExportJob[]>(() => exportQueue.get());
  useEffect(() => exportQueue.subscribe(setJobs), []);
  if (!jobs.length) return null;
  const reveal = canRevealDownloads();
  return (
    <div className="fixed z-[1300] bottom-20 md:bottom-4 left-4 right-4 md:left-auto md:w-[380px] flex flex-col gap-2 pointer-events-none" aria-live="polite" data-export-queue="">
      {jobs.slice(-4).map(j => (
        <div key={j.id} role="status" data-export-job={j.status}
          className="pointer-events-auto rounded-2xl border border-nv-line/15 bg-nv-raised shadow-2xl p-3 text-nv-ink">
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[11px] ${j.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' : j.status === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-nv-accent/15 text-nv-accent'}`} aria-hidden="true">
              <i className={`fas ${j.status === 'done' ? 'fa-check' : j.status === 'error' ? 'fa-exclamation' : j.status === 'running' ? 'fa-circle-notch fa-spin' : 'fa-clock'}`}></i>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-bold truncate" title={j.label}>{j.label}</p>
              {j.status === 'running' || j.status === 'waiting' ? (
                <>
                  <p className="text-[11px] text-nv-muted truncate">{j.text}</p>
                  <div className="mt-1.5 h-1.5 rounded-full bg-nv-well overflow-hidden">
                    <div className="h-full bg-nv-accent transition-all duration-150" style={{ width: `${Math.round(j.progress)}%` }} />
                  </div>
                </>
              ) : j.status === 'error' ? (
                <p className="text-[11px] text-red-400">Export impossible : {j.error}</p>
              ) : (
                <>
                  <p className="text-[11px] text-nv-muted break-words" data-export-report="">{reportLine(j)}</p>
                  <p className="text-[11px] text-nv-muted truncate" title={j.result?.download.name}>{j.saved ? 'Enregistré : ' : 'Prêt : '}{j.result?.download.name}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {reveal && j.saved ? (
                      <button type="button" onClick={() => revealDownload(j.result!.download.name)}
                        title="Montre le fichier dans l'Explorateur Windows (comme « Show in Finder » après un Bounce de Logic)"
                        className="nova-hit min-h-9 px-3 rounded-lg bg-cyan-500 text-black text-[12px] font-bold">
                        <i className="fas fa-folder-open mr-1.5" aria-hidden="true"></i>Ouvrir le dossier
                      </button>
                    ) : null}
                    <button type="button" onClick={() => void exportQueue.download(j.id)}
                      title={j.saved ? 'Télécharger encore une fois' : 'Télécharger le fichier'}
                      className={`nova-hit min-h-9 px-3 rounded-lg text-[12px] font-bold ${reveal && j.saved ? 'border border-nv-line/15 text-nv-ink' : 'bg-cyan-500 text-black'}`}>
                      <i className="fas fa-download mr-1.5" aria-hidden="true"></i>{j.saved ? 'Télécharger encore' : 'Télécharger'}
                    </button>
                  </div>
                </>
              )}
            </div>
            {j.status !== 'running' && (
              <button type="button" onClick={() => exportQueue.remove(j.id)} aria-label="Fermer la notification" title="Fermer"
                className="nova-hit w-7 h-7 shrink-0 rounded-full text-nv-muted hover:text-nv-ink flex items-center justify-center">
                <i className="fas fa-times text-[11px]" aria-hidden="true"></i>
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ExportQueueToast;
