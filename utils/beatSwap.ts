/**
 * R23 · Changer de beat en gardant les voix (« Remplacer l'instru… »).
 *
 * Au studio, l'artiste rappe sur un beat, puis en veut un autre. Pro Tools
 * oblige à tout refaire à la main (Elastic Audio piste par piste, transposer
 * chaque clip, recaler le premier temps). Ici, une seule opération :
 *   1. on lit le tempo, la tonalité et le PREMIER TEMPS des deux beats
 *      (catalogue d'abord, sinon à l'écoute) ;
 *   2. les voix suivent la grille du nouveau beat : chaque instant musical
 *      (mesure, temps) garde sa place — étirement non destructif (R13) ;
 *   3. elles sont transposées par l'intervalle le plus court (−2 plutôt que
 *      +10), PSOLA formants gardés (R13) ;
 *   4. repères, accords, boucle et zone de punch suivent ; la tonalité du
 *      projet et des Auto-Tune passe à celle du nouveau beat.
 * Tout le projet change en UNE étape d'annulation.
 *
 * Module pur (sans DOM, sans moteur audio) : testé dans tests/beatSwap.test.ts.
 */
import { TrackType } from '../types';
import type { Clip, DAWState, Marker, PunchSettings, Track } from '../types';
import type { ChordEvent } from './chordDetect';

// ─── Tonalités ───────────────────────────────────────────────────────────────

export interface KeyInfo { root: number; scale: string }

const NOTES_FR = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const MODES_FR: Record<string, string> = { MAJOR: 'majeur', MINOR: 'mineur', MINOR_HARMONIC: 'mineur harmonique', HARMONIC_MINOR: 'mineur harmonique', DORIAN: 'dorien', PHRYGIAN: 'phrygien', PENTATONIC: 'pentatonique' };
const mod12 = (n: number) => ((Math.round(n) % 12) + 12) % 12;

/** « La mineur ». */
export const keyName = (k: KeyInfo | null | undefined): string =>
  k ? `${NOTES_FR[mod12(k.root)]} ${MODES_FR[(k.scale || 'MINOR').toUpperCase()] ?? ''}`.trim() : 'tonalité inconnue';

/** Modes « mineurs » (tonique = tonique du relatif mineur). */
const isMinorLike = (scale: string) => /MINOR|DORIAN|PHRYGIAN|AEOLIAN/i.test(scale || 'MINOR');

/**
 * Tonique ramenée au mineur relatif : Do majeur et La mineur ont les mêmes
 * notes ; une voix en Do majeur passée sur un beat en La mineur ne bouge pas.
 */
export const relativeMinorRoot = (k: KeyInfo): number => (isMinorLike(k.scale) ? mod12(k.root) : mod12(k.root + 9));

/**
 * Transposition des voix d'une tonalité à l'autre : l'intervalle le plus court
 * (Sol mineur → La mineur : +2, pas −10 ; Sol mineur → Fa mineur : −2).
 * `other` : l'autre sens (choix proposé à l'artiste). À égalité (triton) : vers
 * le bas (une voix baissée sonne plus naturelle qu'une voix montée).
 */
export function semitoneChoices(from: KeyInfo | null | undefined, to: KeyInfo | null | undefined): { best: number; other: number | null } {
  if (!from || !to) return { best: 0, other: null };
  const d = mod12(relativeMinorRoot(to) - relativeMinorRoot(from));
  if (d === 0) return { best: 0, other: null };
  const best = d >= 6 ? d - 12 : d;
  return { best, other: best > 0 ? best - 12 : best + 12 };
}

// ─── Tempo ──────────────────────────────────────────────────────────────────

/**
 * Tempo visé pour les voix. Un beat annoncé à 188 BPM et l'ancien à 94 : même
 * pulsation en double tempo. On garde le multiple (½, 1, 2) le plus proche de
 * l'ancien tempo, seulement s'il évite un étirement de plus d'un tiers.
 */
export function effectiveTempo(oldBpm: number, newBpm: number): { bpm: number; folded: 'half' | 'double' | null } {
  if (!(oldBpm > 0 && newBpm > 0)) return { bpm: newBpm, folded: null };
  const dist = (b: number) => Math.abs(Math.log(b / oldBpm));
  if (dist(newBpm) <= Math.log(4 / 3)) return { bpm: newBpm, folded: null };
  const half = newBpm / 2, dbl = newBpm * 2;
  if (dist(half) < dist(newBpm) && dist(half) <= dist(dbl)) return { bpm: half, folded: 'half' };
  if (dist(dbl) < dist(newBpm)) return { bpm: dbl, folded: 'double' };
  return { bpm: newBpm, folded: null };
}

