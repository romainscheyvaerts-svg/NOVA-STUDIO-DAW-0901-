/**
 * Retour haptique au doigt (téléphone, tablette), quand l'appareil le permet.
 *
 * - Appli Make Music (Capacitor) : le module Haptics s'il est installé (iPhone compris) ;
 * - navigateur Android : navigator.vibrate ;
 * - iPhone dans Safari, ordinateur, souris : rien (aucune erreur).
 *
 * Une vibration très courte, jamais pendant que le doigt glisse en continu (le pincement
 * ne vibre qu'au passage d'un cran), et coupée quand l'utilisateur a demandé moins
 * d'animations au système.
 */
export type HapticKind = 'select' | 'press' | 'success' | 'warning';

const MS: Record<HapticKind, number | number[]> = { select: 8, press: 15, success: [10, 40, 18], warning: [25, 50, 25] };

type CapHaptics = { impact?: (o: { style: string }) => Promise<void>; selectionChanged?: () => Promise<void>; notification?: (o: { type: string }) => Promise<void> };

const coarse = (): boolean => {
  try { return !!window.matchMedia?.('(pointer: coarse)').matches; } catch { return false; }
};

const reduced = (): boolean => {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

let last = 0;

export function haptic(kind: HapticKind = 'select'): void {
  if (typeof window === 'undefined' || !coarse() || reduced()) return;
  // Pas plus d'une vibration toutes les 40 ms (rafales de touchers, pincement).
  const now = Date.now();
  if (now - last < 40) return;
  last = now;
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: { Haptics?: CapHaptics } } }).Capacitor?.Plugins?.Haptics;
    if (cap) {
      if (kind === 'select' && cap.selectionChanged) { void cap.selectionChanged().catch(() => {}); return; }
      if ((kind === 'success' || kind === 'warning') && cap.notification) { void cap.notification({ type: kind === 'success' ? 'SUCCESS' : 'WARNING' }).catch(() => {}); return; }
      if (cap.impact) { void cap.impact({ style: kind === 'press' ? 'MEDIUM' : 'LIGHT' }).catch(() => {}); return; }
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(MS[kind]);
  } catch { /* appareil sans vibreur, ou refusé par le navigateur */ }
}
