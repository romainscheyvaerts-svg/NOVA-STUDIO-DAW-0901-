import type { DAWState, Track } from '../types';

/**
 * R21 · Notes de session (Pro Tools : Comments de piste et Project Notes).
 *
 *  - un commentaire par piste (Track.comment) : affiché dans la console et
 *    l'en-tête de piste ;
 *  - des notes de projet : consignes de mix, références, notes libres. Les
 *    paroles restent dans `lyrics` (le prompteur) et sont montrées au même
 *    endroit ;
 *  - collaboration : une opération « notes » ne porte que les champs changés
 *    (« p:mix », « p:lyrics », « t:<id piste> ») ; le plus récent du journal
 *    gagne, champ par champ (même règle que le mix).
 *
 * Module pur : tests/sessionNotes.test.ts.
 */

export interface ProjectNotes {
  /** Consignes de mix (ingé son). */
  mix?: string;
  /** Morceaux de référence, liens. */
  references?: string;
  /** Notes libres (à faire, idées). */
  general?: string;
  /** Dernière modification (ms) et auteur, affichés sous les notes. */
  updatedAt?: number;
  updatedBy?: string;
}

export type ProjectNoteField = 'lyrics' | 'mix' | 'references' | 'general';
export const PROJECT_NOTE_FIELDS: ProjectNoteField[] = ['lyrics', 'mix', 'references', 'general'];

export const NOTE_LABELS: Record<ProjectNoteField, { label: string; hint: string; placeholder: string }> = {
  lyrics: { label: 'Paroles', hint: 'Les mêmes que dans le prompteur : les modifier ici les change là-bas.', placeholder: 'Couplet 1…' },
  mix: { label: 'Consignes de mix', hint: 'Pro Tools : Project Notes. Ce que l\'ingé doit savoir (voix devant, 808 sans saturation…).', placeholder: 'Ex. : voix lead bien devant, pas trop de reverb sur les backs' },
  references: { label: 'Références', hint: 'Morceaux de référence, liens, ambiance visée.', placeholder: 'Ex. : « Titre » de tel artiste pour le son de la voix' },
  general: { label: 'Notes libres', hint: 'À faire, idées, ce qui reste à enregistrer.', placeholder: 'Ex. : refaire le 2e couplet, ajouter des adlibs' },
};

/** Longueur maximale d'une note (au-delà : coupée, pour la collaboration et la sauvegarde). */
export const MAX_NOTE = 20000;
export const MAX_COMMENT = 500;

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Valeur d'une note de projet (paroles comprises). */
export function noteValue(s: Pick<DAWState, 'lyrics' | 'projectNotes'>, f: ProjectNoteField): string {
  if (f === 'lyrics') return s.lyrics || '';
  return (s.projectNotes?.[f] as string | undefined) || '';
}

/** Change une note de projet (paroles comprises). */
export function withNote<S extends Pick<DAWState, 'lyrics' | 'projectNotes'>>(s: S, f: ProjectNoteField, text: string, by?: string, now = Date.now()): S {
  const v = clip(text, MAX_NOTE);
  if (noteValue(s, f) === v) return s;
  if (f === 'lyrics') return { ...s, lyrics: v };
  return { ...s, projectNotes: { ...(s.projectNotes || {}), [f]: v, updatedAt: now, ...(by ? { updatedBy: by } : {}) } };
}

/** Commentaire d'une piste changé (vide = retiré). */
export function withTrackComment(t: Track, text: string): Track {
  const v = clip(text, MAX_COMMENT).replace(/\s+$/, '');
  if ((t.comment || '') === v) return t;
  const out = { ...t };
  if (v) out.comment = v; else delete out.comment;
  return out;
}

/** Nombre de notes remplies (pastille du bouton « Notes »). */
export function notesCount(s: Pick<DAWState, 'lyrics' | 'projectNotes' | 'tracks'>): number {
  let n = PROJECT_NOTE_FIELDS.filter(f => noteValue(s, f).trim()).length;
  n += s.tracks.filter(t => (t.comment || '').trim()).length;
  return n;
}

// ─── Collaboration ─────────────────────────────────────────────────────────────

export type NotesFields = Record<string, string>;

/** Toutes les notes du projet, champ par champ (« p:mix », « t:<id> »). */
export function notesFieldsOf(s: Pick<DAWState, 'lyrics' | 'projectNotes' | 'tracks'>): NotesFields {
  const out: NotesFields = {};
  for (const f of PROJECT_NOTE_FIELDS) out[`p:${f}`] = noteValue(s, f);
  for (const t of s.tracks) if (t.id !== 'master' || t.comment) out[`t:${t.id}`] = t.comment || '';
  return out;
}

/** Champs changés depuis les valeurs connues (envoyées ou reçues). */
export function changedNotes(known: NotesFields, fields: NotesFields): NotesFields {
  const out: NotesFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (known[k] === undefined && !v) continue; // rien de nouveau (piste sans commentaire)
    if (known[k] !== v) out[k] = v;
  }
  return out;
}

/** Opération reçue vérifiée (seulement des textes, clés connues). */
export function sanitizeNotesOp(raw: unknown): NotesFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = (raw as { fields?: unknown }).fields;
  if (!f || typeof f !== 'object') return null;
  const out: NotesFields = {};
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (/^p:(lyrics|mix|references|general)$/.test(k)) out[k] = v.slice(0, MAX_NOTE);
    else if (/^t:[\w.:~-]{1,120}$/.test(k)) out[k] = v.slice(0, MAX_COMMENT);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Applique des champs reçus. `accept(clé)` : le champ reçu est-il le plus récent
 * (horloge du journal) ? `pending` : champs modifiés ici pas encore partis (gardés).
 */
export function applyNotesFields<S extends Pick<DAWState, 'lyrics' | 'projectNotes' | 'tracks'>>(
  s: S, fields: NotesFields, accept: (key: string) => boolean = () => true, pending: Set<string> = new Set(), by?: string,
): { state: S; applied: string[] } {
  let out = s;
  const applied: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (pending.has(k) || !accept(k)) continue;
    if (k.startsWith('p:')) {
      const f = k.slice(2) as ProjectNoteField;
      if (!PROJECT_NOTE_FIELDS.includes(f)) continue;
      const next = withNote(out, f, v, by);
      if (next !== out) { out = next; applied.push(k); }
    } else if (k.startsWith('t:')) {
      const id = k.slice(2);
      const i = out.tracks.findIndex(t => t.id === id);
      if (i < 0) continue;
      const nt = withTrackComment(out.tracks[i], v);
      if (nt !== out.tracks[i]) {
        const tracks = [...out.tracks];
        tracks[i] = nt;
        out = { ...out, tracks };
        applied.push(k);
      }
    }
  }
  return { state: out, applied };
}

/** Courte description pour l'avis « X a modifié… ». */
export function notesChangeLabel(keys: string[], tracks: Pick<Track, 'id' | 'name'>[]): string {
  const parts: string[] = [];
  for (const k of keys.slice(0, 3)) {
    if (k.startsWith('p:')) parts.push(NOTE_LABELS[k.slice(2) as ProjectNoteField]?.label.toLowerCase() || 'les notes');
    else { const t = tracks.find(x => x.id === k.slice(2)); parts.push(`le commentaire de « ${t?.name || 'piste'} »`); }
  }
  return parts.join(', ') + (keys.length > 3 ? '…' : '');
}
