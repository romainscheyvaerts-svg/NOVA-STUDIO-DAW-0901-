/**
 * État de la connexion d'une collaboration (les deux modes), et ce qu'on en
 * montre : un seul libellé clair, une couleur, et l'action proposée quand
 * quelque chose ne va pas. Aucune action ne doit échouer en silence.
 *
 * Module pur : testable tel quel.
 */

/** Direct Supabase Realtime (diffusion + présence). */
export type RealtimeState = 'connecting' | 'live' | 'down';

export interface CollabStatus {
  /** Membre de la session (join réussi). */
  joined: boolean;
  realtime: RealtimeState;
  /** Le serveur (journal des opérations) répond. */
  reachable: boolean;
  /** Le navigateur se dit hors ligne (navigator.onLine). */
  browserOffline: boolean;
  /** Rattrapage des opérations manquées en cours. */
  catchingUp: boolean;
  lastSyncAt: number | null;
  /** Modifications pas encore parties (file d'envoi). */
  pending: number;
  /** Envoi d'audio en cours (octets). */
  upload: { sent: number; total: number } | null;
  lastError: string | null;
  /** Opérations reçues impossibles à appliquer (abandonnées après plusieurs essais). */
  failedOps: number;
  /** Nos modifications refusées pour de bon par le serveur (retirées de la file). */
  droppedOps: number;
  /** Aller-retour avec le serveur (médiane des derniers envois, ms). */
  rttMs: number | null;
}

export const initialCollabStatus = (): CollabStatus => ({
  joined: false, realtime: 'connecting', reachable: true, browserOffline: false, catchingUp: false,
  lastSyncAt: null, pending: 0, upload: null, lastError: null, failedOps: 0, droppedOps: 0, rttMs: null,
});

export type CollabStatusCode = 'connecting' | 'offline' | 'catching_up' | 'sending' | 'polling' | 'waiting_peer' | 'live' | 'error';

export interface CollabStatusView {
  code: CollabStatusCode;
  /** Libellé court (pastille). */
  short: string;
  /** Phrase complète (ce qui se passe et quoi faire). */
  label: string;
  tone: 'ok' | 'busy' | 'warn' | 'error';
  /** Action proposée : réessayer tout de suite, ou recharger la session. */
  action?: 'retry' | 'reload';
  actionLabel?: string;
}

const mo = (b: number) => Math.max(0, Math.round(b / 1048576));

/** Ce qu'on affiche. othersOnline : autres membres connectés (présence) ; peerSeen : dernier signe de vie de l'autre (ms). */
export function collabStatusView(s: CollabStatus, ctx: { othersOnline: number; peerSeenAt?: number | null; now?: number } = { othersOnline: 0 }): CollabStatusView {
  const pend = s.pending > 0 ? ` (${s.pending} modification${s.pending > 1 ? 's' : ''} en attente)` : '';
  if (s.failedOps > 0) {
    return {
      code: 'error', short: 'À recharger', tone: 'error', action: 'reload', actionLabel: 'Recharger la session',
      label: `${s.failedOps > 1 ? `${s.failedOps} modifications reçues n'ont` : "Une modification reçue n'a"} pas pu être appliquée${s.failedOps > 1 ? 's' : ''} (audio introuvable ou connexion). Recharge la session pour repartir de la version en ligne.`,
    };
  }
  if (s.droppedOps > 0) {
    return {
      code: 'error', short: 'Modif. refusée', tone: 'error', action: 'reload', actionLabel: 'Recharger la session',
      label: `${s.lastError || 'Une de tes modifications a été refusée par le serveur.'} Les autres modifications continuent de partir ; recharge la session pour repartir d'un état commun.`,
    };
  }
  if (!s.joined && s.realtime === 'connecting' && s.reachable) {
    return { code: 'connecting', short: 'Connexion…', tone: 'busy', label: 'Connexion à la session…' };
  }
  if (s.browserOffline || !s.reachable) {
    return {
      code: 'offline', short: 'Hors ligne', tone: 'warn', action: 'retry', actionLabel: 'Réessayer',
      label: `Hors ligne : tes modifications sont gardées et partiront toutes seules au retour du réseau${pend}.`,
    };
  }
  if (s.upload && s.upload.total > 0 && s.upload.sent < s.upload.total) {
    const pct = Math.round((100 * s.upload.sent) / s.upload.total);
    return { code: 'sending', short: `Envoi ${pct} %`, tone: 'busy', label: `Envoi de l'audio… ${mo(s.upload.sent)} / ${Math.max(1, mo(s.upload.total))} Mo (${pct} %). Si la connexion coupe, l'envoi reprendra là où il s'est arrêté.` };
  }
  if (s.catchingUp) {
    return { code: 'catching_up', short: 'Rattrapage…', tone: 'busy', label: 'Rattrapage des modifications faites pendant ton absence…' };
  }
  if (s.realtime !== 'live') {
    return {
      code: 'polling', short: 'Sans direct', tone: 'warn', action: 'retry', actionLabel: 'Réessayer le direct',
      label: `Direct indisponible : les modifications arrivent quand même, toutes les 10 secondes${pend}.`,
    };
  }
  if (s.pending > 0) {
    return { code: 'sending', short: 'Envoi…', tone: 'busy', label: `Envoi de tes modifications…${pend}` };
  }
  if (ctx.othersOnline <= 0) {
    const now = ctx.now ?? Date.now();
    const seen = ctx.peerSeenAt && now - ctx.peerSeenAt < 120_000;
    return {
      code: 'waiting_peer', short: seen ? 'En direct' : "En attente de l'autre", tone: seen ? 'ok' : 'busy',
      label: seen
        ? "En direct : l'autre est actif (sa présence ne s'affiche pas, mais ses modifications arrivent)."
        : "En direct, en attente de l'autre : personne d'autre n'est connecté pour l'instant. Envoie-lui le lien d'invitation.",
    };
  }
  return { code: 'live', short: 'En direct', tone: 'ok', label: 'En direct : tout est synchronisé.' };
}