// ─── Plan ───────────────────────────────────────────────────────────────────

/** Ce qu'on sait d'un beat. `downbeat` : premier temps (s, temps du projet). */
export interface BeatInfo {
  bpm: number;
  key: KeyInfo | null;
  downbeat: number;
  /** D'où viennent les infos (affichées : « annoncé par le catalogue », « détecté à l'écoute »). */
  bpmFrom?: 'catalogue' | 'projet' | 'écoute';
  keyFrom?: 'catalogue' | 'projet' | 'écoute';
  /** Confiance de la détection du premier temps (0-1). */
  downbeatConfidence?: number;
  title?: string;
}

export interface SwapOptions {
  /** Recaler les voix au nouveau tempo (défaut : oui). */
  retime?: boolean;
  /** Transposer les voix (défaut : oui si la tonalité change). */
  transpose?: boolean;
  /** Transposition imposée (l'autre sens, par exemple). */
  semitones?: number;
  /** Réglage fin du premier temps (ms, + = voix plus tard). */
  offsetMs?: number;
  /** Décalage d'un nombre entier de temps (le premier temps a été mal deviné). */
  beatShift?: number;
}

export const TEMPO_ALERT = 0.15;
export const SEMITONE_ALERT = 3;

export interface SwapPlan {
  oldBpm: number;
  newBpm: number;
  /** Tempo visé pour les voix (½ ou ×2 si plus proche). */
  targetBpm: number;
  folded: 'half' | 'double' | null;
  /** Durée des voix × factor (ancien tempo / tempo visé). 1 sans recalage. */
  factor: number;
  /** Variation de tempo vue par les voix (+0,064 = 6,4 % plus rapide). */
  tempoChange: number;
  semitones: number;
  /** L'autre sens (null : pas de changement de tonalité ou inconnu). */
  altSemitones: number | null;
  fromKey: KeyInfo | null;
  toKey: KeyInfo | null;
  /** Premier temps de l'ancien / du nouveau beat (s, projet), décalage compris. */
  dbOld: number;
  dbNew: number;
  retime: boolean;
  transpose: boolean;
  warnings: string[];
}

