/**
 * Dossiers glissés depuis l'Explorateur (ou le Finder) : un dossier de stems lâché sur les pistes
 * donne ses fichiers, comme dans les autres DAW (une piste par son). Avant, le dossier arrivait comme
 * un « fichier » vide sans type : « 1 fichier ignoré (pas de l'audio…) ».
 *
 * Les entrées du glisser (webkitGetAsEntry) ne sont lisibles QUE pendant l'événement « drop » :
 * `dropEntries` les relève tout de suite, `expandDropped` les parcourt ensuite (asynchrone).
 */

/** Sous-ensemble de l'API FileSystemEntry du navigateur (tests : objets simulés). */
export interface DropEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (ok: (f: File) => void, ko?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (list: DropEntry[]) => void, ko?: (e: unknown) => void) => void };
}

/** Windows ne donne pas toujours de type MIME (.aif, .flac…) : on regarde aussi l'extension. */
const AUDIO_EXT = /\.(wav|wave|mp3|aif|aiff|flac|ogg|oga|opus|m4a|aac|webm|caf)$/i;
export const isAudioFile = (f: { name: string; type?: string }): boolean =>
  (f.type || '').startsWith('audio/') || AUDIO_EXT.test(f.name);

/** Plafonds : un dossier d'échantillons entier lâché par erreur ne crée pas 2 000 pistes. */
export const MAX_DROPPED_FILES = 128;
const MAX_DEPTH = 4;

/** Entrées du glisser, relevées pendant l'événement (null : rien de lisible, garder dataTransfer.files). */
export function dropEntries(dt: DataTransfer | null | undefined): DropEntry[] | null {
  const items = Array.from(dt?.items || []);
  if (!items.length) return null;
  const entries: DropEntry[] = [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const e = (it as any).webkitGetAsEntry?.() as DropEntry | null;
    if (!e) return null;
    entries.push(e);
  }
  return entries.some(e => e.isDirectory) ? entries : null;
}

const fileOf = (e: DropEntry): Promise<File | null> =>
  new Promise(res => { try { e.file!(f => res(f), () => res(null)); } catch { res(null); } });

const readAll = async (e: DropEntry): Promise<DropEntry[]> => {
  const out: DropEntry[] = [];
  let reader: ReturnType<NonNullable<DropEntry['createReader']>>;
  try { reader = e.createReader!(); } catch { return out; }
  // readEntries rend les entrées par paquets (100 dans Chromium) : on relit jusqu'à un paquet vide.
  for (let guard = 0; guard < 100; guard++) {
    const batch = await new Promise<DropEntry[]>(res => { try { reader.readEntries(l => res(l || []), () => res([])); } catch { res([]); } });
    if (!batch.length) break;
    out.push(...batch);
  }
  return out;
};

/** Tri « naturel » (01 Kick, 02 Snare, … 10 Voix) sur le chemin dans le dossier. */
const natural = (a: string, b: string) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' });

/**
 * Fichiers des entrées relevées (dossiers parcourus, sous-dossiers compris, fichiers cachés ignorés),
 * dans l'ordre naturel des chemins. `keep` filtre les fichiers utiles (audio, MIDI…).
 */
export async function expandDropped(entries: DropEntry[], keep: (f: File) => boolean = () => true): Promise<{ files: File[]; truncated: boolean }> {
  const found: { path: string; file: File }[] = [];
  let truncated = false;
  const walk = async (e: DropEntry, depth: number, path: string): Promise<void> => {
    if (found.length >= MAX_DROPPED_FILES) { truncated = true; return; }
    if (e.name.startsWith('.')) return;
    if (e.isFile) {
      const f = await fileOf(e);
      if (f && keep(f)) found.push({ path, file: f });
      return;
    }
    if (!e.isDirectory || depth >= MAX_DEPTH) return;
    const kids = (await readAll(e)).sort((a, b) => natural(a.name, b.name));
    for (const k of kids) await walk(k, depth + 1, `${path}/${k.name}`);
  };
  for (const e of entries) await walk(e, 0, e.name);
  found.sort((a, b) => natural(a.path, b.path));
  return { files: found.map(x => x.file), truncated };
}
