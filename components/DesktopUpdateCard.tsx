import React, { useEffect, useState } from 'react';
import { getNovaDesktop } from '../utils/desktopApp';
import { canRevealDownloads, revealDownload } from '../services/ExportQueue';
import {
  BUSY_TEXT, LEGACY_DOWNLOAD_URL, desktopHasNativeUpdate, dismissLegacyVersion, dismissedLegacyVersion,
  formatSize, sendUpdateCommand, shouldShowLegacyCard, useLegacyManifest, useNativeUpdate,
} from '../utils/appUpdate';

/**
 * Carte « mise à jour de Nova Studio » (appli Windows seulement), posée DANS la page (sous la
 * barre de transport, elle pousse le contenu : aucun bouton recouvert, au bureau comme au
 * téléphone).
 *  - appli 1.5.3+ : « Nova Studio X.Y.Z est prête » (Redémarrer et mettre à jour / Plus tard),
 *    puis une fois « Mis à jour en X.Y.Z ✓ » ; tout le travail est fait par l'appli.
 *  - appli plus ancienne : « Une nouvelle version de Nova Studio est disponible » + bouton qui
 *    télécharge l'installateur.
 * Rien sur le site (navigateur). Visible aussi en mode simple : c'est ce qui garde les testeurs
 * à jour, pas une fonction de plus.
 */
const Notes: React.FC<{ notes: string[] }> = ({ notes }) => notes.length ? (
  <ul className="mt-1 grid gap-x-6 gap-y-0.5 text-[12px] leading-snug text-slate-300 sm:grid-cols-2" data-testid="app-update-notes">
    {notes.map(n => <li key={n} className="flex gap-1.5"><span aria-hidden="true" className="text-cyan-300">•</span><span>{n}</span></li>)}
  </ul>
) : null;

const shell = 'shrink-0 border-b px-4 py-3 sm:px-5';

