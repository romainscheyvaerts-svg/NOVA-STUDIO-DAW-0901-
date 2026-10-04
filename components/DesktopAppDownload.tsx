import React from 'react';
import { DESKTOP_APP_DOWNLOAD_URL, isNovaDesktop } from '../utils/desktopApp';

/**
 * Proposition de l'application Windows (ponts ASIO et VST intégrés).
 * Rien n'est affiché quand on est déjà dans l'application.
 */
/** Ce que l'appli demande (compte gratuit, export payant sans abonnement) : dit avant le téléchargement. */
export const ACCOUNT_NOTE = 'Compte gratuit requis pour démarrer · export inclus avec Nova Pro';

const DesktopAppDownload: React.FC<{ compact?: boolean }> = ({ compact }) => {
  if (isNovaDesktop()) return null;
  if (compact) {
    return (
      <a
        href={DESKTOP_APP_DOWNLOAD_URL}
        download
        className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-200 hover:bg-cyan-500/20 transition-colors"
      >
        <i className="fab fa-windows" aria-hidden="true"></i>
        <span className="min-w-0">
          <span className="block">Télécharger Nova Studio pour Windows (recommandé au studio : pont ASIO et VST intégrés)</span>
          <span className="block font-normal text-cyan-200/70">{ACCOUNT_NOTE}</span>
        </span>
      </a>
    );
  }
  return (
    <div className="p-4 rounded-xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/15 to-purple-500/15">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center shrink-0">
          <i className="fab fa-windows text-cyan-300" aria-hidden="true"></i>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-[11px] font-bold text-white mb-1">Nova Studio pour Windows</h4>
          <p className="text-[10px] text-slate-300 leading-relaxed mb-3">
            L'application installe Nova Studio sur le PC : les ponts ASIO et VST démarrent tout seuls,
            le micro est autorisé une fois pour toutes, la session est sauvegardée à la fermeture.
          </p>
          <p className="text-[10px] text-slate-300 leading-relaxed mb-3">
            <i className="fas fa-user-check mr-1 text-cyan-300" aria-hidden="true"></i>
            {ACCOUNT_NOTE} (sinon 2 € par projet). On se connecte une fois, le studio est ensuite libre.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={DESKTOP_APP_DOWNLOAD_URL}
              download
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black text-[10px] font-black uppercase tracking-wide rounded-lg transition-colors flex items-center gap-2"
            >
              <i className="fas fa-download" aria-hidden="true"></i>
              <span>Télécharger Nova Studio pour Windows (recommandé au studio : pont ASIO et VST intégrés)</span>
            </a>
            <span className="text-[9px] text-slate-400">environ 36 Mo • Windows 10/11</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DesktopAppDownload;
