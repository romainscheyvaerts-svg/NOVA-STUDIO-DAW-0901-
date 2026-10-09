import type { Clip, ClipLock, Track } from '../types';

/**
 * Verrou de clip (Pro Tools : Clip › Verrouiller/Déverrouiller l'édition et
 * Verrouiller/déverrouiller le clip sur un emplacement temporel). Module pur.
 *
 * - « edit » (Edit Lock, Ctrl+L) : le clip ne bouge plus, ne se rogne plus,
 *   ne se coupe plus, ne se supprime plus, et son contenu (gain, fondus,
 *   justesse, effets de clip…) ne change plus. Le renommer, changer sa couleur
 *   ou le déverrouiller restent possibles.
 * - « time » (Time Lock, Alt+Maj+L) : le son reste calé au même endroit de la
 *   timeline (un rognage garde l'instant de chaque son) ; tout le reste se fait.
 *
 * La protection est posée à un seul endroit : chaque modification LOCALE du
 * projet passe par `enforceClipLocks` (App.tsx, historique d'annulation). Une
 * modification qui touche un clip verrouillé est refusée pour sa piste (les
 * clips de cette piste restent tels quels, seuls les clips nouveaux étrangers
 * au clip verrouillé, comme une prise, sont gardés), avec un message. Les opérations
 * reçues d'un collaborateur, l'ouverture d'un projet, annuler / rétablir ne
 * passent pas par là. Le champ `lock` voyage avec le clip (collaboration,
 * sauvegarde) ; une ancienne version de NOVA l'ignore.
 */

export const LOCK_LABEL: Record<ClipLock, string> = {
  edit: 'verrouillé (édition)',
  time: 'verrouillé sur sa position',
};

export const isClipLock = (v: unknown): v is ClipLock => v === 'edit' || v === 'time';

/** Champs qu'un verrou d'édition protège (position, longueur, son, gain, fondus, retouches). */
const EDIT_FIELDS = [
  'start', 'duration', 'offset', 'fadeIn', 'fadeOut', 'fadeInCurve', 'fadeOutCurve', 'gain', 'gainPoints', 'gainRender',
  'isReversed', 'isMuted', 'notes', 'cc', 'breaths', 'warp', 'pitchEdit', 'araEdit', 'audioSuite', 'elastic', 'loop', 'syncPoint', 'groove',
] as const;

const r9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** Empreinte de ce qu'un verrou d'édition protège. */
export function editSig(c: Clip): string {
  const rec = c as unknown as Record<string, unknown>;
  return JSON.stringify(EDIT_FIELDS.map(k => {
    const v = rec[k];
    return typeof v === 'number' ? r9(v) : v ?? null;
  }));
}

/** Instant de la timeline où commence le son du clip (ce qu'un verrou de position protège). */
export const anchorOf = (c: Clip): number => r9((c.start || 0) - (c.offset || 0));

export interface LockRefusal { trackId: string; trackName: string; clipName: string; lock: ClipLock }

/**
 * Le passage `prev → next` respecte-t-il le clip verrouillé `before` ?
 * `after` : le même clip dans `next` (absent : supprimé ou remplacé).
 */
export function lockViolated(before: Clip, after: Clip | undefined): boolean {
  const lock = before.lock;
  if (!isClipLock(lock)) return false;
  if (!after) return lock === 'edit';
  // Déverrouillé (ou verrou changé) dans la même modification : c'est le geste de l'utilisateur.
  if (after.lock !== lock) return false;
  return lock === 'edit' ? editSig(before) !== editSig(after) : anchorOf(before) !== anchorOf(after);
}

/**
 * Clip NOUVEAU (absent avant) tiré du clip verrouillé `l` : morceau d'une
 * découpe, copie sur place. Même son (ou même type pour un clip MIDI) et posé
 * sur la même portion de temps.
 */
const derivedFrom = (c: Clip, l: Clip): boolean =>
  c.start < l.start + l.duration - 1e-9 && c.start + c.duration > l.start + 1e-9
  && (l.bufferId ? c.bufferId === l.bufferId : c.type === l.type);

/**
 * Refuse, piste par piste, les modifications locales qui touchent un clip
 * verrouillé : la piste reprend ses clips d'avant. Les clips NOUVEAUX qui ne
 * viennent pas d'un clip verrouillé (une prise qu'on vient d'enregistrer, un
 * collage d'un autre son) sont gardés : un refus ne perd jamais d'audio.
 * Renvoie `next` inchangé (même référence) quand tout est permis.
 */
export function enforceClipLocks(prev: Track[], next: Track[]): { tracks: Track[]; refused: LockRefusal[] } {
  if (prev === next) return { tracks: next, refused: [] };
  const before = new Map(prev.map(t => [t.id, t] as const));
  const refused: LockRefusal[] = [];
  let out: Track[] | null = null;
  next.forEach((t, i) => {
    const p = before.get(t.id);
    if (!p || p.clips === t.clips || !p.clips?.some(c => isClipLock(c.lock))) return;
    const now = new Map((t.clips || []).map(c => [c.id, c] as const));
    const hits = p.clips.filter(c => lockViolated(c, now.get(c.id)));
    if (!hits.length) return;
    refused.push({ trackId: t.id, trackName: t.name, clipName: hits[0].name, lock: hits[0].lock! });
    const had = new Set(p.clips.map(c => c.id));
    const kept = (t.clips || []).filter(c => !had.has(c.id) && !hits.some(l => derivedFrom(c, l)));
    if (!out) out = [...next];
    out[i] = { ...t, clips: kept.length ? [...p.clips, ...kept] : p.clips };
  });
  return { tracks: out || next, refused };
}

