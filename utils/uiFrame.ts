import { isLiteMode } from './perfMode';

/**
 * Horloge d'affichage partagée des fenêtres d'effets (spectres, aiguilles, vumètres de façade,
 * animations des chorus / flanger) et du visualiseur du transport.
 *
 * Avant, chaque fenêtre ouverte avait sa propre boucle requestAnimationFrame à 60 images/s,
 * même à l'arrêt, même quand rien ne bouge. Ici, une seule boucle pour toutes :
 *  - 30 images/s pendant la lecture, l'écoute du micro ou un geste (15 en mode léger) ;
 *  - au repos (moteur arrêté, aucun geste depuis 3 s) : 4 images/s, par minuterie (le
 *    navigateur ne se réveille plus à chaque image de l'écran) ;
 *  - rien du tout quand aucune fenêtre ne demande d'image.
 * Même signature que requestAnimationFrame / cancelAnimationFrame.
 */
type Cb = (t: number) => void;

let nextId = 1;
const pending = new Map<number, Cb>();
let raf = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let last = 0;
let lastActivity = 0;
let busyProbe: (() => boolean) | null = null;
let listening = false;

const IDLE_AFTER_MS = 3000;
const IDLE_FRAME_MS = 250;

/** Le moteur joue / écoute (fourni par l'appli : lecture, piste armée, scrub). */
export function setUiBusyProbe(fn: (() => boolean) | null) { busyProbe = fn; }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const mark = () => { lastActivity = now(); };
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) window.addEventListener(ev, mark, { passive: true, capture: true });
  window.addEventListener('nova:transport-start', mark);
}

/** Intervalle entre deux images (ms) selon l'activité. */
export function uiFrameMs(t = now()): number {
  let busy = false;
  try { busy = !!busyProbe?.(); } catch { busy = false; }
  if (!busy && t - lastActivity > IDLE_AFTER_MS) return IDLE_FRAME_MS;
  return isLiteMode() ? 1000 / 15 : 1000 / 30;
}

function run(t: number) {
  raf = 0;
  if (!pending.size) return;
  const wait = uiFrameMs(t) - (t - last);
  if (wait > 2) { schedule(wait); return; }
  last = t;
  const cbs = [...pending.values()];
  pending.clear();
  for (const cb of cbs) { try { cb(t); } catch (e) { /* une fenêtre cassée ne bloque pas les autres */ } }
}

function schedule(wait = 0) {
  if (raf || timer || typeof requestAnimationFrame === 'undefined') return;
  // Attente longue (repos) : minuterie, puis une image de l'écran.
  if (wait > 40) timer = setTimeout(() => { timer = null; raf = requestAnimationFrame(run); }, wait);
  else raf = requestAnimationFrame(run);
}

/** Comme requestAnimationFrame, au rythme de l'horloge partagée. */
export function requestUiFrame(cb: Cb): number {
  listen();
  const id = nextId++;
  pending.set(id, cb);
  schedule();
  return id;
}

/** Comme cancelAnimationFrame. */
export function cancelUiFrame(id: number) {
  pending.delete(id);
  if (!pending.size) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { clearTimeout(timer); timer = null; }
  }
}
