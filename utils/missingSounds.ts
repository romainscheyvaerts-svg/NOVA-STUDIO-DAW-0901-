/**
 * Sons manquants (« Relier ») : clips dont le son n'a pas été retrouvé à l'ouverture
 * (fichier absent ou illisible dans le .zip, project.json seul, version dont un son a été
 * effacé de l'appareil). Ils restent à leur place, muets (isOffline). Avant, rien ne les
 * montrait et rien ne permettait de leur redonner un son.
 *
 * Relier = choisir le fichier du son : le nom est cherché automatiquement (« Prise 3.wav »
 * pour le clip « Prise 3 »), un clip peut aussi recevoir un fichier choisi à la main.
 */
import type { Clip, Track } from '../types';

export interface MissingClip { trackId: string; trackName: string; clipId: string; clipName: string; start: number; duration: number }

/** Clip audio dont le son manque (le beat sous licence non acheté n'en fait pas partie : il se rachète). */
export const isMissingSound = (c: Clip): boolean => !!c.isOffline && !c.isUnlicensed && !c.bufferId && !c.notes;

export function missingClips(tracks: Track[]): MissingClip[] {
  const out: MissingClip[] = [];
  for (const t of tracks) for (const c of t.clips || []) {
    if (isMissingSound(c)) out.push({ trackId: t.id, trackName: t.name, clipId: c.id, clipName: c.name, start: c.start, duration: c.duration });
  }
  return out;
}

/** Nom comparable : sans extension, accents, casse, ni séparateurs (« Prise_03.WAV » = « prise 03 »). */
export function soundKey(name: string): string {
  return String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/\s*\((copie|copy|\d+)\)\s*$/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_\-.]+/g, ' ')
    .trim();
}

/**
 * Fichiers choisis → clips à relier, par le nom (identique, sinon l'un contient l'autre).
 * Un même fichier peut relier plusieurs clips (prise découpée en plusieurs morceaux).
 * Un seul clip manquant et un seul fichier : relié quel que soit le nom.
 */
export function matchFiles(files: { name: string }[], missing: MissingClip[]): Map<string, number> {
  const out = new Map<string, number>();
  const keys = files.map(f => soundKey(f.name));
  for (const m of missing) {
    const k = soundKey(m.clipName);
    if (!k) continue;
    let i = keys.findIndex(fk => fk === k);
    if (i < 0) i = keys.findIndex(fk => fk.length >= 3 && k.length >= 3 && (fk.includes(k) || k.includes(fk)));
    if (i >= 0) out.set(m.clipId, i);
  }
  if (!out.size && missing.length === 1 && files.length === 1) out.set(missing[0].clipId, 0);
  return out;
}

/**
 * Clip relié à un son (identifiant dans le registre, durée du son) : il rejoue, à la même place.
 * Son plus court que le clip : le clip est raccourci (jamais de silence inventé au bout).
 */
export function relinkedClip(c: Clip, bufferId: string, soundSeconds: number): Clip {
  const { isOffline: _o, audioRef: _r, ...rest } = c;
  let offset = c.offset || 0;
  if (offset >= soundSeconds) offset = 0;
  const duration = Math.max(0.01, Math.min(c.duration, soundSeconds - offset));
  return { ...rest, bufferId, offset, duration };
}
