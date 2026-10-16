/**
 * Lot 5a · Index du navigateur de sons : one-shots (kits NOVA, batterie du studio), instruments
 * NOVA et boucles NOVA (motifs de batterie, suites d'accords et lignes de 808 écrits à partir des
 * recettes de genre du lot 10, joués par les kits et les instruments de NOVA).
 *
 * - Aucun son nouveau : seulement ce qui est déjà servi par NOVA (kits brouillés `.nks`, batterie
 *   du studio, instruments CC0 de `public/instruments`).
 * - Une entrée ne montre JAMAIS d'adresse de fichier : `ref` est une référence interne
 *   (« kit:<id> », « lib:<id> », « inst:<id> », « loop:<…> ») lue seulement par la pré-écoute et la pose.
 * - Les boucles sont des notes (pas de l'audio) : elles se jouent au tempo et dans la tonalité
 *   du projet sans perte ; leur BPM et leur tonalité d'origine servent au tri (Palette, filtres).
 *
 * Données pures (aucun React) : tests/soundSearch.test.ts (recherche en 200 ms au plus sur 5 000 entrées).
 */
import type { KitIndex, KitCategory } from './drumKitLibrary';
import { DRUM_LIBRARY, DRUM_LIBRARY_STYLES, type LibCategory } from './drumLibrary';
import { INSTRUMENT_PRESETS } from './instrumentPresets';
import { BEAT_GENRES, PROGRESSIONS, type BeatGenreId, type BeatScale } from './beatRecipes';
import { NOTE_NAMES_FR } from './scales';

export type SoundKind = 'oneshot' | 'loop' | 'instrument';
/** Types filtrables (puces du navigateur). */
export type SoundType =
  | 'kick' | 'snare' | 'clap' | 'hihat' | 'openhat' | '808' | 'bass' | 'perc' | 'fx' | 'vocal' | 'melodic'
  | 'drums' | 'chords' | 'bassline' | 'instrument';

export const SOUND_TYPES: { id: SoundType; label: string; kind: SoundKind }[] = [
  { id: 'kick', label: 'Kick', kind: 'oneshot' },
  { id: 'snare', label: 'Snare', kind: 'oneshot' },
  { id: 'clap', label: 'Clap / snap', kind: 'oneshot' },
  { id: 'hihat', label: 'Hi-hat', kind: 'oneshot' },
  { id: 'openhat', label: 'Open hat / crash', kind: 'oneshot' },
  { id: '808', label: '808', kind: 'oneshot' },
  { id: 'bass', label: 'Basse', kind: 'oneshot' },
  { id: 'perc', label: 'Perc', kind: 'oneshot' },
  { id: 'fx', label: 'FX / fill', kind: 'oneshot' },
  { id: 'vocal', label: 'Voix', kind: 'oneshot' },
  { id: 'melodic', label: 'Mélodique', kind: 'oneshot' },
  { id: 'drums', label: 'Boucle batterie', kind: 'loop' },
  { id: 'chords', label: 'Boucle accords', kind: 'loop' },
  { id: 'bassline', label: 'Boucle 808', kind: 'loop' },
  { id: 'instrument', label: 'Instrument', kind: 'instrument' },
];

/** Genres du navigateur (mêmes ids que les recettes du lot 10, plus « pop »). */
export type SoundGenre = BeatGenreId | 'pop';
export const SOUND_GENRES: { id: SoundGenre; label: string }[] = [
  ...BEAT_GENRES.map(g => ({ id: g.id as SoundGenre, label: g.name })),
  { id: 'pop', label: 'Pop' },
];

export interface SoundKey { root: number; scale: BeatScale }

export interface SoundEntry {
  /** Identifiant stable (favoris). */
  id: string;
  kind: SoundKind;
  type: SoundType;
  /** Nom affiché, générique (« Kick 12 », « Trap · Batterie A », « Accords Trap · La mineur »). */
  name: string;
  /** Détail affiché sous le nom (durée, note, progression…). */
  detail: string;
  genres: SoundGenre[];
  /** BPM d'origine (boucles). */
  bpm?: number;
  /** Tonalité d'origine (boucles d'accords et de 808). */
  key?: SoundKey;
  /** Note MIDI de la fondamentale (808 et basses des kits). */
  midi?: number;
  /** Durée (s) des one-shots. */
  dur?: number;
  /** Référence interne (jamais affichée). */
  ref: string;
  /** Texte de recherche, déjà replié (minuscules, sans accents). */
  hay: string;
}

