import { AudioRefs, CollabClient, CollabMember, CollabOp, ensureBuffers, uploadBuffers } from './Collab';
import { CloudLink, createCloudSession, linkToString } from './SessionCloud';
import type { EngineerAckState, RemoteFxPayload, RemoteReturnPayload, RemoteSendPayload } from '../utils/remoteInge';
import type { RemoteIngePhase } from '../types';

/**
 * Transport du mode « Ingé à distance ».
 *
 * Aucune nouvelle table : le lien est une session en ligne (daw_sessions) qui
 * ne porte pas de projet, seulement le journal d'opérations de la
 * collaboration (daw_session_ops, via la fonction daw-session) et l'audio
 * (bucket daw-sessions, morceaux nommés par leur SHA-1, jamais envoyés deux
 * fois). L'artiste et l'ingé y entrent avec leur rôle ; chacun garde SON
 * projet. Le journal sert de file d'attente côté serveur : un ingé hors ligne
 * reçoit tout au rattrapage (reconnexion), dans l'ordre.
 *
 * Opérations :
 *  ri_send   artiste → ingé : audio brut + éditions d'une piste (version v)
 *  ri_return ingé → artiste : rendus gelés (piste, bus VST par source), effets, envois
 *  ri_fx     ingé → artiste : réglages des reverbs / délais de NOVA (en direct)
 *  ri_phase  ingé → artiste : enregistrement / mix
 *  ri_ack    ingé → artiste : « reçue », « en cours », « pont VST fermé »…
 */

export type RemoteRole = 'artist' | 'engineer';

export const REMOTE_KINDS = new Set(['ri_send', 'ri_return', 'ri_fx', 'ri_phase', 'ri_ack']);

export interface RemoteAck { trackId: string; v: number; state: EngineerAckState; detail?: string }

/** Lien d'invitation de l'ingé (il garde sa session : seul le lien s'ouvre). */
export const remoteInviteUrl = (l: CloudLink): string => {
  let base = 'https://www.studiomakemusic.com/daw';
  try { base = `${window.location.origin}${window.location.pathname}`; } catch { /* hors navigateur */ }
  return `${base}?inge=${encodeURIComponent(linkToString(l))}`;
};

export class RemoteIngeClient {
  readonly collab: CollabClient;

  constructor(
    public readonly link: CloudLink,
    public readonly role: RemoteRole,
    name: string,
    onOp: (o: CollabOp) => Promise<void> | void,
    onPresence: (m: CollabMember[]) => void,
  ) {
    this.collab = new CollabClient(link, role, name, onOp, onPresence);
  }

  /** Crée le lien (côté artiste). */
  static async createLink(artistName: string): Promise<CloudLink> {
    const c = await createCloudSession(`Lien ingé · ${artistName || 'Artiste'}`.slice(0, 80));
    return { id: c.id, secret: c.secret };
  }

  get lastSeq() { return this.collab.lastSeq; }

  join(fromSeq: number) { return this.collab.join(fromSeq); }
  catchUp() { return this.collab.catchUp(); }
  leave() { return this.collab.leave(); }

  async sendTrack(p: RemoteSendPayload, bufferIds: string[]): Promise<number> {
    const audio = await uploadBuffers(this.link, bufferIds);
    return this.collab.send('ri_send', { ...p, audio });
  }

  async sendReturn(p: RemoteReturnPayload, bufferIds: string[]): Promise<number> {
    const audio = await uploadBuffers(this.link, bufferIds);
    return this.collab.send('ri_return', { ...p, audio });
  }

  sendFx(p: RemoteFxPayload) { return this.collab.send('ri_fx', p); }
  sendPhase(phase: RemoteIngePhase) { return this.collab.send('ri_phase', { phase }); }
  sendAck(a: RemoteAck) { return this.collab.send('ri_ack', a); }

  /** Télécharge l'audio d'une opération reçue (déjà là : rien). */
  ensureAudio(audio: AudioRefs | undefined) { return ensureBuffers(this.link, audio); }
}
