import type { Clip, CollabRole } from '../types';
import { AUTO_FIELD, PLUGIN_FIELD, type MixFields } from './collabMerge';

/**
 * Historique « qui a changé quoi » d'une collaboration, avec retour arrière.
 *
 * Chaque modification reçue d'un collaborateur laisse une ligne lisible
 * (« Max a changé le volume et l'effet COMPRESSOR de « Voix lead » ») et,
 * quand c'est possible, de quoi revenir à l'état d'avant : les valeurs que
 * l'on avait juste avant de l'appliquer. « Annuler » remet ces valeurs CHEZ
 * MOI, comme une modification faite à la main : elle repart chez tous par le
 * chemin normal (avec mes droits), donc tout le monde revient au même état.
 *
 * Module pur : testable tel quel.
 */

export type UndoAction =
  | { kind: 'mix'; trackId: string; fields: MixFields }
  | { kind: 'clips'; trackId: string; restore: Clip[]; remove: string[] }
  | { kind: 'song'; fields: Record<string, unknown> }
  | { kind: 'tempo'; op: Record<string, unknown> };

export interface HistoryEntry {
  id: string;
  /** Numéro du journal (ordre commun à tous). */
  seq: number;
  at: number;
  who: string;
  role: CollabRole;
  color?: string;
  text: string;
  trackId?: string;
  undo?: UndoAction;
  /** Déjà annulée ici. */
  undone?: boolean;
}

export const HISTORY_MAX = 120;

export const SONG_LABEL: Record<string, string> = {
  projectKey: 'la tonalité', projectScale: 'la gamme', arrangements: 'les arrangements', lyrics: 'les paroles', lyricsRegions: 'les paroles par section',
};

/** Ce qu'un champ de mix veut dire, en français. */
export function mixFieldLabel(f: string, pluginName?: (id: string) => string | undefined): string {
  if (f === 'volume') return 'le volume';
  if (f === 'pan') return 'le panoramique';
  if (f === 'isMuted') return 'le mute';
  if (f === 'outputTrackId') return 'la sortie';
  if (f === 'sends') return 'les envois';
  if (f === 'pluginOrder') return 'la liste des effets';
  if (f === 'structure') return 'la structure (masquée, inactive, dossier)';
  if (f === 'strip') return 'la tranche (trim, phase, largeur)';
  if (f === 'automationMode' || f === 'autoOrder' || f.startsWith(AUTO_FIELD)) return "l'automation";
  if (f.startsWith(PLUGIN_FIELD)) {
    const n = pluginName?.(f.slice(PLUGIN_FIELD.length));
    return n ? `l'effet ${n}` : 'un effet';
  }
  return f;
}

/** « le volume, le panoramique et l'effet COMPRESSOR » (sans doublon, 4 au plus). */
export function joinLabels(labels: string[]): string {
  const u = [...new Set(labels)];
  const shown = u.slice(0, 4);
  const more = u.length - shown.length;
  if (more > 0) return `${shown.join(', ')} et ${more} autre${more > 1 ? 's' : ''} réglage${more > 1 ? 's' : ''}`;
  if (shown.length <= 1) return shown[0] || 'un réglage';
  return `${shown.slice(0, -1).join(', ')} et ${shown[shown.length - 1]}`;
}

/** Ligne pour des clips changés (« a retouché 2 clips de « Voix lead » »). */
export function clipsText(trackName: string, changed: number, added: number, removed: number): string {
  const parts: string[] = [];
  if (added) parts.push(added > 1 ? `ajouté ${added} clips` : 'ajouté un clip');
  if (changed) parts.push(changed > 1 ? `retouché ${changed} clips` : 'retouché un clip');
  if (removed) parts.push(removed > 1 ? `retiré ${removed} clips` : 'retiré un clip');
  return `a ${joinLabels(parts)} sur « ${trackName} »`;
}

/** Ajoute une ligne (les plus récentes d'abord, bornée). */
export const pushHistory = (list: HistoryEntry[], e: HistoryEntry): HistoryEntry[] =>
  [e, ...list.filter(x => x.id !== e.id)].sort((a, b) => b.seq - a.seq).slice(0, HISTORY_MAX);

/** Ce qu'il faut remettre pour annuler des clips reçus : nos versions d'avant, et retirer ceux ajoutés. */
export function clipsUndo(trackId: string, before: Clip[], taken: Clip[], dropped: string[]): UndoAction | undefined {
  const had = new Map(before.map(c => [c.id, c]));
  const restore: Clip[] = [];
  const remove: string[] = [];
  for (const c of taken) { const old = had.get(c.id); if (old) restore.push(old); else remove.push(c.id); }
  for (const id of dropped) { const old = had.get(id); if (old) restore.push(old); }
  if (!restore.length && !remove.length) return undefined;
  return { kind: 'clips', trackId, restore: restore.map(c => { const { buffer: _b, ...r } = c as Clip & { buffer?: unknown }; return r as Clip; }), remove };
}

/** Applique l'annulation de clips à une liste de clips (pur). */
export function applyClipsUndo(clips: Clip[], u: { restore: Clip[]; remove: string[] }): Clip[] {
  const gone = new Set(u.remove);
  const out = clips.filter(c => !gone.has(c.id));
  for (const r of u.restore) {
    const i = out.findIndex(c => c.id === r.id);
    if (i >= 0) out[i] = { ...r, ...((out[i] as any).buffer && out[i].bufferId === r.bufferId ? { buffer: (out[i] as any).buffer } : {}) } as Clip;
    else out.push({ ...r });
  }
  return out;
}

/** Il y a combien de temps, court (« à l'instant », « il y a 3 min »). */
export function agoShort(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.round(m / 60)} h`;
}
