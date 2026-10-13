/**
 * Anti-enregistrement d'écran : protège les instrus et mélodies du catalogue NON achetées.
 * Règle de Romain : pas de tag audio ; un enregistrement de la sortie son ou un 2e téléphone
 * qui filme restent possibles (accepté : ça fait de la pub).
 *
 * Sources de détection (chacune appelle window.__novaCaptureGuard([...noms])) :
 *  - appli Windows (desktop/nova_desktop.py) : logiciels d'enregistrement ouverts (OBS,
 *    Bandicam, ShareX, Barre de jeu Xbox en enregistrement…), envoyés toutes les 5 s ; la
 *    fenêtre est en plus exclue des captures (WDA_EXCLUDEFROMCAPTURE) ;
 *  - appli iPhone Make Music (SceneDelegate.swift) : UIScreen.isCaptured → « Enregistrement
 *    de l'écran (iPhone) » (iOS ne laisse aucune appli bloquer l'enregistrement) ;
 *  - appli Android Make Music : rien à détecter, la capture est bloquée (FLAG_SECURE, écran
 *    noir) via window.NovaSecure.secure(true) tant que le studio est ouvert.
 * Navigateur : aucun moyen fiable de détecter un enregistrement (limite des navigateurs).
 * Les admins du studio sont exemptés (captures pour la promo, tests).
 */
import { track } from './analytics';

type Listener = (apps: string[]) => void;
let current: string[] = [];
const listeners = new Set<Listener>();
const signales = new Set<string>();

export const recordersRunning = (): string[] => current;

export function onRecordersChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Appli Windows : fenêtre exclue des captures (on) ou capturable (off : admin). */
export function setCaptureProtection(on: boolean): void {
  try { (window as any).chrome?.webview?.postMessage(on ? 'nova-desktop:capture-protect:on' : 'nova-desktop:capture-protect:off'); } catch { /* hors appli */ }
}

/** Appli Android Make Music : écran protégé (FLAG_SECURE) tant que le studio est ouvert. */
export function setSecureScreen(on: boolean): void {
  if (typeof window === 'undefined') return;
  const seen = new Set<unknown>();
  for (const w of [window, window.parent, window.top]) {
    if (!w || seen.has(w)) continue;
    seen.add(w);
    try { (w as any).NovaSecure?.secure(on); } catch { /* autre origine / hors appli */ }
  }
}

/** Reçoit la liste des logiciels d'enregistrement en cours (vide : plus rien). */
export function reportRecorders(apps: unknown): void {
  const list = Array.isArray(apps) ? [...new Set(apps.map(String).map(s => s.trim()).filter(Boolean))].slice(0, 10) : [];
  const changed = list.length !== current.length || list.some((a, i) => a !== current[i]);
  current = list;
  for (const a of list) {
    if (signales.has(a)) continue;
    signales.add(a);
    // Signalé au studio (statistiques) : quel logiciel, sur quelle plateforme.
    track('screen_capture_detected', { app: a, platform: typeof navigator !== 'undefined' ? navigator.platform || '' : '' });
  }
  if (changed) listeners.forEach(fn => { try { fn(list); } catch { /* */ } });
}

/** Instrus / mélodies du catalogue présentes dans le projet et pas achetées. */
export function unboughtCatalog<T extends { instrumentId?: string | number; name?: string }>(tracks: T[], owned: (string | number)[]): T[] {
  const o = new Set(owned.map(String));
  return tracks.filter(t => t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '' && !o.has(String(t.instrumentId)));
}

if (typeof window !== 'undefined') {
  (window as any).__novaCaptureGuard = reportRecorders;
  // Appli Windows : redemande l'état au chargement de la page.
  try { (window as any).chrome?.webview?.postMessage('nova-desktop:recorders?'); } catch { /* */ }
}
