import type { CueLevel, CueMix, Track } from '../types';
import { FADER_MAX_GAIN } from './faderLaw';
import { DEFAULT_PAN_LAW, legacyPanToStereo, monoMatrix, panGains, stereoMatrix, stereoPanOf, type PanLaw } from './panLaw';

/**
 * R15 · Mixes casque (cue mixes), comme les envois pré-fader de Pro Tools vers les
 * sorties d'une carte : chaque musicien a SON mix (niveau et pan par piste, plus le
 * clic) sur une paire de sorties. Module pur.
 *
 * Deux chemins :
 *  - la LECTURE (prises déjà faites, beat) part du DAW : prise pré-fader de chaque
 *    piste → gain + pan du mix → paire de sorties (envoyée au pont avec le master) ;
 *  - la VOIX EN DIRECT d'une piste armée est mélangée DANS LE PONT (matrice entrée →
 *    sortie) : latence = tampon de la carte seulement, sans aller-retour navigateur.
 */

export const pairLabel = (pair: number) => `Sorties ${2 * pair + 1}-${2 * pair + 2}`;

let seq = 0;
export const newCueId = () => `cue-${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Paires de sorties de la carte (1-2 = paire 0, le master). */
export const outputPairs = (outputChannels: number) => Math.max(1, Math.floor(Math.max(0, outputChannels) / 2));

/** Nouveau mix casque : prochaine paire libre après 1-2 (3-4, 5-6…). */
export function newCueMix(existing: CueMix[], name?: string, pairs = 8): CueMix {
  const used = new Set(existing.map(m => m.pair));
  let pair = 1;
  while (used.has(pair) && pair < Math.max(2, pairs)) pair++;
  return { id: newCueId(), name: (name || '').trim() || `Casque ${existing.length + 1}`, pair, levels: {}, click: 0.7, master: 1 };
}

/** Les deux mixes de départ : l'artiste (sorties 3-4) et l'ingé (sorties 5-6). */
export const defaultCueMixes = (): CueMix[] => {
  const a = newCueMix([], 'Casque artiste');
  const b = newCueMix([a], 'Casque ingé');
  return [a, b];
};

/** Niveau d'une piste dans le mix ; une piste jamais réglée suit le mix principal. */
export function cueLevelOf(mix: Pick<CueMix, 'levels'>, track: Pick<Track, 'id' | 'volume' | 'pan'>): CueLevel {
  const l = mix.levels[track.id];
  if (l) return { level: clampLevel(l.level), pan: clampPan(l.pan), ...(l.muted ? { muted: true } : {}) };
  return { level: clampLevel(track.volume ?? 1), pan: clampPan(track.pan ?? 0) };
}

// Même butée que les faders (+12 dB, utils/faderLaw) : une piste à +12 dB l'est aussi au casque.
const clampLevel = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(FADER_MAX_GAIN, v)) : 1);
const clampPan = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

/**
 * Positions du pan d'une piste dans un mix casque (22/10/2026) : [pan, 1] pour une piste mono,
 * [G, D] pour une piste stéréo. Sans réglage propre au mix : le pan (ou G / D) du mix principal ;
 * avec un pan propre au mix sur une piste stéréo : converti comme un ancien pan (utils/panLaw).
 */
export function cuePanPositions(mix: Pick<CueMix, 'levels'>, track: Pick<Track, 'id' | 'pan' | 'stereoPan'>, stereo: boolean): [number, number] {
  const l = mix.levels[track.id];
  if (!stereo) return [l ? clampPan(l.pan) : clampPan(track.pan ?? 0), 1];
  const sp = l ? legacyPanToStereo(clampPan(l.pan)) : stereoPanOf({ pan: track.pan ?? 0, stereoPan: track.stereoPan });
  return [sp.l, sp.r];
}

export function setCueLevel(mix: CueMix, trackId: string, patch: Partial<CueLevel>, track?: Pick<Track, 'id' | 'volume' | 'pan'>): CueMix {
  const cur = mix.levels[trackId] || (track ? cueLevelOf(mix, track) : { level: 1, pan: 0 });
  const next: CueLevel = { level: clampLevel(patch.level ?? cur.level), pan: clampPan(patch.pan ?? cur.pan) };
  if (patch.muted ?? cur.muted) next.muted = true;
  return { ...mix, levels: { ...mix.levels, [trackId]: next } };
}

/** « Copier le mix principal » : volume et pan de chaque piste (Pro Tools : Copy to Send). */
export function copyMainMix(mix: CueMix, tracks: Pick<Track, 'id' | 'volume' | 'pan' | 'isMuted'>[]): CueMix {
  const levels: Record<string, CueLevel> = {};
  for (const t of tracks) levels[t.id] = { level: clampLevel(t.volume), pan: clampPan(t.pan), ...(t.isMuted ? { muted: true } : {}) };
  return { ...mix, levels };
}

/**
 * Gains gauche / droite d'un signal MONO (loi de balance : au centre, plein niveau des
 * deux côtés). Gardée pour mémoire : le retour direct suit maintenant la loi de pan du
 * projet (lawGains), comme la lecture et l'export.
 */
export function balanceGains(level: number, pan: number): [number, number] {
  const p = clampPan(pan);
  return [level * Math.min(1, 1 - p), level * Math.min(1, 1 + p)];
}

/** Gains gauche / droite d'un signal MONO placé par la loi de pan du projet (même loi que la lecture). */
export function lawGains(level: number, pan: number, law: PanLaw = DEFAULT_PAN_LAW): [number, number] {
  const [g, d] = panGains(clampPan(pan), law);
  return [level * g, level * d];
}

export interface CueProblem {
  kind: 'no-bridge' | 'one-pair' | 'pair-missing' | 'same-pair';
  message: string;
  mixIds: string[];
}

/**
 * Ce qui empêche un mix casque de sortir sur sa paire, en clair. Rien de bloquant :
 * le mix peut toujours être écouté sur la sortie principale (« Écouter »).
 */
export function cueProblems(mixes: CueMix[], o: { bridge: boolean; outputChannels: number }): CueProblem[] {
  const out: CueProblem[] = [];
  if (!mixes.length) return out;
  if (!o.bridge) {
    out.push({ kind: 'no-bridge', mixIds: mixes.map(m => m.id),
      message: "Sans Nova Studio (pont ASIO), le navigateur n'a qu'une sortie stéréo : les mixes casque ne peuvent pas partir sur d'autres sorties. Tu peux écouter un mix casque sur ta sortie (bouton « Écouter ») pour le préparer." });
    return out;
  }
  const pairs = outputPairs(o.outputChannels);
  if (pairs < 2) {
    out.push({ kind: 'one-pair', mixIds: mixes.map(m => m.id),
      message: `Ta carte n'a qu'une paire de sorties (1-2) : les mixes casque ne peuvent pas sortir séparément. Tu peux quand même écouter un mix casque sur les sorties 1-2 (bouton « Écouter ») pour le monitoring.` });
    return out;
  }
  const missing = mixes.filter(m => m.pair >= pairs || m.pair < 1);
  if (missing.length) out.push({ kind: 'pair-missing', mixIds: missing.map(m => m.id),
    message: `${missing.map(m => `« ${m.name} »`).join(', ')} : ${missing.length > 1 ? 'ces sorties n’existent' : 'cette sortie n’existe'} pas sur ta carte (${pairs} paires : sorties 1 à ${pairs * 2}). Choisis une autre paire.` });
  const byPair = new Map<number, string[]>();
  mixes.forEach(m => byPair.set(m.pair, [...(byPair.get(m.pair) || []), m.id]));
  const dup = [...byPair.values()].filter(ids => ids.length > 1).flat();
  if (dup.length) out.push({ kind: 'same-pair', mixIds: dup,
    message: 'Deux mixes casque partent sur la même paire : ils s’additionnent dans le même casque.' });
  return out;
}

/** Mix réellement envoyé sur sa paire (pont, paire existante, pas coupé). */
export const cueRoutable = (mix: CueMix, o: { bridge: boolean; outputChannels: number }) =>
  o.bridge && !mix.muted && mix.pair >= 1 && mix.pair < outputPairs(o.outputChannels);

export interface MonitorRoute { in: number; out: number; gain: number }

/**
 * Matrice du retour direct dans le pont : voix des pistes armées → sorties 1-2 (master,
 * ou le mix casque écouté) et → la paire de chaque mix casque. Une entrée stéréo va
 * gauche → gauche, droite → droite (piste stéréo : par son double pan G / D) ; une entrée mono
 * est placée par la loi de pan du projet (22/10/2026 : avant, une loi de balance, 0 dB au
 * centre, différente de la lecture).
 */
export function directMonitorRoutes(o: {
  /** Loi de pan du projet (absente : −3 dB). */
  panLaw?: PanLaw;
  armed: { track: Pick<Track, 'id' | 'volume' | 'pan'> & { stereoPan?: Track['stereoPan']; stereo?: boolean }; channels: number[] }[];
  mixes: CueMix[];
  monitoring: boolean;
  monitorLevel: number;
  outputChannels: number;
  bridge?: boolean;
  /** Mix casque écouté sur les sorties 1-2 à la place du master. */
  listenId?: string | null;
}): MonitorRoute[] {
  const routes: MonitorRoute[] = [];
  const add = (cin: number, out: number, gain: number) => {
    if (gain <= 1e-6 || cin < 0 || out < 0 || out >= Math.max(2, o.outputChannels)) return;
    const r = routes.find(x => x.in === cin && x.out === out);
    if (r) r.gain += gain; else routes.push({ in: cin, out, gain });
  };
  const law = o.panLaw ?? DEFAULT_PAN_LAW;
  // `pos` : [pan, 1] (piste mono) ou [G, D] (piste stéréo).
  const send = (ch: number[], l: CueLevel, scale: number, pair: number, pos: [number, number], stereo: boolean) => {
    if (l.muted || !ch.length) return;
    const g = l.level * scale;
    if (ch.length >= 2) {
      const m = stereo ? stereoMatrix(pos[0], pos[1], law) : monoMatrix(pos[0], law);
      add(ch[0], 2 * pair, g * m.ll); add(ch[0], 2 * pair + 1, g * m.lr);
      add(ch[1], 2 * pair, g * m.rl); add(ch[1], 2 * pair + 1, g * m.rr);
      return;
    }
    const [gl, gr] = lawGains(g, pos[0], law);
    add(ch[0], 2 * pair, gl); add(ch[0], 2 * pair + 1, gr);
  };
  const mainPos = (t: { pan: number; stereoPan?: Track['stereoPan']; stereo?: boolean }): [number, number] => {
    if (!t.stereo) return [clampPan(t.pan ?? 0), 1];
    const sp = stereoPanOf({ pan: t.pan ?? 0, stereoPan: t.stereoPan });
    return [sp.l, sp.r];
  };
  const listen = o.listenId ? o.mixes.find(m => m.id === o.listenId) : undefined;
  if (o.monitoring) {
    for (const a of o.armed) {
      // Sorties 1-2 : le retour habituel (niveau du retour casque), ou le mix casque écouté.
      if (listen) send(a.channels, cueLevelOf(listen, a.track), (listen.master ?? 1) * o.monitorLevel, 0, cuePanPositions(listen, a.track, !!a.track.stereo), !!a.track.stereo);
      else send(a.channels, { level: 1, pan: a.track.pan ?? 0 }, o.monitorLevel, 0, mainPos(a.track), !!a.track.stereo);
    }
  }
  const opts = { bridge: o.bridge !== false, outputChannels: o.outputChannels };
  for (const m of o.mixes) {
    if (!cueRoutable(m, opts)) continue;
    for (const a of o.armed) send(a.channels, cueLevelOf(m, a.track), m.master ?? 1, m.pair, cuePanPositions(m, a.track, !!a.track.stereo), !!a.track.stereo);
  }
  return routes.map(r => ({ ...r, gain: Math.round(r.gain * 1e6) / 1e6 }));
}

/**
 * Sorties de la carte de chaque canal envoyé au pont : master sur 1-2, puis chaque mix
 * routable sur sa paire. `layout` = ordre des canaux du message (L, R par mix).
 */
export function outputLayout(mixes: CueMix[], o: { bridge: boolean; outputChannels: number }): { dests: number[]; mixIds: string[] } {
  const dests = [0, 1];
  const mixIds: string[] = [];
  for (const m of mixes) {
    if (!cueRoutable(m, o)) continue;
    dests.push(2 * m.pair, 2 * m.pair + 1);
    mixIds.push(m.id);
  }
  return { dests, mixIds };
}

/** Mixes casque lus depuis le projet (valeurs bornées, au moins 2 à la création). */
export function sanitizeCueMixes(raw: unknown): CueMix[] {
  if (!Array.isArray(raw)) return [];
  const out: CueMix[] = [];
  for (const r of raw.slice(0, 16)) {
    if (!r || typeof r !== 'object') continue;
    const m = r as Record<string, any>;
    const id = typeof m.id === 'string' && m.id ? m.id.slice(0, 64) : newCueId();
    const levels: Record<string, CueLevel> = {};
    if (m.levels && typeof m.levels === 'object') {
      for (const [k, v] of Object.entries(m.levels as Record<string, any>).slice(0, 400)) {
        if (!v || typeof v !== 'object') continue;
        levels[k.slice(0, 120)] = { level: clampLevel(Number(v.level)), pan: clampPan(Number(v.pan)), ...(v.muted ? { muted: true } : {}) };
      }
    }
    out.push({
      id, name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 40) : 'Casque',
      pair: Number.isInteger(m.pair) && m.pair >= 0 && m.pair < 16 ? m.pair : 1,
      levels, click: Math.max(0, Math.min(FADER_MAX_GAIN, Number.isFinite(Number(m.click)) ? Number(m.click) : 0.7)),
      master: Math.max(0, Math.min(FADER_MAX_GAIN, Number.isFinite(Number(m.master)) ? Number(m.master) : 1)),
      ...(m.muted ? { muted: true } : {}),
    });
  }
  return out;
}
