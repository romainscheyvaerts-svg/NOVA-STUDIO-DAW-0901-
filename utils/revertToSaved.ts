import type { VersionMeta } from './recoveryStore';

/**
 * « Revenir à la version enregistrée » (Pro Tools : File › Revert to Saved).
 *
 * La version enregistrée = la dernière sauvegarde VOULUE de ce projet sur cet
 * appareil : « Sauvegarder » (cloud ou fichier) écrit aussi une version
 * « manual » dans l'historique de la session, et une version nommée (R21)
 * compte aussi. Les sauvegardes automatiques (toutes les 15 s) n'en sont pas.
 *
 * Revenir n'efface rien : l'état actuel est d'abord gardé dans « Versions de
 * la session » (on peut donc revenir en avant). Module pur : tests/revertToSaved.test.ts.
 */

export const isSavedVersion = (v: Pick<VersionMeta, 'reason' | 'versionNumber'>): boolean =>
  v.reason === 'manual' || v.reason === 'named' || !!v.versionNumber;

/** La dernière version enregistrée du projet (null : jamais sauvegardé sur cet appareil). */
export function findSavedVersion(list: VersionMeta[], projectId: string): VersionMeta | null {
  return list.filter(v => v.projectId === projectId && isSavedVersion(v)).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
}

/**
 * Identifiants à ne jamais supprimer au ménage automatique : la dernière
 * version enregistrée de chaque projet (sinon 20 sauvegardes auto, soit 5 min,
 * la feraient disparaître et « Revenir à la version enregistrée » n'aurait plus de cible).
 */
export function savedVersionsToKeep(list: Pick<VersionMeta, 'id' | 'projectId' | 'savedAt' | 'reason' | 'versionNumber'>[]): Set<number> {
  const best = new Map<string, { id: number; savedAt: number }>();
  for (const v of list) {
    if (v.reason !== 'manual') continue;
    const b = best.get(v.projectId);
    if (!b || v.savedAt > b.savedAt) best.set(v.projectId, { id: v.id, savedAt: v.savedAt });
  }
  return new Set([...best.values()].map(x => x.id));
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });

/** « il y a 12 min (14:32) », « il y a 2 h (11:05) », « hier à 18:40 »… */
export function savedAgo(savedAt: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - savedAt) / 60000));
  const d = new Date(savedAt), n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (!sameDay) {
    const y = new Date(now - 86_400_000);
    return d.toDateString() === y.toDateString() ? `hier à ${hhmm(savedAt)}` : `le ${d.toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' })} à ${hhmm(savedAt)}`;
  }
  if (min < 1) return `à l’instant (${hhmm(savedAt)})`;
  if (min < 60) return `il y a ${min} min (${hhmm(savedAt)})`;
  return `il y a ${Math.round(min / 60)} h (${hhmm(savedAt)})`;
}