export const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const MINOR_FAMILY: ReadonlySet<BeatScale> = new Set(['MINOR', 'MINOR_HARMONIC', 'PHRYGIAN', 'DORIAN']);
export const isMinorScale = (s: string | undefined) => MINOR_FAMILY.has((s || '') as BeatScale);
export const keyLabel = (k: SoundKey) => `${NOTE_NAMES_FR[((k.root % 12) + 12) % 12]} ${isMinorScale(k.scale) ? 'mineur' : 'majeur'}`;

// ── One-shots des kits NOVA ───────────────────────────────────────────────────────────────
const KIT_TYPE: Record<KitCategory, SoundType> = {
  kick: 'kick', snare: 'snare', clap: 'clap', snap: 'clap', rim: 'perc', hihat: 'hihat', openhat: 'openhat', roll: 'hihat',
  crash: 'openhat', tom: 'perc', perc: 'perc', shaker: 'perc', '808': '808', bass: 'bass', fill: 'fx', vocal: 'vocal',
  oneshot: 'melodic', bongo: 'perc', conga: 'perc', djembe: 'perc', dundun: 'perc', balafon: 'melodic', kalimba: 'melodic',
  marimba: 'melodic', udu: 'perc',
};
/** Styles des kits → genres du navigateur. */
const KIT_STYLE_GENRES: Record<string, SoundGenre[]> = {
  trap: ['trap'], drill: ['drill-uk', 'drill-fr'], afro: ['afro'], detroit: ['trap'], boombap: ['boombap'], pop: ['pop', 'rnb'], acoustique: ['rnb', 'pop'],
};
const LIB_TYPE: Record<LibCategory, SoundType> = { kick: 'kick', snare: 'snare', clap: 'clap', hatc: 'hihat', hato: 'openhat', rim: 'perc', cymbal: 'openhat' };
const LIB_LABEL: Record<LibCategory, string> = { kick: 'Kick', snare: 'Snare', clap: 'Clap', hatc: 'Hi-hat', hato: 'Open hat', rim: 'Rim', cymbal: 'Cymbale' };
const LIB_STYLE_GENRES: Record<string, SoundGenre[]> = {
  afro: ['afro'], boombap: ['boombap'], drill: ['drill-uk', 'drill-fr'], rnb: ['rnb'], soul: ['rnb', 'boombap'], trap: ['trap'], pop: ['pop'], reggaeton: ['afro'],
};

const fmtDur = (d: number) => `${d < 1 ? d.toFixed(2) : d.toFixed(1)} s`.replace('.', ',');
const NOTE_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteOf = (m: number) => `${NOTE_EN[m % 12]}${Math.floor(m / 12) - 1}`;

function hayOf(e: Omit<SoundEntry, 'hay'>, extra = ''): string {
  const t = SOUND_TYPES.find(x => x.id === e.type)?.label || '';
  const g = e.genres.map(id => SOUND_GENRES.find(x => x.id === id)?.label || id).join(' ');
  const k = e.key ? keyLabel(e.key) : '';
  const m = e.midi ? `${noteOf(e.midi)} ${NOTE_NAMES_FR[e.midi % 12]}` : '';
  return fold(`${e.name} ${e.detail} ${t} ${e.type} ${g} ${k} ${m} ${e.kind === 'loop' ? 'boucle loop' : e.kind === 'instrument' ? 'instrument' : 'one shot oneshot'} ${extra}`);
}
const entry = (e: Omit<SoundEntry, 'hay'>, extra = ''): SoundEntry => ({ ...e, hay: hayOf(e, extra) });

