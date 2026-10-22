/**
 * L3 · Écart 16 — Musiciens de séance : un batteur, un bassiste (808 ou basse)
 * et des claviers qui jouent TOUT SEULS en suivant la piste d'accords et la
 * grille du morceau (comme les Session Players de Logic, sans IA).
 *
 * Principe (aucune IA, aucun audio généré) :
 *  - une « région musicien » est un clip MIDI ordinaire qui porte ses réglages
 *    (`Clip.seance`) : style (trap, drill UK / FR, boom bap, R&B, afro), motif,
 *    intensité, complexité, remplissages. Une région par section : chaque
 *    section a donc ses propres réglages ;
 *  - ses notes sont CALCULÉES à partir des recettes de genre sourcées
 *    (utils/beatRecipes.ts, sources dans CONTENU/nova-151/sons-beat/RECETTES_BEAT.md
 *    et CONTENU/nova-pro-2026/seance/RECETTES.md), des accords et de la carte
 *    des tempos (changements et rampes) ; elles sont rangées dans `clip.notes`.
 *    La lecture, l'export, le rendu d'un VST, la sauvegarde .zip et la
 *    collaboration (opération « content ») lisent donc exactement les mêmes
 *    notes, sans rien changer au moteur ; une ancienne version de NOVA joue
 *    simplement les notes ;
 *  - dès qu'une entrée change (accords, tempo, réglage, position du clip), les
 *    notes sont recalculées dans la MÊME mise à jour (`refreshSessionPlayers`,
 *    appelé par App.setState : une seule étape d'annulation, opérations reçues
 *    comprises). Le calcul est déterministe (mêmes entrées = mêmes notes, mêmes
 *    identifiants) : tous les membres d'une collaboration obtiennent le même
 *    résultat ;
 *  - retoucher les notes à la main (piano roll, quantifier, varier…) fige la
 *    région : les retouches sont gardées, jamais écrasées ;
 *  - « Figer en notes MIDI » retire seulement les réglages : les notes restent
 *    EXACTEMENT celles qu'on entendait.
 *
 * Module pur (aucun React, aucun moteur) : tests/sessionPlayer.test.ts.
 */
import { TrackType, type Clip, type DAWState, type MidiNote, type Track } from '../types';
import { QUALITY_INTERVALS, chordAt, chordTones, type ChordEvent } from './chordDetect';
import { BEAT_GENRES, genreFromText, genreRecipe, type BeatGenreId, type DrumLine } from './beatRecipes';
import { kitForGenre, parseHits, voiceChord } from './beatStarter';
import { rowStepsPerBar, sectionsFromMarkers, type StepRate } from './drumPatterns';
import { makeDrumMachine, drumPadsFor, type DrumMachine, type DrumRow } from './drumKits';
import { applyKitDef, type KitIndex } from './drumKitLibrary';
import { DEFAULT_SAMPLER, normalizeSampler } from './melodicSampler';
import { settingsForInstrument } from './instrumentPresets';
import { presetSettings } from './novaSynthPresets';
import { scaleIntervals } from './scales';
import {
  barToTime, buildTempoMap, quartersPerBar, quartersToTime, segmentAtBar, timeToPosition, timeToQuarters, type TempoMap,
} from './tempoMap';

// ─── Réglages ───────────────────────────────────────────────────────────────────────────

export type SeanceRole = 'drums' | 'bass' | 'keys';

export interface SeanceSettings {
  role: SeanceRole;
  /** Genre (recettes de « Démarrer un beat »). */
  style: BeatGenreId;
  /** Motif de la recette du genre (0, 1, 2 : A, B, C). */
  pattern: number;
  /** 1 (doux) … 10 (fort) : force des coups ; à 7 et plus, crash au début de la région. */
  intensity: number;
  /** 1 (simple) … 10 (chargé) : densité de notes, croissante (5 = la recette publiée). */
  complexity: number;
  /** 0 (aucun) … 10 : remplissages (fills) en fin de phrase et en fin de région. */
  fills: number;
  /** Swing (0 … 0,6, échelle de la boîte à rythmes). Absent : celui de la recette. */
  swing?: number;
  /** Section du morceau (nom du repère), pour l'affichage. */
  section?: string;
  /** Empreinte des entrées qui ont donné les notes actuelles. */
  sig?: string;
  /** Empreinte des notes générées (reconnaître une retouche à la main). */
  nsig?: string;
  /** Position de la région à la génération (noires depuis le début du morceau). */
  q0?: number;
  q1?: number;
}

/** Version des règles : la changer régénère les régions (jamais celles qu'on a figées). */
export const SEANCE_RULES_VERSION = 1;

export const SEANCE_ROLES: { id: SeanceRole; label: string; emoji: string; track: string; hint: string }[] = [
  { id: 'drums', label: 'Batteur', emoji: '🥁', track: 'BATTEUR', hint: 'Joue la batterie du style choisi sur la grille du morceau, avec remplissages en fin de phrase.' },
  { id: 'bass', label: 'Bassiste', emoji: '🎸', track: 'BASSE', hint: 'Joue la fondamentale de chaque accord (808 en trap et en drill), au rythme du style.' },
  { id: 'keys', label: 'Claviers', emoji: '🎹', track: 'CLAVIERS', hint: 'Plaque les accords de la piste d’accords, voix au plus près, au rythme du style.' },
];
export const roleInfo = (r: SeanceRole) => SEANCE_ROLES.find(x => x.id === r) || SEANCE_ROLES[0];

export const SEANCE_STYLES = BEAT_GENRES.map(g => ({ id: g.id, name: g.name, emoji: g.emoji, hint: g.hint }));

const clampInt = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;

/** Réglages valides (reçus d'un collaborateur, lus dans un projet), null s'ils sont inutilisables. */
export function sanitizeSeance(raw: unknown): SeanceSettings | null {
  const r = raw as Partial<SeanceSettings> | null;
  if (!r || typeof r !== 'object') return null;
  if (r.role !== 'drums' && r.role !== 'bass' && r.role !== 'keys') return null;
  const style = BEAT_GENRES.some(g => g.id === r.style) ? (r.style as BeatGenreId) : 'trap';
  const out: SeanceSettings = {
    role: r.role, style,
    pattern: clampInt(r.pattern, 0, 2, 0),
    intensity: clampInt(r.intensity, 1, 10, 6),
    complexity: clampInt(r.complexity, 1, 10, 5),
    fills: clampInt(r.fills, 0, 10, 5),
  };
  if (typeof r.swing === 'number' && Number.isFinite(r.swing)) out.swing = Math.max(0, Math.min(0.6, r.swing));
  if (typeof r.section === 'string' && r.section) out.section = r.section.slice(0, 40);
  if (typeof r.sig === 'string') out.sig = r.sig.slice(0, 40);
  if (typeof r.nsig === 'string') out.nsig = r.nsig.slice(0, 40);
  if (typeof r.q0 === 'number' && Number.isFinite(r.q0)) out.q0 = r.q0;
  if (typeof r.q1 === 'number' && Number.isFinite(r.q1)) out.q1 = r.q1;
  return out;
}

