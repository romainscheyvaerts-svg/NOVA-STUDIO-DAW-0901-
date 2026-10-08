import type { DAWState, Track } from '../types';

/**
 * R21 · Versions nommées (Pro Tools : File › Save As New Version, nom_v2,
 * nom_v3… ; Logic : Project Alternatives).
 *
 * Pas de deuxième historique : une version nommée est un POINT MARQUÉ dans
 * l'historique de la sauvegarde automatique (utils/recoveryStore, « Versions
 * de la session ») : numéro, commentaire, jamais effacée par le ménage
 * (20 dernières + une par heure). Le projet prend le nom « Titre v2 ».
 *
 * Ici : noms, numéros, comparaison de deux versions (pistes ajoutées,
 * retirées, renommées, clips changés). Module pur : tests/projectVersions.test.ts.
 */

const V_RE = /\s*(?:[-_ ]v|\s\(v)(\d{1,4})\)?\s*$/i;

/** Nom sans le suffixe de version (« Mon son v3 » → « Mon son »). */
export function baseName(name: string): string {
  return (name || '').replace(V_RE, '').trim() || 'Projet';
}

/** Numéro lu dans le nom (« Mon son v3 » → 3), sinon null. */
export function versionInName(name: string): number | null {
  const m = (name || '').match(V_RE);
  return m ? parseInt(m[1], 10) : null;
}

/** Nom de la version n (« Mon son » → « Mon son v2 »). */
export function versionName(name: string, n: number): string {
  return `${baseName(name)} v${n}`.slice(0, 80);
}

export interface NamedVersionLike { versionNumber?: number; projectId: string }

/**
 * Prochain numéro : après le plus grand déjà donné à ce projet (historique,
 * nom, état). Un projet jamais versionné est la v1 : la première nouvelle
 * version est la v2 (comme Pro Tools).
 */
export function nextVersionNumber(s: Pick<DAWState, 'id' | 'name' | 'sessionVersion'>, history: NamedVersionLike[] = []): number {
  let max = Math.max(1, s.sessionVersion || 0, versionInName(s.name) || 0);
  for (const v of history) if (v.projectId === s.id && v.versionNumber) max = Math.max(max, v.versionNumber);
  return max + 1;
}

export const MAX_VERSION_COMMENT = 400;
export const cleanComment = (c: string | undefined) => (c || '').replace(/\s+/g, ' ').trim().slice(0, MAX_VERSION_COMMENT);

// ─── Comparaison ───────────────────────────────────────────────────────────────

export interface TrackDiffEntry { id: string; name: string }
export interface VersionDiff {
  added: TrackDiffEntry[];
  removed: TrackDiffEntry[];
  renamed: { id: string; from: string; to: string }[];
  /** Pistes dont les clips ont changé (nombre de clips avant → après). */
  clipsChanged: { id: string; name: string; before: number; after: number }[];
  /** Pistes dont les effets ont changé (nombre avant → après). */
  pluginsChanged: { id: string; name: string; before: number; after: number }[];
  tempo?: { before: number; after: number };
  /** Aucune différence de structure. */
  same: boolean;
}

type T = Pick<Track, 'id' | 'name' | 'clips' | 'plugins'>;
const sig = (t: T) => (t.clips || []).map(c => `${c.id}:${(+c.start).toFixed(3)}:${(+c.duration).toFixed(3)}:${c.isMuted ? 1 : 0}`).sort().join('|');
const psig = (t: T) => (t.plugins || []).map(p => `${p.type}:${p.name}:${p.isEnabled ? 1 : 0}`).join('|');

/**
 * Ce qui a changé de `before` (la version) à `after` (le projet ouvert).
 * Les pistes sont reconnues par identifiant, sinon par nom.
 */
export function compareVersions(before: { tracks: T[]; bpm?: number }, after: { tracks: T[]; bpm?: number }): VersionDiff {
  const b = before.tracks.filter(t => t.id !== 'master');
  const a = after.tracks.filter(t => t.id !== 'master');
  const used = new Set<string>();
  const pair = new Map<string, T>();
  for (const tb of b) {
    const m = a.find(x => x.id === tb.id && !used.has(x.id)) || a.find(x => !used.has(x.id) && x.name.trim().toLowerCase() === tb.name.trim().toLowerCase());
    if (m) { used.add(m.id); pair.set(tb.id, m); }
  }
  const diff: VersionDiff = { added: [], removed: [], renamed: [], clipsChanged: [], pluginsChanged: [], same: true };
  for (const tb of b) {
    const ta = pair.get(tb.id);
    if (!ta) { diff.removed.push({ id: tb.id, name: tb.name }); continue; }
    if (ta.name !== tb.name) diff.renamed.push({ id: ta.id, from: tb.name, to: ta.name });
    if (sig(ta) !== sig(tb)) diff.clipsChanged.push({ id: ta.id, name: ta.name, before: (tb.clips || []).length, after: (ta.clips || []).length });
    if (psig(ta) !== psig(tb)) diff.pluginsChanged.push({ id: ta.id, name: ta.name, before: (tb.plugins || []).length, after: (ta.plugins || []).length });
  }
  for (const ta of a) if (!used.has(ta.id)) diff.added.push({ id: ta.id, name: ta.name });
  if (before.bpm && after.bpm && Math.abs(before.bpm - after.bpm) > 1e-3) diff.tempo = { before: before.bpm, after: after.bpm };
  diff.same = !diff.added.length && !diff.removed.length && !diff.renamed.length && !diff.clipsChanged.length && !diff.pluginsChanged.length && !diff.tempo;
  return diff;
}

/** Phrases prêtes à afficher. */
export function diffLines(d: VersionDiff): string[] {
  if (d.same) return ['Aucune différence de pistes, de clips ni d\'effets.'];
  const out: string[] = [];
  const names = (l: { name: string }[]) => l.slice(0, 6).map(x => `« ${x.name} »`).join(', ') + (l.length > 6 ? '…' : '');
  if (d.added.length) out.push(`+ ${d.added.length} piste${d.added.length > 1 ? 's' : ''} ajoutée${d.added.length > 1 ? 's' : ''} depuis : ${names(d.added)}`);
  if (d.removed.length) out.push(`− ${d.removed.length} piste${d.removed.length > 1 ? 's' : ''} retirée${d.removed.length > 1 ? 's' : ''} depuis : ${names(d.removed)}`);
  for (const r of d.renamed.slice(0, 4)) out.push(`✎ « ${r.from} » renommée « ${r.to} »`);
  if (d.clipsChanged.length) out.push(`✂ clips modifiés sur ${names(d.clipsChanged)}`);
  if (d.pluginsChanged.length) out.push(`🎛 effets modifiés sur ${names(d.pluginsChanged)}`);
  if (d.tempo) out.push(`♩ tempo ${d.tempo.before} → ${d.tempo.after} BPM`);
  return out;
}
