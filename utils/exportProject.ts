import type { Track } from '../types';

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
 * Même règle que usesKitSounds (utils/drumKitLibrary, chantier des kits) : une référence de kit
 * commence par « kit: ». Les projets avec des kits ne s'exportent JAMAIS gratuitement.
 */
export function projectUsesKits(tracks: Pick<Track, 'drumMachine' | 'melodicSampler'>[]): boolean {
  const isKit = (ref: unknown) => typeof ref === 'string' && ref.startsWith('kit:');
  return tracks.some(t => {
    const ms = t.melodicSampler as { kitRef?: unknown } | undefined;
    if (ms && isKit(ms.kitRef)) return true;
    const rows = (t.drumMachine as { rows?: { sound?: unknown }[] } | undefined)?.rows || [];
    return rows.some(r => isKit(r?.sound));
  });
}
