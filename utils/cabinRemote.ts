import type { CollabRole } from '../types';
import type { GuestRights } from './guestRights';

/**
 * Télécommande de cabine (chantier 17 · B6 de la feuille de route).
 *
 * Au studio, l'artiste est en cabine, casque sur la tête ; le micro du studio
 * est branché sur le PC de l'ingé. Son téléphone (rejoint la séance comme
 * « artiste invité ») devient une télécommande : REC, lecture, stop, retour au
 * début, et le prompteur de ses paroles calé sur la lecture de l'ingé.
 *
 * Protocole (messages éphémères du direct, services/Collab : JAMAIS dans le
 * journal ni dans une file d'envoi : un REC qui partirait 30 s plus tard, au
 * retour du réseau, serait dangereux) :
 *  - « rc »  téléphone → ingé : une commande (id, cmd, from, to, at) ;
 *  - « rca » ingé → téléphone : l'accusé (fait, déjà fait, refusé + pourquoi) ;
 *  - « rcs » ingé → tous : l'état du transport (REC, lecture, position, décompte) ;
 *  - « rcq » téléphone → ingé : « redonne-moi l'état » (écran rallumé, retour du réseau).
 *
 * Les commandes sont EXPLICITES (rec, stop…), jamais des bascules : deux appuis
 * sur REC ne lancent pas puis n'arrêtent pas la prise. C'est l'ingé qui décide
 * (droit « remote » de utils/guestRights), vérifié chez lui à la réception.
 *
 * Module pur : testable tel quel (tests/cabinRemote.test.ts).
 */

export type CabinCmd = 'rec' | 'play' | 'stop' | 'home';
export const CABIN_CMDS: CabinCmd[] = ['rec', 'play', 'stop', 'home'];
export const CABIN_EV = { cmd: 'rc', ack: 'rca', state: 'rcs', ask: 'rcq' } as const;

export interface CabinCommand {
  id: string;
  cmd: CabinCmd;
  /** Clé de membre de l'expéditeur (u:<compte>:<appareil>). */
  from: string;
  /** Clé de membre de l'ingé visé (un seul exécute, même avec deux ingés en ligne). */
  to: string;
  /** Instant d'envoi, exprimé sur l'HORLOGE DE L'INGÉ (décalage estimé par le téléphone). */
  at: number;
}

export interface CabinState {
  /** Clé de membre de l'ingé qui publie. */
  from: string;
  /** Nom de l'ingé (affiché). */
  eng: string;
  /** Télécommande permise par l'ingé. */
  allowed: boolean;
  rec: boolean;
  play: boolean;
  /** Position du morceau (s) à l'instant `at`. */
  pos: number;
  /** Décompte en cours : chiffre affiché chez l'ingé (null : pas de décompte). */
  ci: number | null;
  /** Piste(s) qui enregistrent / prêtes (« Voix lead »), null : rien d'armé. */
  track: string | null;
  /** Horloge de l'ingé (ms). */
  at: number;
}

export interface CabinAck {
  id: string;
  /** Clé de membre du téléphone. */
  to: string;
  ok: boolean;
  /** Ce qui a été fait ('deja' : rien à faire, c'était déjà le cas). */
  done?: CabinCmd | 'deja';
  reason?: string;
  /** Horloge de l'ingé à la réception (ms). */
  at: number;
}

/** Commande trop vieille à l'arrivée (horloge de l'ingé) : refusée, rien ne part. */
export const CABIN_STALE_MS = 3000;
/** Deux commandes identiques à moins de … ms : un double appui, la 2e est ignorée. */
export const CABIN_DOUBLE_MS = 800;
/** Sans état reçu depuis … ms : liaison lente, puis perdue (boutons coupés). */
export const CABIN_LATE_MS = 2500;
export const CABIN_LOST_MS = 5000;
/** Sans accusé au bout de … ms : « l'ingé n'a pas répondu ». */
export const CABIN_ACK_TIMEOUT_MS = 2000;

export const newCabinId = (): string => {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return (crypto as Crypto).randomUUID().replace(/-/g, '').slice(0, 16); } catch { /* */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 16);
};

const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Commande reçue vérifiée (null : illisible, ignorée). */
export function sanitizeCabinCommand(raw: unknown): CabinCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64), from = str(r.from), to = str(r.to), at = num(r.at);
  if (!id || !from || !to || at === null || !CABIN_CMDS.includes(r.cmd as CabinCmd)) return null;
  return { id, cmd: r.cmd as CabinCmd, from, to, at };
}

export function sanitizeCabinState(raw: unknown): CabinState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = str(r.from), pos = num(r.pos), at = num(r.at);
  if (!from || pos === null || at === null) return null;
  const ci = num(r.ci);
  return {
    from, eng: (str(r.eng, 60) || "l'ingé"), allowed: r.allowed === true, rec: r.rec === true, play: r.play === true,
    pos: Math.max(0, pos), ci: ci === null ? null : Math.round(ci), track: str(r.track, 80), at,
  };
}