export function planSwap(old: BeatInfo, next: BeatInfo, o: SwapOptions = {}): SwapPlan {
  const retime = o.retime !== false && old.bpm > 0 && next.bpm > 0;
  const eff = effectiveTempo(old.bpm, next.bpm);
  const targetBpm = retime ? eff.bpm : old.bpm;
  const factor = retime ? old.bpm / targetBpm : 1;
  const choice = semitoneChoices(old.key, next.key);
  const transpose = o.transpose !== false && !!old.key && !!next.key;
  const semitones = transpose ? (typeof o.semitones === 'number' && Number.isFinite(o.semitones) ? Math.max(-12, Math.min(12, Math.round(o.semitones))) : choice.best) : 0;
  const beat = 60 / (targetBpm > 0 ? targetBpm : 120);
  const dbNew = next.downbeat + (o.offsetMs || 0) / 1000 + (o.beatShift || 0) * beat;
  const tempoChange = factor > 0 ? 1 / factor - 1 : 0;
  const warnings: string[] = [];
  if (retime && Math.abs(tempoChange) > TEMPO_ALERT) {
    warnings.push(`Tempo ${tempoChange > 0 ? '+' : '−'}${Math.round(Math.abs(tempoChange) * 100)} % : au-delà de ±15 %, la voix risque de sonner trafiquée (${tempoChange > 0 ? 'pressée' : 'traînante'}). Un beat plus proche de ${Math.round(old.bpm)} BPM sonnera plus naturel.`);
  }
  if (Math.abs(semitones) > SEMITONE_ALERT) {
    warnings.push(`${semitones > 0 ? '+' : '−'}${Math.abs(semitones)} demi-tons : au-delà de ±3, la voix risque de sonner trafiquée. Les formants sont gardés, mais réécoute bien (ou garde la tonalité d'origine).`);
  }
  if (eff.folded && retime) warnings.push(`Le nouveau beat est annoncé à ${round1(next.bpm)} BPM : tes voix suivent sa pulsation en ${eff.folded === 'half' ? 'demi-tempo' : 'double tempo'} (${round1(targetBpm)} BPM), c'est plus naturel.`);
  if (!old.key || !next.key) warnings.push(`Tonalité ${!old.key ? "de l'ancien beat" : 'du nouveau beat'} inconnue : tes voix ne sont pas transposées.`);
  return {
    oldBpm: old.bpm, newBpm: next.bpm, targetBpm, folded: retime ? eff.folded : null, factor, tempoChange,
    semitones, altSemitones: transpose ? (semitones === choice.best ? choice.other : choice.best) : choice.other,
    fromKey: old.key, toKey: next.key, dbOld: old.downbeat, dbNew, retime, transpose, warnings,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Instant du projet après le changement de beat (la même position musicale). */
export const swapTime = (p: Pick<SwapPlan, 'dbOld' | 'dbNew' | 'factor'>, t: number): number => p.dbNew + (t - p.dbOld) * p.factor;

/** Résumé lisible : « 94 → 100 BPM (+6 %), Sol mineur → La mineur (+2 demi-tons) ». */
export function planSummary(p: SwapPlan): string {
  const parts: string[] = [];
  if (p.retime && Math.abs(p.factor - 1) > 1e-4) parts.push(`${round1(p.oldBpm)} → ${round1(p.targetBpm)} BPM (${p.tempoChange > 0 ? '+' : '−'}${round1(Math.abs(p.tempoChange) * 100)} %)`);
  else parts.push(`tempo gardé (${round1(p.targetBpm)} BPM)`);
  if (p.semitones) parts.push(`${keyName(p.fromKey)} → ${keyName(p.toKey)} (${p.semitones > 0 ? '+' : '−'}${Math.abs(p.semitones)} demi-ton${Math.abs(p.semitones) > 1 ? 's' : ''})`);
  else if (p.fromKey && p.toKey) parts.push(`${keyName(p.toKey)} (même gamme, pas de transposition)`);
  return parts.join(' · ');
}

// ─── Ce qui bouge ───────────────────────────────────────────────────────────

/** La piste du beat (celle qu'on remplace). */
export const isBeatTrack = (t: Track): boolean => t.id === 'instrumental';

/** Pistes qui suivent le nouveau beat (voix, prises, MIDI) : pas le beat, le master, les bus. */
export const followsBeat = (t: Track): boolean =>
  !isBeatTrack(t) && t.id !== 'master' && t.type !== TrackType.BUS && t.type !== TrackType.SEND;

/** Clips audio à rendre (étirement / transposition), avec leur piste. */
export function audioClipsToRender(tracks: Track[]): { trackId: string; clip: Clip }[] {
  const out: { trackId: string; clip: Clip }[] = [];
  for (const t of tracks) {
    if (!followsBeat(t) || t.type !== TrackType.AUDIO) continue;
    for (const c of t.clips) if (!c.notes && (c.bufferId || c.buffer)) out.push({ trackId: t.id, clip: c });
  }
  return out;
}

/** Y a-t-il des voix (de l'audio hors beat) à garder ? */
export const hasVoicesToKeep = (tracks: Track[]): boolean => audioClipsToRender(tracks).length > 0;

const mapMarker = (m: Marker, f: (t: number) => number): Marker => {
  const time = Math.max(0, r6(f(m.time)));
  return m.endTime !== undefined ? { ...m, time, endTime: Math.max(time + 0.01, r6(f(m.endTime))) } : { ...m, time };
};

/** Accords : suivent la grille, transposés avec les voix. */
export function mapChords(chords: ChordEvent[] | undefined, f: (t: number) => number, semitones: number): ChordEvent[] | undefined {
  if (!chords) return chords;
  return chords.map(c => {
    const start = Math.max(0, r6(f(c.start)));
    return { ...c, start, end: Math.max(start + 0.01, r6(f(c.end))), root: mod12(c.root + semitones) };
  });
}

/** Un clip MIDI suit la grille (notes en secondes depuis le début du clip) et la tonalité. */
function mapMidiClip(c: Clip, f: (t: number) => number, factor: number, semitones: number, drums: boolean): Clip {
  const start = r6(f(c.start));
  return {
    ...c,
    start: Math.max(0, start),
    duration: r6(c.duration * factor),
    offset: r6((c.offset || 0) * factor),
    notes: c.notes?.map(n => ({ ...n, start: r6(n.start * factor), duration: r6(n.duration * factor), pitch: drums ? n.pitch : Math.max(0, Math.min(127, n.pitch + semitones)) })),
  };
}

/** Patch d'un clip audio rendu (étiré / transposé) : posé à sa nouvelle place. */
export interface ClipRender { trackId: string; clipId: string; patch: Partial<Clip> }

export interface SwapInput {
  plan: SwapPlan;
  /** Nouveau clip du beat (déjà dans le registre audio). */
  beatClip: Clip;
  /** Catalogue : identifiant (licence à l'export), titre, genre. */
  beat: { instrumentId?: string | number; title?: string; genre?: string };
  /** Clips audio rendus (utils/clipTranspose via services/elasticRender). */
  renders: ClipRender[];
  /** Effets qui suivent la tonalité du projet (Auto-Tune…). */
  usesProjectKey?: (pluginType: string) => boolean;
}

/**
 * Le projet après le changement de beat. Pur : un seul `setState`, donc une
 * seule étape d'annulation (« Revenir à l'ancien beat » = Ctrl+Z).
 */
export function applySwap(state: DAWState, inp: SwapInput): DAWState {
  const { plan } = inp;
  const f = (t: number) => swapTime(plan, t);
  const st = plan.semitones;
  const renders = new Map(inp.renders.map(r => [`${r.trackId}/${r.clipId}`, r.patch]));
  const keyKnown = !!plan.toKey;
  const tracks = state.tracks.map(t => {
    if (isBeatTrack(t)) {
      const next: Track = { ...t, clips: [inp.beatClip] };
      if (inp.beat.instrumentId !== undefined) next.instrumentId = inp.beat.instrumentId as any;
      else delete (next as any).instrumentId;
      return next;
    }
    let out: Track = t;
    if (followsBeat(t)) {
      const drums = t.type === TrackType.DRUM_RACK || !!t.drumMachine;
      const clips = t.clips.map(c => {
        if (c.notes || c.type === TrackType.MIDI) return mapMidiClip(c, f, plan.factor, st, drums);
        const patch = renders.get(`${t.id}/${c.id}`);
        let nc: Clip = { ...c, start: r6(f(c.start)) };
        if (patch) {
          const o = { ...nc } as Record<string, unknown>;
          for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete o[k]; else o[k] = v; }
          nc = o as unknown as Clip;
        } else if (plan.retime) {
          nc.duration = r6(c.duration * plan.factor);
        }
        // Un passage qui partirait avant 0 (anacrouse avant le 1er temps) : on rogne le début.
        if (nc.start < 0) {
          const cut = -nc.start;
          nc = { ...nc, start: 0, offset: r6((nc.offset || 0) + cut), duration: r6(Math.max(0.01, nc.duration - cut)) };
        }
        return nc;
      });
      out = { ...t, clips };
      // Gel d'une piste audio : son rendu figé sur l'ancien tempo, on le retire (à regeler).
      if (t.isFrozen && t.type === TrackType.AUDIO) {
        out.isFrozen = false;
        delete (out as any).frozenClip; delete (out as any).frozenClipIds; delete (out as any).frozenSourceSig; delete (out as any).frozenPluginSig; delete (out as any).frozenUpToPluginIndex;
      }
    }
    if (keyKnown && inp.usesProjectKey && t.plugins.some(p => inp.usesProjectKey!(p.type))) {
      out = { ...out, plugins: out.plugins.map(p => (inp.usesProjectKey!(p.type) ? { ...p, params: { ...p.params, rootKey: plan.toKey!.root, scale: plan.toKey!.scale } } : p)) };
    }
    return out;
  });

  const punch: PunchSettings = state.punch && (state.punch.punchOut > state.punch.punchIn)
    ? { ...state.punch, punchIn: Math.max(0, r6(f(state.punch.punchIn))), punchOut: Math.max(0, r6(f(state.punch.punchOut))) }
    : state.punch;
  const next: DAWState = {
    ...state,
    tracks,
    bpm: Math.round(plan.newBpm * 100) / 100,
    markers: (state.markers || []).map(m => mapMarker(m, f)),
    chords: mapChords(state.chords, f, st),
    loopStart: Math.max(0, r6(f(state.loopStart))),
    loopEnd: Math.max(0, r6(f(state.loopEnd))),
    punch,
    beatTitle: inp.beat.title ?? state.beatTitle,
    beatGenre: inp.beat.genre ?? state.beatGenre,
  };
  // Piste tempo : changements de tempo de l'ancien beat retirés (les changements de mesure restent).
  if (state.tempoEvents?.some(e => e.bpm !== undefined)) {
    next.tempoEvents = state.tempoEvents.map(e => { const x = { ...e }; delete x.bpm; return x; }).filter(e => e.numerator !== undefined || e.denominator !== undefined);
  }
  if (keyKnown) { next.projectKey = plan.toKey!.root; next.projectScale = plan.toKey!.scale; }
  return next;
}

/** Message de fin, pour l'artiste. */
export function doneText(p: SwapPlan, voices: number, title?: string): string {
  const what = voices ? `${voices} clip${voices > 1 ? 's' : ''} de voix recalé${voices > 1 ? 's' : ''}` : 'aucune voix à recaler';
  return `🔁 Nouveau beat${title ? ` « ${title} »` : ''} posé — ${what} : ${planSummary(p)}. Ctrl+Z (ou « Revenir à l'ancien beat ») pour tout retrouver.`;
}

// ─── Analyse du beat : grille et premier temps ───────────────────────────────

export interface BeatGrid {
  /** Tempo affiné sur toute la durée (régression des attaques). */
  bpm: number;
  /** Premier temps fort (début de la 1re mesure jouée), s depuis le début du son. */
  downbeat: number;
  /** Phase de la grille des temps (s, dans [0, période)). */
  beatPhase: number;
  confidence: number;
}

/** Enveloppes d'attaque (pas de 5 ms) : bande entière et graves (< ~150 Hz : kick, 808). */
function onsetEnvelopes(x: Float32Array, sr: number, hopSec = 0.005) {
  const hop = Math.max(1, Math.round(sr * hopSec));
  const frames = Math.floor(x.length / hop);
  const full = new Float64Array(frames), low = new Float64Array(frames);
  const a = Math.exp((-2 * Math.PI * 150) / sr);
  let l1 = 0, l2 = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0, sl = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const v = x[i];
      l1 = (1 - a) * v + a * l1; l2 = (1 - a) * l1 + a * l2;
      s += v * v; sl += l2 * l2;
    }
    full[f] = Math.sqrt(s / hop); low[f] = Math.sqrt(sl / hop);
  }
  const flux = (e: Float64Array) => {
    const d = new Float64Array(e.length);
    for (let f = 1; f < e.length; f++) d[f] = Math.max(0, Math.log(1e-5 + e[f]) - Math.log(1e-5 + e[f - 1]));
    return d;
  };
  return { hop, hopSec: hop / sr, frames, full, low, odf: flux(full), lowOdf: flux(low) };
}

