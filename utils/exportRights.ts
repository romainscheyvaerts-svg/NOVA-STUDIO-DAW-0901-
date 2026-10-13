import type { DAWState, Track } from '../types';
import { usesKitSounds } from './drumKitLibrary';

/**
 * Droits de sortie audio d'un projet (mêmes règles que la fenêtre Exporter) :
 * - beat / mélodie du catalogue non acheté : le mix propre est bloqué (licence à acheter) ;
 * - sons des kits NOVA sans instru du catalogue : export payant (2 € ou un export Nova Pro) ;
 * - admin : libre.
 * Sert aux chemins de sortie hors de la fenêtre Exporter (version envoyée en collaboration…).
 */

const hasId = (t: Track) => t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '';

export const unlicensedBeats = (tracks: Track[], owned: (string | number)[]) => {
  const o = owned.map(String);
  return tracks.filter(t => hasId(t) && !o.includes(String(t.instrumentId)));
};
export const hasCatalogBeat = (tracks: Track[]) => tracks.some(hasId);
export const projectUsesKits = (tracks: Track[]) => tracks.some(t => usesKitSounds(t));

export interface RightsChecks {
  isAdmin: () => Promise<boolean>;
  isExportPaid: (projectKey: string) => Promise<boolean>;
}

/**
 * Une version de mix envoyée hors de la fenêtre Exporter doit-elle porter le tag sonore Make Music
 * (comme la démo gratuite) ? Oui si elle contient un beat du catalogue sans licence, ou des sons des
 * kits NOVA dans un projet dont l'export n'est pas payé. Admin : jamais.
 */
export async function mixNeedsTag(st: Pick<DAWState, 'id' | 'tracks' | 'exportKey'>, owned: (string | number)[], checks: RightsChecks): Promise<boolean> {
  const beat = unlicensedBeats(st.tracks, owned).length > 0;
  const kits = projectUsesKits(st.tracks) && !hasCatalogBeat(st.tracks);
  if (!beat && !kits) return false;
  if (await checks.isAdmin().catch(() => false)) return false;
  if (beat) return true;
  const key = exportKeyOf(st);
  return !key || !(await checks.isExportPaid(key).catch(() => false));
}

/** Id local par défaut, commun à tous les projets non enregistrés : jamais une clé d'export. */
export const SHARED_PROJECT_ID = 'proj-1';
export const newExportKey = () => `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** Clé d'export du projet ('' tant qu'il n'en a pas : rien n'est débloqué). */
export const exportKeyOf = (st: Pick<DAWState, 'id' | 'exportKey'>): string =>
  st.exportKey || (st.id && st.id !== SHARED_PROJECT_ID && !/^proj-1$/.test(st.id) ? st.id : '');
