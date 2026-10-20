import type { ContextMenuItem, Track, TrackSend } from '../types';
import { acceptsSend, transferSend } from './insertCopy';

/**
 * Envoi réglé au doigt comme un fader (tablette, téléphone) — module pur,
 * tests/sendFader.test.ts ; composant components/SendFader.
 *
 * Au doigt, le potard de 26 px de la console se tournait mal (le doigt cache
 * la valeur, la course verticale de 150 px se mélange au défilement). Sur un
 * écran tactile, chaque envoi devient une barre horizontale qu'on glisse comme
 * un fader : même courbe que les faders de NOVA (position = √(niveau / 1,5)),
 * aimant sur 0 dB, double toucher = 0 dB, appui long = menu (copier /
 * déplacer vers une autre tranche, pré / post).
 */

export const SEND_MAX = 1.5;

/** Niveau → position 0…1 (même courbe que les faders de la console). */
export const sendPos = (level: number): number => Math.sqrt(Math.max(0, Math.min(SEND_MAX, Number.isFinite(level) ? level : 0)) / SEND_MAX);

/** Position 0…1 → niveau. */
export const sendLevelAt = (pos: number): number => {
  const p = Math.max(0, Math.min(1, pos));
  return p * p * SEND_MAX;
};

/** Largeur de l'aimant autour de 0 dB (en position) : le doigt retombe pile sur 0 dB. */
export const UNITY_SNAP = 0.012;

/**
 * Glisser relatif (comme un fader : la barre ne saute pas sous le doigt) :
 * `dx` pixels sur une course de `travelPx` pixels. `fine` : 10 fois plus précis
 * (deux doigts, ou Maj à la souris).
 */
export function dragSendLevel(startLevel: number, dx: number, travelPx: number, fine = false): number {
  const travel = Math.max(40, travelPx);
  const p = sendPos(startLevel) + (dx / travel) * (fine ? 0.1 : 1);
  const clamped = Math.max(0, Math.min(1, p));
  if (Math.abs(clamped - sendPos(1)) < UNITY_SNAP) return 1;
  return Math.round(sendLevelAt(clamped) * 10000) / 10000;
}

/** Valeur lisible (« −10,0 dB », « −∞ », « 0 dB »). */
export function sendDbText(level: number): string {
  if (!(level > 1e-5)) return '−∞';
  const db = 20 * Math.log10(level);
  if (Math.abs(db) < 0.05) return '0 dB';
  return `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1).replace('.', ',')} dB`;
}

/**
 * Menu d'un envoi au doigt (appui long) : copier / déplacer vers une autre
 * tranche — le glisser-déposer de la souris (Alt+glisser) n'existe pas au doigt.
 */
export function sendTransferMenuItems(
  track: Track, send: TrackSend, all: Track[], busName: string,
  apply: (fn: (ts: Track[]) => Track[], label: string) => void,
): ContextMenuItem[] {
  const dests = all.filter(t => t.id !== track.id && !t.isHidden && acceptsSend(t, send.id) && t.type !== 'BUS').slice(0, 8);
  const items: ContextMenuItem[] = [];
  for (const t of dests) {
    items.push({
      label: `Copier vers « ${t.name} »`, icon: 'fa-copy',
      title: 'Alt+glisser l’envoi sur une autre tranche (niveau, pré / post, pan, mute)',
      onClick: () => apply(ts => transferSend(ts, track.id, send.id, t.id, { slot: send.slot }).tracks, `Envoi vers « ${busName} » copié sur « ${t.name} »`),
    });
  }
  for (const t of dests) {
    items.push({
      label: `Déplacer vers « ${t.name} »`, icon: 'fa-right-left',
      title: 'Glisser l’envoi sur une autre tranche (préréglage Studio pro) ; l’original retombe à zéro',
      onClick: () => apply(ts => transferSend(ts, track.id, send.id, t.id, { slot: send.slot, move: true }).tracks, `Envoi vers « ${busName} » déplacé sur « ${t.name} »`),
    });
  }
  return items;
}