const sampleAt = (d: Float64Array, pos: number, spread = 1): number => {
  // Maximum dans ±spread trames (une attaque tombe rarement pile sur la trame).
  const c = Math.round(pos);
  let m = 0;
  for (let k = c - spread; k <= c + spread; k++) if (k >= 0 && k < d.length && d[k] > m) m = d[k];
  return m;
};

/**
 * Instant précis d'une attaque près de `near` (s) : premier bloc de 1 ms dont
 * l'énergie atteint la moitié du plus fort bloc de la fenêtre (comme on la lit
 * à l'oreille / sur la forme d'onde). null si la fenêtre est vide.
 */
export function attackNear(x: Float32Array, sr: number, near: number, span = 0.03): number | null {
  const blk = Math.max(4, Math.round(sr * 0.001));
  const a = Math.max(0, Math.round((near - span) * sr)), b = Math.min(x.length, Math.round((near + span) * sr));
  if (b - a < blk * 4) return null;
  const e: number[] = [];
  for (let k = a; k + blk <= b; k += blk) { let s = 0; for (let i = k; i < k + blk; i++) s += x[i] * x[i]; e.push(Math.sqrt(s / blk)); }
  const peak = Math.max(...e);
  if (!(peak > 1e-4)) return null;
  // Niveau d'avant l'attaque (bas de la fenêtre) : une attaque doit monter nettement.
  const floor = Math.min(...e.slice(0, Math.max(1, Math.floor(e.length / 3))));
  if (peak < floor * 2) return null;
  const want = floor + (peak - floor) * 0.5;
  const i = e.findIndex(v => v >= want);
  return i < 0 ? null : (a + i * blk) / sr;
}

