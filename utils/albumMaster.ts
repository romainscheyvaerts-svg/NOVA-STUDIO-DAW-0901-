/**
 * Mastering d'un EP / d'un album (écart 22 du comparatif du 21/10/2026) : règles pures, sans DOM.
 * Tests : tests/albumMaster.test.ts.
 *
 * Chaque titre est masterisé par le moteur du « Master express » (utils/quickMaster.ts, dans son
 * Worker) avec le MÊME style, la même intensité et la même cible : les titres sortent au même
 * niveau (écart de LUFS intégré ≤ 0,5 LU visé). Un titre peut être volontairement plus doux
 * (interlude) : décalage relatif de sa cible.
 *
 * Enchaînements : blanc après chaque titre (exact à l'échantillon) ou fondu enchaîné avec le
 * suivant (puissance constante). L'album est assemblé d'un seul tenant, puis coupé aux débuts de
 * titre : chaque fichier va de son début au début du suivant (lecture sans blanc ajouté, comme un CD).
 * Livraison : un WAV 24 bits par titre (sans métadonnée intégrée, règle des distributeurs déjà
 * suivie par utils/distributionPackage.ts), feuille de minutage .cue (avec les ISRC) et fiche
 * metadonnees_album.json ; l'album d'un seul tenant en option.
 */
import { isValidIsrc, normalizeIsrc } from './distributionCheck';

export interface AlbumTitleSpec {
  name: string;
  isrc: string;
  /** Blanc après le titre (s), ignoré s'il y a un fondu enchaîné. */
  gapAfter: number;
  /** Fondu enchaîné avec le titre suivant (s) ; 0 = pas de fondu. */
  xfadeNext: number;
  /** Niveau relatif visé (dB, ≤ 0 pour un interlude plus doux). */
  offsetDb: number;
}

export const ALBUM_MAX_TITLES = 20;
export const DEFAULT_GAP = 2;
export const GAP_CHOICES = [0, 0.5, 1, 2, 3, 4];
export const XFADE_CHOICES = [0, 1, 2, 4, 6];
export const OFFSET_CHOICES = [0, -1, -2, -3, -4, -6];
/** Écart maximal visé entre titres au même niveau (LU). */
export const ALBUM_SPREAD_MAX = 0.5;

export const titleSpec = (name: string): AlbumTitleSpec => ({ name: cleanTitle(name), isrc: '', gapAfter: DEFAULT_GAP, xfadeNext: 0, offsetDb: 0 });

/** Nom de titre propre depuis un nom de fichier (« 03_Mon son (mix final).wav » → « Mon son (mix final) »). */
export function cleanTitle(file: string): string {
  return (file || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/^\s*\d{1,2}\s*[-_.)]\s*/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Sans titre';
}

/** ISRC : vide (le distributeur en attribue) ou valide ; renvoie l'ISRC normalisé, '' ou null si invalide. */
export function isrcOf(s: string): string | null {
  const t = (s || '').trim();
  if (!t) return '';
  return isValidIsrc(t) ? normalizeIsrc(t) : null;
}

/** ISRC en double dans l'album (chaque titre a le sien). */
export function duplicateIsrcs(specs: AlbumTitleSpec[]): string[] {
  const seen = new Map<string, number>();
  for (const s of specs) { const v = isrcOf(s.isrc); if (v) seen.set(v, (seen.get(v) || 0) + 1); }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

export interface AssembledAlbum {
  ch: Float32Array[];
  /** Début de chaque titre (échantillons) dans l'album. */
  starts: number[];
  /** Fin de l'audio de chaque titre (échantillons). */
  ends: number[];
  length: number;
}

/** Placement des titres (échantillons), sans rien calculer d'audio. */
export function albumLayout(lengths: number[], specs: AlbumTitleSpec[], sampleRate: number): { starts: number[]; ends: number[]; xf: number[]; length: number } {
  const starts: number[] = [], ends: number[] = [], xf: number[] = [];
  let pos = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (i > 0) {
      const prev = specs[i - 1] || titleSpec('');
      // Fondu borné à la moitié de chaque titre : jamais un fondu d'entrée sur un fondu de sortie.
      const x = Math.min(Math.round(Math.max(0, prev.xfadeNext) * sampleRate), Math.floor(lengths[i - 1] / 2), Math.floor(lengths[i] / 2));
      xf[i - 1] = x;
      pos = x > 0 ? ends[i - 1] - x : ends[i - 1] + Math.round(Math.max(0, prev.gapAfter) * sampleRate);
    }
    starts.push(pos);
    ends.push(pos + lengths[i]);
  }
  if (lengths.length) xf[lengths.length - 1] = 0;
  return { starts, ends, xf, length: ends.length ? ends[ends.length - 1] : 0 };
}