export function sanitizeCabinAck(raw: unknown): CabinAck | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64), to = str(r.to), at = num(r.at);
  if (!id || !to || at === null) return null;
  const done = r.done === 'deja' || CABIN_CMDS.includes(r.done as CabinCmd) ? (r.done as CabinAck['done']) : undefined;
  return { id, to, ok: r.ok === true, at, ...(done ? { done } : {}), ...(str(r.reason, 300) ? { reason: str(r.reason, 300)! } : {}) };
}

/** Mémoire des commandes déjà vues (identifiants, et dernier instant de chaque commande). */
export class CabinDedup {
  private ids = new Set<string>();
  private last = new Map<CabinCmd, number>();
  seen(id: string): boolean { return this.ids.has(id); }
  note(c: Pick<CabinCommand, 'id' | 'cmd'>, now: number) {
    this.ids.add(c.id);
    if (this.ids.size > 500) this.ids.delete(this.ids.values().next().value as string);
    this.last.set(c.cmd, now);
  }
  /** La même commande vient d'être exécutée (double appui, deux téléphones) ? */
  recent(cmd: CabinCmd, now: number): boolean {
    const t = this.last.get(cmd);
    return t !== undefined && now - t < CABIN_DOUBLE_MS;
  }
}

export type CabinAction = 'record' | 'play' | 'stop' | 'home' | 'none';

export interface CabinHostCtx {
  myKey: string;
  myRole: CollabRole | null;
  myName: string;
  rights: GuestRights | null | undefined;
  /** Rôle de l'expéditeur d'après la présence (null : inconnu, pas en ligne). */
  senderRole: CollabRole | null;
  senderName?: string | null;
  isRecording: boolean;
  isPlaying: boolean;
  /** Décompte en cours. */
  countIn: boolean;
  /** Une prise est en train de démarrer (armement, micro) : REC déjà demandé. */
  busy: boolean;
  dedup: CabinDedup;
  now: number;
}

export interface CabinDecision {
  action: CabinAction;
  ack: Omit<CabinAck, 'id' | 'to' | 'at'>;
  /** Pour le journal de l'ingé (« Nina a lancé REC depuis la cabine »). */
  log?: string;
}

const CMD_LABEL: Record<CabinCmd, string> = { rec: 'REC', play: 'la lecture', stop: 'STOP', home: 'le retour au début' };

/**
 * Chez l'ingé : que faire de cette commande ? null = pas pour moi (aucun accusé).
 * Ordre : destinataire, doublon, droit, fraîcheur, puis l'état du transport.
 */
export function cabinDecide(c: CabinCommand, ctx: CabinHostCtx): CabinDecision | null {
  if (c.to !== ctx.myKey || ctx.myRole !== 'engineer') return null;
  const eng = ctx.myName || "l'ingé";
  if (ctx.dedup.seen(c.id)) return { action: 'none', ack: { ok: true, done: 'deja' } };
  const double = ctx.dedup.recent(c.cmd, ctx.now);
  ctx.dedup.note(c, ctx.now);
  if (ctx.senderRole !== 'artist') return { action: 'none', ack: { ok: false, reason: "Seul l'artiste de la séance peut piloter depuis la cabine." } };
  if (!ctx.rights?.remote) return { action: 'none', ack: { ok: false, reason: `🔒 ${eng} n'a pas activé la télécommande de cabine : demande-lui (Parler).` } };
  const late = ctx.now - c.at;
  if (late > CABIN_STALE_MS) {
    return { action: 'none', ack: { ok: false, reason: `Réseau trop lent : ta commande est arrivée ${Math.round(late / 1000)} s après. Rien n'a été lancé, réessaie.` } };
  }
  if (double) return { action: 'none', ack: { ok: true, done: 'deja' } };
  const who = ctx.senderName || "L'artiste";
  const log = `🎛️ ${who} a lancé ${CMD_LABEL[c.cmd]} depuis la cabine`;
  switch (c.cmd) {
    case 'rec':
      if (ctx.isRecording || ctx.countIn || ctx.busy) return { action: 'none', ack: { ok: true, done: 'deja' } };
      return { action: 'record', ack: { ok: true, done: 'rec' }, log };
    case 'stop':
      if (!ctx.isRecording && !ctx.isPlaying && !ctx.countIn && !ctx.busy) return { action: 'none', ack: { ok: true, done: 'deja' } };
      return { action: 'stop', ack: { ok: true, done: 'stop' }, log };
    case 'play':
      if (ctx.isRecording || ctx.countIn || ctx.busy) return { action: 'none', ack: { ok: false, reason: 'La prise est en cours : appuie sur STOP pour l’arrêter.' } };
      if (ctx.isPlaying) return { action: 'none', ack: { ok: true, done: 'deja' } };
      return { action: 'play', ack: { ok: true, done: 'play' }, log };
    case 'home':
      if (ctx.isRecording || ctx.countIn || ctx.busy) return { action: 'none', ack: { ok: false, reason: 'Pendant la prise, on ne revient pas au début : STOP d’abord.' } };
      return { action: 'home', ack: { ok: true, done: 'home' }, log };
  }
  return null;
}

