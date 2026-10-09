import React, { useEffect, useRef } from 'react';
import type { VersionMeta } from '../utils/recoveryStore';
import { savedAgo } from '../utils/revertToSaved';

interface Props {
  version: VersionMeta | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation de « Revenir à la version enregistrée ». « Garder mon travail »
 * a le focus (Entrée ne jette rien par erreur) ; Échap ferme.
 */
const RevertToSavedDialog: React.FC<Props> = ({ version, busy, onConfirm, onCancel }) => {
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!version) return;
    keepRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [version, onCancel]);
  if (!version) return null;
  const when = savedAgo(version.savedAt);
  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/60 p-4" onClick={onCancel}
      role="dialog" aria-modal="true" aria-labelledby="revert-title" data-testid="revert-dialog">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-nv-surface p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 id="revert-title" className="text-[16px] font-black text-nv-ink mb-2">
          <i className="fas fa-clock-rotate-left mr-2 text-amber-300" aria-hidden="true" />Revenir à la version enregistrée ?
        </h2>
        <p className="text-[13px] text-nv-muted leading-relaxed">
          Le projet revient tel qu’il était à la dernière sauvegarde, <b className="text-nv-ink">{when}</b>
          {version.takes ? ` (${version.takes} prise${version.takes > 1 ? 's' : ''})` : ''}. Tout ce que tu as fait depuis est retiré.
        </p>
        <p className="mt-2 text-[12px] text-emerald-300/90">
          Rien n’est perdu : ta version actuelle est d’abord gardée dans « Versions de la session ».
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button ref={keepRef} type="button" onClick={onCancel} disabled={busy} data-testid="revert-cancel"
            className="min-h-11 rounded-xl bg-white/[0.06] border border-white/10 text-[13px] font-bold text-nv-ink hover:bg-white/10">
            Garder mon travail
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} data-testid="revert-confirm"
            className="min-h-11 rounded-xl bg-amber-500 text-black text-[13px] font-black hover:bg-amber-400 disabled:opacity-60">
            {busy ? 'Retour en cours…' : `Revenir à ${new Date(version.savedAt).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' })}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RevertToSavedDialog;
