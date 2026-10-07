/**
 * Groove et swing sur n'importe quel clip MIDI (V25), comme le Groove Pool
 * d'Ableton Live (Timing, Velocity, Commit) et le swing global de FL Studio.
 *
 * Un groove = une grille (croches ou doubles-croches) sur 1 ou 2 mesures et,
 * pour chaque case, un décalage (fraction de case, + = en retard) et un
 * multiplicateur de vélocité. Chaque note prend le décalage de la case la plus
 * proche : elle garde son propre écart à la grille (le jeu reste humain), le
 * groove s'y ajoute. Les positions sont calées sur la grille DU MORCEAU (début
 * du clip compris), comme dans Live.
 *
 * Non destructif : le clip garde ses notes d'origine (`clip.groove.source`) et
 * ses notes jouées sont recalculées à chaque réglage ; « Appliquer le groove »
 * (Commit Groove de Live) retire la source : les notes groovées deviennent les
 * notes du clip. Une note retouchée à la main pendant que le groove est actif
 * redevient « d'origine » en retirant son décalage (voir rebaseSource).
 */
import { ClipGroove, GrooveTemplate, MidiNote } from '../types';
import { GROOVES as DRUM_GROOVES } from './drumPatterns';

export type { ClipGroove, GrooveTemplate };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Swing (FL, MPC) : `pct` = place du contretemps dans la paire, 50 % = droit, 66 % = triolet. */
export function swingTemplate(division: 8 | 16, pct: number, accent = 0.85): GrooveTemplate {
  const p = clamp(pct, 50, 75);
  const off = (2 * p) / 100 - 1; // en fraction de case
  const spb = division === 16 ? 4 : 2;
  const timing = Array.from({ length: spb }, (_, i) => (i % 2 === 1 ? off : 0));
  const velocity = Array.from({ length: spb }, (_, i) => (i % 2 === 1 ? accent : 1));
  return {
    id: `swing${division}-${Math.round(p)}`,
    name: `Swing ${division === 16 ? 'double-croches' : 'croches'} ${Math.round(p)} %`,
    stepsPerBeat: spb, lengthBeats: 1, timing, velocity,
  };
}

/** Grooves prêts (Groove Pool) : MPC, trap, et ceux de la boîte à rythmes. */
export const PRESET_GROOVES: (GrooveTemplate & { hint: string })[] = [
  { ...swingTemplate(16, 55), id: 'mpc55', name: 'MPC 55 %', hint: 'Swing léger de double-croches façon MPC 60 (55 %) : juste assez pour que les hi-hats respirent.' },
  { ...swingTemplate(16, 58), id: 'mpc58', name: 'MPC 58 %', hint: 'Swing MPC 58 % : le groove boom bap / lo-fi classique.' },
  { ...swingTemplate(16, 62), id: 'mpc62', name: 'MPC 62 %', hint: 'Swing MPC 62 % : bien chaloupé, presque ternaire.' },
  {
    id: 'trap-bounce', name: 'Trap « bounce »', stepsPerBeat: 4, lengthBeats: 4,
    hint: 'Hi-hats qui rebondissent : 2e et 4e double-croches un peu en retard et plus douces, temps 2 et 4 appuyés (rebond façon Metro Boomin / Southside).',
    timing: [0, 0.14, 0.04, 0.16, 0, 0.14, 0.04, 0.16, 0, 0.14, 0.04, 0.16, 0, 0.14, 0.04, 0.16],
    velocity: [1, 0.68, 0.84, 0.72, 1.08, 0.68, 0.84, 0.72, 1, 0.68, 0.84, 0.72, 1.08, 0.7, 0.86, 0.76],
  },
  ...DRUM_GROOVES.filter(g => g.id !== 'none' && g.id !== 'mpc').map(g => ({
    id: `dm-${g.id}`, name: g.name, hint: g.hint, stepsPerBeat: 4, lengthBeats: 4, timing: g.timing, velocity: g.velocity,
  })),
];

export interface GrooveContext {
  bpm: number;
  /** Début du clip dans le morceau (s) : la grille est celle du morceau. */
  clipStart: number;
}

const slotsOf = (t: GrooveTemplate) => Math.max(1, Math.round(t.stepsPerBeat * t.lengthBeats));