/** Nom affiché de la région (« Batteur · Trap · Refrain »). */
export function seanceClipName(s: Pick<SeanceSettings, 'role' | 'style' | 'section'>): string {
  return [roleInfo(s.role).label, genreRecipe(s.style).name, s.section].filter(Boolean).join(' · ');
}

// ─── Contexte : tempo, accords, tonalité ────────────────────────────────────────────────

export interface SeanceContext {
  map: TempoMap;
  chords: ChordEvent[];
  /** Tonalité du projet (null : inconnue, la gamme est alors déduite des accords). */
  key: { root: number; scale: string } | null;
}

type CtxState = Pick<DAWState, 'bpm' | 'timeSignature' | 'tempoEvents' | 'chords' | 'projectKey' | 'projectScale'>;

export function seanceContext(st: CtxState): SeanceContext {
  const k = st.projectKey;
  const sc = (st.projectScale || '').toUpperCase();
  return {
    map: buildTempoMap(st.bpm, st.timeSignature, st.tempoEvents),
    chords: [...(st.chords || [])].sort((a, b) => a.start - b.start),
    key: typeof k === 'number' && Number.isFinite(k) && sc && sc !== 'CHROMATIC' ? { root: ((Math.round(k) % 12) + 12) % 12, scale: sc } : null,
  };
}

const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;
const EPS = 1e-9;

/** Classes de notes de la gamme : celle du projet, sinon les notes de tous les accords (tonalité déduite). */
export function seanceScale(ctx: SeanceContext): Set<number> {
  if (ctx.key) return new Set(scaleIntervals(ctx.key.scale).map(i => pc(ctx.key!.root + i)));
  const s = new Set<number>();
  for (const c of ctx.chords) chordTones(c.root, c.quality).forEach(x => s.add(x));
  return s;
}

/** Notes permises à l'instant t (s) : gamme ∪ accord en cours. */
export function allowedAt(ctx: SeanceContext, t: number, scale = seanceScale(ctx)): Set<number> {
  const out = new Set(scale);
  const c = chordAt(ctx.chords, t + 1e-6);
  if (c) chordTones(c.root, c.quality).forEach(x => out.add(x));
  return out;
}

/** Mesures dont l'étendue touche [t0, t1[ : numéro, début en noires, noires par mesure. */
function regionBars(map: TempoMap, t0: number, t1: number): { bar: number; q: number; qpb: number }[] {
  const out: { bar: number; q: number; qpb: number }[] = [];
  let bar = timeToPosition(map, Math.max(0, t0)).bar;
  for (let guard = 0; guard < 4096; guard++, bar++) {
    if (barToTime(map, bar) >= t1 - 1e-9) break;
    const seg = segmentAtBar(map, bar);
    const qpb = quartersPerBar(seg);
    out.push({ bar, q: seg.q + (bar - seg.bar) * qpb, qpb });
  }
  return out;
}

// ─── Petits outils ─────────────────────────────────────────────────────────────────────

/** Empreinte courte d'une valeur (FNV-1a sur le JSON). */
export function hashOf(v: unknown): string {
  const s = JSON.stringify(v) || '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}.${h.toString(36)}`;
}

const r6 = (x: number) => Math.round(x * 1e6);
const velMul = (intensity: number) => 0.6 + (0.4 * (Math.max(1, Math.min(10, intensity)) - 1)) / 9;

// ─── Batterie ──────────────────────────────────────────────────────────────────────────

type DrumRole = DrumLine['role'];

/** Pad de la boîte à rythmes pour un rôle de recette (même règle que « Démarrer un beat »). */
const ROLE_PAD: Record<DrumRole, string[]> = {
  kick: ['kick'], snare: ['snare', 'clap'], clap: ['clap', 'snare'], hihat: ['hatc'], openhat: ['hato', 'hatc'],
  perc: ['perc', 'perc2', 'fx'], perc2: ['perc2', 'perc', 'fx'], rim: ['fx', 'perc'], shaker: ['shaker', 'perc', 'hatc'],
  crash: ['crash'], tom: ['tom', 'perc', 'snare'],
};

/** Note MIDI du pad d'un rôle (60 = 1re rangée, comme drumSongClips), null si aucun pad ne convient. */
export function drumPitchFor(role: DrumRole, rows: Pick<DrumRow, 'id'>[]): number | null {
  for (const id of ROLE_PAD[role] || []) {
    const i = rows.findIndex(r => r.id === id);
    if (i >= 0) return 60 + i;
  }
  return null;
}

interface Hit { role: DrumRole; q: number; vel: number; n: number; cellQ: number }

/**
 * Rang d'un coup de la recette : la complexité c joue les coups de rang ≤ c.
 * 1 = l'ossature (kick sur le 1, caisse claire, charleston à la noire), 2 = charleston
 * à la croche, 3 = autres kicks et caisses, 4 = charleston à la double et open hat,
 * 5 = ghosts, percussions, rolls (la recette publiée est donc entière à 5).
 */
function hitRank(role: DrumRole, i: number, per: number, vel: number): number {
  const pos16 = (i * 16) / per;
  const onQ = Math.abs(pos16 / 4 - Math.round(pos16 / 4)) < 1e-9;
  const on8 = Math.abs(pos16 / 2 - Math.round(pos16 / 2)) < 1e-9;
  const ghost = vel > 0 && vel <= 64;
  switch (role) {
    case 'kick': return i === 0 ? 1 : ghost ? 5 : 3;
    case 'snare': case 'clap': case 'rim': return ghost ? 5 : vel >= 118 || onQ ? 1 : 3;
    case 'hihat': return ghost ? 4 : onQ ? 1 : on8 ? 2 : 4;
    case 'openhat': return 4;
    default: return 5;
  }
}