export function kitEntries(ix: KitIndex | null): SoundEntry[] {
  if (!ix) return [];
  return ix.sounds.map(s => {
    const genres = [...new Set(s.styles.flatMap(st => KIT_STYLE_GENRES[st] || []))];
    const detail = `${fmtDur(s.dur)}${s.midi ? ` · ${noteOf(s.midi)}` : ''} · kit NOVA`;
    return entry({ id: `kit:${s.id}`, kind: 'oneshot', type: KIT_TYPE[s.cat] || 'perc', name: s.name, detail, genres, dur: s.dur, ...(s.midi ? { midi: s.midi } : {}), ref: `kit:${s.id}` },
      ix.categories.find(c => c.id === s.cat)?.label || '');
  });
}

/** Batterie du studio (utils/drumLibrary) : « Kick 3 · Trap ». */
export function studioEntries(): SoundEntry[] {
  const out: SoundEntry[] = [];
  const seen = new Set<string>();
  for (const [style, cats] of Object.entries(DRUM_LIBRARY)) {
    for (const [cat, ids] of Object.entries(cats) as [LibCategory, string[]][]) {
      ids.forEach((id, i) => {
        if (seen.has(id)) return;
        seen.add(id);
        const styles = Object.entries(DRUM_LIBRARY).filter(([, c]) => Object.values(c).some(list => (list as string[]).includes(id))).map(([s]) => s);
        out.push(entry({
          id: `lib:${id}`, kind: 'oneshot', type: LIB_TYPE[cat], name: `${LIB_LABEL[cat]} ${i + 1} · ${DRUM_LIBRARY_STYLES[style] || style}`,
          detail: 'batterie du studio', genres: [...new Set(styles.flatMap(s => LIB_STYLE_GENRES[s] || []))], ref: `lib:${id}`,
        }, 'studio make music'));
      });
    }
  }
  return out;
}

/** Instruments NOVA (piano, Rhodes, guitare, cordes, cloches, nappe). */
export function instrumentEntries(): SoundEntry[] {
  return INSTRUMENT_PRESETS.map(p => entry({
    id: `inst:${p.id}`, kind: 'instrument', type: 'instrument', name: `${p.emoji} ${p.name}`, detail: p.hint,
    genres: BEAT_GENRES.filter(g => g.instruments.includes(p.id)).map(g => g.id), ref: `inst:${p.id}`,
  }, p.category));
}

// ── Boucles NOVA (recettes du lot 10) ─────────────────────────────────────────────────────
/** Référence d'une boucle : « loop:drums:<genre>:<variante> », « loop:chords:<progression>:<tonique>:<instrument> », « loop:808:<progression>:<tonique> ». */
export type LoopRef =
  | { t: 'drums'; genre: BeatGenreId; variant: number }
  | { t: 'chords'; prog: string; root: number; instrument: string }
  | { t: '808'; prog: string; root: number };

export function parseLoopRef(ref: string): LoopRef | null {
  const p = ref.split(':');
  if (p[0] !== 'loop') return null;
  if (p[1] === 'drums' && p.length === 4) return { t: 'drums', genre: p[2] as BeatGenreId, variant: Number(p[3]) || 0 };
  if (p[1] === 'chords' && p.length === 5) return { t: 'chords', prog: p[2], root: Number(p[3]) || 0, instrument: p[4] };
  if (p[1] === '808' && p.length === 4) return { t: '808', prog: p[2], root: Number(p[3]) || 0 };
  return null;
}

export function loopEntries(): SoundEntry[] {
  const out: SoundEntry[] = [];
  for (const g of BEAT_GENRES) {
    g.drums.forEach((d, v) => out.push(entry({
      id: `loop:drums:${g.id}:${v}`, kind: 'loop', type: 'drums', name: `${g.name} · Batterie ${String.fromCharCode(65 + v)}`,
      detail: `${d.bars} mesure${d.bars > 1 ? 's' : ''} · ${d.name}`, genres: [g.id], bpm: g.bpm, ref: `loop:drums:${g.id}:${v}`,
    }, 'drums beat rythme')));
  }
  for (const p of PROGRESSIONS) {
    const g = BEAT_GENRES.find(x => x.id === p.genre);
    if (!g) continue;
    for (let root = 0; root < 12; root++) {
      const key: SoundKey = { root, scale: p.scale };
      for (const inst of g.instruments.slice(0, 2)) {
        const iname = INSTRUMENT_PRESETS.find(x => x.id === inst)?.name || inst;
        out.push(entry({
          id: `loop:chords:${p.id}:${root}:${inst}`, kind: 'loop', type: 'chords', name: `Accords ${g.name} · ${keyLabel(key)}`,
          detail: `${p.roman} · ${iname}`, genres: [g.id], bpm: g.bpm, key, ref: `loop:chords:${p.id}:${root}:${inst}`,
        }, `${p.name} accords chords progression ${iname}`));
      }
      out.push(entry({
        id: `loop:808:${p.id}:${root}`, kind: 'loop', type: 'bassline', name: `808 ${g.name} · ${keyLabel(key)}`,
        detail: `suit ${p.roman}`, genres: [g.id], bpm: g.bpm, key, ref: `loop:808:${p.id}:${root}`,
      }, `${p.name} basse bass 808`));
    }
  }
  return out;
}

