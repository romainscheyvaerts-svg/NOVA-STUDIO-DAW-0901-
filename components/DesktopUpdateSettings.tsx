import React from 'react';
import { getNovaDesktop } from '../utils/desktopApp';
import {
  LEGACY_DOWNLOAD_URL, desktopHasNativeUpdate, formatSize, isNewerVersion, refreshLegacyManifest,
  sendUpdateCommand, useLegacyManifest, useNativeUpdate,
} from '../utils/appUpdate';

/**
 * Réglages › « Mises à jour de Nova Studio » (appli Windows seulement) : version installée,
 * « Mises à jour automatiques » (activé par défaut) et « Rechercher maintenant ».
 * Appli ancienne (sans mise à jour native) : version + lien vers la nouvelle version.
 */
const fmtWhen = (ms: number) => ms ? new Date(ms).toLocaleString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

const NativeSettings: React.FC = () => {
  const st = useNativeUpdate();
  const phase = st?.phase || 'idle';
  const checking = phase === 'checking' || phase === 'downloading';
  const status = !st ? 'Lecture de l’état…'
    : phase === 'checking' ? 'Recherche en cours…'
      : phase === 'downloading' ? `Téléchargement de la nouvelle version… ${Math.round((st.progress || 0) * 100)} %`
        : phase === 'ready' && st.available ? `Nova Studio ${st.available.version} est prête : elle s’installe à la fermeture (ou « Redémarrer et mettre à jour »).`
          : phase === 'installing' ? 'Installation de la mise à jour…'
            : phase === 'uptodate' ? `Nova Studio est à jour${st.lastCheck ? ` (vérifié le ${fmtWhen(st.lastCheck)})` : ''}.`
              : phase === 'error' ? `Recherche impossible pour l’instant : ${st.error || 'pas de connexion'}. Réessaie plus tard.`
                : phase === 'off' ? 'Mises à jour coupées sur ce PC.'
                  : st.lastCheck ? `Dernière vérification : ${fmtWhen(st.lastCheck)}.` : 'Nova Studio vérifie les mises à jour toutes les 6 heures.';
  const tone = phase === 'error' ? 'text-amber-300' : phase === 'ready' ? 'text-cyan-200' : 'text-slate-300';
  const auto = st ? st.auto : true;
  return (
    <>
      <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[12px] font-bold text-white">Mises à jour automatiques</span>
          <span className="block text-[11px] text-slate-400">Téléchargées en arrière-plan, installées quand tu fermes Nova Studio. Jamais pendant un enregistrement.</span>
        </span>
        <input type="checkbox" role="switch" checked={auto} disabled={!st || phase === 'off'} data-testid="app-update-auto"
          aria-label="Mises à jour automatiques"
          onChange={e => sendUpdateCommand(e.target.checked ? 'auto:on' : 'auto:off')}
          className="h-5 w-9 shrink-0 cursor-pointer accent-cyan-500" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!st || checking || phase === 'off' || phase === 'installing'} data-testid="app-update-check"
          onClick={() => sendUpdateCommand('check')}
          className="nova-hit min-h-10 rounded-xl bg-cyan-500 px-4 text-[11px] font-black text-black disabled:opacity-50">
          {checking ? 'Recherche…' : 'Rechercher maintenant'}
        </button>
        {phase === 'ready' && st?.available && (
          <button type="button" data-testid="app-update-settings-apply" onClick={() => sendUpdateCommand('apply')}
            className="nova-hit min-h-10 rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 text-[11px] font-black text-cyan-100">
            Redémarrer et mettre à jour
          </button>
        )}
      </div>
      <p role="status" data-testid="app-update-status" className={`text-[11px] leading-snug ${tone}`}>{status}</p>
      {st?.busyText && <p role="alert" className="text-[11px] font-bold text-amber-300">{st.busyText}</p>}
    </>
  );
};

const LegacySettings: React.FC<{ version: string }> = ({ version }) => {
  const { status, manifest } = useLegacyManifest(true);
  const newer = manifest && isNewerVersion(manifest.version, version);
  return (
    <>
      <p role="status" data-testid="app-update-status" className="text-[11px] leading-snug text-slate-300">
        {status === 'checking' ? 'Recherche en cours…'
          : newer ? `Nova Studio ${manifest!.version} est disponible (${formatSize(manifest!.size)}). Installe-la une fois : ensuite, les mises à jour se feront toutes seules.`
            : status === 'error' ? 'Recherche impossible pour l’instant (pas de connexion ?). Réessaie plus tard.'
              : 'Nova Studio est à jour.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={status === 'checking'} data-testid="app-update-check" onClick={() => { void refreshLegacyManifest(true); }}
          className="nova-hit min-h-10 rounded-xl border border-white/15 bg-white/5 px-4 text-[11px] font-black text-white disabled:opacity-50">
          Rechercher maintenant
        </button>
        {newer && (
          <a href={LEGACY_DOWNLOAD_URL} download data-testid="app-update-settings-download"
            className="nova-hit inline-flex min-h-10 items-center rounded-xl bg-cyan-500 px-4 text-[11px] font-black text-black">
            Télécharger la mise à jour
          </a>
        )}
      </div>
    </>
  );
};

const DesktopUpdateSettings: React.FC = () => {
  const info = getNovaDesktop();
  if (!info) return null;
  const native = desktopHasNativeUpdate(info);
  return (
    <div className="space-y-2.5 rounded-2xl border border-white/10 bg-white/[0.02] p-4" data-testid="app-update-settings" data-nova-target="app-update-settings">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-cyan-300">Mises à jour de Nova Studio</span>
        <span className="text-[10px] font-mono text-slate-400" data-testid="app-update-installed">version installée : {info.version}</span>
      </div>
      {native ? <NativeSettings /> : <LegacySettings version={info.version} />}
    </div>
  );
};

export default DesktopUpdateSettings;
