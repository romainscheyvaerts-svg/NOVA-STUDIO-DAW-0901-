/**
 * Lot 5b · « Palette » : 2 à 5 boucles NOVA assorties au projet en cours.
 *
 * Règles (testées sur l'index, tests/loopPalette.test.ts) :
 *  - même tonalité que le projet ou sa relative (La mineur ↔ Do majeur), JAMAIS une autre ;
 *  - BPM d'origine à ±15 % du tempo du projet (ou en half / double time) ;
 *  - une boucle par rôle : batterie, accords, 808 (la 808 suit la MÊME suite que les accords),
 *    puis un instrument ou une perc en plus selon la taille demandée ;
 *  - un dé (graine) pour tirer une autre palette, reproductible.
 * Les boucles étant des notes, elles se jouent ensuite au tempo exact du projet.
 */
import { bpmCompatible, keyCompatible, parseLoopRef, type SoundEntry, type SoundGenre, type SoundKey } from './soundSearch';
import { BEAT_GENRES, genreRecipe, type BeatGenreId } from './beatRecipes';
import { rng } from './patternVary';

export interface PaletteRequest {
  bpm: number;
  /** Tonalité du projet ; absente : celle du genre (tonique par défaut). */
  key?: SoundKey | null;
  genre?: SoundGenre | null;
  /** 2 à 5 boucles. */
  count?: number;
  seed?: number;
}

export interface PaletteResult {
  items: SoundEntry[];
  key: SoundKey;
  genre: BeatGenreId;
  /** Pourquoi la palette est plus courte que demandé (aucune boucle compatible…). */
  note?: string;
}

const pick = <T,>(list: T[], r: () => number): T | undefined => (list.length ? list[Math.floor(r() * list.length) % list.length] : undefined);

/** Genre de la palette : celui demandé, sinon celui dont le tempo colle le mieux au projet. */
export function paletteGenre(bpm: number, genre?: SoundGenre | null): BeatGenreId {
  if (genre && BEAT_GENRES.some(g => g.id === genre)) return genre as BeatGenreId;
  const scored = BEAT_GENRES.map(g => ({ g, d: Math.min(...[bpm, bpm * 2, bpm / 2].map(t => Math.abs(g.bpm - t) / t)) }));
  scored.sort((a, b) => a.d - b.d);
  return scored[0].g.id;
}

export function buildPalette(index: SoundEntry[], req: PaletteRequest): PaletteResult {
  const r = rng((req.seed ?? 1) * 2654435761);
  const count = Math.max(2, Math.min(5, Math.round(req.count ?? 4)));
  const genre = paletteGenre(req.bpm, req.genre);
  const g = genreRecipe(genre);
  const key: SoundKey = req.key && Number.isFinite(req.key.root) ? req.key : { root: g.defaultRoot, scale: g.scale };
  const fits = (e: SoundEntry) => e.kind === 'loop' && (!e.bpm || bpmCompatible(e.bpm, req.bpm)) && (!e.key || keyCompatible(e.key, key));
  const loops = index.filter(fits);
  const ofGenre = (l: SoundEntry[]) => { const f = l.filter(e => e.genres.includes(genre)); return f.length ? f : l; };

  const items: SoundEntry[] = [];
  const drums = pick(ofGenre(loops.filter(e => e.type === 'drums')), r);
  if (drums) items.push(drums);
  const chords = pick(ofGenre(loops.filter(e => e.type === 'chords')), r);
  if (chords) {
    items.push(chords);
    // La 808 qui suit la même suite, dans la même tonalité.
    const c = parseLoopRef(chords.ref);
    const bass = c && c.t === 'chords' ? loops.find(e => { const b = parseLoopRef(e.ref); return !!b && b.t === '808' && b.prog === c.prog && b.root === c.root; }) : undefined;
    if (bass) items.push(bass);
  }
  // Compléments : une autre couche d'accords (autre instrument, même suite) puis une autre batterie.
  if (items.length < count && chords) {
    const c = parseLoopRef(chords.ref);
    const alt = loops.find(e => { const x = parseLoopRef(e.ref); return !!x && !!c && x.t === 'chords' && c.t === 'chords' && x.prog === c.prog && x.root === c.root && x.instrument !== c.instrument; });
    if (alt) items.push(alt);
  }
  // Puis une autre suite d'accords du genre, même tonalité (pour un refrain ou un pont).
  if (items.length < count && chords) {
    const c = parseLoopRef(chords.ref);
    const other = pick(ofGenre(loops.filter(e => { const x = parseLoopRef(e.ref); return e.type === 'chords' && !!x && !!c && x.t === 'chords' && c.t === 'chords' && x.prog !== c.prog; })), r);
    if (other) items.push(other);
  }
  // Toujours au moins 2 : une seconde batterie en dernier recours.
  if (items.length < Math.min(2, count)) {
    const other = pick(ofGenre(loops.filter(e => e.type === 'drums' && !items.includes(e))), r);
    if (other) items.push(other);
  }
  const out = items.slice(0, count);
  return {
    items: out, key, genre,
    ...(out.length < 2 ? { note: 'Pas assez de boucles dans ce tempo et cette tonalité : change de genre ou de tempo.' } : {}),
  };
}
