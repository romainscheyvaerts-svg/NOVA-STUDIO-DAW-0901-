import type { DAWState } from '../types';

/**
 * Règles de l'historique d'annulation (App.tsx, useUndoRedo).
 *
 * - Profondeur : 256 étapes. Avant : 100, une séance d'édition de 200 gestes ne
 *   pouvait pas revenir à son début (Pro Tools : 64 niveaux au maximum ; un ingé
 *   qui comp, nettoie et mixe en fait bien plus en une heure). Les étapes partagent
 *   leur structure (Immer) : seules les pistes modifiées sont copiées.
 * - Changer de projet (ouvrir un fichier, une session du cloud, un modèle, une
 *   version, récupérer après un plantage) vide l'historique, comme Pro Tools à
 *   l'ouverture d'une session. Avant, Ctrl+Z juste après l'ouverture ramenait le
 *   projet PRÉCÉDENT (souvent la session vide du démarrage) : le travail ouvert
 *   disparaissait d'un seul raccourci.
 */
export const UNDO_LIMIT = 256;

/**
 * Le nouvel état est-il un AUTRE projet ? Identifiant différent ET pistes
 * entièrement remplacées. La 1re sauvegarde dans le cloud change l'identifiant
 * sans toucher aux pistes : l'historique est gardé (on annule après avoir sauvé).
 */
/**
 * Historique d'annulation (App.tsx, useUndoRedo). `group` regroupe plusieurs
 * modifications en UNE étape (tout ce que Nova fait pour un message du chat) :
 * 0/absent = normal, 1 = groupe ouvert sans modification encore, 2 = l'étape du
 * groupe est posée, les modifications suivantes s'y ajoutent.
 */
export interface UndoHistory<T> { past: T[]; present: T; future: T[]; lastChangeAt?: number; group?: 0 | 1 | 2; lastAction?: number }

/**
 * Geste de l'utilisateur en cours (`trackUserActions`) : `action` augmente à chaque appui
 * (souris, doigt, stylet) et à chaque touche (hors répétition et hors saisie de texte) ;
 * `gesture` vaut true tant que le bouton ou le doigt reste appuyé ; `releasedAt` : heure du
 * relâché (le lâcher d'un glisser finit souvent le geste : il appartient à la même étape).
 */
export interface UserAction { action: number; gesture: boolean; releasedAt?: number }

/**
 * Une modification RÉELLE du projet : nouvelle étape, ou fusion dans la précédente
 * (anti-rebond des gestes rapprochés, ou groupe ouvert). Pur (appelé dans un reducer).
 *
 * Avec `user` (l'appli, App.tsx) : l'étape suit les GESTES, comme dans les DAW, et plus
 * seulement l'horloge :
 * - un glisser (clip, fondu, fader…) = UNE étape, même avec des pauses : avant, une pause
 *   de plus de 300 ms au milieu du glisser coupait le geste en deux et Ctrl+Z ne ramenait
 *   le clip qu'à mi-chemin ;
 * - deux commandes distinctes (S puis Ctrl+D, Suppr puis Ctrl+V…) = deux étapes, même
 *   tapées en moins de 300 ms : avant, un seul Ctrl+Z annulait les deux ;
 * - l'anti-rebond reste pour le reste (touche maintenue qui se répète, modifications en
 *   rafale de l'appli après un même geste).
 */
export function recordChange<T>(h: UndoHistory<T>, next: T, now: number, opts: { debounceMs: number; limit: number; clean: (s: T) => T; user?: UserAction }): UndoHistory<T> {
  const u = opts.user;
  const lastAction = u ? u.action : h.lastAction;
  if (h.group === 2) return { ...h, present: next, lastChangeAt: now, lastAction };
  if (!h.group) {
    const sameAction = !u || h.lastAction === undefined || h.lastAction === u.action;
    // Même geste, toujours appuyé (ou tout juste relâché : le lâcher) : on fond, quelle que soit la pause.
    if (u && h.lastAction === u.action && (u.gesture || now - (u.releasedAt ?? -Infinity) <= opts.debounceMs)) return { ...h, present: next, lastChangeAt: now, lastAction };
    if (sameAction && now - (h.lastChangeAt || 0) < opts.debounceMs) return { ...h, present: next, lastChangeAt: now, lastAction };
  }
  return { past: [...h.past, opts.clean(h.present)].slice(-opts.limit), present: next, future: [], lastChangeAt: now, group: h.group === 1 ? 2 : h.group, lastAction };
}

/** Cible où l'on tape du texte (nom de piste, champ de recherche…) : ses touches ne sont pas des commandes. */
const isTextEntry = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  if (el.tagName !== 'INPUT') return false;
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'color'].includes(type);
};

/**
 * Suivi des gestes de l'utilisateur pour l'historique (App.tsx). Écoute en capture (aucun
 * composant ne peut l'arrêter) et ne provoque aucun rendu : un compteur lu au moment où
 * une modification arrive.
 */
export function trackUserActions(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): { current: () => UserAction; dispose: () => void } {
  const st: UserAction = { action: 0, gesture: false };
  const down = () => { st.action++; st.gesture = true; };
  const up = () => { if (st.gesture) st.releasedAt = Date.now(); st.gesture = false; };
  const key = (e: KeyboardEvent) => {
    if (e.repeat || isTextEntry(e.target)) return;
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.key === 'AltGraph') return;
    st.action++;
  };
  const on: [string, EventListener, boolean][] = [
    ['pointerdown', down as EventListener, true], ['pointerup', up as EventListener, true], ['pointercancel', up as EventListener, true],
    ['blur', up as EventListener, false], ['keydown', key as EventListener, true],
  ];
  for (const [n, f, c] of on) target.addEventListener(n, f, c);
  return {
    current: () => ({ ...st }),
    dispose: () => { for (const [n, f, c] of on) target.removeEventListener(n, f, c); },
  };
}

/** Ouvre un groupe : la prochaine modification pose UNE étape, les suivantes s'y fondent. */
export const openUndoGroup = <T>(h: UndoHistory<T>): UndoHistory<T> => ({ ...h, group: 1 });
/** Ferme le groupe : la modification suivante repart sur une nouvelle étape. */
export const closeUndoGroup = <T>(h: UndoHistory<T>): UndoHistory<T> => ({ ...h, group: 0, lastChangeAt: 0 });

export function isProjectSwitch(prev: Pick<DAWState, 'id' | 'tracks'>, next: Pick<DAWState, 'id' | 'tracks'>): boolean {
  if (!prev || !next || prev.id === next.id || prev.tracks === next.tracks) return false;
  const before = new Set(prev.tracks || []);
  return !(next.tracks || []).some(t => before.has(t));
}
