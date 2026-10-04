/**
 * Tonalité du catalogue en français, pour l'affichage.
 *
 * Le catalogue mélange les écritures (« F# minor », « B MIN », « Bb min »,
 * « C # minor », « B HAMONIC minor ») et les cartes les affichaient telles
 * quelles, en anglais : « Fa# mineur » parle davantage à un débutant.
 * Une écriture illisible est rendue telle quelle.
 */
const NOTES = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];

export function tonaliteFr(brut?: string | null): string {
  if (!brut) return '';
  const texte = String(brut).trim().toUpperCase().replace(/\s+/g, ' ');
  const m = texte.match(/^([A-G])\s*(#|B|♭)?/);
  if (!m) return String(brut).trim();
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let root = base[m[1]];
  if (m[2] === '#') root = (root + 1) % 12;
  else if (m[2] === 'B' || m[2] === '♭') root = (root + 11) % 12;
  const reste = texte.slice(m[0].length);
  let gamme = 'mineur'; // le catalogue est massivement en mineur
  if (/HARMONIC|HAMONIC/.test(reste)) gamme = 'mineur harmonique';
  else if (/\bMIN\b|MINOR|^\s*M\b/.test(reste)) gamme = 'mineur';
  else if (/PENTA/.test(reste)) gamme = 'pentatonique';
  else if (/MAJ/.test(reste)) gamme = 'majeur';
  return `${NOTES[root]} ${gamme}`;
}