/** Coups d'une ligne de recette sur une mesure : position dans la mesure (noires), vélocité, roll, rang. */
function lineBar(line: DrumLine, patBars: number, bar: number, qpb: number): { qi: number; vel: number; n: number; cellQ: number; rank: number; triplet: boolean; i16: number }[] {
  const per = rowStepsPerBar({ rate: line.rate as StepRate | undefined });
  const cellQ = 4 / per;
  const nCells = Math.max(1, Math.round(qpb / cellQ));
  const { vel, ratchet } = parseHits(line.hits);
  if (!vel.length) return [];
  const pb = ((bar % patBars) + patBars) % patBars;
  const out: { qi: number; vel: number; n: number; cellQ: number; rank: number; triplet: boolean; i16: number }[] = [];
  for (let i = 0; i < nCells; i++) {
    const idx = (pb * per + i) % vel.length;
    const v = vel[idx];
    if (!(v > 0)) continue;
    out.push({ qi: i * cellQ, vel: v, n: Math.max(1, Math.min(4, ratchet[idx] || 1)), cellQ, rank: hitRank(line.role, i, per, v), triplet: per % 3 === 0, i16: Math.round((i * 16) / per) });
  }
  return out;
}

const FILL_ROLL = [72, 88, 104, 122];
const FILL_TOMS = [64, 72, 80, 88];
const HAT_ROLL_STYLES: ReadonlySet<BeatGenreId> = new Set(['trap', 'drill-uk', 'drill-fr']);

/** Une mesure sur combien a un remplissage (0 = seulement en fin de région). */
export const fillEvery = (fills: number): 0 | 4 | 8 => (fills >= 8 ? 4 : fills >= 4 ? 8 : 0);
/** Longueur du remplissage, en doubles-croches. */
export const fillLength = (fills: number): 4 | 8 => (fills >= 6 ? 8 : 4);

/**
 * Coups de batterie d'une région (en noires depuis le début du morceau). Les mesures
 * gardent leur numéro dans le MORCEAU : couper une région ne décale pas le motif.
 */
export function drumHitsFor(s: SeanceSettings, map: TempoMap, t0: number, t1: number, rows: Pick<DrumRow, 'id'>[]): Hit[] {
  const g = genreRecipe(s.style);
  const nV = g.drums.length;
  const main = g.drums[((s.pattern % nV) + nV) % nV];
  const other1 = g.drums[(s.pattern + 1) % nV];
  const other2 = g.drums[(s.pattern + 2) % nV];
  const swing = s.swing ?? main.swing ?? g.swing ?? 0;
  const bars = regionBars(map, t0, t1);
  if (!bars.length) return [];
  const lastBar = bars[bars.length - 1].bar;
  const every = s.fills > 0 ? fillEvery(s.fills) : 0;
  const has = (role: DrumRole) => drumPitchFor(role, rows) !== null;
  const raw: (Hit & { rank: number })[] = [];
  /** Ajoute les coups d'une variante ; `layer` : rang forcé (couches de complexité 6 à 10). */
  const addVariant = (v: typeof main, bar: { bar: number; q: number; qpb: number }, pick: (l: DrumLine, rank: number, vel: number) => number | null) => {
    for (const line of v.lines) {
      for (const h of lineBar(line, v.bars, bar.bar, bar.qpb)) {
        const rank = pick(line, h.rank, h.vel);
        if (rank === null) continue;
        const sw = !h.triplet && h.i16 % 2 === 1 ? swing * 0.125 : 0;
        raw.push({ role: line.role, q: bar.q + h.qi + sw, vel: h.vel, n: h.n, cellQ: h.cellQ, rank });
      }
    }
  };
  const mainHit = (l: DrumLine, rank: number, vel: number) => (l.role === 'snare' || l.role === 'clap') && (vel >= 118 || rank === 1);
  for (const b of bars) {
    addVariant(main, b, (_l, rank) => rank);
    // Complexité 6 à 10 : des coups pris aux deux AUTRES motifs publiés du même genre, couche par couche.
    addVariant(other1, b, (l, _r) => (l.role === 'hihat' || l.role === 'openhat' ? 6 : null));
    addVariant(other1, b, (l, _r) => (['perc', 'perc2', 'shaker', 'rim'].includes(l.role) ? 7 : null));
    addVariant(other1, b, (l, _r) => (l.role === 'kick' ? 8 : null));
    addVariant(other2, b, (l, _r) => (l.role === 'hihat' || l.role === 'openhat' ? 9 : null));
    addVariant(other2, b, (l, r, v) => (l.role === 'kick' || l.role === 'hihat' || l.role === 'openhat' || mainHit(l, r, v) ? null : 10));
  }
  // Complexité : on garde les rangs ≤ c ; les rolls ne se déroulent qu'à partir de 5.
  let hits: Hit[] = raw.filter(h => h.rank <= s.complexity).map(h => ({ role: h.role, q: h.q, vel: h.vel, n: s.complexity >= Math.max(5, h.rank) ? h.n : 1, cellQ: h.cellQ }));
  // Intensité douce : pas d'open hat.
  if (s.intensity <= 3) hits = hits.filter(h => h.role !== 'openhat');
  // Remplissages : fin de phrase (toutes les 4 ou 8 mesures du morceau) et dernière mesure de la région.
  const fillBars = new Set<number>();
  if (s.fills > 0) for (const b of bars) if (b.bar === lastBar || (every && (b.bar + 1) % every === 0)) fillBars.add(b.bar);
  for (const b of bars) {
    if (!fillBars.has(b.bar)) continue;
    const len = fillLength(s.fills);
    const zone = b.q + b.qpb - len / 4;
    const inZone = (q: number) => q > zone - 1e-9 && q < b.q + b.qpb - 1e-9;
    const rollRole: DrumRole = has('snare') ? 'snare' : 'clap';
    hits = hits.filter(h => !(inZone(h.q) && (h.role === 'snare' || h.role === 'clap' || h.role === 'rim' || h.role === 'perc' || h.role === 'perc2' || h.role === 'tom'))
      // Le kick laisse la place au roulement (il garde le premier temps du remplissage).
      && !(h.role === 'kick' && h.q > zone + 1e-9 && h.q < b.q + b.qpb - 1e-9));
    if (HAT_ROLL_STYLES.has(s.style)) hits = hits.map(h => (h.role === 'hihat' && inZone(h.q) ? { ...h, n: Math.max(2, h.n) } : h));
    for (let k = 0; k < len; k++) {
      const q = zone + k * 0.25;
      if (len === 8 && k < 4) hits.push({ role: has('tom') ? 'tom' : rollRole, q, vel: FILL_TOMS[k], n: 1, cellQ: 0.25 });
      else { const j = len === 8 ? k - 4 : k; hits.push({ role: rollRole, q, vel: FILL_ROLL[j], n: j === 3 ? 2 : 1, cellQ: 0.25 }); }
    }
  }
  // Intensité forte : crash sur le premier temps de la région (si le kit a une crash).
  if (s.intensity >= 7 && has('crash')) {
    const qStart = timeToQuarters(map, t0);
    const first = bars.find(b => b.q >= qStart - 1e-6);
    if (first && Math.abs(first.q - qStart) < 1e-6) hits.push({ role: 'crash', q: first.q, vel: 110, n: 1, cellQ: 0.25 });
  }
  // Un seul coup par pad et par instant (le plus fort, le roll le plus long).
  const byKey = new Map<string, Hit>();
  for (const h of hits) {
    const k = `${h.role === 'snare' || h.role === 'clap' ? (has('snare') ? 'snare' : 'clap') : h.role}@${Math.round(h.q * 1e6)}`;
    const p = byKey.get(k);
    if (!p) byKey.set(k, h);
    else byKey.set(k, { ...p, vel: Math.max(p.vel, h.vel), n: Math.max(p.n, h.n) });
  }
  return [...byKey.values()].sort((a, b) => a.q - b.q || a.role.localeCompare(b.role));
}

