import type { Clip, CollabRole, Track } from '../types';
import { clipShape, hashOf } from './collabFingerprint';
import { ownerRoleOf, participantOf } from './collabPeers';

/**
 * Contenu d'une piste en collaboration, CLIP PAR CLIP (format « cv: 2 »).
 *
 * Avant : le contenu d'une piste voyageait d'un bloc (tous ses clips) et
 * seul son propriétaire pouvait l'envoyer. Deux défauts graves :
 *  - l'ingé en direct ne pouvait rien éditer dans les prises de l'artiste
 *    (comp, respirations, gain de clip, fondus, justesse) : ses retouches
 *    restaient chez lui puis étaient effacées par la version suivante de
 *    l'artiste ;
 *  - deux éditions faites en même temps sur deux clips de la même piste :
 *    la dernière version effaçait l'autre.
 *
 * Maintenant chaque envoi dit QUELS clips ont changé et lesquels ont été
 * retirés, par rapport à ce que tout le monde avait déjà (empreinte de
 * chaque clip). À la réception, la règle « dernière écriture gagne »
 * s'applique clip par clip (numéro du journal), et un clip modifié ici mais
 * pas encore parti n'est jamais écrasé (le nôtre partira après et gagnera
 * partout). Le contenu complet reste dans l'opération : une ancienne version
 * de NOVA le lit comme avant.
 *
 * Module pur : testable tel quel.
 */

export const CONTENT_FORMAT = 2;

/** Empreinte d'un clip (ce qui voyage : position, son, gain, fondus, éditions). */
export const clipSig = (c: Clip): string => hashOf(clipShape(c));

/** Ce qui décrit la piste hors clips (nom, couleur, instrument, prises, guide…). */
export const metaSigOf = (content: Record<string, unknown>): string => {
  const { clips: _c, ...rest } = content || {};
  return hashOf(rest);
};

/** Ce que tout le monde a déjà d'une piste : empreinte de la description et de chaque clip. */
export interface KnownContent { meta: string; clips: Map<string, string> }

export const knownOf = (meta: string, clips: Clip[]): KnownContent =>
  ({ meta, clips: new Map((clips || []).map(c => [c.id, clipSig(c)])) });

export interface ContentDelta { changed: string[]; removed: string[]; meta: boolean }

/** Clips ajoutés ou modifiés, clips retirés, description changée — depuis ce que tout le monde a. */
export function contentDelta(known: KnownContent | undefined, metaSig: string, clips: Clip[]): ContentDelta {
  const changed: string[] = [];
  const ids = new Set<string>();
  for (const c of clips || []) {
    ids.add(c.id);
    if (!known || known.clips.get(c.id) !== clipSig(c)) changed.push(c.id);
  }
  const removed = known ? [...known.clips.keys()].filter(id => !ids.has(id)) : [];
  return { changed, removed, meta: !known || known.meta !== metaSig };
}

export const isEmptyDelta = (d: ContentDelta): boolean => !d.changed.length && !d.removed.length && !d.meta;

/** Clips modifiés ici et pas encore partis (à ne pas écraser à la réception). */
export function pendingClipIds(known: KnownContent | undefined, clips: Clip[]): Set<string> {
  const d = contentDelta(known, known?.meta || '', clips);
  return new Set([...d.changed, ...d.removed]);
}

/**
 * Fusion clip par clip d'un contenu reçu.
 *  - accept(clipId) : règle « dernière écriture gagne » (horloge par clip) ;
 *  - pending : clips modifiés ici, pas encore partis (gardés tels quels).
 * Renvoie les clips de la piste et ce qui a été pris (pour mettre à jour « ce que tout le monde a »).
 */
