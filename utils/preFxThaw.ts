import { PreFxOp, Track } from '../types';
import { freezeIndex, isTrackFrozen, isVst } from './freeze';
import { authorsOf, countPreFxEdits, describeOps, opsWithAuthors, summaryLine } from './preFxEdits';

/**
 * Retour sur le PC de l'ingé : dégel automatique des pistes gelées à la
 * sauvegarde, si les plugins sont là. Les éditions faites ailleurs sont déjà
 * dans les clips (audio sec) : en repassant sur la vraie chaîne d'effets, elles
 * passent AVANT les effets. Pur : testable sans audio.
 */

/** Pistes (et bus) gelés automatiquement, à dégeler sur un PC qui a les plugins. */
export const thawCandidates = (tracks: Track[]): Track[] =>
  tracks.filter(t => isTrackFrozen(t) && !!t.frozenAuto && !t.vstInstrument);

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Effets VST3 rendus dans la piste qui manquent sur ce PC. */
export function missingPlugins(t: Track, installedPaths: string[]): string[] {
  const have = new Set(installedPaths.map(norm));
  return (t.plugins || []).slice(0, freezeIndex(t) + 1)
    .filter(p => isVst(p) && p.isEnabled)
    .filter(p => { const path = p.params?.localPath; return !path || !have.has(norm(String(path))); })
    .map(p => String(p.params?.name || p.name || 'Plugin VST'));
}

export interface ThawPlan {
  thaw: string[];
  missing: { trackId: string; trackName: string; plugins: string[] }[];
}

export function planThaw(tracks: Track[], installedPaths: string[]): ThawPlan {
  const plan: ThawPlan = { thaw: [], missing: [] };
  for (const t of thawCandidates(tracks)) {
    const miss = missingPlugins(t, installedPaths);
    if (miss.length) plan.missing.push({ trackId: t.id, trackName: t.name, plugins: miss });
    else plan.thaw.push(t.id);
  }
  return plan;
}

/** Dégel (brouillon Immer) : la piste repasse sur sa vraie chaîne ; rendu, photo et journal restent. */
export function applyThaw(tracks: Track[], ids: string[]): void {
  const set = new Set(ids);
  tracks.forEach(t => { if (set.has(t.id)) { t.isFrozen = false; delete t.frozenAuto; } });
}

/** Regel (annuler le dégel) : on réentend les rendus faits au studio. */
export function applyRefreeze(tracks: Track[], ids: string[]): void {
  const set = new Set(ids);
  tracks.forEach(t => { if (set.has(t.id) && t.frozenClip) { t.isFrozen = true; t.frozenAuto = true; } });
}

export interface ReplayTrackSummary {
  trackId: string;
  trackName: string;
  ops: PreFxOp[];
  count: number;
  text: string;
  /** La photo du gel est encore là : on peut revenir à la version d'avant. */
  baseRenderId?: string;
}

export interface ReplaySummary {
  total: number;
  authors: string[];
  line: string;
  tracks: ReplayTrackSummary[];
}

/**
 * Résumé des éditions rejouées avant les effets : pistes dégelées, plus les
 * pistes qui alimentent un bus VST dégelé (leur reverb repart de l'audio sec).
 */
export function replaySummary(tracks: Track[], thawedIds: string[]): ReplaySummary {
  const thawed = new Set(thawedIds);
  const out: ReplayTrackSummary[] = [];
  for (const t of tracks) {
    if (!t.freezeBase) continue;
    const feedsThawedBus = (t.sendFreezes || []).some(sf => thawed.has(sf.busId));
    if (!thawed.has(t.id) && !feedsThawedBus) continue;
    const ops = opsWithAuthors(t).filter(o => o.kind !== 'add');
    const count = countPreFxEdits(ops);
    if (count === 0) continue;
    out.push({ trackId: t.id, trackName: t.name, ops, count, text: describeOps(ops), baseRenderId: t.freezeBase.renderId });
  }
  const all = out.flatMap(x => x.ops);
  const total = out.reduce((n, x) => n + x.count, 0);
  const authors = authorsOf(all);
  return { total, authors, line: summaryLine(total, authors), tracks: out };
}
