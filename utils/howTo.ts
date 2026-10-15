/**
 * Pilotage de « ❓ Comment faire ? » depuis n'importe où (barre du haut, palette Ctrl+K, chat,
 * carte « Et après ? ») sans faire transiter d'état par App.tsx : un petit magasin observable,
 * lu par components/HowToHost.
 */
import type { HowToMoment } from './guides';

export interface HowToState {
  /** Liste des parcours ouverte (avec, éventuellement, un parcours déjà choisi). */
  panel: { initialId: string | null } | null;
  /** Parcours en mode « Montre-moi ». */
  coach: string | null;
}

let state: HowToState = { panel: null, coach: null };
const subs = new Set<() => void>();
const emit = () => { subs.forEach(f => { try { f(); } catch { /* abonné défaillant */ } }); };

export const howTo = {
  get: (): HowToState => state,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
  /** Ouvre la liste (ou directement le détail d'un parcours). */
  open(initialId: string | null = null) { state = { panel: { initialId }, coach: null }; emit(); },
  closePanel() { if (!state.panel) return; state = { ...state, panel: null }; emit(); },
  /** Lance « Montre-moi » (ferme la liste). */
  showMe(id: string) { state = { panel: null, coach: id }; emit(); },
  stopCoach() { if (!state.coach) return; state = { ...state, coach: null }; emit(); },
};

// --- « Et après ? » : déjà vu / ne plus montrer --------------------------------------
const SEEN_KEY = 'nova_howto_seen';
const OFF_KEY = 'nova_howto_next_off';

export const nextStepPrefs = {
  off(): boolean { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } },
  setOff() { try { localStorage.setItem(OFF_KEY, '1'); } catch { /* stockage indisponible */ } emit(); },
  seen(m: HowToMoment): boolean { try { return (JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[]).includes(m); } catch { return false; } },
  markSeen(m: HowToMoment) {
    try {
      const list = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
      if (!list.includes(m)) localStorage.setItem(SEEN_KEY, JSON.stringify([...list, m].slice(-10)));
    } catch { /* idem */ }
  },
};