/**
 * Album d'un seul tenant (stéréo). Blancs exacts à l'échantillon ; fondu enchaîné à puissance
 * constante (cos / sin) sur la zone commune. Hors fondu, chaque échantillon est celui du titre.
 */
export function assembleAlbum(titles: Float32Array[][], specs: AlbumTitleSpec[], sampleRate: number): AssembledAlbum {
  const lengths = titles.map(t => t[0]?.length || 0);
  const lay = albumLayout(lengths, specs, sampleRate);
  const out = [new Float32Array(lay.length), new Float32Array(lay.length)];
  titles.forEach((t, i) => {
    const s = lay.starts[i], n = lengths[i];
    const fin = i > 0 ? lay.xf[i - 1] : 0;      // fondu d'entrée (zone commune avec le précédent)
    const fout = lay.xf[i] || 0;                 // fondu de sortie (zone commune avec le suivant)
    for (let c = 0; c < 2; c++) {
      const x = t[c] || t[0], o = out[c];
      for (let k = 0; k < n; k++) {
        // Hors fondu : l'échantillon du titre, tel quel (aucun autre titre à cet endroit).
        if (k >= fin && k < n - fout) { o[s + k] = x[k]; continue; }
        const g = k < fin ? Math.sin((Math.PI / 2) * ((k + 0.5) / fin)) : Math.cos((Math.PI / 2) * ((k - (n - fout) + 0.5) / fout));
        o[s + k] += g * x[k];
      }
    }
  });
  return { ch: out, starts: lay.starts, ends: lay.ends, length: lay.length };
}

/** Coupe l'album aux débuts de titre : fichier i = [début i, début i+1), le dernier jusqu'à la fin. */
export function splitAlbum(album: AssembledAlbum): Float32Array[][] {
  return album.starts.map((s, i) => {
    const e = i + 1 < album.starts.length ? album.starts[i + 1] : album.length;
    return album.ch.map(c => c.slice(s, e));
  });
}

/**
 * Fichier du titre i SANS assembler tout l'album (mémoire) : identique, au bit près, à
 * `splitAlbum(assembleAlbum(...))[i]`. Il ne faut que la fin du titre précédent (zone de fondu).
 */
export function albumTitleFile(i: number, titles: Float32Array[][], specs: AlbumTitleSpec[], sampleRate: number): Float32Array[] {
  const lengths = titles.map(t => t[0]?.length || 0);
  const lay = albumLayout(lengths, specs, sampleRate);
  const start = lay.starts[i], end = i + 1 < lay.starts.length ? lay.starts[i + 1] : lay.length;
  const fin = i > 0 ? lay.xf[i - 1] : 0;
  // Fenêtre locale : titre précédent (pour sa zone de fondu) + titre i. Le fondu de sortie du
  // titre i tombe après la fin du fichier (il est dans le fichier suivant).
  const win: Float32Array[][] = [];
  const wspecs: AlbumTitleSpec[] = [];
  if (fin > 0) { win.push(titles[i - 1]); wspecs.push(specs[i - 1]); }
  win.push(titles[i]); wspecs.push({ ...specs[i], xfadeNext: 0, gapAfter: 0 });
  const local = assembleAlbum(win, wspecs, sampleRate);
  const off = local.starts[fin > 0 ? 1 : 0];
  // Le blanc après le titre (zéros) complète le fichier jusqu'au début du suivant.
  return local.ch.map(c => { const o = new Float32Array(end - start); o.set(c.subarray(off, Math.min(c.length, off + (end - start)))); return o; });
}