/** Message à l'utilisateur après un refus. */
export function refusalText(list: LockRefusal[]): string {
  if (!list.length) return '';
  const r = list[0];
  const how = r.lock === 'edit' ? 'Ctrl+L' : 'Alt+Maj+L';
  const more = list.length > 1 ? ` (et ${list.length - 1} autre${list.length > 2 ? 's' : ''} piste${list.length > 2 ? 's' : ''})` : '';
  return `🔒 « ${r.clipName} » est ${LOCK_LABEL[r.lock]} sur « ${r.trackName} »${more} : rien n’a bougé sur cette piste. Déverrouille-le d’abord (${how} ou menu du clip › Édition).`;
}

/**
 * Pose ou retire un verrou sur des clips : si l'un des clips visés n'a pas ce
 * verrou, tous le prennent ; sinon tous le perdent.
 */
export function toggleClipLock(tracks: Track[], clipIds: string[], kind: ClipLock): { tracks: Track[]; on: boolean; count: number } {
  const ids = new Set(clipIds);
  const targets = tracks.flatMap(t => t.clips.filter(c => ids.has(c.id)));
  if (!targets.length) return { tracks, on: false, count: 0 };
  const on = targets.some(c => c.lock !== kind);
  const out = tracks.map(t => {
    if (!t.clips.some(c => ids.has(c.id))) return t;
    return {
      ...t,
      clips: t.clips.map(c => {
        if (!ids.has(c.id)) return c;
        const n: Clip = { ...c };
        if (on) n.lock = kind; else delete n.lock;
        return n;
      }),
    };
  });
  return { tracks: out, on, count: targets.length };
}

/** Pourquoi un geste à la souris est refusé sur ce clip (null : permis). */
export function dragRefusal(c: Clip, action: 'move' | 'edit'): string | null {
  if (c.lock === 'edit') return `🔒 « ${c.name} » est verrouillé : ni déplacé, ni rogné, ni retouché. Ctrl+L (ou menu du clip › Édition) pour le déverrouiller.`;
  if (c.lock === 'time' && action === 'move') return `📌 « ${c.name} » est verrouillé sur sa position : il se rogne et se retouche, mais ne se déplace pas. Alt+Maj+L pour le libérer.`;
  return null;
}

// ---------------------------------------------------------------- messages
// La vérification tourne dans l'historique d'annulation (une fonction pure, que
// React peut appeler deux fois) : le message part par ce petit relais, une fois.
type Listener = (text: string) => void;
const listeners = new Set<Listener>();
let last = { text: '', at: 0 };
export const clipLockNotices = {
  report(list: LockRefusal[]) {
    const text = refusalText(list);
    if (!text) return;
    const now = Date.now();
    if (text === last.text && now - last.at < 400) return;
    last = { text, at: now };
    // Hors du rendu React (la vérification s'exécute pendant une mise à jour d'état).
    setTimeout(() => listeners.forEach(l => l(text)), 0);
  },
  on(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
};

/**
 * Modification qui ne doit pas passer par la vérification des verrous
 * (opération reçue d'un collaborateur) : la fonction est marquée.
 */
export function trustedUpdate<F extends (...a: any[]) => any>(fn: F): F {
  (fn as any).__clipLockTrusted = true;
  return fn;
}
export const isTrustedUpdate = (fn: unknown): boolean => typeof fn === 'function' && !!(fn as any).__clipLockTrusted;

/**
 * Appui sur un clip verrouillé : aucun geste ne démarre ; si l'utilisateur
 * tire quand même (souris ou doigt), on lui dit pourquoi rien ne bouge, une
 * fois. Écoute la fenêtre jusqu'au relâchement.
 */
export function explainLockedDrag(x0: number, y0: number, why: string) {
  if (typeof window === 'undefined') return;
  let told = false;
  const check = (x: number, y: number) => {
    if (told || Math.hypot(x - x0, y - y0) <= 4) return;
    told = true;
    window.dispatchEvent(new CustomEvent('nova:notify', { detail: why }));
  };
  const onMove = (e: MouseEvent) => check(e.clientX, e.clientY);
  const onTouch = (e: TouchEvent) => { const t = e.touches[0]; if (t) check(t.clientX, t.clientY); };
  const done = () => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('touchmove', onTouch, true);
    window.removeEventListener('mouseup', done, true);
    window.removeEventListener('touchend', done, true);
  };
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('touchmove', onTouch, true);
  window.addEventListener('mouseup', done, true);
  window.addEventListener('touchend', done, true);
}
