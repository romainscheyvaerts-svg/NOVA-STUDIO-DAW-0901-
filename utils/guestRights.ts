import type { CollabRole, Track } from '../types';
import { participantOf } from './collabPeers';

/**
 * « Artiste invité » : ce qu'un artiste peut modifier dans la séance de l'ingé.
 *
 * Le cas le plus fréquent : un artiste qui n'y connaît rien rejoint, depuis son
 * téléphone, la séance que l'ingé a ouverte sur son PC. Avant, il arrivait dans
 * le DAW complet avec les droits de tout artiste : il pouvait baisser le beat,
 * toucher le bus, supprimer la piste « Voix lead » préparée par l'ingé, changer
 * le tempo, la tonalité, l'ordre des pistes… et tout partait chez l'ingé.
 *
 * C'est l'ingé qui décide (opération « guest_rights », acceptée de lui seul) :
 *  - limited : mode simple (par défaut quand l'ingé ouvre la séance). L'artiste
 *    enregistre sur SA piste (créée à son nom), réécoute, choisit ses prises,
 *    écrit ses paroles, parle à l'ingé. Le reste de la séance est en lecture seule ;
 *  - ownMix : il peut aussi régler le son de SES pistes (volume, effets) ;
 *  - markers : il peut poser des repères (« couplet 2 ici »).
 *
 * La règle est appliquée À LA RÉCEPTION, chez tout le monde (une opération
 * interdite envoyée par un artiste est ignorée chez l'ingé, même si elle vient
 * d'une ancienne version ou d'un appareil trafiqué), et à l'envoi (rien
 * d'interdit ne part ; l'interface ne le propose pas).
 *
 * Module pur : testable tel quel.
 */

export interface GuestRights {
  /** Mode simple : l'artiste ne touche qu'à ses propres prises. */
  limited: boolean;
  /** Il peut régler le son (volume, pan, effets) de SES pistes. */
  ownMix?: boolean;
  /** Il peut poser des repères partagés. */
  markers?: boolean;
  /**
   * Télécommande de cabine (utils/cabinRemote) : depuis son téléphone, en cabine,
   * il lance REC, la lecture, STOP et le retour au début sur le PC de l'ingé.
   */
  remote?: boolean;
  /** Qui a décidé (nom de l'ingé) et quand (ms). */
  by?: string;
  at?: number;
}

/** Opération de la collaboration qui porte les droits (de l'ingé seulement). */
export const GUEST_RIGHTS_KIND = 'guest_rights';

/** Ce que l'ingé met par défaut en ouvrant sa séance : l'artiste enregistre, le mix reste à l'ingé. */
export const DEFAULT_GUEST_RIGHTS: GuestRights = { limited: true, ownMix: false, markers: false, remote: false };

/** Valeur reçue vérifiée (null : illisible, ignorée). */
export function sanitizeGuestRights(raw: unknown): GuestRights | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.limited !== 'boolean') return null;
  const out: GuestRights = { limited: r.limited, ownMix: r.ownMix === true, markers: r.markers === true, remote: r.remote === true };
  if (typeof r.by === 'string') out.by = r.by.slice(0, 40);
  if (typeof r.at === 'number' && Number.isFinite(r.at)) out.at = r.at;
  return out;
}

/** Cet artiste est-il en mode simple (invité de l'ingé) ? */
export const isLimitedGuest = (role: CollabRole | null | undefined, rights: GuestRights | null | undefined): boolean =>
  role === 'artist' && !!rights?.limited;

/** Piste à lui, nommément (créée à son nom pendant la séance). */
export const guestOwnsTrack = (t: Track | undefined | null, participant: string): boolean =>
  !!t && !!participant && t.collabOwnerKey === participant;

/** Peut-il régler le son de cette piste ? Ses pistes seulement, et si l'ingé l'a permis. */
export const guestCanMix = (t: Track | undefined | null, participant: string, rights: GuestRights | null | undefined): boolean =>
  !rights?.limited || (!!rights.ownMix && guestOwnsTrack(t, participant));

/** Peut-il modifier les prises (clips) de cette piste ? Les siennes seulement. */
export const guestCanEditContent = (t: Track | undefined | null, participant: string, rights: GuestRights | null | undefined): boolean =>
  !rights?.limited || guestOwnsTrack(t, participant);

/** Peut-il supprimer cette piste ? Les siennes seulement. */
export const guestCanDelete = guestCanEditContent;

/** Champs de la session qu'un invité peut écrire : ses paroles. */
export const GUEST_SONG_FIELDS = ['lyrics', 'lyricsRegions'] as const;

/**
 * Champs de la session REFUSÉS à un invité (tout le reste de l'opération « song ») :
 * tonalité, gamme, arrangements, et la fréquence d'échantillonnage du projet
 * (utils/projectRate) : la changer recrée le moteur et reconvertit tous les sons
 * de la séance chez tout le monde — c'est la séance de l'ingé.
 */
export const GUEST_REFUSED_SONG_FIELDS = ['projectKey', 'projectScale', 'arrangements', 'sampleRate', 'panLaw'] as const;

/**
 * Opérations jamais permises à un invité en mode simple : elles changent la
 * séance de l'ingé pour tout le monde (tempo, ordre, groupes, accords, beat,
 * opérations sur le temps, verrou de volume, « Écouter ensemble », notes de
 * séance, revendication de pistes, gel).
 */
