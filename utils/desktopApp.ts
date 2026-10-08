/**
 * Application Windows « Nova Studio » (dossier desktop/ du dépôt).
 * Elle affiche ce même site dans une fenêtre Edge WebView2 (depuis la 1.1, une copie
 * du site construit est livrée avec l'appli et servie en local sous la même adresse :
 * démarrage hors ligne, mises à jour téléchargées en arrière-plan) et lance elle-même
 * les ponts ASIO (8766) et VST (8765) : pas de .exe séparé à télécharger ni à lancer.
 * Elle se signale par window.__novaDesktop = { version, ui } et par le suffixe
 * « NovaStudioDesktop/<version> » du user-agent.
 */
export const DESKTOP_APP_DOWNLOAD_URL = '/downloads/NovaStudioSetup.exe';

export interface NovaDesktopInfo {
  version: string;
  platform?: string;
  /** Version de l'interface au démarrage (« ui-<empreinte> »), ou « online » (site chargé en ligne). */
  ui?: string;
  bridges?: { asio: number; vst: number };
  /**
   * (1.5) Fenêtre de la page (HWND du contrôle WebView2) : l'éditeur d'un insert ARA
   * (Melodyne) s'y ancre en fenêtre enfant, en bas de la fenêtre Édition (comme Pro Tools).
   */
  hwnd?: number;
}

/** Fenêtre où ancrer l'éditeur d'un plugin (appli Windows seulement), sinon null. */
export const desktopHwnd = (): number | null => {
  const h = getNovaDesktop()?.hwnd;
  return typeof h === 'number' && h > 0 ? h : null;
};

export const getNovaDesktop = (): NovaDesktopInfo | null => {
  if (typeof window === 'undefined') return null;
  const info = (window as any).__novaDesktop as NovaDesktopInfo | undefined;
  if (info && typeof info.version === 'string') return info;
  const m = /NovaStudioDesktop\/([\w.-]+)/.exec(navigator.userAgent || '');
  return m ? { version: m[1] } : null;
};

/** Vrai quand la page tourne dans l'application Windows (ponts intégrés). */
export const isNovaDesktop = (): boolean => getNovaDesktop() !== null;
