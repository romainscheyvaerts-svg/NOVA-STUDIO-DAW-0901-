import { catalogSupabase } from '../services/supabase';

/**
 * Journal des erreurs du DAW, dans la même table que le site Make Music
 * (client_errors, récapitulatif e-mail quotidien à l'admin). Avant, un bug en
 * production passait inaperçu. Prudent : 5 envois maximum par session, une
 * fois par message, bruit des navigateurs / extensions ignoré.
 */
const IGNORE = /ResizeObserver loop|Script error\.?$|Non-Error promise rejection|extension:\/\/|AbortError|The operation was aborted|NetworkError when attempting|Failed to fetch$|Load failed$|dynamically imported module|Importing a module script failed|NotAllowedError|play\(\) request was interrupted/i;
const seen = new Set<string>();
let sent = 0;

export const logClientError = (err: unknown, context?: string): void => {
  try {
    const e = err as { message?: string; stack?: string };
    const message = `${context ? `[${context}] ` : ''}${e?.message || String(err)}`.slice(0, 500);
    if (!message.trim() || IGNORE.test(message) || seen.has(message) || sent >= 5) return;
    seen.add(message);
    sent++;
    void catalogSupabase.auth.getSession().then(({ data }) =>
      catalogSupabase.from('client_errors').insert({
        app: 'daw',
        message,
        stack: (e?.stack || '').slice(0, 2000) || null,
        url: (window.location.pathname + window.location.search).slice(0, 300),
        user_agent: navigator.userAgent.slice(0, 300),
        user_id: data.session?.user?.id ?? null,
      })
    ).catch(() => { /* le journal ne doit jamais gêner le studio */ });
  } catch { /* idem */ }
};

export const installGlobalErrorLog = (): void => {
  window.addEventListener('error', (ev) => logClientError(ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => logClientError(ev.reason, 'promesse'));
};
