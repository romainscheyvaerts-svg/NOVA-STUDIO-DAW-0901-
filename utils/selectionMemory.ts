import { editSelectionStore, type EditSelectionState } from './editSelection';
import { selLength, type TimeSelection } from './timeSelection';

/**
 * Mémoire de la sélection (Pro Tools) :
 *  - « Restaurer la dernière sélection » (Pro Tools : Opt+Cmd+Z ; NOVA : Ctrl+Alt+Z) :
 *    la sélection d'avant revient (plage et clips) ; un 2e appui revient à celle
 *    d'après (va-et-vient), comme dans Pro Tools ;
 *  - repère qui mémorise une PLAGE (Memory Location « Selection ») : le rappeler
 *    resélectionne la plage sur les mêmes pistes et y place la tête de lecture.
 * La sélection n'est pas une édition : rien ne va dans l'historique d'annulation.
 */

export interface SelectionSnapshot { time: TimeSelection | null; clipIds: string[] }

const MAX = 30;
/**
 * Une sélection qui ne vit pas plus que ça (glisser du Sélecteur : une sélection
 * par image ; clic qui vide avant de sélectionner) n'entre pas dans l'historique.
 */
export const SETTLE_MS = 300;

export const snapshotOf = (s: Pick<EditSelectionState, 'time' | 'clipIds'>): SelectionSnapshot => ({
  time: s.time ? { start: s.time.start, end: s.time.end, trackIds: [...s.time.trackIds] } : null,
  clipIds: [...(s.clipIds || [])],
});

export const isEmptySnapshot = (s: SelectionSnapshot | null | undefined): boolean =>
  !s || (!s.time || selLength(s.time) < 1e-4) && s.clipIds.length === 0;

export const sameSnapshot = (a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean => {
  if (!a || !b) return a === b;
  const ta = a.time, tb = b.time;
  const sameTime = (!ta && !tb) || (!!ta && !!tb && Math.abs(ta.start - tb.start) < 1e-6 && Math.abs(ta.end - tb.end) < 1e-6
    && ta.trackIds.length === tb.trackIds.length && ta.trackIds.every((id, i) => id === tb.trackIds[i]));
  if (!sameTime) return false;
  if (a.clipIds.length !== b.clipIds.length) return false;
  const sb = new Set(b.clipIds);
  return a.clipIds.every(id => sb.has(id));
};

/**
 * Historique des sélections (logique pure, testée) : `observe` reçoit chaque
 * sélection, `restore` rend la précédente non vide (ou null).
 */
export class SelectionHistory {
  private past: SelectionSnapshot[] = [];
  private current: SelectionSnapshot | null = null;
  private restoring: SelectionSnapshot | null = null;
  /** Depuis quand la sélection courante est là (ms). */
  private since = 0;

  observe(s: SelectionSnapshot, now = Date.now()) {
    if (this.restoring && sameSnapshot(s, this.restoring)) { this.current = s; this.restoring = null; this.since = now; return; }
    this.restoring = null;
    if (sameSnapshot(s, this.current)) { this.current = s; return; }
    // Sélection de passage (pendant un glisser) : remplacée, pas gardée.
    const settled = now - this.since >= SETTLE_MS;
    this.since = now;
    if (settled && this.current && !isEmptySnapshot(this.current)) {
      this.past = this.past.filter(p => !sameSnapshot(p, this.current));
      this.past.push(this.current);
      if (this.past.length > MAX) this.past.shift();
    }
    this.current = s;
  }

  /** La sélection d'avant (la courante prend sa place : un 2e appui y revient). */
  restore(exists: (s: SelectionSnapshot) => SelectionSnapshot | null = s => s): SelectionSnapshot | null {
    while (this.past.length) {
      const prev = exists(this.past.pop()!);
      if (!prev || isEmptySnapshot(prev) || sameSnapshot(prev, this.current)) continue;
      if (this.current && !isEmptySnapshot(this.current)) {
        this.past = this.past.filter(p => !sameSnapshot(p, this.current));
        this.past.push(this.current);
      }
      this.current = prev;
      this.restoring = prev;
      this.since = 0;
      return prev;
    }
    return null;
  }

  get size() { return this.past.length; }
  clear() { this.past = []; this.current = null; this.restoring = null; }
}

// ------------------------------------------------------------- branchement sur la sélection partagée

export const selectionHistory = new SelectionHistory();
let unsub: (() => void) | null = null;

/** Suit la sélection partagée (utils/editSelection) ; idempotent. */
export function startSelectionHistory(): () => void {
  if (!unsub) {
    selectionHistory.observe(snapshotOf(editSelectionStore.get()));
    unsub = editSelectionStore.subscribe(() => selectionHistory.observe(snapshotOf(editSelectionStore.get())));
  }
  return () => { unsub?.(); unsub = null; };
}

/** Évènement : la vue Pistes resélectionne ces clips (elle garde sa propre sélection de clips). */
export const SELECT_CLIPS_EVENT = 'nova:select-clips';

/** Applique une sélection mémorisée : plage dans le magasin partagé, clips par la vue Pistes. */
export function applySelection(s: SelectionSnapshot) {
  // Plage et clips d'un seul coup : l'historique voit la sélection rendue, pas un état intermédiaire.
  editSelectionStore.set({ time: s.time ? { ...s.time, trackIds: [...s.time.trackIds] } : null, clipIds: [...s.clipIds] });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SELECT_CLIPS_EVENT, { detail: { clipIds: [...s.clipIds], keepTime: !!s.time } }));
}

/**
 * Ctrl+Alt+Z. `alive` dit si une piste / un clip existe encore (sinon il est
 * retiré de la sélection rendue). Renvoie le message à afficher.
 */
export function restoreLastSelection(alive: { track: (id: string) => boolean; clip: (id: string) => boolean }): string {
  const prev = selectionHistory.restore(s => {
    const time = s.time ? { ...s.time, trackIds: s.time.trackIds.filter(alive.track) } : null;
    const out: SelectionSnapshot = { time: time && time.trackIds.length ? time : null, clipIds: s.clipIds.filter(alive.clip) };
    return isEmptySnapshot(out) ? null : out;
  });
  if (!prev) return 'Pas de sélection précédente à restaurer.';
  applySelection(prev);
  return `↩︎ Sélection précédente restaurée : ${describeSelection(prev)} (Ctrl+Alt+Z encore : retour à l’autre).`;
}

const fmtS = (s: number) => `${s.toFixed(2).replace('.', ',')} s`;

export function describeSelection(s: SelectionSnapshot): string {
  const parts: string[] = [];
  if (s.time) parts.push(`plage de ${fmtS(selLength(s.time))} sur ${s.time.trackIds.length} piste${s.time.trackIds.length > 1 ? 's' : ''}`);
  if (s.clipIds.length) parts.push(`${s.clipIds.length} clip${s.clipIds.length > 1 ? 's' : ''}`);
  return parts.join(' + ');
}

export { isSelectionMarker, selectionMarker, selectionFromMarker, cleanMarkerSelection } from './selectionMarkers';
export type { MarkerSelection } from './selectionMarkers';
