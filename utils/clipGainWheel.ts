import { runEditCommand } from './editCommands';
import { editSelectionStore } from './editSelection';

/**
 * Gain de clip à la molette (Pro Tools : Démarrer+Maj+molette sur un clip ;
 * ici Ctrl+Maj+molette, la touche Windows n'arrivant pas au navigateur — la
 * touche Cmd sur Mac marche aussi). Un cran = 0,5 dB (le pas de la session
 * LENNON), molette vers le haut = plus fort. Les petits pas d'un pavé tactile
 * s'additionnent jusqu'à un cran. Les crans rapprochés sont regroupés (150 ms)
 * en un seul réglage : peu d'étapes d'annulation pour un geste.
 *
 * Le clip visé : celui sous la souris ; s'il fait partie de la sélection (clips
 * ou plage), toute la sélection suit, comme Pro Tools.
 * Logique pure testable (tests/clipGainWheel.test.ts) + accumulateur.
 */

/** Pixels de molette pour un cran (souris classique : 100 px). */
export const WHEEL_NOTCH_PX = 100;
export const WHEEL_STEP_DB = 0.5;
const GROUP_MS = 150;

/** Le geste concerne-t-il le gain de clip (et pas le zoom) ? */
export const isClipGainWheel = (e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): boolean =>
  !!e.shiftKey && !!(e.ctrlKey || e.metaKey);

/**
 * Accumulateur : renvoie les dB à appliquer pour ce mouvement (0 tant qu'un cran
 * n'est pas atteint) et le reste. Molette vers le haut (deltaY < 0) = plus fort.
 * Maj inverse deltaX / deltaY sur certains navigateurs : on prend le plus grand.
 */
export function wheelToDb(rest: number, e: { deltaY: number; deltaX?: number; deltaMode?: number }): { db: number; rest: number } {
  const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX || 0) ? e.deltaY : (e.deltaX || 0);
  // Lignes (Firefox : 3 lignes par cran) ou pages.
  const px = e.deltaMode === 1 ? raw * (WHEEL_NOTCH_PX / 3) : e.deltaMode === 2 ? raw * 4 * WHEEL_NOTCH_PX : raw;
  const total = rest - px; // haut = positif
  const steps = Math.trunc(total / WHEEL_NOTCH_PX);
  return { db: steps * WHEEL_STEP_DB, rest: total - steps * WHEEL_NOTCH_PX };
}

/** Le clip est-il dans la sélection courante (clips choisis ou plage qui le couvre) ? */
export function inSelection(trackId: string, clip: { id: string; start: number; duration: number }): boolean {
  const s = editSelectionStore.get();
  if (s.clipIds.includes(clip.id)) return true;
  const t = s.time;
  return !!t && t.trackIds.includes(trackId) && clip.start < t.end && clip.start + clip.duration > t.start && t.end - t.start > 1e-4;
}

let rest = 0;
let pendingDb = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Un mouvement de molette sur un clip (Ctrl+Maj) : le gain suit, regroupé. */
export function clipGainWheel(trackId: string, clip: { id: string; start: number; duration: number }, e: { deltaY: number; deltaX?: number; deltaMode?: number }): void {
  if (!inSelection(trackId, clip)) editSelectionStore.set({ clipIds: [clip.id], time: null, focusTrackId: trackId });
  const r = wheelToDb(rest, e);
  rest = r.rest;
  if (!r.db) return;
  pendingDb += r.db;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const db = Math.round(pendingDb * 10) / 10;
    pendingDb = 0; timer = null;
    if (db) runEditCommand('clipGainNudge', { db });
  }, GROUP_MS);
}

/** Tests : remet l'accumulateur à zéro. */
export const resetClipGainWheel = () => { rest = 0; pendingDb = 0; if (timer) clearTimeout(timer); timer = null; };
