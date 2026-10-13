import type { Track } from '../types';
import { canCommit } from './commit';
import { bakeRefusalShort, canBakeTrack } from './freeze';

/**
 * Commit / gel de plusieurs pistes d'un coup (Pro Tools : sélectionner les
 * pistes, puis Piste › Commit… ou Freeze). Module pur : quelles pistes sont
 * traitées, lesquelles sont laissées et pourquoi (message clair à l'ingé).
 * L'exécution (rendus l'un après l'autre) est dans hooks/useProToolsEcarts.
 * Tests : tests/batchRender.test.ts.
 */
export type BatchKind = 'commit' | 'freeze' | 'unfreeze';

export interface BatchPlan {
  todo: string[];
  skipped: { id: string; name: string; why: string }[];
}

const hasContent = (t: Track) => (t.clips || []).some(c => !c.isFreezeSlice);

/** Pourquoi une piste ne peut pas être traitée (null = elle le peut). */
export function batchBlocker(t: Track, kind: BatchKind): string | null {
  if (t.id === 'master') return 'le master';
  if (t.isInactive) return 'piste inactive';
  if (kind === 'commit') {
    if (!canCommit(t)) return t.isVca ? 'un VCA' : t.folder ? 'un dossier' : 'un bus ou le beat';
    if (!hasContent(t)) return 'piste vide';
    return null;
  }
  if (kind === 'unfreeze') return t.isFrozen ? null : 'déjà en direct';
  if (t.isFrozen) return 'déjà gelée';
  if (t.vstInstrument) return 'instrument VST (rendu déjà automatique)';
  if (!canBakeTrack(t)) return bakeRefusalShort(t);
  if (!hasContent(t)) return 'piste vide';
  return null;
}

/** Pistes à traiter, dans l'ordre de la session. */
export function batchPlan(tracks: Track[], ids: string[], kind: BatchKind): BatchPlan {
  const want = new Set(ids);
  const plan: BatchPlan = { todo: [], skipped: [] };
  for (const t of tracks) {
    if (!want.has(t.id)) continue;
    const why = batchBlocker(t, kind);
    if (why) plan.skipped.push({ id: t.id, name: t.name, why });
    else plan.todo.push(t.id);
  }
  return plan;
}

const VERB: Record<BatchKind, [string, string]> = {
  commit: ['commitée', 'commitées'],
  freeze: ['gelée', 'gelées'],
  unfreeze: ['dégelée', 'dégelées'],
};

/** Message de fin (ou d'impossibilité) en français. */
export function batchSummary(kind: BatchKind, plan: BatchPlan, done: number, failed: string[]): string {
  const [one, many] = VERB[kind];
  const skipped = plan.skipped.length
    ? ` Laissée${plan.skipped.length > 1 ? 's' : ''} : ${plan.skipped.slice(0, 4).map(s => `« ${s.name} » (${s.why})`).join(', ')}${plan.skipped.length > 4 ? '…' : ''}.`
    : '';
  if (!plan.todo.length) {
    return `Aucune piste à traiter.${skipped || ' Sélectionne des pistes (plage sur plusieurs pistes, ou coche-les dans la fenêtre).'}`;
  }
  const fail = failed.length ? ` Échec : ${failed.map(n => `« ${n} »`).join(', ')}.` : '';
  const head = kind === 'commit' ? '✅' : kind === 'freeze' ? '❄️' : '🔥';
  const extra = kind === 'commit' && done ? ' Les originales sont gardées (inactives et masquées) : menu de la piste → « Restaurer la piste d’origine ».' : '';
  return `${head} ${done} piste${done > 1 ? 's' : ''} ${done > 1 ? many : one} sur ${plan.todo.length}.${extra}${fail}${skipped}`;
}