/** Position du morceau chez l'ingé, maintenant (extrapolée depuis le dernier état reçu, horloge locale). */
export function cabinPosition(s: Pick<CabinState, 'pos' | 'play' | 'rec'>, receivedAt: number, now: number): number {
  return s.play || s.rec ? s.pos + Math.max(0, now - receivedAt) / 1000 : s.pos;
}

export type CabinLink = 'attente' | 'ok' | 'lent' | 'perdu';

/** Qualité de la liaison avec l'ingé d'après l'âge du dernier état reçu. */
export function cabinLink(receivedAt: number | null, now: number): CabinLink {
  if (receivedAt === null) return 'attente';
  const age = now - receivedAt;
  return age < CABIN_LATE_MS ? 'ok' : age < CABIN_LOST_MS ? 'lent' : 'perdu';
}

/**
 * Décalage d'horloge estimé (horloge de l'ingé − la mienne), lissé : le
 * téléphone exprime ses commandes sur l'horloge de l'ingé, qui peut ainsi
 * refuser une commande trop vieille même si les deux horloges diffèrent de
 * plusieurs secondes. Erreur ≈ le temps de trajet d'un message (≪ 3 s).
 */
export function nextClockOffset(prev: number | null, engAt: number, localReceive: number): number {
  const sample = engAt - localReceive;
  if (prev === null) return sample;
  // Le plus grand décalage observé correspond au trajet le plus court : on le suit vite, on oublie lentement.
  return sample > prev ? sample : prev * 0.9 + sample * 0.1;
}

export interface CabinButtons {
  rec: { enabled: boolean; label: string; cmd: CabinCmd };
  play: { enabled: boolean; label: string; cmd: CabinCmd };
  home: { enabled: boolean };
  /** Raison affichée quand les boutons sont coupés (null : tout va bien). */
  blocked: string | null;
}

/** Ce que le téléphone permet, d'après l'état reçu, la liaison et la commande en route. */
export function cabinButtons(o: {
  state: Pick<CabinState, 'rec' | 'play' | 'ci' | 'allowed' | 'eng'> | null;
  link: CabinLink;
  online: boolean;
  engineerHere: boolean;
  pending: CabinCmd | null;
  /** Nom de l'ingé quand aucun état n'est encore reçu. */
  eng?: string;
}): CabinButtons {
  const eng = o.state?.eng || o.eng || "l'ingé";
  const Eng = eng.charAt(0).toUpperCase() + eng.slice(1);
  let blocked: string | null = null;
  if (!o.online) blocked = '📡 Pas de réseau sur ton téléphone : rien ne peut partir. Reconnecte le Wi-Fi du studio.';
  else if (!o.engineerHere) blocked = `${Eng} n'est pas dans la séance pour l'instant : la télécommande revient dès qu'il est là.`;
  else if (o.link === 'attente') blocked = `Connexion à la console de ${eng}…`;
  else if (o.link === 'perdu') blocked = `Liaison avec ${eng} perdue : on ne lance rien sans être sûr qu'il reçoit. Touche « Réessayer ».`;
  else if (o.state && !o.state.allowed) blocked = `🔒 ${eng} n'a pas activé la télécommande de cabine. Demande-lui (Parler).`;
  const live = !blocked;
  const recording = !!o.state && (o.state.rec || o.state.ci !== null);
  return {
    rec: recording
      ? { enabled: live && o.pending !== 'stop', label: '■ STOP', cmd: 'stop' }
      : { enabled: live && o.pending !== 'rec', label: '● REC', cmd: 'rec' },
    play: o.state?.play && !recording
      ? { enabled: live && o.pending !== 'stop', label: '■ Stop', cmd: 'stop' }
      : { enabled: live && !recording && o.pending !== 'play', label: '▶ Lecture', cmd: 'play' },
    home: { enabled: live && !recording && o.pending !== 'home' },
    blocked,
  };
}

/** Phrase de l'accusé, pour l'artiste (sans jargon). */
export function cabinAckText(a: Pick<CabinAck, 'ok' | 'done' | 'reason'>, eng: string): string {
  if (!a.ok) return a.reason || `${eng} n'a pas pu le faire.`;
  switch (a.done) {
    case 'rec': return `● C'est parti chez ${eng}`;
    case 'stop': return `■ Arrêté chez ${eng}`;
    case 'play': return `▶ Lecture chez ${eng}`;
    case 'home': return '⏮ Retour au début';
    default: return '✓ Déjà fait';
  }
}
