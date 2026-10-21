import { useSyncExternalStore } from 'react';

/**
 * Fenêtres détachées (écart 17) : une vue du studio (d'abord la console) dans une
 * 2e fenêtre, sur le 2e écran de l'ingé. C'est un PORTAIL React : même arbre, même
 * état, même moteur audio, rien n'est copié ni synchronisé à la main. La fenêtre fille
 * reçoit les styles de la page (y compris ceux chargés plus tard) et suit le thème.
 *
 *  - fermer la fenêtre fille rend la vue à la fenêtre principale ;
 *  - sa place et sa taille sont retenues (rouverte au même endroit) ;
 *  - les touches tapées dans la fenêtre fille (Espace, Ctrl+Z…) vont au studio ;
 *  - fermer ou recharger le studio ferme la fenêtre fille.
 *
 * La fenêtre charge `popout.html` (page vide du site, même origine : ses polices et
 * feuilles de style se chargent normalement), puis le studio y affiche la vue.
 *
 * Navigateur : une fenêtre ne s'ouvre qu'après un geste (clic, touche) ; sinon
 * `openPopout` rend false et l'appelant le dit. Nova Studio : la vue web laisse ouvrir
 * cette page (desktop/nova_desktop.py).
 */
export type PopoutId = 'console';

export interface Geometry { x: number; y: number; w: number; h: number }
export interface PopoutHandle { id: PopoutId; win: Window; container: HTMLElement; close: () => void }

const GEO_KEY = 'nova_popout_geometry_v1';
const TITLES: Record<PopoutId, string> = { console: 'Console · NOVA' };
const DEFAULT_GEO: Record<PopoutId, Geometry> = { console: { x: 80, y: 80, w: 1280, h: 720 } };

const open = new Map<PopoutId, PopoutHandle>();
/** Fenêtres demandées, encore en chargement. */
const opening = new Map<PopoutId, Window>();
export const POPOUT_PAGE = 'popout.html';
const popoutUrl = () => {
  let base = '/';
  try { base = (import.meta as any).env?.BASE_URL || '/'; } catch { /* hors Vite */ }
  return `${base.endsWith('/') ? base : `${base}/`}${POPOUT_PAGE}`;
};
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; listeners.forEach(fn => fn()); };

export const popoutStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: (id: PopoutId) => open.get(id) || null,
  isOpen: (id: PopoutId) => open.has(id),
  isOpening: (id: PopoutId) => opening.has(id),
};
/** La fenêtre détachée de cette vue (null : la vue est dans la fenêtre principale). */
export const usePopout = (id: PopoutId): PopoutHandle | null => {
  useSyncExternalStore(popoutStore.subscribe, () => version, () => 0);
  return open.get(id) || null;
};

export function savedGeometry(id: PopoutId): Geometry {
  try {
    const all = JSON.parse(localStorage.getItem(GEO_KEY) || '{}');
    const g = all?.[id];
    if (g && [g.x, g.y, g.w, g.h].every((v: any) => Number.isFinite(v)) && g.w >= 320 && g.h >= 240) return g;
  } catch { /* stockage indisponible */ }
  return DEFAULT_GEO[id];
}
function saveGeometry(id: PopoutId, win: Window) {
  try {
    const g: Geometry = { x: win.screenX, y: win.screenY, w: win.outerWidth || win.innerWidth, h: win.outerHeight || win.innerHeight };
    if (!(g.w >= 320 && g.h >= 240)) return;
    const all = JSON.parse(localStorage.getItem(GEO_KEY) || '{}') || {};
    all[id] = g;
    localStorage.setItem(GEO_KEY, JSON.stringify(all));
  } catch { /* fenêtre déjà fermée ou stockage indisponible */ }
}

/** Copie les styles de la page dans la fenêtre fille et suit ceux ajoutés ou retirés ensuite. */
function mirrorStyles(src: Document, dst: Document): () => void {
  const map = new Map<Node, Node>();
  const isStyle = (n: Node): n is HTMLElement => n instanceof (src.defaultView as any).HTMLElement && (n.nodeName === 'STYLE' || (n.nodeName === 'LINK' && (n as HTMLLinkElement).rel === 'stylesheet'));
  const add = (n: Node) => {
    if (!isStyle(n) || map.has(n)) return;
    const c = dst.importNode(n, true);
    if (n.nodeName === 'LINK') (c as HTMLLinkElement).href = (n as HTMLLinkElement).href; // adresse absolue
    dst.head.appendChild(c);
    map.set(n, c);
  };
  src.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(add);
  const syncRoot = () => {
    const a = src.documentElement, b = dst.documentElement;
    b.className = a.className;
    for (const at of Array.from(a.attributes)) if (at.name !== 'id') b.setAttribute(at.name, at.value);
    dst.body.className = src.body.className;
  };
  syncRoot();
  const mo = new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === 'attributes') { syncRoot(); continue; }
      r.addedNodes.forEach(add);
      r.removedNodes.forEach(n => { const c = map.get(n); if (c && c.parentNode) c.parentNode.removeChild(c); map.delete(n); });
      // Style modifié en place (rechargement à chaud) : recopié.
      if (r.type === 'characterData' || (r.target.nodeName === 'STYLE' && map.has(r.target))) {
        const t = r.target.nodeName === 'STYLE' ? r.target : r.target.parentNode;
        const c = t && map.get(t);
        if (c && t) (c as HTMLElement).textContent = (t as HTMLElement).textContent;
      }
    }
  });
  mo.observe(src.head, { childList: true, subtree: true, characterData: true });
  mo.observe(src.documentElement, { attributes: true });
  mo.observe(src.body, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
}

