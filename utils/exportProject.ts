import type { Track } from '../types';
import { usesKitSounds } from './drumKitLibrary';

/**
 * Ce que le serveur doit savoir d'un projet pour décider de l'export (nova-billing,
 * action « export_access ») : les instrus / mélodies du catalogue qu'il contient et s'il
 * joue des sons des kits de batterie NOVA. Aucune décision n'est prise ici.
 */

/** Identifiants (texte) des instrus / mélodies du catalogue présentes dans le projet. */
export function catalogIdsOf(tracks: Pick<Track, 'instrumentId'>[]): string[] {
  const ids = new Set<string>();
  for (const t of tracks) {
    const id = t.instrumentId;
    if (id === undefined || id === null || id === '') continue;
    ids.add(String(id));
  }
  return [...ids].sort();
}

/**
 * Le projet joue-t-il des sons des kits NOVA (boîte à rythmes, sampler chargé depuis un pad) ?
 * Règle UNIQUE du chantier des kits (usesKitSounds, utils/drumKitLibrary) : les projets avec des
 * kits ne s'exportent JAMAIS gratuitement (le serveur refuse la voie « licence » quand kits = true).
 */
export function projectUsesKits(tracks: Parameters<typeof usesKitSounds>[0][]): boolean {
  return tracks.some(t => usesKitSounds(t));
}
