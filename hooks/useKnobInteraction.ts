import { useCallback, useRef } from 'react';

/**
 * Gestes « console » communs à tous les potards et faders :
 * - glisser vertical (souris ou doigt) pour régler ;
 * - Maj ou Ctrl enfoncée pendant le glissement = réglage fin (10x plus précis), comme dans les
 *   DAW sous Windows (Ctrl) et sur Mac (Maj / Cmd) ;
 * - molette = petit pas (Maj ou Ctrl + molette = pas fin) ;
 * - double-clic (ou double tape), ou Alt+clic = valeur par défaut.
 *
 * La valeur par défaut est `defaultValue` si fourni, sinon 0 pour une plage
 * bipolaire (pan, gain en dB…), sinon la valeur qu'avait le potard à
 * l'ouverture du panneau.
 *
 * `log: true` : course logarithmique (fréquences, temps), min doit être > 0.
 */
export interface KnobOptions {
  min?: number;
  max?: number;
  /** Pixels de glissement pour parcourir toute la course. */
  sensitivity?: number;
  disabled?: boolean;
  defaultValue?: number;
  log?: boolean;
  /** Pas de la molette, en fraction de la course (1 % par défaut). */
  wheelStep?: number;
  /** Faders horizontaux : glisser vers la droite augmente. */
  horizontal?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
  /**
   * Valeur réelle au moment du geste, si elle bouge sans redessiner le composant
   * (automation pendant la lecture : seul le visuel du potard suit la courbe).
   */
  valueNow?: () => number;
}

export const KNOB_HINT = 'Glisser pour régler · Ctrl ou Maj : réglage fin · molette · double-clic ou Alt+clic : valeur par défaut';

/** Réglage fin : Maj, Ctrl ou Cmd enfoncée (Windows : Ctrl ; Mac : Cmd / Maj). */
export const isFineKey = (e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean => !!(e.shiftKey || e.ctrlKey || e.metaKey);

export const useKnobInteraction = (
  value: number,
  onChange: (newValue: number) => void,
  options: KnobOptions = {}
) => {
  const mountValue = useRef(value);
  const latest = useRef({ value, onChange, options });
  latest.current = { value, onChange, options };

  const cfg = () => {
    const o = latest.current.options;
    const min = o.min ?? 0;
    const max = o.max ?? 1;
    const log = !!o.log && min > 0 && max > min;
    const toNorm = (v: number) => {
      const x = Number.isFinite(v) ? v : min;
      const n = log ? Math.log(Math.max(min, x) / min) / Math.log(max / min) : (x - min) / ((max - min) || 1);
      return Math.max(0, Math.min(1, n));
    };
    const fromNorm = (n: number) => {
      const c = Math.max(0, Math.min(1, n));
      return log ? min * Math.pow(max / min, c) : min + c * (max - min);
    };
    const defaultValue = o.defaultValue ?? (min < 0 && max > 0 ? 0 : mountValue.current);
    return { min, max, toNorm, fromNorm, defaultValue, sens: o.sensitivity ?? 200, disabled: !!o.disabled, horizontal: !!o.horizontal };
  };

  const emit = (v: number) => { if (Number.isFinite(v)) latest.current.onChange(v); };
  const current = () => { const f = latest.current.options.valueNow; return f ? f() : latest.current.value; };

  const reset = useCallback(() => {
    const c = cfg();
    if (c.disabled) return;
    emit(Math.max(c.min, Math.min(c.max, c.defaultValue)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const c = cfg();
    if (c.disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Double-clic (le second appui) ou Alt+clic : valeur par défaut, sans glissement.
    if (e.detail >= 2 || e.altKey) { reset(); return; }

    let last = c.horizontal ? e.clientX : e.clientY;
    let norm = c.toNorm(current());
    latest.current.options.onStart?.();
    // Fenêtre du bouton : la console peut être dans une fenêtre détachée (2e écran, utils/popoutWindow).
    const win: Window = (e.currentTarget as HTMLElement)?.ownerDocument?.defaultView || window;

    const onMouseMove = (m: MouseEvent) => {
      const pos = c.horizontal ? m.clientX : m.clientY;
      const delta = c.horizontal ? pos - last : last - pos;
      last = pos;
      norm = Math.max(0, Math.min(1, norm + (delta / c.sens) * (isFineKey(m) ? 0.1 : 1)));
      emit(c.fromNorm(norm));
    };
    const onMouseUp = () => {
      win.removeEventListener('mousemove', onMouseMove);
      win.removeEventListener('mouseup', onMouseUp);
      win.document.body.style.cursor = '';
      latest.current.options.onEnd?.();
    };
    win.addEventListener('mousemove', onMouseMove);
    win.addEventListener('mouseup', onMouseUp);
    win.document.body.style.cursor = c.horizontal ? 'ew-resize' : 'ns-resize';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset]);

  const lastTapRef = useRef(0);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const c = cfg();
    if (c.disabled || e.touches.length !== 1) return;
    e.stopPropagation();
    // Double tape = valeur par défaut
    const now = Date.now();
    if (now - lastTapRef.current < 300) { lastTapRef.current = 0; reset(); return; }
    lastTapRef.current = now;

    let last = c.horizontal ? e.touches[0].clientX : e.touches[0].clientY;
    let norm = c.toNorm(current());
    latest.current.options.onStart?.();
    const win: Window = (e.currentTarget as HTMLElement)?.ownerDocument?.defaultView || window;

    const onTouchMove = (t: TouchEvent) => {
      if (t.touches.length === 0) return;
      if (t.cancelable) t.preventDefault();
      const pos = c.horizontal ? t.touches[0].clientX : t.touches[0].clientY;
      const delta = c.horizontal ? pos - last : last - pos;
      last = pos;
      norm = Math.max(0, Math.min(1, norm + delta / c.sens));
      emit(c.fromNorm(norm));
    };
    const onTouchEnd = () => {
      win.removeEventListener('touchmove', onTouchMove);
      win.removeEventListener('touchend', onTouchEnd);
      win.removeEventListener('touchcancel', onTouchEnd);
      latest.current.options.onEnd?.();
    };
    win.addEventListener('touchmove', onTouchMove, { passive: false });
    win.addEventListener('touchend', onTouchEnd);
    win.addEventListener('touchcancel', onTouchEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset]);

  // Molette : écouteur natif non passif (sinon la page défile en même temps).
  const wheelEl = useRef<HTMLElement | null>(null);
  const onWheel = useRef((w: WheelEvent) => {
    const c = cfg();
    if (c.disabled || w.deltaY === 0) return;
    w.preventDefault();
    w.stopPropagation();
    const step = (latest.current.options.wheelStep ?? 0.01) * (isFineKey(w) ? 0.1 : 1);
    const n = c.toNorm(current()) + (w.deltaY < 0 ? step : -step);
    emit(c.fromNorm(n));
  });
  const wheelRef = useCallback((el: HTMLElement | null) => {
    if (wheelEl.current) wheelEl.current.removeEventListener('wheel', onWheel.current);
    wheelEl.current = el;
    if (el) el.addEventListener('wheel', onWheel.current, { passive: false });
  }, []);

  return {
    handleMouseDown,
    handleTouchStart,
    handleDoubleClick: reset,
    wheelRef,
    /** À étaler sur l'élément saisissable : {...knob.bind} */
    bind: { onMouseDown: handleMouseDown, onTouchStart: handleTouchStart, ref: wheelRef, title: KNOB_HINT },
  };
};
