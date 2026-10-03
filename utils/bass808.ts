/**
 * Basse 808 mélodique (piste MIDI « 808 ») : chaque note du piano roll joue la
 * 808 accordée sur sa hauteur, tenue pendant la note, monophonique (une
 * nouvelle note coupe la précédente) avec glissé quand deux notes se
 * chevauchent (le « slide » des 808 trap). Fonctions pures : testées sans audio.
 */

export type Bass808Style = '808' | '808-dist';

/** Réglages de l'instrument 808 d'une piste MIDI (voyagent avec le projet). */
export interface Bass808Settings {
  /** Son : 808 propre ou saturée (suit le kit de batterie à la création). */
  style: Bass808Style;
  /** Glissé entre deux notes qui se chevauchent. */
  glide: boolean;
  /** Durée du glissé (s), 0.06 par défaut. */
  glideTime?: number;
}

export const BASS808_TRACK_ID = 'track-808';
/** Note de référence du son 808 (Do 2, 65,4 Hz) : le sample est rejoué plus vite ou plus lentement. */
export const BASS808_ROOT = 36;
export const DEFAULT_GLIDE_TIME = 0.06;
/** Relâchement court en fin de note (s). */
export const BASS808_RELEASE = 0.06;

export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Vitesse de lecture du sample pour jouer `pitch` (sample enregistré sur `root`). */
export const rateForPitch = (pitch: number, root = BASS808_ROOT) => Math.pow(2, (pitch - root) / 12);

/** Style de 808 de chaque kit de batterie (la drill est saturée). */
export const kit808Style = (kitId?: string | null): Bass808Style => (kitId === 'drill' ? '808-dist' : '808');

/** Tonique du morceau dans l'octave grave des 808 (Do 1 … Si 1, 32,7 – 61,7 Hz). */
export const bass808RootNote = (projectKey?: number | null) => {
  const pc = typeof projectKey === 'number' && Number.isFinite(projectKey) ? ((Math.round(projectKey) % 12) + 12) % 12 : 0;
  return 24 + pc;
};

/** Rythme de 808 proposé par kit (pas de 16e) : celui que jouait l'ancienne rangée 808. */
const KIT_808_STEPS: Record<string, number[]> = {
  trap: [0, 7, 10], drill: [0, 3, 6, 10, 13], rnb: [0, 10],
};

export interface Note808 { id: string; pitch: number; start: number; duration: number; velocity: number }

/**
 * Notes de départ de la piste 808 : la tonique du morceau, sur le rythme 808
 * du kit (sinon le premier temps de chaque mesure), tenue jusqu'au coup suivant.
 */
export function starter808Notes(opts: { projectKey?: number | null; bpm: number; bars: number; kitId?: string | null }): Note808[] {
  const step = 60 / (opts.bpm || 120) / 4;
  const pitch = bass808RootNote(opts.projectKey);
  const hits = KIT_808_STEPS[opts.kitId || ''] || [0];
  const notes: Note808[] = [];
  for (let b = 0; b < Math.max(1, opts.bars); b++) {
    hits.forEach((s, i) => {
      const next = i + 1 < hits.length ? hits[i + 1] : 16;
      notes.push({ id: `n808-${b}-${s}`, pitch, start: (b * 16 + s) * step, duration: (next - s) * step, velocity: 0.9 });
    });
  }
  return notes;
}

/** Une « voix » 808 : une attaque, éventuellement des glissés, un relâchement. */
export interface Voice808 {
  start: number;
  end: number;
  velocity: number;
  /** Hauteurs successives (la première à `start`, les suivantes = glissés). */
  steps: { t: number; pitch: number }[];
}

/**
 * Plan de jeu monophonique : les notes (temps absolus) deviennent des voix qui
 * ne se chevauchent jamais. Une note qui commence pendant la précédente :
 * glissé (si `glide`) sans réattaque, sinon elle coupe la précédente. Deux
 * notes collées (fin = début) se rejouent. Accord : la note la plus grave gagne.
 */
export function plan808(notes: { pitch: number; start: number; duration: number; velocity: number }[], glide: boolean): Voice808[] {
  const sorted = notes
    .filter(n => n.duration > 0 && Number.isFinite(n.start))
    .slice()
    .sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const voices: Voice808[] = [];
  let cur: Voice808 | null = null;
  const EPS = 1e-6;
  for (const n of sorted) {
    const end = n.start + n.duration;
    if (cur && n.start < cur.end - EPS) {
      const sameStart = n.start <= cur.start + EPS;
      if (glide || sameStart) {
        const last = cur.steps[cur.steps.length - 1];
        if (n.start <= last.t + EPS) last.pitch = n.pitch; else cur.steps.push({ t: n.start, pitch: n.pitch });
        if (sameStart) cur.velocity = Math.max(cur.velocity, n.velocity);
        // La nouvelle note mène : la voix s'arrête à sa fin.
        cur.end = sameStart ? Math.max(cur.end, end) : end;
        continue;
      }
      cur.end = n.start; // coupe la précédente
    }
    cur = { start: n.start, end, velocity: n.velocity, steps: [{ t: n.start, pitch: n.pitch }] };
    voices.push(cur);
  }
  return voices.filter(v => v.end > v.start + EPS);
}

export type Event808 =
  | { kind: 'start'; t: number; pitch: number; velocity: number }
  | { kind: 'glide'; t: number; pitch: number }
  | { kind: 'stop'; t: number };

/**
 * Événements d'un plan dans la fenêtre [from, to[, triés dans le temps (un
 * relâchement passe avant une attaque au même instant).
 */
export function events808(voices: Voice808[], from: number, to: number): Event808[] {
  const out: Event808[] = [];
  const inWin = (t: number) => t >= from && t < to;
  for (const v of voices) {
    if (v.end < from || v.start >= to) continue;
    v.steps.forEach((s, i) => {
      if (!inWin(s.t)) return;
      out.push(i === 0 ? { kind: 'start', t: s.t, pitch: s.pitch, velocity: v.velocity } : { kind: 'glide', t: s.t, pitch: s.pitch });
    });
    if (inWin(v.end)) out.push({ kind: 'stop', t: v.end });
  }
  const rank = { stop: 0, start: 1, glide: 2 } as const;
  return out.sort((a, b) => a.t - b.t || rank[a.kind] - rank[b.kind]);
}
