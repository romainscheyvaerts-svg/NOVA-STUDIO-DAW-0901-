/**
 * Noms des fichiers livrés : « Titre_BPM_Ton_Piste.wav », la convention des
 * studios (l'ingé qui reçoit 40 stems voit tout de suite le tempo et la
 * tonalité). Pas d'accents ni d'espaces : le nom passe partout (zip, mail,
 * Pro Tools, clé USB, Windows comme Mac).
 */
import { keyToId3 } from './audioFormats';

/** Morceau de nom de fichier sûr : accents retirés, espaces → « - », caractères interdits retirés. */
export function safePart(s: string, max = 40): string {
  const t = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[œŒ]/g, 'oe').replace(/[æÆ]/g, 'ae')
    .replace(/[#♯]/g, 'd').replace(/♭/g, 'b')
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return t.slice(0, max).replace(/[-.]+$/g, '');
}

/** Tonalité courte pour un nom de fichier : « Cm », « Fdm » (Fa# mineur) ; '' si inconnue. */
export function keyForFile(root?: number, scale?: string): string {
  const k = keyToId3(root, scale);
  return k ? safePart(k) : '';
}

export interface StemNameParts {
  title: string;
  bpm?: number;
  key?: string;
  part?: string;
  ext: string;
}

/** « Titre_140_Cm_Voix-lead.wav » (les morceaux absents sont sautés). */
export function deliveryFileName(p: StemNameParts): string {
  const bpm = p.bpm && p.bpm > 0 ? String(Math.round(p.bpm * 100) / 100).replace('.', ',') : '';
  const parts = [safePart(p.title) || 'Morceau', bpm ? `${bpm}BPM`.replace(',', '.') : '', p.key || '', p.part ? safePart(p.part, 48) : '']
    .filter(Boolean);
  return `${parts.join('_')}.${p.ext.replace(/^\./, '')}`;
}

/** Noms uniques dans un même zip (« Voix », « Voix-2 »…). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map(n => {
    const k = n.toLowerCase();
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    if (c === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)}-${c}${n.slice(dot)}` : `${n}-${c}`;
  });
}

export const extensionOf = (format: 'WAV' | 'AIFF' | 'FLAC' | 'MP3'): string =>
  format === 'MP3' ? 'mp3' : format === 'FLAC' ? 'flac' : format === 'AIFF' ? 'aif' : 'wav';

/**
 * Noms des fichiers d'un zip de stems, avec la BONNE extension. Avant R1, en MP3,
 * les stems du zip étaient nommés « .wav » (zip.file(`${trackName}.wav`)).
 */
export function stemFileNames(format: 'WAV' | 'AIFF' | 'FLAC' | 'MP3', naming: { title: string; bpm?: number; key?: string }, labels: string[]): string[] {
  const ext = extensionOf(format);
  return uniqueNames(labels.map(part => deliveryFileName({ ...naming, part, ext })));
}
