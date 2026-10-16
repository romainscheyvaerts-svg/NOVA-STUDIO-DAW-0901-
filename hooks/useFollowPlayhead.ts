import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';

/**
 * Suivi de la tête de lecture dans l'arrangement, comme Pro Tools / Logic :
 *  - pendant la lecture, la vue avance d'une page quand la tête sort de l'écran ;
 *  - si l'utilisateur fait défiler À LA MAIN (molette horizontale, Maj+molette, pavé tactile,
 *    doigt, barre de défilement, minimap), le suivi se SUSPEND : on regarde ailleurs
 *    sans être ramené de force ;
 *  - il reprend au prochain Play, ou tout de suite avec le bouton « Suivre ».
 *
 * Un défilement fait par NOVA (suivi lui-même, zoom, « montrer ce clip ») ne suspend rien :
 * seul compte un défilement horizontal qui suit de près un geste de l'utilisateur.
 */

/** Fenêtre (ms) entre le geste et l'événement « scroll » qu'il provoque. */
export const USER_SCROLL_WINDOW_MS = 600;

export interface FollowDecision {
  /** Défilement fait par NOVA (suivi de la tête) : jamais une raison de suspendre. */
  auto: boolean;
  playing: boolean;
  /** Déplacement horizontal (px) depuis le dernier « scroll ». */
  dx: number;
  /** Temps écoulé depuis le dernier geste de l'utilisateur (ms). */
  sinceGesture: number;
}

/** Ce défilement doit-il suspendre le suivi ? (pur, testé) */
export const shouldSuspendFollow = (d: FollowDecision): boolean =>
  !d.auto && d.playing && Math.abs(d.dx) >= 1 && d.sinceGesture >= 0 && d.sinceGesture < USER_SCROLL_WINDOW_MS;

export interface FollowPlayhead {
  /** Suivi suspendu (bouton « Suivre » affiché). */
  suspended: boolean;
  /** Lu à chaque image par le calque de la tête de lecture. */
  suspendedRef: MutableRefObject<boolean>;
  /** Reprendre le suivi (bouton « Suivre »). */
  resume: () => void;
  /** Geste de défilement fait ailleurs que dans la zone (minimap). */
  noteUserScroll: () => void;
}

export function useFollowPlayhead(
  scrollRef: RefObject<HTMLElement | null>,
  isPlaying: boolean,
  /** Posé à true par le suivi juste avant de défiler lui-même. */
  autoScrollRef: MutableRefObject<boolean>,
): FollowPlayhead {
  const [suspended, setSuspended] = useState(false);
  const suspendedRef = useRef(false);
  const gestureAt = useRef(-Infinity);
  const lastLeft = useRef<number | null>(null);
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;

  const set = useCallback((v: boolean) => {
    if (suspendedRef.current === v) return;
    suspendedRef.current = v;
    setSuspended(v);
  }, []);
  const resume = useCallback(() => set(false), [set]);
  const noteUserScroll = useCallback(() => { gestureAt.current = performance.now(); autoScrollRef.current = false; }, [autoScrollRef]);

  // Chaque nouveau Play repart en suivi.
  const wasPlaying = useRef(isPlaying);
  useEffect(() => {
    if (isPlaying && !wasPlaying.current) set(false);
    wasPlaying.current = isPlaying;
  }, [isPlaying, set]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastLeft.current = el.scrollLeft;
    // Ctrl / Cmd + molette = zoom (pas un défilement de l'utilisateur).
    const onWheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) noteUserScroll(); };
    const onTouch = () => noteUserScroll();
    // Clic sur la barre de défilement : la cible est la zone elle-même (pas un clip ni une piste).
    const onPointerDown = (e: PointerEvent) => { if (e.target === el) noteUserScroll(); };
    const onKey = (e: KeyboardEvent) => { if (e.target === el && /^(Page(Up|Down)|Home|End|Arrow(Left|Right))$/.test(e.key)) noteUserScroll(); };
    const onScroll = () => {
      const left = el.scrollLeft;
      const dx = lastLeft.current === null ? 0 : left - lastLeft.current;
      lastLeft.current = left;
      const auto = autoScrollRef.current;
      if (auto && Math.abs(dx) >= 1) autoScrollRef.current = false;
      if (shouldSuspendFollow({ auto, playing: playingRef.current, dx, sinceGesture: performance.now() - gestureAt.current })) set(true);
    };
    el.addEventListener('wheel', onWheel, { passive: true, capture: true });
    el.addEventListener('touchmove', onTouch, { passive: true });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('keydown', onKey);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      el.removeEventListener('touchmove', onTouch);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, autoScrollRef, noteUserScroll, set]);

  return { suspended, suspendedRef, resume, noteUserScroll };
}
