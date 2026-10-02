/**
 * Application Windows « Nova Studio » (dossier desktop/ du dépôt).
 * Elle charge ce même site dans une fenêtre Edge WebView2 et lance elle-même les
 * ponts ASIO (8766) et VST (8765) : pas de .exe séparé à télécharger ni à lancer.
 * Elle se signale par window.__novaDesktop = { version } et par le suffixe
 * « NovaStudioDesktop/<version> » du user-agent.
 */
export const DESKTOP_APP_DOWNLOAD_URL = '/downloads/NovaStudioSetup.exe';

export interface NovaDesktopInfo {
  version: string;
  platform?: string;
  bridges?: { asio: number; vst: number };
}

export const getNovaDesktop = (): NovaDesktopInfo | null => {
  if (typeof window === 'undefined') return null;
  const info = (window as any).__novaDesktop as NovaDesktopInfo | undefined;
  if (info && typeof info.version === 'string') return info;
  const m = /NovaStudioDesktop\/([\w.-]+)/.exec(navigator.userAgent || '');
  return m ? { version: m[1] } : null;
};

/** Vrai quand la page tourne dans l'application Windows (ponts intégrés). */
export const isNovaDesktop = (): boolean => getNovaDesktop() !== null;
