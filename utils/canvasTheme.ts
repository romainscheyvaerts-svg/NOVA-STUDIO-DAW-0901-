/**
 * Couleurs des dessins sur <canvas> (timeline, formes d'onde, minimap,
 * vumètres) selon le thème affiché. Le canvas ne lit pas les variables CSS :
 * on lui donne ici les mêmes teintes que styles/novaTheme.js.
 *
 *   const c = canvasTheme();
 *   ctx.strokeStyle = c.ink(0.08);   // trait discret (blanc en sombre, encre en clair)
 *
 * Les composants qui dessinent ajoutent `useTheme().theme` aux dépendances de
 * leur dessin pour se redessiner au changement de thème.
 */
export type CanvasTheme = ReturnType<typeof build>;

const rgba = (rgb: string) => (a: number) => `rgba(${rgb}, ${a})`;

function build(light: boolean) {
  return light ? {
    light: true,
    /** Encre : traits, textes, poignées (équivalent du blanc en thème sombre). */
    ink: rgba('15, 23, 42'),
    /** Voile qui assombrit légèrement (équivalent du noir translucide en sombre). */
    veil: (a: number) => `rgba(100, 116, 139, ${Math.min(1, a * 0.45)})`,
    bg: '#f1f4f8', surface: '#ffffff', panel: '#e8ecf2',
    text: '#0f172a', textMuted: '#475569', line: '#cbd5e1',
    accent: '#0891b2', accentFill: rgba('8, 145, 178'),
    clipTop: '#ffffff', clipBottom: '#f3f6fa', clipMutedTop: '#e2e8f0', clipMutedBottom: '#d9dfe7', mutedWave: '#94a3b8',
    labelBg: 'rgba(255, 255, 255, 0.88)', labelText: '#0f172a', labelMuted: '#64748b',
  } : {
    light: false,
    ink: rgba('255, 255, 255'),
    veil: (a: number) => `rgba(0, 0, 0, ${a})`,
    bg: '#0c0d10', surface: '#14161a', panel: '#08090b',
    text: '#e2e8f0', textMuted: '#94a3b8', line: '#1e2229',
    accent: '#00f2ff', accentFill: rgba('0, 242, 255'),
    clipTop: '#1a1d24', clipBottom: '#12151a', clipMutedTop: '#0a0a0a', clipMutedBottom: '#050505', mutedWave: '#333333',
    labelBg: 'rgba(0, 0, 0, 0.6)', labelText: '#ffffff', labelMuted: '#666666',
  };
}

const DARK = build(false);
const LIGHT = build(true);

export function isLightTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
}

/** Couleurs de dessin du thème affiché (lues à chaque dessin : pas de cache à invalider). */
export function canvasTheme(): CanvasTheme {
  return isLightTheme() ? LIGHT : DARK;
}