/** Index complet (les one-shots des kits seulement si leur index est chargé). */
export function buildSoundIndex(ix: KitIndex | null): SoundEntry[] {
  return [...loopEntries(), ...instrumentEntries(), ...kitEntries(ix), ...studioEntries()];
}

// ── Recherche ─────────────────────────────────────────────────────────────────────────────
export interface SoundQuery {
  text?: string;
  kind?: SoundKind | '';
  type?: SoundType | '';
  genre?: SoundGenre | '';
  /** BPM visé : boucles dont le BPM est à ±tol (défaut 15 %), ou au double / à la moitié (half-time). */
  bpm?: number | null;
  bpmTol?: number;
  /** Tonalité visée : boucles dans la même tonalité ou sa relative. */
  key?: SoundKey | null;
  favs?: Set<string> | null;
}

/** Même tonalité, ou relative (La mineur ↔ Do majeur). */
export function keyCompatible(a: SoundKey, b: SoundKey): boolean {
  const ra = ((a.root % 12) + 12) % 12, rb = ((b.root % 12) + 12) % 12;
  const ma = isMinorScale(a.scale), mb = isMinorScale(b.scale);
  if (ma === mb) return ra === rb;
  // Relative : la tonique mineure est 3 demi-tons sous la majeure.
  return ma ? (ra + 3) % 12 === rb : (rb + 3) % 12 === ra;
}

/** Le BPM d'une boucle colle-t-il au tempo visé (±tol, ou en half / double time) ? */
export function bpmCompatible(loopBpm: number, target: number, tol = 0.15): boolean {
  if (!(loopBpm > 0) || !(target > 0)) return true;
  return [target, target * 2, target / 2].some(t => Math.abs(loopBpm - t) / t <= tol + 1e-9);
}

export function searchSounds(index: SoundEntry[], q: SoundQuery): SoundEntry[] {
  const words = fold(q.text || '').split(/\s+/).filter(Boolean);
  const tol = q.bpmTol ?? 0.15;
  const out: SoundEntry[] = [];
  for (const e of index) {
    if (q.kind && e.kind !== q.kind) continue;
    if (q.type && e.type !== q.type) continue;
    if (q.genre && !e.genres.includes(q.genre)) continue;
    if (q.favs && !q.favs.has(e.id)) continue;
    // BPM et tonalité : ne trient que les boucles (un one-shot va à tous les tempos, une 808 est réaccordée).
    if (e.kind === 'loop' && q.bpm && e.bpm && !bpmCompatible(e.bpm, q.bpm, tol)) continue;
    if (e.kind === 'loop' && q.key && e.key && !keyCompatible(e.key, q.key)) continue;
    if (words.length && !words.every(w => (/^\d+$/.test(w) ? (` ${e.hay} `).includes(` ${w} `) : e.hay.includes(w)))) continue;
    out.push(e);
  }
  return out;
}

// ── Favoris (par appareil) ────────────────────────────────────────────────────────────────
const FAV_KEY = 'nova_sound_favs';
export function soundFavorites(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
}
export function toggleSoundFavorite(id: string): Set<string> {
  const s = soundFavorites();
  if (s.has(id)) s.delete(id); else s.add(id);
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch { /* stockage plein ou bloqué */ }
  return s;
}
