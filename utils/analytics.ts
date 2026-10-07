import { catalogSupabase } from '../services/supabase';
import { recordAction } from './feedbackLog';

/**
 * Mesure d'audience anonyme du parcours Nova (table analytics_events du site,
 * tableau de bord dans l'espace admin Make Music). Sans cookie publicitaire ni
 * adresse IP : un identifiant aléatoire gardé dans le navigateur, et des
 * événements courts. Envoi groupé, jamais bloquant.
 *
 * Étapes suivies (à garder alignées avec le tableau de bord du site) :
 *  daw_open, beat_tried, melody_tried, rec_started, take_recorded,
 *  mix_style_applied, lyrics_opened, share_opened, export_opened,
 *  export_done, buy_beat_clicked, pro_mix_clicked, studio_booking_clicked,
 *  pro_gate_shown, pro_subscribed, collab_started, simple_mode_toggled …
 */

const VISITOR_KEY = 'nova_visitor_id';
const rand = () => (crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 32);

const visitorId = (() => {
  try {
    let v = localStorage.getItem(VISITOR_KEY);
    if (!v) { v = rand(); localStorage.setItem(VISITOR_KEY, v); }
    return v;
  } catch { return rand(); }
})();
const sessionId = rand();

type Row = { app: 'daw'; event: string; visitor: string; session: string; props: Record<string, unknown> | null; path: string; user_id: string | null };
let queue: Row[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const onceSeen = new Set<string>();

const flush = async () => {
  timer = null;
  const batch = queue.splice(0, 50);
  if (!batch.length) return;
  try {
    const { data } = await catalogSupabase.auth.getSession();
    const uid = data.session?.user?.id ?? null;
    await catalogSupabase.from('analytics_events').insert(batch.map(r => ({ ...r, user_id: uid })));
  } catch { /* la mesure ne doit jamais gêner le studio */ }
};

/** Enregistre une étape du parcours (nom en minuscules_avec_underscores). */
export const track = (event: string, props?: Record<string, unknown>): void => {
  try {
    if (!/^[a-z0-9_]{2,40}$/.test(event)) return;
    // Journal des 20 dernières actions joint aux signalements (nom seulement).
    recordAction(`etape:${event}`);
    // Pas de mesure en local / dans les tests automatiques.
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) && !localStorage.getItem('nova_track_local')) return;
    let small: Record<string, unknown> | null = null;
    if (props) {
      small = {};
      for (const [k, v] of Object.entries(props).slice(0, 8)) {
        small[k.slice(0, 30)] = typeof v === 'string' ? v.slice(0, 80) : typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 80);
      }
    }
    queue.push({ app: 'daw', event, visitor: visitorId, session: sessionId, props: small, path: window.location.pathname.slice(0, 200), user_id: null });
    if (queue.length >= 20) void flush();
    else if (!timer) timer = setTimeout(() => { void flush(); }, 4000);
  } catch { /* idem */ }
};

/** Comme track, mais une seule fois par session (ex. première prise). */
export const trackOnce = (event: string, props?: Record<string, unknown>): void => {
  // Marqué « vu » seulement si l'événement part vraiment (nom valide, hors local).
  if (onceSeen.has(event) || !/^[a-z0-9_]{2,40}$/.test(event)) return;
  try {
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) && !localStorage.getItem('nova_track_local')) return;
  } catch { /* stockage indisponible : on mesure quand même */ }
  onceSeen.add(event);
  track(event, props);
};

// Envoi des derniers événements quand on quitte la page.
try {
  window.addEventListener('pagehide', () => { void flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
} catch { /* */ }