/** Décalage (s) et multiplicateur de vélocité de la note qui commence à `absStart` (s). */
function grooveAt(t: GrooveTemplate, absStart: number, bpm: number, amount: number, velAmount: number, quantize: number) {
  const beat = 60 / bpm;
  const slotDur = beat / t.stepsPerBeat;
  const x = absStart / slotDur;
  const idx = Math.round(x);
  const dev = x - idx;
  const n = slotsOf(t);
  const k = ((idx % n) + n) % n;
  const shiftSlots = (t.timing[k] || 0) * amount - dev * quantize;
  const vMul = 1 + ((t.velocity[k] ?? 1) - 1) * velAmount;
  return { shift: shiftSlots * slotDur, vMul };
}

/** Notes groovées (mêmes identifiants que la source). */
export function applyGroove(source: MidiNote[], g: Pick<ClipGroove, 'template' | 'amount' | 'velocity' | 'quantize'>, ctx: GrooveContext): MidiNote[] {
  const amount = clamp(g.amount ?? 1, 0, 1.5);
  const va = clamp(g.velocity ?? 0, 0, 1);
  const q = clamp(g.quantize ?? 0, 0, 1);
  return source.map(n => {
    const { shift, vMul } = grooveAt(g.template, ctx.clipStart + n.start, ctx.bpm, amount, va, q);
    return { ...n, start: Math.max(0, n.start + shift), velocity: clamp(n.velocity * vMul, 0.01, 1) };
  });
}

const same = (a: MidiNote, b: MidiNote) => a.pitch === b.pitch && Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.duration - b.duration) < 1e-6 && Math.abs(a.velocity - b.velocity) < 1e-6;

/**
 * Source à jour : les notes non touchées depuis le dernier calcul gardent leur
 * original, les notes retouchées ou ajoutées à la main perdent leur décalage.
 */
export function rebaseSource(current: MidiNote[], g: ClipGroove, ctx: GrooveContext): MidiNote[] {
  const prev = new Map(g.source.map(n => [n.id, n]));
  const generated = new Map(applyGroove(g.source, g, ctx).map(n => [n.id, n]));
  return current.map(n => {
    const gen = generated.get(n.id);
    if (gen && same(gen, n)) return prev.get(n.id)!;
    // Retouchée : on retire le décalage de sa case (approximation, comme Live quand on édite pendant le groove).
    const { shift, vMul } = grooveAt(g.template, ctx.clipStart + n.start, ctx.bpm, clamp(g.amount ?? 1, 0, 1.5), clamp(g.velocity ?? 0, 0, 1), 0);
    return { ...n, start: Math.max(0, n.start - shift), velocity: clamp(n.velocity / (vMul || 1), 0.01, 1) };
  });
}

/**
 * Pose (ou règle) un groove sur un clip : renvoie les champs à écrire
 * (`notes` + `groove`). Une seule écriture = une étape d'annulation.
 */
export function setClipGroove(
  clip: { start: number; notes?: MidiNote[]; groove?: ClipGroove },
  next: Omit<ClipGroove, 'source'>,
  bpm: number,
): { notes: MidiNote[]; groove: ClipGroove } {
  const ctx = { bpm, clipStart: clip.start };
  const source = clip.groove ? rebaseSource(clip.notes || [], clip.groove, ctx) : (clip.notes || []);
  const groove: ClipGroove = { ...next, source };
  return { notes: applyGroove(source, groove, ctx), groove };
}

/** « Appliquer le groove » (Commit) : les notes groovées restent, la source part. */
export const commitGroove = (clip: { notes?: MidiNote[] }): { notes: MidiNote[]; groove: undefined } => ({ notes: clip.notes || [], groove: undefined });

/** Retirer le groove : retour aux notes d'origine (retouches comprises). */
export function removeGroove(clip: { start: number; notes?: MidiNote[]; groove?: ClipGroove }, bpm: number): { notes: MidiNote[]; groove: undefined } {
  if (!clip.groove) return { notes: clip.notes || [], groove: undefined };
  return { notes: rebaseSource(clip.notes || [], clip.groove, { bpm, clipStart: clip.start }), groove: undefined };
}

// ---------------------------------------------------------------------------
// Extraction d'un groove (boucle audio ou MIDI)
// ---------------------------------------------------------------------------

