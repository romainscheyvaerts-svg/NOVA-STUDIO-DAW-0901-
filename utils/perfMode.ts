/**
 * Mode léger pour les PC peu puissants (2 à 4 cœurs, 4 Go, carte graphique intégrée).
 *
 * Posé avant le premier affichage par le script d'index.html (attribut html[data-perf="lite"]) :
 * choix de l'utilisateur dans localStorage « nova_perf » (« leger » / « complet »), sinon
 * détection (≤ 2 cœurs, ou ≤ 4 cœurs et ≤ 4 Go). En mode léger : aucun flou, pas d'animations
 * décoratives en boucle (CSS d'index.html), affichage de la lecture à 30 images/s.
 * L'audio n'est jamais touché.
 */
export type PerfChoice = 'auto' | 'leger' | 'complet';

const KEY = 'nova_perf';

export const detectLowEnd = (cores?: number, memoryGb?: number): boolean => {
  const c = cores ?? 8;
  const m = memoryGb ?? 8;
  return c <= 2 || (c <= 4 && m <= 4);
};

export function readPerfChoice(): PerfChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'leger' || v === 'complet' ? v : 'auto';
  } catch { return 'auto'; }
}

export function isLiteFor(choice: PerfChoice, cores?: number, memoryGb?: number): boolean {
  if (choice === 'leger') return true;
  if (choice === 'complet') return false;
  return detectLowEnd(cores, memoryGb);
}

const nav = (): { hardwareConcurrency?: number; deviceMemory?: number } =>
  (typeof navigator !== 'undefined' ? navigator as any : {});

/** Le mode léger est-il actif sur ce PC ? */
export function isLiteMode(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-perf')) {
    return document.documentElement.getAttribute('data-perf') === 'lite';
  }
  return isLiteFor(readPerfChoice(), nav().hardwareConcurrency, nav().deviceMemory);
}

/** Le PC a été détecté comme peu puissant (pour l'afficher dans les réglages). */
export const detectedLowEnd = (): boolean => detectLowEnd(nav().hardwareConcurrency, nav().deviceMemory);

/** Choix dans les réglages : appliqué tout de suite (CSS) et mémorisé. */
export function setPerfChoice(choice: PerfChoice) {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice);
  } catch { /* stockage indisponible : le choix vaut pour cette séance */ }
  if (typeof document !== 'undefined') {
    if (isLiteFor(choice, nav().hardwareConcurrency, nav().deviceMemory)) document.documentElement.setAttribute('data-perf', 'lite');
    else document.documentElement.removeAttribute('data-perf');
  }
  try { window.dispatchEvent(new CustomEvent('nova:perf-mode')); } catch { /* hors navigateur */ }
}

/** Images/s de l'affichage de la lecture (tête de lecture, horloge). */
export const playheadFrameMs = (): number => (isLiteMode() ? 1000 / 30 : 0);