/**
 * Grille du beat : tempo affiné et premier temps fort. `approxBpm` : tempo
 * annoncé (catalogue) ou estimé. La phase des temps est cherchée sur toute la
 * durée (robuste), puis le temps fort de la mesure par les graves (kick, 808),
 * puis affinée sur les attaques réelles (médiane), pour un calage à la ms.
 */
export function analyzeBeatGrid(x: Float32Array, sr: number, approxBpm: number, beatsPerBar = 4): BeatGrid | null {
  if (!(approxBpm > 0) || x.length < sr * 2) return null;
  const env = onsetEnvelopes(x, sr);
  const { hopSec, frames } = env;
  if (frames < 100) return null;

  // 1) Phase des temps (période annoncée), puis tempo affiné par régression.
  const scorePhase = (periodF: number, phaseF: number, d: Float64Array) => {
    let s = 0, n = 0;
    for (let p = phaseF; p < frames; p += periodF) { s += sampleAt(d, p); n++; }
    return n ? s / n : 0;
  };
  // Tempo annoncé à ±3 % près (catalogue arrondi, estimation) : période et phase cherchées ensemble.
  let period = 60 / approxBpm;
  let best = 0, bestS = -1, bestP = period;
  for (let bpmC = approxBpm * 0.97; bpmC <= approxBpm * 1.03; bpmC += 0.05) {
    const pfC = 60 / bpmC / hopSec;
    for (let ph = 0; ph < pfC; ph += 1) { const s = scorePhase(pfC, ph, env.odf); if (s > bestS) { bestS = s; best = ph; bestP = 60 / bpmC; } }
  }
  period = bestP;
  let phase = best * hopSec;

  // Attaques réelles près de chaque temps → droite t = phase + k × période.
  const fitGrid = () => {
    const ks: number[] = [], ts: number[] = [];
    const dur = x.length / sr;
    for (let k = 0; phase + k * period < dur - 0.05; k++) {
      const g = phase + k * period;
      const strength = sampleAt(env.odf, g / hopSec, 2);
      if (strength < bestS * 0.6) continue;
      const at = attackNear(x, sr, g, Math.min(0.04, period * 0.2));
      if (at !== null && Math.abs(at - g) < period * 0.2) { ks.push(k); ts.push(at); }
    }
    return { ks, ts };
  };
  for (let pass = 0; pass < 2; pass++) {
    const { ks, ts } = fitGrid();
    if (ks.length < 4) break;
    const n = ks.length, mk = ks.reduce((a, b) => a + b, 0) / n, mt = ts.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (ks[i] - mk) * (ts[i] - mt); den += (ks[i] - mk) ** 2; }
    const slope = den > 0 ? num / den : period;
    if (Math.abs(slope / period - 1) < 0.03) period = slope;
    // Phase : médiane des écarts (insensible aux attaques en avance ou en retard).
    const dev = ts.map((t, i) => t - ks[i] * period).sort((a, b) => a - b);
    phase = dev[Math.floor(dev.length / 2)];
  }
  let bpm = 60 / period;
  // Beats produits au BPM entier (ou demi) : on arrondit quand c'est à moins de 0,08 BPM.
  const nearHalf = Math.round(bpm * 2) / 2;
  if (Math.abs(bpm - nearHalf) < 0.08) { bpm = nearHalf; period = 60 / bpm; }
  while (phase < 0) phase += period;
  phase = phase % period;

  // 2) Temps fort de la mesure : les graves (kick, 808) tombent sur le 1.
  const bar = period * beatsPerBar;
  let bestB = 0, bestBS = -1;
  for (let b = 0; b < beatsPerBar; b++) {
    let s = 0, n = 0;
    for (let t = phase + b * period; t < x.length / sr; t += bar) { s += sampleAt(env.lowOdf, t / hopSec, 2) + 0.5 * sampleAt(env.odf, t / hopSec, 2); n++; }
    const v = n ? s / n : 0;
    if (v > bestBS * 1.0001) { bestBS = v; bestB = b; }
  }
  const barPhase = phase + bestB * period;

  // 3) Premier temps fort joué : la première mesure où la musique a commencé.
  let peak = 0;
  for (let f = 0; f < frames; f++) if (env.full[f] > peak) peak = env.full[f];
  let start = 0;
  for (let f = 0; f < frames; f++) if (env.full[f] > peak * 0.05) { start = f * hopSec; break; }
  let downbeat = barPhase;
  while (downbeat - bar >= start - 0.06) downbeat -= bar;
  while (downbeat < start - 0.06) downbeat += bar;

  // Confiance : attaques fortes sur la grille / attaques fortes ailleurs.
  const mean = env.odf.reduce((a, b) => a + b, 0) / frames;
  const confidence = Math.max(0, Math.min(1, (bestS / Math.max(1e-9, mean) - 1) / 8));
  return { bpm: Math.round(bpm * 1000) / 1000, downbeat: Math.round(downbeat * 1e5) / 1e5, beatPhase: Math.round(phase * 1e5) / 1e5, confidence: Math.round(confidence * 100) / 100 };
}