export function mergeClips(local: Clip[], incoming: Clip[], delta: { changed?: unknown; removed?: unknown; full?: unknown }, accept: (clipId: string) => boolean, pending: Set<string>):
  { clips: Clip[]; taken: Clip[]; dropped: string[] } {
  const changed = new Set((Array.isArray(delta.changed) ? delta.changed : []).filter((x): x is string => typeof x === 'string'));
  const removed = (Array.isArray(delta.removed) ? delta.removed : []).filter((x): x is string => typeof x === 'string');
  const byId = new Map((incoming || []).filter(c => c && typeof c.id === 'string').map(c => [c.id, c]));
  // Version complète qui fait foi (réparation d'un écart) : nos clips absents chez elle sont retirés.
  if (delta.full === true) for (const c of local || []) if (!byId.has(c.id) && !removed.includes(c.id)) removed.push(c.id);
  const out = [...(local || [])];
  const taken: Clip[] = [];
  const dropped: string[] = [];
  for (const id of changed) {
    const c = byId.get(id);
    if (!c || pending.has(id) || !accept(id)) continue;
    const i = out.findIndex(x => x.id === id);
    // Le son en mémoire (buffer) n'est jamais dans l'opération : on garde le nôtre s'il est le même.
    const keep = i >= 0 && (out[i] as any).buffer && out[i].bufferId === c.bufferId ? { buffer: (out[i] as any).buffer } : {};
    const next = { ...c, ...keep } as Clip;
    if (i >= 0) out[i] = next; else out.push(next);
    taken.push(c);
  }
  for (const id of removed) {
    if (pending.has(id) || !accept(id)) continue;
    const i = out.findIndex(x => x.id === id);
    if (i >= 0) out.splice(i, 1);
    dropped.push(id);
  }
  return { clips: out, taken, dropped };
}

/** Met à jour « ce que tout le monde a » après une fusion. */
export function noteMerged(known: KnownContent | undefined, taken: Clip[], dropped: string[], meta?: string): KnownContent {
  const k: KnownContent = known ? { meta: known.meta, clips: new Map(known.clips) } : { meta: '', clips: new Map() };
  taken.forEach(c => k.clips.set(c.id, clipSig(c)));
  dropped.forEach(id => k.clips.delete(id));
  if (meta !== undefined) k.meta = meta;
  return k;
}

/** Après un envoi : ce qui est parti est connu de tous (seulement ce qu'on a envoyé). */
export function noteSent(known: KnownContent | undefined, sent: { meta: string; clips: Clip[]; changed: string[]; removed: string[] }): KnownContent {
  const k: KnownContent = known ? { meta: known.meta, clips: new Map(known.clips) } : { meta: '', clips: new Map() };
  const byId = new Map(sent.clips.map(c => [c.id, c]));
  sent.changed.forEach(id => { const c = byId.get(id); if (c) k.clips.set(id, clipSig(c)); });
  sent.removed.forEach(id => k.clips.delete(id));
  k.meta = sent.meta;
  return k;
}

// --- Qui peut éditer le contenu d'une piste ------------------------------------------------

/**
 * Peut-on ENVOYER le contenu de cette piste ? Son propriétaire (rôle, et
 * personne si la piste est nommée) ; l'ingé son aussi, sur les pistes des
 * artistes et du beatmaker (comp, respirations, gain, justesse) et les
 * siennes — jamais sur le beat (non acheté : son audio ne voyage pas).
 */
export function canSendContent(t: Track, me: { role: CollabRole; key: string }): boolean {
  const owner = ownerRoleOf(t);
  if (me.role === 'engineer') {
    if (t.collabOwner === 'engineer') return !t.collabOwnerKey || t.collabOwnerKey === me.key;
    return owner !== null;
  }
  if (owner !== me.role) return false;
  return !t.collabOwnerKey || t.collabOwnerKey === me.key;
}

/**
 * Accepte-t-on ce contenu reçu ? Du propriétaire ; de l'ingé seulement au
 * format clip par clip (une version complète de l'ingé écraserait la prise
 * en cours de l'artiste).
 */
export function contentAllowed(existing: Track | undefined, author: { role: CollabRole; memberKey: string }, clipWise: boolean): { ok: boolean; reason?: string } {
  if (!existing) return { ok: true };
  const who = participantOf(author.memberKey);
  if (author.role === 'engineer' && clipWise) {
    if (existing.collabOwner === 'engineer') return !existing.collabOwnerKey || existing.collabOwnerKey === who ? { ok: true } : { ok: false, reason: 'piste d’un autre ingé' };
    return ownerRoleOf(existing) !== null ? { ok: true } : { ok: false, reason: 'piste partagée (beat)' };
  }
  if (ownerRoleOf(existing) !== author.role) return { ok: false, reason: 'piste d’un autre rôle' };
  if (existing.collabOwnerKey && existing.collabOwnerKey !== who) return { ok: false, reason: `piste de ${existing.collabOwnerName || 'quelqu’un d’autre'}` };
  return { ok: true };
}

// --- Mix : qui peut régler quoi ------------------------------------------------------------

/**
 * Peut-on régler le mix de cette piste (et l'envoyer) ? L'ingé : toutes. Un
 * artiste ou un beatmaker : SES pistes, et les pistes partagées (beat, bus,
 * master). Avant : seul l'ingé envoyait son mix — en « Feat à distance »
 * sans ingé, le volume ou les effets qu'un artiste mettait sur SA voix
 * restaient chez lui, et les autres entendaient autre chose.
 */