/** Temps d'une feuille .cue (mm:ss:ff, 75 trames par seconde). */
export function cueTime(samples: number, sampleRate: number): string {
  const frames = Math.floor((samples / sampleRate) * 75 + 1e-9);
  const m = Math.floor(frames / (75 * 60)), s = Math.floor(frames / 75) % 60, f = frames % 75;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

const cueText = (s: string) => (s || '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();

/** Feuille de minutage de l'album d'un seul tenant (TITLE, PERFORMER, ISRC, INDEX 01 par titre). */
export function albumCue(o: { album: string; artist: string; file: string; specs: AlbumTitleSpec[]; starts: number[]; sampleRate: number }): string {
  const L = [`PERFORMER "${cueText(o.artist)}"`, `TITLE "${cueText(o.album)}"`, `FILE "${cueText(o.file)}" WAVE`];
  o.specs.forEach((sp, i) => {
    L.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${cueText(sp.name)}"`, `    PERFORMER "${cueText(o.artist)}"`);
    const isrc = isrcOf(sp.isrc);
    if (isrc) L.push(`    ISRC ${isrc}`);
    L.push(`    INDEX 01 ${cueTime(o.starts[i] || 0, o.sampleRate)}`);
  });
  return L.join('\r\n') + '\r\n';
}

/** Nom de fichier propre (« 01 - Mon son.wav »). */
export function titleFileName(i: number, name: string, ext = 'wav'): string {
  const base = (name || 'Sans titre').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Sans titre';
  return `${String(i + 1).padStart(2, '0')} - ${base}.${ext}`;
}

/** Écart de loudness entre titres au même niveau visé (LU) : décalages relatifs retirés. */
export function lufsSpread(lufs: number[], offsets: number[] = []): number {
  const v = lufs.map((x, i) => x - (offsets[i] || 0)).filter(Number.isFinite);
  return v.length > 1 ? Math.max(...v) - Math.min(...v) : 0;
}

export interface AlbumTitleResult { lufs: number; truePeak: number; duration: number }

/** Fiche de l'album (metadonnees_album.json) : ordre, minutage, ISRC, mesures. */
export function albumManifest(o: { album: string; artist: string; specs: AlbumTitleSpec[]; results: AlbumTitleResult[]; starts: number[]; sampleRate: number; target: { label: string; lufs: number; ceiling: number }; files: string[] }) {
  const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
  return {
    format: 'nova-album/1',
    album: o.album.trim(), artiste: o.artist.trim(),
    cible: { plateforme: o.target.label, lufs: o.target.lufs, crete_dbtp: o.target.ceiling },
    frequence_hz: o.sampleRate, bits: 24,
    ecart_lufs_entre_titres: r1(lufsSpread(o.results.map(r => r.lufs), o.specs.map(s => s.offsetDb))),
    titres: o.specs.map((s, i) => ({
      numero: i + 1, titre: s.name, isrc: isrcOf(s.isrc) || null, fichier: o.files[i] || null,
      debut_s: Math.round(((o.starts[i] || 0) / o.sampleRate) * 1000) / 1000,
      duree_s: Math.round((o.results[i]?.duration || 0) * 1000) / 1000,
      lufs: r1(o.results[i]?.lufs ?? NaN), crete_vraie_dbtp: r1(o.results[i]?.truePeak ?? NaN),
      niveau_relatif_db: s.offsetDb, blanc_apres_s: s.xfadeNext > 0 ? 0 : s.gapAfter, fondu_enchaine_s: s.xfadeNext,
    })),
    logiciel: 'NOVA Studio',
  };
}

/** Début des échantillons d'un WAV (après « data » et sa taille) ; -1 si introuvable. */
export function wavDataOffset(wav: Uint8Array): number {
  let p = 12;
  while (p + 8 <= wav.length) {
    const id = String.fromCharCode(wav[p], wav[p + 1], wav[p + 2], wav[p + 3]);
    const size = wav[p + 4] | (wav[p + 5] << 8) | (wav[p + 6] << 16) | (wav[p + 7] << 24) >>> 0;
    if (id === 'data') return p + 8;
    p += 8 + size + (size & 1);
  }
  return -1;
}

/**
 * Album d'un seul tenant à partir des WAV des titres (mêmes format et fréquence) : un en-tête,
 * puis les échantillons de chaque fichier, sans rien recalculer (morceaux d'un Blob : pas de copie).
 */
export function concatWavParts(parts: Uint8Array[]): Uint8Array[] {
  if (!parts.length) return [];
  const offs = parts.map(wavDataOffset);
  if (offs.some(o => o < 0)) throw new Error('WAV illisible');
  const sizes = parts.map((p, i) => p.length - offs[i]);
  const data = sizes.reduce((s, x) => s + x, 0);
  const header = parts[0].slice(0, offs[0]);
  const dv = new DataView(header.buffer);
  dv.setUint32(offs[0] - 4, data, true);
  dv.setUint32(4, header.length - 8 + data + (data & 1), true);
  const out = [header, ...parts.map((p, i) => p.subarray(offs[i]))];
  if (data & 1) out.push(new Uint8Array(1));
  return out;
}

/** Déplace un titre (ordre de l'album). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}