export interface Onset {
  /** Instant dans le morceau (s). */
  time: number;
  /** Force relative (vélocité 0-1 ou crête audio). */
  level: number;
}

/**
 * Groove d'une boucle : pour chaque case (doubles-croches par défaut) sur 1 ou
 * 2 mesures, l'écart moyen des attaques à la grille et leur force moyenne
 * (rapportée à la plus forte). Les cases sans attaque restent neutres.
 */
export function extractGroove(onsets: Onset[], opts: { bpm: number; stepsPerBeat?: number; lengthBeats?: number; name?: string }): GrooveTemplate {
  const spb = opts.stepsPerBeat || 4;
  const len = opts.lengthBeats || 4;
  const n = Math.round(spb * len);
  const slotDur = 60 / opts.bpm / spb;
  const sumT = new Array(n).fill(0), sumV = new Array(n).fill(0), cnt = new Array(n).fill(0);
  for (const o of onsets) {
    const x = o.time / slotDur;
    const idx = Math.round(x);
    const k = ((idx % n) + n) % n;
    sumT[k] += x - idx; sumV[k] += o.level; cnt[k]++;
  }
  const meanV = sumV.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
  const maxV = Math.max(1e-9, ...meanV);
  return {
    id: `user-${Date.now().toString(36)}`,
    name: opts.name || 'Groove extrait',
    stepsPerBeat: spb, lengthBeats: len,
    timing: sumT.map((s, i) => (cnt[i] ? Math.round((s / cnt[i]) * 1000) / 1000 : 0)),
    velocity: meanV.map((v, i) => (cnt[i] ? Math.round(clamp(v / maxV, 0.3, 1) * 1000) / 1000 : 1)),
  };
}

/** Attaques d'un clip MIDI (une par instant, force = la plus forte vélocité). */
export function midiOnsets(clip: { start: number; notes?: MidiNote[] }): Onset[] {
  const by = new Map<number, number>();
  for (const n of clip.notes || []) {
    const t = Math.round((clip.start + n.start) * 1e4) / 1e4;
    by.set(t, Math.max(by.get(t) || 0, n.velocity));
  }
  return Array.from(by.entries()).sort((a, b) => a[0] - b[0]).map(([time, level]) => ({ time, level }));
}

/** Force (crête sur 30 ms) de chaque attaque d'un signal mono. */
export function onsetLevels(x: Float32Array | number[], sr: number, times: number[]): number[] {
  const w = Math.max(1, Math.round(sr * 0.03));
  return times.map(t => {
    const i0 = Math.max(0, Math.round(t * sr));
    let peak = 0;
    for (let i = i0, e = Math.min(x.length, i0 + w); i < e; i++) peak = Math.max(peak, Math.abs(x[i]));
    return peak;
  });
}

/** Longueur conseillée du groove extrait : 2 mesures si la boucle en fait au moins 2. */
export const grooveLengthFor = (clipDuration: number, bpm: number, beatsPerBar = 4): number =>
  clipDuration >= (60 / bpm) * beatsPerBar * 2 - 1e-3 ? beatsPerBar * 2 : beatsPerBar;

// ---------------------------------------------------------------------------
// Réserve de grooves de l'utilisateur (Groove Pool), gardée sur cet appareil
// ---------------------------------------------------------------------------

const POOL_KEY = 'nova.groovePool';

export function readGroovePool(): GrooveTemplate[] {
  try { const v = JSON.parse(localStorage.getItem(POOL_KEY) || '[]'); return Array.isArray(v) ? v.filter(g => g && Array.isArray(g.timing)) : []; } catch { return []; }
}

export function saveToGroovePool(g: GrooveTemplate): GrooveTemplate[] {
  const list = [g, ...readGroovePool().filter(x => x.id !== g.id)].slice(0, 24);
  try { localStorage.setItem(POOL_KEY, JSON.stringify(list)); } catch { /* stockage indisponible */ }
  return list;
}

export function removeFromGroovePool(id: string): GrooveTemplate[] {
  const list = readGroovePool().filter(x => x.id !== id);
  try { localStorage.setItem(POOL_KEY, JSON.stringify(list)); } catch { /* */ }
  return list;
}