export function canSendMix(t: Track, me: { role: CollabRole; key: string }): boolean {
  if (me.role === 'engineer') return true;
  if (ownerRoleOf(t) === null && !t.collabOwnerKey) return true;
  if (t.collabOwnerKey) return t.collabOwnerKey === me.key;
  return ownerRoleOf(t) === me.role;
}

/** Accepte-t-on ce réglage de mix reçu ? Même règle que l'envoi, du point de vue de l'auteur. */
export function mixAllowed(existing: Track | undefined, author: { role: CollabRole; memberKey: string }): boolean {
  if (author.role === 'engineer') return true;
  if (!existing) return false;
  return canSendMix(existing, { role: author.role, key: participantOf(author.memberKey) });
}

// --- Suppression d'une piste ---------------------------------------------------------------

/** Peut-on supprimer cette piste pour tout le monde ? Son propriétaire ; une piste partagée : l'ingé. */
export function deleteAllowed(existing: Track | undefined, author: { role: CollabRole; memberKey: string }): boolean {
  if (!existing) return false;
  const who = participantOf(author.memberKey);
  if (existing.collabOwnerKey) return existing.collabOwnerKey === who;
  if (ownerRoleOf(existing) === null) return author.role === 'engineer';
  return ownerRoleOf(existing) === author.role;
}

// --- Ordre des pistes ------------------------------------------------------------------------

const rank = (t: Track) => (t.id === 'master' ? 3 : t.type === 'BUS' || t.type === 'SEND' ? 2 : 1);

/**
 * Ordre des pistes, le même chez tous : celui de la dernière liste reçue
 * (règle « dernière écriture gagne ») ; les pistes qu'elle ne connaît pas
 * (créées en même temps ailleurs) vont, par identifiant, avant les bus et le master.
 * Ne dépend que des pistes présentes et de la liste : même résultat partout.
 */
export function canonicalOrder<T extends Track>(tracks: T[], order: string[] | null | undefined): T[] {
  if (!order || !order.length) return tracks;
  const pos = new Map(order.map((id, i) => [id, i]));
  const listed = tracks.filter(t => pos.has(t.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  const others = tracks.filter(t => !pos.has(t.id)).sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: T[] = [];
  const firstTail = listed.findIndex(t => rank(t) > 1);
  const head = firstTail < 0 ? listed : listed.slice(0, firstTail);
  const tail = firstTail < 0 ? [] : listed.slice(firstTail);
  out.push(...head, ...others.filter(t => rank(t) === 1), ...tail, ...others.filter(t => rank(t) > 1));
  return out;
}

export const orderOf = (tracks: Track[]): string[] => tracks.map(t => t.id);
export const sameOrder = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// --- Session : tonalité, arrangements, paroles --------------------------------------------------

/** Champs de la session partagés en plus (dernière écriture gagne, champ par champ). */
export const SONG_FIELDS = ['projectKey', 'projectScale', 'arrangements', 'lyrics', 'lyricsRegions'] as const;
export type SongField = typeof SONG_FIELDS[number];

export function songFieldsOf(s: Record<string, any>): Record<SongField, unknown> {
  const out = {} as Record<SongField, unknown>;
  for (const f of SONG_FIELDS) out[f] = s[f] ?? null;
  return out;
}

/** Valeur reçue vérifiée (null : champ retiré). undefined : illisible, ignorée. */
export function sanitizeSongField(f: SongField, v: unknown): unknown {
  if (v === null) return null;
  switch (f) {
    case 'projectKey': return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 12 ? v : undefined;
    case 'projectScale': return typeof v === 'string' && v.length <= 40 ? v : undefined;
    case 'lyrics': return typeof v === 'string' ? v.slice(0, 20000) : undefined;
    case 'lyricsRegions': return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
    case 'arrangements': return Array.isArray(v)
      ? v.filter((a: any) => a && typeof a.id === 'string' && Array.isArray(a.sections)).slice(0, 50)
        .map((a: any) => ({ ...a, name: String(a.name || 'Arrangement').slice(0, 80), sections: a.sections.filter((x: unknown) => typeof x === 'string'), mutedClipIds: Array.isArray(a.mutedClipIds) ? a.mutedClipIds.filter((x: unknown) => typeof x === 'string') : [] }))
      : undefined;
    default: return undefined;
  }
}
