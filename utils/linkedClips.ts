import type { Clip, Track } from '../types';
import { quartersToTime, timeToQuarters, type TempoMap } from './tempoMap';

/**
 * L3 · Clips MIDI liés (copies liées d'un motif) : modifier les notes d'une
 * copie modifie toutes les copies ; « Rendre unique » détache une copie.
 *
 * Forme rétrocompatible : chaque copie garde SES notes dans `notes` (une
 * ancienne version de NOVA joue donc chaque copie telle quelle) ; `linkId`
 * (Clip) dit seulement qui va avec qui. La synchronisation est faite à chaque
 * mise à jour du projet (App, setState) par `syncLinkedClips`, pure :
 *  - une seule copie d'un groupe a changé de contenu (notes, contrôleurs,
 *    groove) → ce contenu est recopié dans toutes les autres, à la même
 *    position MUSICALE (le tempo peut changer entre deux copies) ;
 *  - plusieurs copies ont changé ensemble (changement de tempo, opération sur
 *    le temps, collaboration) → rien n'est recopié (elles restent telles quelles) ;
 *  - une nouvelle copie apparaît avec un contenu différent (clip coupé en deux,
 *    collé puis retouché) → elle et la copie retouchée quittent le groupe : une
 *    moitié de motif ne doit pas écraser le motif entier.
 * Un groupe d'une seule copie n'est pas « lié » (pas de pastille).
 *
 * Collaboration : `linkId` voyage avec le clip (contenu de la piste) ; chacun
 * applique la même règle aux opérations reçues. Module pur : tests/linkedClips.test.ts.
 */

let seq = 0;
export const newLinkId = () => `lk${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const isMidi = (c: Clip) => Array.isArray(c.notes);

/** Nombre de copies par groupe (seuls les groupes de 2 copies ou plus comptent). */
export function linkCounts(tracks: Track[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tracks) for (const c of t.clips) if (c.linkId) m.set(c.linkId, (m.get(c.linkId) || 0) + 1);
  return m;
}

export const isLinked = (c: Pick<Clip, 'linkId'>, counts: Map<string, number>) => !!c.linkId && (counts.get(c.linkId) || 0) > 1;

/**
 * « Dupliquer en copie liée » : la copie suit le clip (ou se pose à `start`) ;
 * le clip d'origine entre dans le groupe s'il n'en avait pas.
 */
export function duplicateLinked(clips: Clip[], clipId: string, opts: { start?: number; id?: string; linkId?: string } = {}): { clips: Clip[]; id: string | null } {
  const i = clips.findIndex(c => c.id === clipId);
  if (i < 0 || !isMidi(clips[i])) return { clips, id: null };
  const src = clips[i];
  const linkId = src.linkId || opts.linkId || newLinkId();
  const id = opts.id || `clip-link-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const { tempoEpoch: _e, takeNumber: _n, ...rest } = src;
  const copy: Clip = { ...rest, id, linkId, start: opts.start ?? src.start + src.duration };
  const out = clips.map((c, k) => (k === i && c.linkId !== linkId ? { ...c, linkId } : c));
  out.push(copy);
  return { clips: out, id };
}

/** « Rendre unique » : la copie quitte son groupe (ses notes restent les siennes). */
export function makeUnique(clip: Clip): Clip {
  if (!clip.linkId) return clip;
  const { linkId: _l, ...rest } = clip;
  return rest as Clip;
}

/** Copie indépendante (Dupliquer, Coller) : sans lien. */
export const unlinked = (c: Clip): Clip => makeUnique(c);

const contentChanged = (a: Clip, b: Clip) => a.notes !== b.notes || a.cc !== b.cc || a.groove !== b.groove;

/** Même contenu (comparé en valeur) ? Positions des notes à 1 µs près. */
function sameContent(a: Clip, b: Clip): boolean {
  const na = a.notes || [], nb = b.notes || [];
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    const x = na[i], y = nb[i];
    if (x.pitch !== y.pitch || Math.abs(x.start - y.start) > 1e-6 || Math.abs(x.duration - y.duration) > 1e-6 || x.velocity !== y.velocity) return false;
  }
  return JSON.stringify(a.cc || null) === JSON.stringify(b.cc || null);
}