const NativeCard: React.FC = () => {
  const st = useNativeUpdate();
  const [laterLocal, setLaterLocal] = useState(false);
  const [justOpen, setJustOpen] = useState(true);
  const just = st?.justUpdated || null;
  // « Mis à jour en X.Y.Z ✓ » : montré UNE fois (l'appli l'oublie dès qu'il est affiché).
  useEffect(() => { if (just) sendUpdateCommand('seen'); }, [just?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return null;
  if (just && justOpen) {
    return (
      <div role="status" data-testid="app-update-done" className={`${shell} border-emerald-400/30 bg-emerald-500/[0.08]`}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-x-4 gap-y-2">
          <i className="fas fa-circle-check mt-0.5 text-emerald-300" aria-hidden="true"></i>
          <div className="min-w-0 grow basis-[16rem]">
            <p className="text-[13px] font-bold text-white">Mis à jour en {just.version} ✓</p>
            <Notes notes={just.notes} />
          </div>
          <button type="button" onClick={() => setJustOpen(false)} data-testid="app-update-done-ok"
            className="nova-hit h-9 shrink-0 rounded-lg border border-white/15 bg-white/5 px-3.5 text-[12px] font-bold text-white hover:bg-white/10">
            OK
          </button>
        </div>
      </div>
    );
  }
  const a = st.available;
  if (!a || laterLocal || st.dismissed || !(st.phase === 'ready' || st.phase === 'installing')) return null;
  const installing = st.phase === 'installing';
  const busy = st.busy ? (st.busyText || BUSY_TEXT[st.busy]) : '';
  return (
    <div role="status" aria-live="polite" data-testid="app-update-card" className={`${shell} border-cyan-400/30 bg-cyan-500/[0.07]`}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-x-4 gap-y-2">
        <i className="fas fa-arrow-rotate-right mt-0.5 text-cyan-300" aria-hidden="true"></i>
        <div className="min-w-0 grow basis-[16rem]">
          <p className="text-[13px] font-bold text-white">Nova Studio {a.version} est prête</p>
          <Notes notes={a.notes} />
          <p className="mt-1 text-[11px] text-slate-400">
            {installing ? 'Sauvegarde de ta session, puis Nova Studio se met à jour et se rouvre tout seul…'
              : st.auto ? 'Sinon, elle s’installera toute seule quand tu fermeras Nova Studio. Tes sessions sont gardées.'
                : 'Mises à jour automatiques coupées : elle s’installe quand tu cliques « Redémarrer et mettre à jour ».'}
          </p>
          {(busy || st.error) && <p role="alert" data-testid="app-update-busy" className="mt-1 text-[12px] font-bold text-amber-300">{busy || st.error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" disabled={installing} data-testid="app-update-apply"
            onClick={() => sendUpdateCommand('apply')}
            className="nova-hit h-9 rounded-lg bg-cyan-500 px-3.5 text-[12px] font-bold text-black hover:bg-cyan-400 disabled:opacity-50">
            {installing ? 'Redémarrage…' : 'Redémarrer et mettre à jour'}
          </button>
          {!installing && (
            <button type="button" data-testid="app-update-later"
              onClick={() => { setLaterLocal(true); sendUpdateCommand('later'); }}
              className="nova-hit h-9 rounded-lg border border-white/15 bg-white/5 px-3.5 text-[12px] font-bold text-white hover:bg-white/10">
              Plus tard
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const LegacyCard: React.FC = () => {
  const info = getNovaDesktop();
  const { manifest } = useLegacyManifest(true);
  const [dismissed, setDismissed] = useState<string | null>(() => dismissedLegacyVersion());
  const [started, setStarted] = useState(false);
  if (!shouldShowLegacyCard(info, manifest, dismissed) || !manifest) return null;
  const reveal = canRevealDownloads();
  return (
    <div role="status" data-testid="app-update-legacy" className={`${shell} border-cyan-400/30 bg-cyan-500/[0.07]`}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-x-4 gap-y-2">
        <i className="fab fa-windows mt-0.5 text-cyan-300" aria-hidden="true"></i>
        <div className="min-w-0 grow basis-[16rem]">
          <p className="text-[13px] font-bold text-white">Une nouvelle version de Nova Studio est disponible ({manifest.version})</p>
          <Notes notes={manifest.notes} />
          <p className="mt-1 text-[11px] text-slate-400" data-testid="app-update-legacy-help">
            {started
              ? 'Téléchargement lancé : ouvre NovaStudioSetup.exe, Nova Studio se ferme puis se met à jour. Tes sessions sont gardées. Ensuite, les mises à jour se feront toutes seules.'
              : `Tu as la version ${info?.version}. Installe la nouvelle (${formatSize(manifest.size)}) : ensuite, les mises à jour se feront toutes seules.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {started && reveal ? (
            <button type="button" data-testid="app-update-legacy-reveal" onClick={() => revealDownload('NovaStudioSetup.exe')}
              className="nova-hit h-9 rounded-lg bg-cyan-500 px-3.5 text-[12px] font-bold text-black hover:bg-cyan-400">
              <i className="fas fa-folder-open mr-1.5" aria-hidden="true"></i>Ouvrir le dossier
            </button>
          ) : (
            <a href={LEGACY_DOWNLOAD_URL} download data-testid="app-update-legacy-download" onClick={() => setStarted(true)}
              className="nova-hit inline-flex h-9 items-center rounded-lg bg-cyan-500 px-3.5 text-[12px] font-bold text-black hover:bg-cyan-400">
              <i className="fas fa-download mr-1.5" aria-hidden="true"></i>Télécharger la mise à jour
            </a>
          )}
          <button type="button" data-testid="app-update-legacy-later"
            onClick={() => { dismissLegacyVersion(manifest.version); setDismissed(manifest.version); }}
            className="nova-hit h-9 rounded-lg border border-white/15 bg-white/5 px-3.5 text-[12px] font-bold text-white hover:bg-white/10">
            Plus tard
          </button>
        </div>
      </div>
    </div>
  );
};

const DesktopUpdateCard: React.FC = () => {
  const info = getNovaDesktop();
  if (!info) return null;
  return desktopHasNativeUpdate(info) ? <NativeCard /> : <LegacyCard />;
};

export default DesktopUpdateCard;
