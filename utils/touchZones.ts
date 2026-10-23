/**
 * Zones de toucher « dans l'espace libre seulement » (écrans tactiles : tablette, téléphone, PC tactile).
 *
 * Un petit bouton (moins de 44 px) se touche sur une zone invisible plus grande (::after, index.html),
 * mais jamais au point d'empiéter sur un voisin : pour chaque côté, la zone s'étend au plus de la
 * moitié de l'espace libre jusqu'au contrôle voisin le plus proche, et en largeur sans sortir de la boîte
 * de son conteneur (sinon la barre du haut se croyait trop large et repliait « Exporter » dans ☰).
 * Les extensions sont posées en variables CSS sur le bouton (valeurs négatives) : --nv-zt, --nv-zb, --nv-zl, --nv-zr.
 *
 * Recalculé après un changement de mise en page (éléments ajoutés / retirés, taille de la fenêtre),
 * regroupé (250 ms) et jamais pendant un glisser : coût mesuré de quelques ms pour 400 boutons.
 */
const TARGET = 44;
const CONTROLS = 'button, [role=button], [role=slider], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], a[href], input:not([type=hidden]), select, textarea';

type Box = { l: number; t: number; r: number; b: number };

const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };

/**
 * Limite en largeur : le premier ancêtre qui coupe ou fait défiler son contenu (la zone n'y ajoute pas de
 * défilement), ou un groupe des barres mesurées par barFit / dockFit (barre du haut, bandeau du bas : leur
 * largeur mesurée ne doit pas bouger) ; sinon l'écran.
 */
function bounds(el: HTMLElement): Box {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const par = p.parentElement;
    const measured = p.matches('[data-testid=transport-bar], [data-nova-dock]') || !!(par && par.matches('[data-testid=transport-bar], [data-nova-dock]'));
    const ox = getComputedStyle(p).overflowX;
    if (measured || ox !== 'visible') return box(p);
  }
  return { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight };
}

/** Calcule les extensions de tous les petits boutons visibles. Renvoie le nombre de boutons traités. */
export function computeTouchZones(root: ParentNode = document): number {
  const all = Array.from(root.querySelectorAll<HTMLElement>(CONTROLS)).filter(el => el.getClientRects().length > 0);
  const boxes = all.map(box);
  let n = 0;
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.tagName !== 'BUTTON' || el.hasAttribute('data-no-hit') || el.classList.contains('delete-fx')) continue;
    const me = boxes[i];
    const w = me.r - me.l, h = me.b - me.t;
    if (w < 1 || h < 1) continue;
    const needX = Math.max(0, (TARGET - w) / 2), needY = Math.max(0, (TARGET - h) / 2);
    // .nova-hit / .nova-hit-tactile : jamais moins que leur zone dessinée d'avant (40 px de large, 44 de haut).
    const legacy = el.classList.contains('nova-hit') || el.classList.contains('nova-hit-tactile');
    const minX = legacy ? Math.max(0, (40 - w) / 2) : 0, minY = legacy ? needY : 0;
    const set = (v: string, px: number) => { const s = `${-Math.max(0, Math.floor(px))}px`; if (el.style.getPropertyValue(v) !== s) el.style.setProperty(v, s); };
    if (!needX && !needY) { set('--nv-zl', 0); set('--nv-zr', 0); set('--nv-zt', 0); set('--nv-zb', 0); continue; }
    const c = bounds(el);
    // Largeur : bornée par le conteneur (la largeur mesurée des barres ne bouge pas). Hauteur : seulement par les
    // voisins et l'écran (une zone qui dépasse en hauteur ne change la mise en page de rien).
    let l = Math.min(needX, me.l - c.l), r = Math.min(needX, c.r - me.r), t = Math.min(needY, me.t), b = Math.min(needY, window.innerHeight - me.b);
    for (let j = 0; j < all.length; j++) {
      if (j === i) continue;
      const o = boxes[j];
      if (all[j].contains(el) || el.contains(all[j])) continue;
      const overlapY = Math.min(me.b + b, o.b) - Math.max(me.t - t, o.t) > 0;
      const overlapX = Math.min(me.r + r, o.r) - Math.max(me.l - l, o.l) > 0;
      // Voisin à gauche / à droite (sur la même rangée) : la moitié de l'écart.
      if (overlapY) {
        if (o.r <= me.l && me.l - o.r < l * 2 + 1) l = Math.min(l, (me.l - o.r) / 2);
        if (o.l >= me.r && o.l - me.r < r * 2 + 1) r = Math.min(r, (o.l - me.r) / 2);
      }
      // Voisin au-dessus / au-dessous (même colonne).
      if (overlapX) {
        if (o.b <= me.t && me.t - o.b < t * 2 + 1) t = Math.min(t, (me.t - o.b) / 2);
        if (o.t >= me.b && o.t - me.b < b * 2 + 1) b = Math.min(b, (o.t - me.b) / 2);
      }
    }
    set('--nv-zl', Math.max(minX, l)); set('--nv-zr', Math.max(minX, r)); set('--nv-zt', Math.max(minY, t)); set('--nv-zb', Math.max(minY, b));
    n++;
  }
  return n;
}

let started = false;

/** Démarre le calcul automatique sur un écran tactile (sans effet à la souris). */
export function startTouchZones(): void {
  if (started || typeof window === 'undefined') return;
  let coarse = false;
  try { coarse = !!window.matchMedia?.('(pointer: coarse)').matches; } catch { /* */ }
  if (!coarse) return;
  started = true;
  let timer: number | undefined;
  let pointerDown = false;
  const run = () => {
    timer = undefined;
    if (pointerDown || document.hidden) { schedule(); return; }
    try { computeTouchZones(); } catch { /* jamais bloquant */ }
  };
  const schedule = () => { if (timer === undefined) timer = window.setTimeout(run, 400); };
  window.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  window.addEventListener('pointerup', () => { pointerDown = false; schedule(); }, true);
  window.addEventListener('pointercancel', () => { pointerDown = false; schedule(); }, true);
  window.addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}