function drumNotes(c: Pick<Clip, 'id' | 'start' | 'duration'>, s: SeanceSettings, ctx: SeanceContext, rows: Pick<DrumRow, 'id'>[]): MidiNote[] {
  const t0 = c.start, t1 = c.start + c.duration;
  const m = velMul(s.intensity);
  const out: Omit<MidiNote, 'id'>[] = [];
  for (const h of drumHitsFor(s, ctx.map, t0, t1, rows)) {
    const pitch = drumPitchFor(h.role, rows);
    if (pitch === null) continue;
    for (let k = 0; k < h.n; k++) {
      const q = h.q + (k * h.cellQ) / h.n;
      const t = quartersToTime(ctx.map, q);
      // Tolérance d'une microseconde aux bords : un début de région arrondi (tempo changé puis rétabli) garde son premier coup.
      if (t < t0 - 1e-6 || t >= t1 - 1e-6) continue;
      const tEnd = quartersToTime(ctx.map, q + h.cellQ / h.n);
      out.push({ pitch, start: Math.max(0, t - t0), duration: Math.max(0.005, Math.min(0.1, tEnd - t)), velocity: Math.min(1, (h.vel / 127) * m * (k === 0 ? 1 : 0.8)) });
    }
  }
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return out.map((n, i) => ({ id: `sp-${c.id}-${i}`, ...n }));
}

// ─── Basse ─────────────────────────────────────────────────────────────────────────────

/** Instrument de la piste de basse : 808 (trap, drill) ou basse NOVA. */
export const is808Style = (style: BeatGenreId) => style === 'trap' || style === 'drill-uk' || style === 'drill-fr';

interface Attack { q: number; rank: number; force?: boolean }

/** Attaques d'un rythme de 16 pas par mesure (« x… »), rang 1 sur le 1er temps, 3 sur les temps, 5 ailleurs. */
function rhythmAttacks(hits: string, bars: { bar: number; q: number; qpb: number }[], rankAt: (i: number) => number): Attack[] {
  const { vel } = parseHits(hits);
  if (!vel.length) return [];
  const out: Attack[] = [];
  for (const b of bars) {
    const n = Math.round(b.qpb * 4);
    const span = Math.max(1, Math.round(vel.length / 16));
    const pb = b.bar % span;
    for (let i = 0; i < n; i++) if (vel[(pb * 16 + i) % vel.length] > 0) out.push({ q: b.q + i * 0.25, rank: rankAt(i) });
  }
  return out;
}

const baseRank = (i: number) => (i === 0 ? 1 : i % 4 === 0 ? 3 : 5);

/**
 * Ligne de basse : fondamentale de l'accord à CHAQUE changement d'accord (toujours,
 * même en complexité 1) et au premier temps des mesures, puis le rythme de la recette
 * du genre (sous le kick ou rythme propre), sauts d'octave, quinte, glissés 808 et notes
 * d'approche selon la complexité. Toutes les notes sont dans l'accord en cours ou dans
 * la gamme.
 */