/** Touches tapées dans la fenêtre fille : rejouées au studio (sauf dans un champ de saisie). */
function forwardKeys(child: Window, main: Window): () => void {
  const fwd = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const copy = new (main as any).KeyboardEvent(e.type, { key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true });
    const handled = !main.document.body.dispatchEvent(copy);
    if (handled || copy.defaultPrevented) e.preventDefault();
  };
  child.addEventListener('keydown', fwd);
  child.addEventListener('keyup', fwd);
  return () => { child.removeEventListener('keydown', fwd); child.removeEventListener('keyup', fwd); };
}

/**
 * Ouvre (ou ramène au premier plan) la fenêtre détachée d'une vue. Rend false si le
 * navigateur ou l'appli l'a bloquée (fenêtre surgissante interdite). La vue y apparaît
 * dès que la page est chargée (usePopout).
 */
export function openPopout(id: PopoutId): boolean {
  const have = open.get(id) || null;
  if (have && !have.win.closed) { try { have.win.focus(); } catch { /* rien */ } return true; }
  const pending = opening.get(id);
  if (pending && !pending.closed) { try { pending.focus(); } catch { /* rien */ } return true; }
  if (typeof window === 'undefined') return false;
  const g = savedGeometry(id);
  const features = `popup=yes,width=${Math.round(g.w)},height=${Math.round(g.h)},left=${Math.round(g.x)},top=${Math.round(g.y)}`;
  let win: Window | null = null;
  try { win = window.open(popoutUrl(), `nova-${id}`, features); } catch { win = null; }
  if (!win) return false;
  opening.set(id, win);
  changed();
  const w = win;
  let tries = 0;
  // Page chargée (même origine) : on y installe la vue. Sondage court : l'événement « load »
  // d'une fenêtre fille n'est pas toujours rattrapable selon le moment où on l'écoute.
  const ready = () => {
    if (opening.get(id) !== w) return;
    if (w.closed) { opening.delete(id); changed(); return; }
    let ok = false;
    try { ok = w.document.readyState === 'complete' && !!w.document.body && w.location.pathname.endsWith(POPOUT_PAGE); } catch { ok = false; }
    if (!ok) { if (tries++ < 200) window.setTimeout(ready, 25); else { opening.delete(id); try { w.close(); } catch { /* rien */ } changed(); } return; }
    opening.delete(id);
    attach(id, w);
  };
  window.setTimeout(ready, 0);
  return true;
}

function attach(id: PopoutId, win: Window): PopoutHandle {
  const doc = win.document;
  doc.title = TITLES[id];
  const stopStyles = mirrorStyles(document, doc);
  const stopKeys = forwardKeys(win, window);
  doc.body.style.margin = '0';
  doc.body.style.height = '100vh';
  doc.body.style.overflow = 'hidden';
  doc.body.style.background = 'var(--bg-main)';
  doc.body.style.color = 'var(--text-primary)';
  const container = doc.createElement('div');
  container.id = `nova-popout-${id}`;
  container.setAttribute('data-nova-popout', id);
  container.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;';
  doc.body.appendChild(container);

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    saveGeometry(id, win);
    stopStyles(); stopKeys();
    window.clearInterval(poll);
    window.removeEventListener('pagehide', closeChild);
    if (open.get(id)?.win === win) open.delete(id);
    changed();
  };
  const closeChild = () => { finish(); try { win.close(); } catch { /* déjà fermée */ } };
  // Place et taille retenues à chaque déplacement (la fermeture par la croix ne laisse pas toujours le temps).
  let geoTimer = 0;
  win.addEventListener('resize', () => { window.clearTimeout(geoTimer); geoTimer = window.setTimeout(() => saveGeometry(id, win), 300); });
  win.addEventListener('pagehide', finish);
  win.addEventListener('beforeunload', finish);
  // Fermeture par la croix de la fenêtre : relevée aussi au cas où pagehide ne vient pas.
  const poll = window.setInterval(() => { if (win.closed) finish(); }, 500);
  window.addEventListener('pagehide', closeChild);
  const handle: PopoutHandle = { id, win, container, close: closeChild };
  open.set(id, handle);
  changed();
  return handle;
}

export function closePopout(id: PopoutId) {
  open.get(id)?.close();
  const w = opening.get(id);
  if (w) { opening.delete(id); try { w.close(); } catch { /* rien */ } changed(); }
}
/** Détache ou ramène la vue ; false si la fenêtre n'a pas pu s'ouvrir. */
export function togglePopout(id: PopoutId): boolean {
  if (open.has(id) || opening.has(id)) { closePopout(id); return true; }
  return openPopout(id);
}
