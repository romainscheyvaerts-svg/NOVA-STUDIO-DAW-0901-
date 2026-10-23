/**
 * Noms de la base de récupération (IndexedDB), partagés par la page (utils/recoveryStore) et
 * l'écrivain de prises qui tourne dans un Worker (engine/takeWriter.worker.ts). Aucune
 * dépendance : importable dans un Worker.
 */
export const DB_NAME = 'nova-recovery';
export const DB_VERSION = 1;
export const AUDIO = 'audio';
export const VERSIONS = 'versions';
export const TAKES = 'takes';
export const TAKE_CHUNKS = 'takeChunks';
export const STORES = [AUDIO, VERSIONS, TAKES, TAKE_CHUNKS] as const;