/** Contenu de `src` recopié dans `dst`, à la même position musicale (carte donnée) ou en secondes (tempo constant). */
export function copyContent(src: Clip, dst: Clip, map?: TempoMap | null): Clip {
  const out: Clip = { ...dst, notes: src.notes, cc: src.cc, groove: src.groove };
  if (!src.cc) delete out.cc;
  if (!src.groove) delete out.groove;
  if (!map || map.segments.length < 2) return out;
  const q0 = timeToQuarters(map, src.start), d0 = timeToQuarters(map, dst.start);
  const at = (t: number) => quartersToTime(map, d0 + (timeToQuarters(map, src.start + t) - q0)) - dst.start;
  out.notes = (src.notes || []).map(n => {
    const s = at(n.start), e = at(n.start + n.duration);
    return { ...n, start: Math.max(0, s), duration: Math.max(1e-4, e - s) };
  });
  if (src.cc) out.cc = Object.fromEntries(Object.entries(src.cc).map(([k, pts]) => [k, (pts || []).map(p => ({ ...p, t: Math.max(0, at(p.t)) }))]));
  return out;
}

/**
 * Applique la règle des copies liées entre l'état d'avant et l'état d'après.
 * Renvoie `next` tel quel quand rien n'est à faire (même référence).
 */
export function syncLinkedClips(prev: Track[], next: Track[], map?: TempoMap | null): Track[] {
  if (prev === next) return next;
  const prevById = new Map(prev.map(t => [t.id, t]));
  // Clips liés touchés par cette mise à jour : retouchés (contenu changé) ou nouveaux.
  const edited = new Map<string, Clip[]>();
  const fresh = new Map<string, Clip[]>();
  for (const t of next) {
    const pt = prevById.get(t.id);
    if (pt === t) continue;
    const prevClips = pt ? new Map(pt.clips.map(c => [c.id, c])) : null;
    for (const c of t.clips) {
      if (!c.linkId || !isMidi(c)) continue;
      const pc = prevClips?.get(c.id);
      if (pc === c) continue;
      if (!pc) { (fresh.get(c.linkId) || fresh.set(c.linkId, []).get(c.linkId)!).push(c); continue; }
      if (contentChanged(pc, c) || pc.linkId !== c.linkId) (edited.get(c.linkId) || edited.set(c.linkId, []).get(c.linkId)!).push(c);
    }
  }
  if (!edited.size && !fresh.size) return next;

  const detach = new Set<string>();
  const source = new Map<string, Clip>();
  const groups = new Set([...edited.keys(), ...fresh.keys()]);
  for (const g of groups) {
    const ed = edited.get(g) || [];
    const fr = fresh.get(g) || [];
    // Membres de référence : ceux d'avant qui n'ont pas changé.
    const before = prev.flatMap(t => t.clips.filter(c => c.linkId === g));
    const ref = ed.length === 1 ? ed[0] : before.find(c => !ed.some(e => e.id === c.id)) || before[0];
    const oddFresh = fr.filter(c => ref && !sameContent(c, ref));
    if (oddFresh.length) {
      // Clip coupé / collé puis retouché : les morceaux quittent le groupe.
      oddFresh.forEach(c => detach.add(c.id));
      ed.forEach(c => detach.add(c.id));
      continue;
    }
    if (ed.length === 1) source.set(g, ed[0]);
  }
  if (!detach.size && !source.size) return next;

  return next.map(t => {
    let changed = false;
    const clips = t.clips.map(c => {
      if (detach.has(c.id)) { changed = true; return makeUnique(c); }
      const src = c.linkId ? source.get(c.linkId) : undefined;
      if (!src || src.id === c.id || !isMidi(c)) return c;
      if (src.notes === c.notes && src.cc === c.cc && src.groove === c.groove) return c;
      changed = true;
      return copyContent(src, c, map);
    });
    return changed ? { ...t, clips } : t;
  });
}
