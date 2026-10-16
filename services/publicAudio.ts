import type { DAWState } from '../types';
import { AudioEncoder } from './AudioEncoder';
import { sha1, type CloudLink } from './SessionCloud';
import { uploadParts } from './Collab';
import { clipWindow, loadCover, projectEnd, renderClipMix } from '../utils/demoExport';
import { EXTRAIT_SECONDES, type PublicKind } from '../utils/publicTrack';

/**
 * Lot 9b (1.5.1) · Le son de la page publique : rendu du mix (effets, master), en MP3 192 kb/s,
 * crête vraie plafonnée, comme l'extrait à partager :
 *  - « extrait » : 30 s autour de la voix (utils/demoExport.clipWindow), la sortie audio du gratuit ;
 *  - « mix » : le morceau entier (seulement si son export est débloqué : vérifié par le serveur).
 * Envoyé dans le dossier de la séance (morceaux nommés par leur SHA-1, comme les prises) : il
 * n'est jamais mélangé aux pistes séparées, que la page ne montre pas.
 */
export async function renderPublicAudio(st: DAWState, kind: PublicKind, onProgress?: (p: number) => void): Promise<{ bytes: Uint8Array; duration: number; mime: string }> {
  const win = kind === 'extrait' ? clipWindow(st, EXTRAIT_SECONDES) : { start: 0, duration: Math.max(1, projectEnd(st)) };
  const mix = await renderClipMix(st, win.start, Math.min(win.duration, kind === 'extrait' ? EXTRAIT_SECONDES : 15 * 60), onProgress);
  const blob = await AudioEncoder.encodeMP3Plafonne(mix, 192);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), duration: Math.round(mix.duration * 100) / 100, mime: 'audio/mpeg' };
}

/** Pochette (celle de l'instru du catalogue) en JPEG carré 600 px ; null si aucune ou illisible. */
export async function renderCover(st: DAWState): Promise<Uint8Array | null> {
  try {
    const img = await loadCover(st);
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = 600; c.height = 600;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const s = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    ctx.drawImage(img, ((img.naturalWidth || img.width) - s) / 2, ((img.naturalHeight || img.height) - s) / 2, s, s, 0, 0, 600, 600);
    const blob = await new Promise<Blob | null>(res => c.toBlob(b => res(b), 'image/jpeg', 0.86));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; } // image d'une autre origine (canvas « sali ») : pas de pochette
}

/** Envoie le son (et la pochette) dans le dossier de la séance ; renvoie leurs empreintes. */
export async function uploadPublicAudio(link: CloudLink, audio: Uint8Array, cover: Uint8Array | null): Promise<{ parts: string[]; size: number; coverPart: string | null }> {
  const hash = await sha1(audio);
  const coverHash = cover ? await sha1(cover) : null;
  await uploadParts(link, [{ hash, bytes: audio }, ...(cover && coverHash ? [{ hash: coverHash, bytes: cover }] : [])]);
  return { parts: [hash], size: audio.length, coverPart: coverHash };
}
