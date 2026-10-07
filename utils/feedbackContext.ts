/**
 * Contexte technique joint à un signalement, MONTRÉ à l'utilisateur avant
 * l'envoi (« Ce qui sera joint »). Construit à partir d'une liste blanche :
 * on ne lit jamais le stockage local, les cookies ni la session. Donc jamais
 * de mot de passe, de jeton ni de contenu audio ; les journaux passent en plus
 * par `redact` (utils/feedbackLog).
 */
import { actionRing, consoleRing, redact, type ActionEntry, type ConsoleEntry } from './feedbackLog';
import { getNovaDesktop } from './desktopApp';

/** Ce que le studio sait de lui-même (enregistré par App.tsx). */
export interface FeedbackAppState {
  mode?: 'simple' | 'avance';
  view?: string;
  trackCount?: number;
  collabRole?: string | null;
  mobileTab?: string | null;
  layout?: string;
}

let appStateProvider: (() => FeedbackAppState) | null = null;
/** App.tsx s'enregistre ici ; avant (page d'accueil), le contexte reste partiel. */
export const setFeedbackAppState = (fn: (() => FeedbackAppState) | null): void => { appStateProvider = fn; };

export interface FeedbackContext {
  nova: { version: string; build: string | null };
  desktop: { version: string; ui: string | null } | null;
  navigateur: string;
  appareil: { plateforme: string; tactile: boolean; mobile: boolean; langue: string };
  ecran: { largeur: number; hauteur: number; fenetre: string; densite: number };
  en_ligne: boolean;
  page: string;
  studio: FeedbackAppState;
  erreurs: ConsoleEntry[];
  actions: ActionEntry[];
}

/** Version web de NOVA : date de construction (balise « nova-build » posée par vite.config.ts). */
export const novaVersion = (): { version: string; build: string | null } => {
  try {
    const raw = document.querySelector('meta[name="nova-build"]')?.getAttribute('content') || '';
    const ms = Number(raw);
    if (ms > 1e12) {
      const d = new Date(ms);
      const p = (n: number) => String(n).padStart(2, '0');
      return { version: `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`, build: raw };
    }
  } catch { /* hors navigateur */ }
  return { version: 'dev', build: null };
};

/** « Chrome 141 (Windows) », « Safari 18 (iPhone) »… à partir du user-agent, sans le recopier. */
export const describeBrowser = (ua: string): string => {
  const pick = (re: RegExp) => re.exec(ua)?.[1];
  let name = 'Navigateur inconnu';
  const edge = pick(/Edg(?:A|iOS)?\/(\d+)/); const opr = pick(/OPR\/(\d+)/); const ff = pick(/(?:Firefox|FxiOS)\/(\d+)/);
  const crios = pick(/CriOS\/(\d+)/); const chrome = pick(/Chrome\/(\d+)/); const safari = /Safari\//.test(ua) ? pick(/Version\/(\d+)/) : undefined;
  if (edge) name = `Edge ${edge}`;
  else if (opr) name = `Opera ${opr}`;
  else if (ff) name = `Firefox ${ff}`;
  else if (crios) name = `Chrome ${crios}`;
  else if (chrome) name = `Chrome ${chrome}`;
  else if (safari) name = `Safari ${safari}`;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'système inconnu';
  const webview = /NovaStudioDesktop\//.test(ua) ? ', appli Nova Studio' : /; wv\)/.test(ua) ? ', WebView' : '';
  return `${name} (${os}${webview})`;
};

const clean = (v: unknown, max = 40): string | null => (typeof v === 'string' && v ? redact(v).slice(0, max) : null);

export const collectFeedbackContext = (): FeedbackContext => {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const ua = nav.userAgent || '';
  const desk = (() => { try { return getNovaDesktop(); } catch { return null; } })();
  let studio: FeedbackAppState = {};
  try {
    const s = appStateProvider?.() || {};
    // Liste blanche, valeurs courtes : jamais de nom de piste, de projet ni de personne.
    studio = {
      mode: s.mode === 'simple' || s.mode === 'avance' ? s.mode : undefined,
      view: clean(s.view, 24) ?? undefined,
      trackCount: typeof s.trackCount === 'number' && Number.isFinite(s.trackCount) ? Math.max(0, Math.round(s.trackCount)) : undefined,
      collabRole: clean(s.collabRole, 24),
      mobileTab: clean(s.mobileTab, 24),
      layout: clean(s.layout, 24) ?? undefined,
    };
  } catch { /* le studio n'est pas encore là */ }
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    nova: novaVersion(),
    desktop: desk ? { version: String(desk.version).slice(0, 24), ui: clean(desk.ui, 40) } : null,
    navigateur: describeBrowser(ua),
    appareil: {
      plateforme: clean((nav as any).userAgentData?.platform || nav.platform, 24) || 'inconnue',
      tactile: (nav.maxTouchPoints || 0) > 0,
      mobile: /Mobi|Android|iPhone|iPad/.test(ua),
      langue: clean(nav.language, 12) || 'inconnue',
    },
    ecran: {
      largeur: w?.screen?.width || 0,
      hauteur: w?.screen?.height || 0,
      fenetre: w ? `${w.innerWidth}×${w.innerHeight}` : '',
      densite: Math.round((w?.devicePixelRatio || 1) * 100) / 100,
    },
    en_ligne: nav.onLine !== false,
    // Chemin seulement : la partie après « ? » ou « # » peut contenir un lien de session ou un jeton.
    page: w ? w.location.pathname.slice(0, 120) : '',
    studio,
    erreurs: consoleRing.toArray().map(e => ({ ...e, message: redact(e.message) })),
    actions: actionRing.toArray(),
  };
};

/** Résumé lisible (« Ce qui sera joint »), une ligne par élément. */
export const describeContext = (c: FeedbackContext): { label: string; value: string }[] => [
  { label: 'Version de NOVA', value: c.nova.version + (c.desktop ? ` · appli Windows ${c.desktop.version}` : '') },
  { label: 'Navigateur et appareil', value: `${c.navigateur}${c.appareil.tactile ? ' · écran tactile' : ''}` },
  { label: 'Taille d’écran', value: `${c.ecran.largeur}×${c.ecran.hauteur} (fenêtre ${c.ecran.fenetre})` },
  {
    label: 'Studio',
    value: [
      c.studio.mode === 'simple' ? 'mode simple' : c.studio.mode === 'avance' ? 'mode avancé' : null,
      c.studio.view ? `vue ${c.studio.view}` : null,
      typeof c.studio.trackCount === 'number' ? `${c.studio.trackCount} piste${c.studio.trackCount > 1 ? 's' : ''}` : null,
      c.studio.collabRole ? `collaboration : ${c.studio.collabRole}` : null,
    ].filter(Boolean).join(' · ') || 'page d’accueil',
  },
  { label: 'Erreurs récentes', value: c.erreurs.length ? `${c.erreurs.length} (texte nettoyé, sans jeton ni e-mail)` : 'aucune' },
  { label: 'Dernières actions', value: c.actions.length ? `${c.actions.length} noms de commandes (sans contenu)` : 'aucune' },
];
