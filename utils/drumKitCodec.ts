/**
 * Conteneur des sons des kits de batterie (/drums/kits/<id>.nks).
 *
 * Format : « NVK1 » (4 octets) + IV (16 octets) + FLAC chiffré en AES-128-CTR (compteur 128 bits).
 * Écrit par tools/kits/prepare_kits.py (scramble) ; la clé doit rester identique des deux côtés.
 *
 * Ce n'est PAS une protection forte : la clé est dans le code du DAW. C'est un frein contre la
 * récupération directe des sons (ni FLAC ni WAV lisible tel quel, en ligne comme dans le cache) ;
 * le son n'existe en clair qu'en mémoire, juste avant decodeAudioData.
 */

export const KIT_MAGIC = [0x4e, 0x56, 0x4b, 0x31]; // « NVK1 »
const KEY_HEX = '6e6f76612d6b6974732d6d6d2d323031'; // = KEY_HEX de tools/kits/prepare_kits.py
const HEADER = 4 + 16;

export class KitCodecError extends Error {
  constructor(public code: 'format' | 'crypto', message: string) { super(message); this.name = 'KitCodecError'; }
}

export function isKitContainer(buf: ArrayBuffer | Uint8Array): boolean {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length > HEADER && KIT_MAGIC.every((v, i) => b[i] === v);
}

let keyPromise: Promise<CryptoKey> | null = null;
function subtle(): SubtleCrypto {
  const s = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!s) throw new KitCodecError('crypto', 'Déchiffrement indisponible : ouvre NOVA en https (connexion sécurisée).');
  return s;
}
function key(): Promise<CryptoKey> {
  if (!keyPromise) {
    const raw = new Uint8Array(KEY_HEX.match(/../g)!.map(h => parseInt(h, 16)));
    keyPromise = subtle().importKey('raw', raw, { name: 'AES-CTR' }, false, ['decrypt']);
    keyPromise.catch(() => { keyPromise = null; });
  }
  return keyPromise;
}

/** Conteneur .nks → octets FLAC (en mémoire seulement). */
export async function openKitContainer(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf);
  if (!isKitContainer(b)) throw new KitCodecError('format', 'Fichier de son du kit illisible (format inattendu).');
  const iv = b.slice(4, HEADER);
  return subtle().decrypt({ name: 'AES-CTR', counter: iv, length: 128 }, await key(), b.subarray(HEADER));
}