export const GUEST_FORBIDDEN_KINDS = new Set([
  'tempo', 'order', 'groups', 'chords', 'beatswap', 'timeop', 'lock', 'listen', 'notes', 'own', 'freeze', GUEST_RIGHTS_KIND,
  // Scènes de mix (22/10/2026) : la console entière, réservée à l'ingé.
  'scenes',
]);

export interface GuestVerdict {
  ok: boolean;
  /** Pourquoi (journal de la console, pour le diagnostic). */
  reason?: string;
  /** Opération réduite à ce qui est permis (paroles seules d'une opération « song »). */
  op?: Record<string, unknown>;
}

/**
 * Une opération d'un artiste en mode simple est-elle permise ?
 *  - author : l'auteur (sa clé de membre : « u:<compte>:<appareil> ») ;
 *  - existing : la piste visée telle qu'on l'a (undefined : piste nouvelle).
 * Les opérations d'un ingé ou d'un beatmaker, ou d'un artiste hors mode
 * simple, ne passent pas par ici.
 */
export function guestOpVerdict(kind: string, op: Record<string, any> | null | undefined, ctx: {
  rights: GuestRights | null | undefined;
  authorKey: string;
  existing?: Track;
}): GuestVerdict {
  const rights = ctx.rights;
  if (!rights?.limited) return { ok: true };
  const who = participantOf(ctx.authorKey);
  const p = op && typeof op === 'object' ? op : {};
  if (GUEST_FORBIDDEN_KINDS.has(kind)) return { ok: false, reason: `invité : « ${kind} » réservé à l'ingé` };
  switch (kind) {
    case 'mix':
      return guestCanMix(ctx.existing, who, rights) ? { ok: true } : { ok: false, reason: 'invité : le mix est à l’ingé' };
    case 'content': {
      if (ctx.existing) return guestOwnsTrack(ctx.existing, who) ? { ok: true } : { ok: false, reason: 'invité : piste de l’ingé' };
      // Piste nouvelle : une piste audio à son nom (« Voix de Nina »), rien d'autre.
      const c = p.content && typeof p.content === 'object' ? p.content : {};
      const mine = c.collabOwner === 'artist' && c.collabOwnerKey === who && c.type === 'AUDIO';
      return mine ? { ok: true } : { ok: false, reason: 'invité : seule une piste de voix à son nom peut être créée' };
    }
    case 'track_del':
      return guestCanDelete(ctx.existing, who, rights) ? { ok: true } : { ok: false, reason: 'invité : piste de l’ingé' };
    case 'markers':
      return rights.markers ? { ok: true } : { ok: false, reason: 'invité : repères réservés à l’ingé' };
    case 'comments':
      // Chantier 11 : l'invité commente la timeline (« 1:12 le "s" siffle »), répond, résout.
      return { ok: true };
    case 'mixver': {
      // Versions du mix : l'invité ne fait que valider ou demander des retouches (la décision) ;
      // créer une version reste à l'ingé (vérifié aussi à la réception, utils/mixVersions).
      const list = Array.isArray(p.upsert) ? p.upsert : [];
      return list.length ? { ok: true } : { ok: false, reason: 'invité : version vide' };
    }
    case 'song': {
      const fields = p.fields && typeof p.fields === 'object' ? p.fields as Record<string, unknown> : {};
      const kept: Record<string, unknown> = {};
      for (const f of GUEST_SONG_FIELDS) if (f in fields) kept[f] = fields[f];
      if (!Object.keys(kept).length) {
        return { ok: false, reason: 'sampleRate' in fields ? 'invité : fréquence d’échantillonnage du projet réservée à l’ingé' : 'invité : tonalité et arrangements réservés à l’ingé' };
      }
      return Object.keys(kept).length === Object.keys(fields).length ? { ok: true } : { ok: true, op: { ...p, fields: kept } };
    }
    default:
      // Discussion, verrou d'enregistrement (« rec »), audio et VST pilotés par l'ingé…
      return { ok: true };
  }
}

/** Phrases simples, pour l'artiste et pour l'ingé. */
export const GUEST_RIGHTS_HELP = {
  limited: "Mode simple : l'artiste enregistre sur SA piste, réécoute, choisit ses prises et te parle. Le reste de ta séance est en lecture seule chez lui.",
  free: "Mode libre : l'artiste peut aussi toucher aux autres pistes de voix, au tempo, à l'ordre des pistes…",
  ownMix: 'Il peut régler le son de sa voix (volume, effets)',
  markers: 'Il peut poser des repères (« couplet 2 ici »)',
  remote: 'Télécommande de cabine : depuis son téléphone, il lance REC, la lecture et STOP sur ton PC (micro du studio)',
  comments: 'Il peut toujours commenter la timeline (« 1:12 le "s" siffle »), répondre, et valider tes versions',
} as const;

/** Phrase montrée à l'artiste quand il essaie quelque chose que l'ingé garde pour lui. */
export const guestRefusalText = (engineer: string | null | undefined): string =>
  `🔒 C'est ${engineer || "l'ingé"} qui s'occupe du mix et de la séance : demande-lui dans la discussion. Toi, tu enregistres sur ta piste.`;