function bassNotes(c: Pick<Clip, 'id' | 'start' | 'duration'>, s: SeanceSettings, ctx: SeanceContext, use808: boolean): MidiNote[] {
  const t0 = c.start, t1 = c.start + c.duration;
  const map = ctx.map;
  const g = genreRecipe(s.style);
  const nR = g.bass.length;
  const rule = g.bass[((s.pattern % nR) + nR) % nR];
  const kickOf = (v: number) => g.drums[((v % g.drums.length) + g.drums.length) % g.drums.length].lines.find(l => l.role === 'kick')?.hits;
  const bars = regionBars(map, t0, t1);
  const cx = s.complexity;
  const q0 = timeToQuarters(map, t0), q1 = timeToQuarters(map, t1);
  const chords = ctx.chords.filter(ch => ch.end > t0 + 1e-6 && ch.start < t1 - 1e-6);
  if (!chords.length || !bars.length) return [];
  const atk: Attack[] = [];
  // Rang 1 : chaque changement d'accord (et le début de la région s'il tombe dans un accord), le 1er temps des mesures.
  for (const ch of chords) atk.push({ q: Math.max(q0, timeToQuarters(map, ch.start)), rank: 1, force: true });
  for (const b of bars) atk.push({ q: b.q, rank: 1 });
  // Rythme de la recette (publiée : rang ≤ 5).
  atk.push(...rhythmAttacks((rule.followKick && kickOf(s.pattern)) || rule.hits || 'x...............', bars, baseRank));
  // Complexité 8 : les rythmes des autres règles publiées du genre ; 10 : sous les kicks des autres motifs.
  g.bass.forEach((r, i) => { if (r !== rule) atk.push(...rhythmAttacks((r.followKick && kickOf(i)) || r.hits || 'x...............', bars, () => 8)); });
  [s.pattern + 1, s.pattern + 2].forEach(v => { const k = kickOf(v); if (k) atk.push(...rhythmAttacks(k, bars, () => 10)); });
  // Une attaque par instant, dans la région.
  const byQ = new Map<number, Attack>();
  for (const a of atk) {
    if (a.q < q0 - 1e-6 || a.q >= q1 - 1e-6 || a.rank > cx) continue;
    const k = Math.round(a.q * 1e6);
    const p = byQ.get(k);
    if (!p || a.rank < p.rank || a.force) byQ.set(k, { ...a, rank: Math.min(a.rank, p?.rank ?? 99), force: a.force || p?.force });
  }
  const sorted = [...byQ.values()].sort((a, b) => a.q - b.q);
  const scale = seanceScale(ctx);
  const low = use808 ? 24 : 36; // Do1 (808) ou Do2 (basse)
  const rootPitch = (root: number) => low + pc(root);
  const notes: Omit<MidiNote, 'id'>[] = [];
  const m = velMul(s.intensity);
  const octaveOn = (rule.octave && cx >= 5) || cx >= 6;
  let lastChord: ChordEvent | null = null;
  let inChord = 0;
  sorted.forEach((a, i) => {
    const t = quartersToTime(map, a.q);
    const ch = chordAt(chords, t + 1e-6);
    if (!ch) return;
    if (ch !== lastChord) { lastChord = ch; inChord = 0; } else inChord++;
    const nextQ = i + 1 < sorted.length ? sorted[i + 1].q : q1;
    const end = Math.min(quartersToTime(map, nextQ), ch.end, t1);
    if (end - t < 0.01) return;
    const pos = timeToPosition(map, t);
    let pitch = rootPitch(ch.root);
    if (inChord > 0) {
      const iv = QUALITY_INTERVALS[ch.quality] || QUALITY_INTERVALS.maj;
      if (octaveOn && inChord % 4 === 3) pitch += 12;
      else if (cx >= 7 && pos.beat === 2 && pos.frac < 1e-6) {
        // Quinte de l'accord sur le 3e temps (note de l'accord).
        pitch = rootPitch(ch.root) + iv[Math.min(2, iv.length - 1)];
        if (pitch > low + 23) pitch -= 12;
      }
    }
    const downbeat = pos.beat === 0 && pos.frac < 1e-6;
    notes.push({ pitch, start: t - t0, duration: (end - t) * 0.98, velocity: Math.min(1, (downbeat ? 0.95 : 0.88) * m) });
  });
  // Changements d'accord : glissé 808 (recette) ou note d'approche (basse), placés avant le changement.
  const slides = use808 && ((rule.slides && cx >= 5) || cx >= 9);
  const approach = !use808 && cx >= 9;
  if (slides || approach) {
    for (let i = 1; i < chords.length; i++) {
      const prev = chords[i - 1], ch = chords[i];
      if (Math.abs(prev.end - ch.start) > 1e-6 || pc(prev.root) === pc(ch.root)) continue;
      const qc = timeToQuarters(map, ch.start);
      const qs = qc - (slides ? 0.5 : 0.25);
      const ts = quartersToTime(map, qs);
      if (ts <= Math.max(prev.start, t0) + 1e-6 || ch.start >= t1 - 1e-6) continue;
      const ok = allowedAt(ctx, ts, scale);
      if (slides) {
        // Glissé : la note d'arrivée part une croche avant et chevauche la note en cours (808 en glide).
        if (!ok.has(pc(ch.root))) continue;
        notes.push({ pitch: rootPitch(ch.root), start: ts - t0, duration: Math.min(quartersToTime(map, qs + 0.75), t1) - ts, velocity: Math.min(1, 0.8 * m) });
      } else {
        // Approche : la note de la gamme juste en dessous de la fondamentale suivante, une double avant.
        const target = rootPitch(ch.root);
        let p: number | null = null;
        for (let d = 1; d <= 2 && p === null; d++) if (ok.has(pc(target - d))) p = target - d;
        if (p === null) continue;
        // La note en cours s'arrête là.
        for (const n of notes) { const ns = n.start + t0; if (ns < ts - 1e-6 && ns + n.duration > ts - 1e-6) n.duration = Math.max(0.01, (ts - ns) * 0.98); }
        notes.push({ pitch: p < low ? p + 12 : p, start: ts - t0, duration: (ch.start - ts) * 0.98, velocity: Math.min(1, 0.8 * m) });
      }
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return notes.map((n, i) => ({ id: `sp-${c.id}-${i}`, ...n }));
}

// ─── Claviers ──────────────────────────────────────────────────────────────────────────

/** Accords plaqués (voix au plus près) au rythme d'accompagnement du genre. Toutes les notes sont dans l'accord. */
function keysNotes(c: Pick<Clip, 'id' | 'start' | 'duration'>, s: SeanceSettings, ctx: SeanceContext): MidiNote[] {
  const t0 = c.start, t1 = c.start + c.duration;
  const map = ctx.map;
  const g = genreRecipe(s.style);
  const nC = g.comp.length;
  const comp = g.comp[((s.pattern % nC) + nC) % nC];
  const bars = regionBars(map, t0, t1);
  const q0 = timeToQuarters(map, t0), q1 = timeToQuarters(map, t1);
  const chords = ctx.chords.filter(ch => ch.end > t0 + 1e-6 && ch.start < t1 - 1e-6);
  if (!chords.length || !bars.length) return [];
  const atk: Attack[] = [];
  for (const ch of chords) atk.push({ q: Math.max(q0, timeToQuarters(map, ch.start)), rank: 1 });
  for (const b of bars) atk.push({ q: b.q, rank: 1 });
  const compAtk = (pat: string, rank: (i: number) => number) => {
    const p = pat.replace(/[|\s]/g, '');
    for (const b of bars) {
      const n = Math.round(b.qpb * 4);
      for (let i = 0; i < n; i++) { const ch = p[i % p.length]; if (ch === 'x' || ch === 'X') atk.push({ q: b.q + i * 0.25, rank: rank(i) }); }
    }
  };
  compAtk(comp, i => (i % 4 === 0 ? 4 : 5));
  g.comp.forEach(p => { if (p !== comp) compAtk(p, () => 7); });
  for (const b of bars) for (let k = 0; k < Math.round(b.qpb); k++) atk.push({ q: b.q + k, rank: 9 });
  const qs = [...new Set(atk.filter(a => a.rank <= s.complexity && a.q >= q0 - 1e-6 && a.q < q1 - 1e-6).map(a => Math.round(a.q * 1e6)))].sort((a, b) => a - b).map(k => k / 1e6);
  const m = velMul(s.intensity);
  const voicing = new Map<ChordEvent, number[]>();
  let prev: number[] | null = null;
  for (const ch of chords) { const v = voiceChord(ch.root, ch.quality, prev); voicing.set(ch, v); prev = v; }
  const notes: Omit<MidiNote, 'id'>[] = [];
  qs.forEach((q, i) => {
    const t = quartersToTime(map, q);
    const ch = chordAt(chords, t + 1e-6);
    if (!ch) return;
    const end = Math.min(quartersToTime(map, i + 1 < qs.length ? qs[i + 1] : q1), ch.end, t1);
    if (end - t < 0.01) return;
    const v = [...voicing.get(ch)!];
    if (s.intensity >= 8) v.push(v[v.length - 1] + 12);
    const accent = Math.abs(timeToPosition(map, t).frac) < 1e-6 && timeToPosition(map, t).beat === 0;
    v.forEach(p => notes.push({ pitch: p, start: t - t0, duration: (end - t) * 0.98, velocity: Math.min(1, (accent ? 0.82 : 0.7) * m) }));
  });
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return notes.map((n, i) => ({ id: `sp-${c.id}-${i}`, ...n }));
}

// ─── Génération d'une région ────────────────────────────────────────────────────────────

type TrackLike = Pick<Track, 'drumMachine' | 'bass808'>;

const padRows = (t: TrackLike | undefined): Pick<DrumRow, 'id'>[] =>
  (t?.drumMachine?.rows as DrumRow[] | undefined) || makeDrumMachine('trap').rows;

/** Notes d'une région musicien (temps relatif au début du clip, comme tout clip MIDI). */
export function generateSeanceNotes(c: Pick<Clip, 'id' | 'start' | 'duration'>, s: SeanceSettings, ctx: SeanceContext, track?: TrackLike): MidiNote[] {
  if (!(c.duration > 0)) return [];
  if (s.role === 'drums') return drumNotes(c, s, ctx, padRows(track));
  if (s.role === 'bass') return bassNotes(c, s, ctx, !!track?.bass808);
  return keysNotes(c, s, ctx);
}

/** Empreinte des entrées : si elle ne change pas, les notes non plus. */
export function seanceInputSig(c: Pick<Clip, 'start' | 'duration'>, s: SeanceSettings, ctx: SeanceContext, track?: TrackLike): string {
  const t0 = c.start, t1 = c.start + c.duration;
  const harmonic = s.role !== 'drums';
  return hashOf([
    SEANCE_RULES_VERSION, s.role, s.style, s.pattern, s.intensity, s.complexity, s.fills, s.swing ?? null,
    r6(t0), r6(c.duration),
    ctx.map.segments.map(g => [g.bar, r6(g.time), r6(g.q), g.bpm, g.bpmEnd ?? null, g.num, g.den]),
    harmonic ? ctx.chords.filter(ch => ch.end > t0 - 1e-6 && ch.start < t1 + 1e-6).map(ch => [r6(ch.start), r6(ch.end), ch.root, ch.quality]) : 0,
    harmonic && ctx.key ? [ctx.key.root, ctx.key.scale] : 0,
    s.role === 'drums' ? padRows(track).map(r => r.id) : 0,
    s.role === 'bass' ? !!track?.bass808 : 0,
  ]);
}

/**
 * Empreinte des notes d'une région, en position MUSICALE (noires depuis le début du
 * clip) : elle ne bouge pas quand le tempo change (les notes suivent le tempo), mais
 * change dès qu'on retouche une note (hauteur, force, position, longueur).
 */
export function seanceNotesSig(c: Pick<Clip, 'start' | 'notes'>, map: TempoMap, role: SeanceRole): string {
  const q0 = timeToQuarters(map, c.start);
  const rows = (c.notes || []).map(n => {
    const qs = timeToQuarters(map, c.start + n.start);
    return [n.id, n.pitch, Math.round(n.velocity * 1000), n.muted ? 1 : 0, Math.round((qs - q0) * 48),
      role === 'drums' ? 0 : Math.round((timeToQuarters(map, c.start + n.start + n.duration) - qs) * 48)];
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return hashOf(rows);
}

/** Région recalculée (notes + empreintes). */
export function renderSeanceClip(c: Clip, s: SeanceSettings, ctx: SeanceContext, track?: TrackLike): Clip {
  const notes = generateSeanceNotes(c, s, ctx, track);
  // Une région musicien n'est jamais une copie liée : chaque région calcule ses propres notes.
  const { linkId: _l, ...rest } = c;
  const out: Clip = { ...rest, notes };
  out.seance = {
    ...s,
    sig: seanceInputSig(c, s, ctx, track),
    nsig: seanceNotesSig(out, ctx.map, s.role),
    q0: Math.round(timeToQuarters(ctx.map, c.start) * 1e6) / 1e6,
    q1: Math.round(timeToQuarters(ctx.map, c.start + c.duration) * 1e6) / 1e6,
  };
  return out;
}

const FROZEN = ' (figé)';
/** Région figée : les mêmes notes, sans réglages (un clip MIDI ordinaire). */
export function freezeSeanceClip(c: Clip): Clip {
  const { seance: _s, ...rest } = c;
  return { ...rest, name: c.name.endsWith(FROZEN) ? c.name : `${c.name}${FROZEN}`.slice(0, 80) } as Clip;
}

// ─── Mise à jour automatique (App.setState) ─────────────────────────────────────────────

type RefreshState = Pick<DAWState, 'tracks'> & CtxState;

const sameTempo = (a: CtxState, b: CtxState) => a.bpm === b.bpm && a.tempoEvents === b.tempoEvents && a.timeSignature === b.timeSignature;

/**
 * Régions musicien à jour : recalculées si une entrée a changé, figées si quelqu'un a
 * retouché leurs notes à la main. Renvoie `next.tracks` tel quel si rien ne change
 * (aucun calcul s'il n'y a aucun musicien : rien ne tourne au repos).
 */
export function refreshSessionPlayers(prev: RefreshState | null, next: RefreshState): Track[] {
  const tracks = next.tracks;
  if (!tracks.some(t => t.clips?.some(c => c.seance))) return tracks;
  if (prev && prev.tracks === next.tracks && prev.chords === next.chords && sameTempo(prev, next)
    && prev.projectKey === next.projectKey && prev.projectScale === next.projectScale) return tracks;
  const ctx = seanceContext(next);
  const tempoSame = !prev || sameTempo(prev, next);
  const prevClips = new Map<string, Clip>();
  if (prev && prev.tracks !== next.tracks) for (const t of prev.tracks) for (const c of t.clips || []) if (c.seance) prevClips.set(`${t.id}/${c.id}`, c);
  let changed = false;
  const out = tracks.map(t => {
    if (!t.clips?.some(c => c.seance)) return t;
    let tc = false;
    const clips = t.clips.map(c => {
      if (!c.seance) return c;
      const s = sanitizeSeance(c.seance);
      if (!s) { tc = true; return freezeSeanceClip(c); }
      if (c.linkId) { tc = true; return renderSeanceClip(c, s, ctx, t); }
      const q0 = timeToQuarters(ctx.map, c.start), q1 = timeToQuarters(ctx.map, c.start + c.duration);
      const samePlace = s.q0 !== undefined && s.q1 !== undefined && Math.abs(s.q0 - q0) < 1e-4 && Math.abs(s.q1 - q1) < 1e-4;
      const before = prevClips.get(`${t.id}/${c.id}`);
      // Notes retouchées à la main (même réglage, même place) : la région est figée, rien n'est écrasé.
      const touched = before && before.notes !== c.notes && before.seance === c.seance && tempoSame && samePlace;
      const sig = seanceInputSig(c, s, ctx, t);
      if (!touched && sig === s.sig) return c;
      if (samePlace && s.nsig && seanceNotesSig(c, ctx.map, s.role) !== s.nsig) { tc = true; return freezeSeanceClip(c); }
      if (sig === s.sig) return c;
      tc = true;
      return renderSeanceClip(c, s, ctx, t);
    });
    if (!tc) return t;
    changed = true;
    return { ...t, clips };
  });
  return changed ? out : tracks;
}

// ─── Actions (une étape d'annulation chacune côté App) ──────────────────────────────────

/** Style par défaut : le genre du beat, sinon d'après le tempo. */
export function defaultSeanceStyle(st: Pick<DAWState, 'bpm' | 'beatGenre'>): BeatGenreId {
  const byText = st.beatGenre ? genreFromText(st.beatGenre) : null;
  if (byText) return byText;
  const b = st.bpm || 120;
  if (b >= 130) return 'trap';
  if (b >= 96 && b <= 118) return 'afro';
  if (b < 80) return 'rnb';
  return 'boombap';
}

/** Réglages de départ d'une section d'après son nom (choix NOVA, voir RECETTES.md). */
export function sectionDefaults(name?: string): Pick<SeanceSettings, 'intensity' | 'complexity' | 'fills'> {
  const n = (name || '').toLowerCase();
  if (/intro|outro|pont|bridge|break/.test(n)) return { intensity: 4, complexity: 3, fills: 3 };
  if (/refrain|chorus|hook|drop/.test(n)) return { intensity: 8, complexity: 6, fills: 6 };
  return { intensity: 6, complexity: 5, fills: 5 };
}

export interface SeanceRegionPlan { start: number; end: number; section?: string }

/**
 * Où jouer : une région par section (repères de région) si on le demande et qu'il y en a,
 * sinon de la première à la dernière mesure des accords, sinon la boucle, sinon 8 mesures.
 * Les bords sont calés sur les mesures.
 */
export function seanceRegions(st: Pick<DAWState, 'markers' | 'chords' | 'loopStart' | 'loopEnd' | 'isLoopActive'> & CtxState, bySection: boolean): SeanceRegionPlan[] {
  const map = buildTempoMap(st.bpm, st.timeSignature, st.tempoEvents);
  const snap = (t: number, up: boolean) => {
    const p = timeToPosition(map, Math.max(0, t));
    const bar = up && (p.beat > 0 || p.frac > 1e-6) ? p.bar + 1 : p.bar;
    return barToTime(map, bar);
  };
  const secs = bySection ? sectionsFromMarkers((st.markers || []) as any).sort((a, b) => a.start - b.start) : [];
  if (secs.length) {
    return secs.map(s => ({ start: snap(s.start, false), end: snap(s.end, true), section: s.name.slice(0, 40) })).filter(r => r.end > r.start + 1e-3);
  }
  const ch = [...(st.chords || [])].sort((a, b) => a.start - b.start);
  if (ch.length) return [{ start: snap(ch[0].start, false), end: snap(Math.max(...ch.map(c => c.end)), true) }];
  if ((st.loopEnd || 0) > (st.loopStart || 0) + 0.5) return [{ start: snap(st.loopStart || 0, false), end: snap(st.loopEnd, true) }];
  return [{ start: 0, end: barToTime(map, 8) }];
}

export interface SeanceCreateOptions {
  role: SeanceRole;
  style: BeatGenreId;
  pattern?: number;
  /** Une région par section (repères de région). */
  bySection?: boolean;
}

export type SeanceResult = { ok: true; state: DAWState; trackId: string; message: string } | { ok: false; error: string };

/** Boîte à rythmes du batteur : le kit NOVA du genre (sinon le kit synthé le plus proche), sans motif. */
export function drummerKit(style: BeatGenreId, ix: KitIndex | null): DrumMachine {
  const g = genreRecipe(style);
  const base = makeDrumMachine(g.fallbackKit);
  const kit = kitForGenre(g, ix, 0);
  const dm: DrumMachine = kit ? applyKitDef({ ...base, rows: [] }, kit, ix) : base;
  return { ...dm, bars: 1, rows: dm.rows.map(r => ({ ...r, steps: new Array(16).fill(0), ratchet: new Array(16).fill(1), rate: undefined })), patterns: undefined, activePattern: undefined, song: undefined };
}

/** Ajoute un musicien : une piste (batterie, 808 / basse, claviers) et ses régions, notes calculées. */
export function addSessionPlayer(st: DAWState, o: SeanceCreateOptions, ix: KitIndex | null, stamp = Date.now().toString(36)): SeanceResult {
  const info = roleInfo(o.role);
  const g = genreRecipe(o.style);
  if (o.role !== 'drums' && !(st.chords || []).length) {
    return { ok: false, error: `${info.emoji} Le ${info.label.toLowerCase()} suit la piste d’accords, qui est vide. Pose des accords (couloir Accords) ou lance « Détecter » sur ton beat, puis réessaie.` };
  }
  const plans = seanceRegions(st, !!o.bySection);
  const id = `seance-${o.role}-${stamp}`;
  const color = o.role === 'drums' ? '#fb923c' : o.role === 'bass' ? '#e879f9' : '#5eead4';
  let track: Track = {
    id, name: info.track, type: o.role === 'drums' ? TrackType.DRUM_RACK : TrackType.MIDI, color,
    isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: o.role === 'keys' ? 0.7 : 0.85, pan: 0,
    outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
  } as Track;
  if (o.role === 'drums') {
    const dm = drummerKit(o.style, ix);
    track = { ...track, drumMachine: dm, drumPads: drumPadsFor(dm) as any };
  } else if (o.role === 'bass') {
    if (is808Style(o.style)) track = { ...track, name: 'BASSE 808', bass808: { style: g.dist808 ? '808-dist' : '808', glide: true } };
    else track = { ...track, novaSynth: presetSettings(o.style === 'afro' ? 'basse-pluck' : 'basse-rnb') };
  } else {
    track = { ...track, melodicSampler: normalizeSampler({ ...DEFAULT_SAMPLER, ...settingsForInstrument(g.instruments[0]) }) };
  }
  const ctx = seanceContext(st);
  track.clips = plans.map((p, i) => {
    const s: SeanceSettings = { role: o.role, style: o.style, pattern: clampInt(o.pattern, 0, 2, 0), ...sectionDefaults(p.section), ...(p.section ? { section: p.section } : {}) };
    const c: Clip = { id: `clip-${id}-${i}`, start: p.start, duration: p.end - p.start, offset: 0, fadeIn: 0, fadeOut: 0, name: seanceClipName(s), color, type: TrackType.MIDI, notes: [], isMuted: false, gain: 1 };
    return renderSeanceClip(c, s, ctx, track);
  });
  const tracks = [...st.tracks];
  const at = tracks.findIndex(t => t.type === TrackType.BUS || t.type === TrackType.SEND || t.id === 'master');
  tracks.splice(at >= 0 ? at : tracks.length, 0, track);
  const notes = track.clips.reduce((a, c) => a + (c.notes?.length || 0), 0);
  const where = plans.length > 1 ? `${plans.length} régions (une par section)` : 'une région';
  const follow = o.role === 'drums' ? 'sur la grille du morceau' : 'qui suit tes accords';
  return {
    ok: true, state: { ...st, tracks }, trackId: id,
    message: `${info.emoji} ${info.label} ${g.name} ajouté ${follow} : ${where}, ${notes} notes. Règle l’intensité, la complexité et les remplissages par région ; « Figer en notes MIDI » pour éditer à la main. Ctrl+Z pour annuler.`,
  };
}

/** Change les réglages des régions (toutes si `clipIds` est null) et recalcule leurs notes. */
export function updateSeance(st: DAWState, trackId: string, clipIds: string[] | null, patch: Partial<Pick<SeanceSettings, 'style' | 'pattern' | 'intensity' | 'complexity' | 'fills' | 'swing'>>): DAWState {
  const ctx = seanceContext(st);
  let changed = false;
  const tracks = st.tracks.map(t => {
    if (t.id !== trackId) return t;
    const clips = t.clips.map(c => {
      if (!c.seance || (clipIds && !clipIds.includes(c.id))) return c;
      const s0 = sanitizeSeance(c.seance);
      if (!s0) return c;
      const s = sanitizeSeance({ ...s0, ...patch })!;
      if (patch.swing === undefined && 'swing' in patch) delete s.swing;
      const autoName = c.name === seanceClipName(s0);
      changed = true;
      return renderSeanceClip({ ...c, ...(autoName ? { name: seanceClipName(s) } : {}) }, s, ctx, t);
    });
    return { ...t, clips };
  });
  return changed ? { ...st, tracks } : st;
}

/** Fige les régions (toutes si `clipIds` est null) : notes gardées telles quelles. */
export function freezeSeance(st: DAWState, trackId: string, clipIds: string[] | null): { state: DAWState; regions: number; notes: number } {
  let regions = 0, notes = 0;
  const tracks = st.tracks.map(t => {
    if (t.id !== trackId || !t.clips.some(c => c.seance)) return t;
    return {
      ...t, clips: t.clips.map(c => {
        if (!c.seance || (clipIds && !clipIds.includes(c.id))) return c;
        regions++; notes += c.notes?.length || 0;
        return freezeSeanceClip(c);
      }),
    };
  });
  return { state: regions ? { ...st, tracks } : st, regions, notes };
}

/**
 * « Une région par section » : les régions du musicien sont remplacées par une région par
 * repère de région (Intro, Couplet, Refrain…), chacune avec ses réglages de départ.
 */
export function splitSeanceBySections(st: DAWState, trackId: string, stamp = Date.now().toString(36)): SeanceResult {
  const t = st.tracks.find(x => x.id === trackId);
  const first = t?.clips.find(c => c.seance);
  const s0 = first ? sanitizeSeance(first.seance) : null;
  if (!t || !first || !s0) return { ok: false, error: 'Cette piste n’a pas de région musicien.' };
  const plans = seanceRegions(st, true);
  if (!plans.some(p => p.section)) return { ok: false, error: 'Aucune section dans le morceau : pose des repères de région (Intro, Couplet, Refrain…) sur la règle, puis réessaie. Tu peux aussi couper la région avec S.' };
  const ctx = seanceContext(st);
  const regions = plans.map((p, i) => {
    const s: SeanceSettings = { role: s0.role, style: s0.style, pattern: s0.pattern, ...(s0.swing !== undefined ? { swing: s0.swing } : {}), ...sectionDefaults(p.section), ...(p.section ? { section: p.section } : {}) };
    const c: Clip = { ...first, id: `clip-${trackId}-${stamp}-${i}`, start: p.start, duration: p.end - p.start, name: seanceClipName(s), notes: [] };
    delete (c as Partial<Clip>).seance;
    return renderSeanceClip(c, s, ctx, t);
  });
  const tracks = st.tracks.map(x => (x.id === trackId ? { ...x, clips: [...x.clips.filter(c => !c.seance), ...regions].sort((a, b) => a.start - b.start) } : x));
  return { ok: true, state: { ...st, tracks }, trackId, message: `🎚️ ${regions.length} régions, une par section : règle chacune à part (intensité, complexité, remplissages).` };
}

/** Régions musicien d'une piste (dans l'ordre du morceau). */
export const seanceClipsOf = (t: Pick<Track, 'clips'> | undefined | null): Clip[] =>
  (t?.clips || []).filter(c => !!c.seance).sort((a, b) => a.start - b.start);

/** Rôle du musicien d'une piste (null : pas un musicien). */
export const seanceRoleOf = (t: Pick<Track, 'clips'> | undefined | null): SeanceRole | null =>
  (seanceClipsOf(t)[0]?.seance?.role as SeanceRole | undefined) ?? null;
