import React, { useEffect, useState } from 'react';
import { recoveryStore, VersionMeta, VersionReason } from '../utils/recoveryStore';
import { formatAgo } from '../utils/sessionStore';

/**
 * Récupération après plantage et historique des versions (utils/recoveryStore).
 */

const btn = 'min-h-11 rounded-xl px-4 text-[13px] font-black transition-all disabled:opacity-40';
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "aujourd'hui";
  if (d.toDateString() === y.toDateString()) return 'hier';
  return d.toLocaleDateString('fr-BE', { weekday: 'short', day: 'numeric', month: 'short' });
};
const secs = (s: number) => `${s.toFixed(1).replace('.', ',')} s`;
const REASONS: Record<VersionReason, string> = {
  auto: 'sauvegarde automatique',
  take: 'après une prise',
  close: 'en quittant',
  manual: 'enregistrée',
  restore: 'avant une restauration',
  recovered: 'après une récupération',
};

export interface CrashInfo { version: VersionMeta | null; takes: { seconds: number; trackName: string }[]; recording: boolean }

export const CrashRecoveryDialog: React.FC<{
  info: CrashInfo;
  busy: boolean;
  onRecover: () => void;
  onLater: () => void;
  onOpenVersions: () => void;
}> = ({ info, busy, onRecover, onLater, onOpenVersions }) => {
  const v = info.version;
  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="crash-title" data-testid="crash-recovery">
      <div className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-3xl border border-amber-400/30 bg-[#121418] p-6 shadow-2xl">
        <h2 id="crash-title" className="text-lg font-black text-white">🛟 Nova s'est fermé sans prévenir</h2>
        <p className="mt-2 text-[13px] text-slate-300">
          Ta séance ne s'est pas fermée normalement (plantage, appli fermée de force ou coupure de courant). Rien n'est perdu :
        </p>
        <ul className="mt-3 space-y-2 text-[13px] text-slate-200">
          {v && (
            <li className="rounded-xl bg-white/[0.04] border border-white/10 p-3">
              <span className="font-bold text-white">Projet sauvegardé à {fmtTime(v.savedAt)}</span>
              <span className="block text-[12px] text-slate-400">
                {[v.name, `${v.tracks} piste${v.tracks > 1 ? 's' : ''}`, v.takes ? `${v.takes} prise${v.takes > 1 ? 's' : ''}` : null, v.beatTitle].filter(Boolean).join(' · ')} — {formatAgo(v.savedAt)}
              </span>
            </li>
          )}
          {info.takes.map((t, i) => (
            <li key={i} className="rounded-xl bg-emerald-500/10 border border-emerald-400/30 p-3" data-testid="crash-take">
              <span className="font-bold text-emerald-200">🎤 Prise {info.recording && i === info.takes.length - 1 ? 'en cours ' : ''}récupérée : {secs(t.seconds)}</span>
              <span className="block text-[12px] text-slate-400">sur « {t.trackName} », jusqu'à la dernière seconde enregistrée</span>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-col gap-2">
          <button type="button" onClick={onRecover} disabled={busy} className={`${btn} bg-emerald-400 text-black hover:bg-emerald-300`}>
            {busy ? 'Récupération…' : 'Récupérer la session'}
          </button>
          <button type="button" onClick={onOpenVersions} disabled={busy} className={`${btn} bg-white/10 text-white hover:bg-white/15`}>Choisir une autre version</button>
          <button type="button" onClick={onLater} disabled={busy} className="min-h-11 text-[12px] text-slate-400 underline">
            Plus tard (elle reste dans « Reprendre ma session »)
          </button>
        </div>
      </div>
    </div>
  );
};

export const VersionsDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onRestore: (v: VersionMeta) => void;
  busy?: boolean;
  /** Projet ouvert : ses versions d'abord. */
  projectId?: string | null;
}> = ({ open, onClose, onRestore, busy, projectId }) => {
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!open) return;
    setList(null);
    recoveryStore().listVersions().then(setList).catch(() => setList([]));
  }, [open]);
  if (!open) return null;
  const shown = (list || []).filter(v => all || !projectId || v.projectId === projectId);
  const others = (list || []).length - shown.length;
  return (
    <div className="fixed inset-0 z-[710] flex items-end sm:items-center justify-center bg-black/70 p-4" onClick={() => !busy && onClose()} role="dialog" aria-modal="true" aria-labelledby="versions-title" data-testid="versions-dialog">
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-3xl border border-white/10 bg-[#121418] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="versions-title" className="text-lg font-black text-white">🕘 Versions de la session</h2>
            <p className="text-[12px] text-slate-400 mt-1">Gardées sur cet appareil : les 20 dernières, puis une par heure (7 jours). Restaurer ne supprime rien : ta version actuelle reste dans la liste.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fermer" className="w-11 h-11 shrink-0 rounded-xl bg-white/5 text-slate-300">✕</button>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto space-y-1.5 pr-1">
          {list === null && <p className="text-[12px] text-slate-500 p-3">Chargement…</p>}
          {list && !shown.length && <p className="text-[13px] text-slate-400 p-3">Aucune version pour l'instant : elles apparaissent dès que tu enregistres ou modifies ta session.</p>}
          {shown.map((v, i) => (
            <div key={v.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-white">{fmtDay(v.savedAt)} à {fmtTime(v.savedAt)}{i === 0 ? <span className="ml-2 text-[10px] font-black uppercase text-emerald-300">la plus récente</span> : null}</p>
                <p className="text-[11px] text-slate-400 truncate">{[REASONS[v.reason] || v.reason, v.name, `${v.tracks} piste${v.tracks > 1 ? 's' : ''}`, v.takes ? `${v.takes} prise${v.takes > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')}</p>
              </div>
              <button type="button" disabled={busy} onClick={() => onRestore(v)} className={`${btn} shrink-0 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25`}>Restaurer</button>
            </div>
          ))}
          {!all && others > 0 && (
            <button type="button" onClick={() => setAll(true)} className="w-full min-h-11 text-[12px] text-slate-400 underline">Voir aussi les {others} versions d'autres projets</button>
          )}
        </div>
      </div>
    </div>
  );
};
