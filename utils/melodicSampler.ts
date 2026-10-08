/**
 * R18 · Sampler mélodique (FL : Sampler / DirectWave, Live : Simpler, Logic :
 * Quick Sampler) et R20 · instruments multi-échantillons (Live : Sampler,
 * Logic : Sampler, FL : DirectWave).
 *
 * La piste est une piste MIDI ordinaire avec `track.melodicSampler` : le
 * piano roll, l'enregistrement MIDI, le pitch bend et les CC de R16 marchent
 * tels quels. Une ancienne version de NOVA ignore le champ et joue les notes
 * au synthé (rien ne casse).
 *
 * Le son d'un sampler perso vit dans le registre audio (`msample-<id>`),
 * jamais dans l'état (Immer, historique) ; ProjectIO l'écrit dans le projet
 * (`audio/msample-<id>.wav`) et la collaboration l'envoie avec la piste
 * (services/Collab.contentBufferIds). Les instruments (piano, Rhodes…) sont
 * des fichiers du site (`public/instruments/<id>/`), chargés à la demande.
 *
 * Logique pure ici (testée dans tests/melodicSampler.test.ts).
 */

export interface MelodicSamplerSettings {
  version: 1;
  /** Sample perso (registre audio : `msample-<id>`). */
  sampleId?: string;
  /** Nom affiché du son (« Voix de Léo », « Pluck guitare »). */
  sampleName?: string;
  /** Durée du son (s), pour l'affichage. */
  duration?: number;
  /** Instrument multi-échantillons (R20) : id du préréglage (« piano », « rhodes »…). Prime sur le sample perso. */
  instrument?: string;
  /** Note racine du sample perso (MIDI) et accord fin (cents). */
  rootKey: number;
  fineTune: number;
  /** Note racine trouvée automatiquement (pitchAnalysis) : affichée « auto ». */
  rootAuto?: boolean;
  /** Début de la lecture (0-1 du son). */
  start?: number;
  /** Enveloppe ADSR (s ; sustain 0-1). */
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Boucle du sample perso (fractions 0-1 du son). */
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  /** Glissé entre deux notes (s), mode mono (une seule voix, legato) ou poly. */
  glide: number;
  mono: boolean;
  /** Filtre passe-bas (Hz) et résonance (Q). */
  cutoff: number;
  resonance: number;
  /** Sensibilité à la vélocité (0 = toutes les notes au même niveau). */
  velSens: number;
  /** Amplitude du pitch bend (demi-tons). */
  bendRange: number;
  /** Niveau de sortie (dB). */
  gainDb: number;
  /**
   * Tranches d'un chop « vers les notes » (FL Slicex, Live Slice) : chaque
   * tranche (fractions 0-1 du son) joue sans transposition sur sa note,
   * à partir de `sliceBase` (C3 = 48 par défaut). Absent : sampler chromatique.
   */
  slices?: { start: number; end: number }[];
  sliceBase?: number;
  /** Fichier du son dans un projet sauvegardé (le temps de la sauvegarde). */
  audioRef?: string;
}

export const DEFAULT_SAMPLER: MelodicSamplerSettings = {
  version: 1, rootKey: 60, fineTune: 0, attack: 0.003, decay: 0.3, sustain: 1, release: 0.25,
  loop: false, loopStart: 0.25, loopEnd: 0.9, glide: 0, mono: false, cutoff: 20000, resonance: 0.7,
  velSens: 0.7, bendRange: 2, gainDb: 0,
};

const num = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;

/** Réglages lus d'un projet ou d'un collaborateur : bornés, valeurs par défaut. */
export function normalizeSampler(s: Partial<MelodicSamplerSettings> | null | undefined): MelodicSamplerSettings {
  const x = (s || {}) as Partial<MelodicSamplerSettings>;
  const loopStart = num(x.loopStart, DEFAULT_SAMPLER.loopStart, 0, 0.99);
  return {
    version: 1,
    ...(typeof x.sampleId === 'string' && /^[\w-]{1,48}$/.test(x.sampleId) ? { sampleId: x.sampleId } : {}),
    ...(typeof x.sampleName === 'string' ? { sampleName: x.sampleName.slice(0, 48) } : {}),
    ...(typeof x.duration === 'number' && isFinite(x.duration) ? { duration: x.duration } : {}),
    ...(typeof x.instrument === 'string' && /^[a-z0-9-]{1,32}$/.test(x.instrument) ? { instrument: x.instrument } : {}),
    rootKey: Math.round(num(x.rootKey, 60, 0, 127)),
    fineTune: num(x.fineTune, 0, -100, 100),
    ...(x.rootAuto ? { rootAuto: true } : {}),
    ...(typeof x.start === 'number' && x.start > 0 ? { start: num(x.start, 0, 0, 0.95) } : {}),
    attack: num(x.attack, DEFAULT_SAMPLER.attack, 0, 5),
    decay: num(x.decay, DEFAULT_SAMPLER.decay, 0.005, 10),
    sustain: num(x.sustain, DEFAULT_SAMPLER.sustain, 0, 1),
    release: num(x.release, DEFAULT_SAMPLER.release, 0.005, 10),
    loop: !!x.loop,
    loopStart,
    loopEnd: Math.max(loopStart + 0.01, num(x.loopEnd, DEFAULT_SAMPLER.loopEnd, 0.01, 1)),
    glide: num(x.glide, 0, 0, 2),
    mono: !!x.mono,
    cutoff: num(x.cutoff, 20000, 40, 20000),
    resonance: num(x.resonance, 0.7, 0.1, 18),
    velSens: num(x.velSens, DEFAULT_SAMPLER.velSens, 0, 1),
    bendRange: Math.round(num(x.bendRange, 2, 0, 24)),
    gainDb: num(x.gainDb, 0, -24, 12),
    ...(Array.isArray(x.slices) && x.slices.length ? {
      slices: x.slices.slice(0, 64).map(t => ({ start: num(t?.start, 0, 0, 1), end: num(t?.end, 1, 0, 1) })).filter(t => t.end > t.start),
      sliceBase: Math.round(num(x.sliceBase, 48, 0, 120)),
    } : {}),
  };
}

export const SAMPLER_PREFIX = 'msample-';
export const samplerBufferKey = (id: string) => `${SAMPLER_PREFIX}${id}`;
export const newSamplerSampleId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ===== Zones (multi-échantillons) =====

/** Zone d'un instrument : un échantillon, ses notes et ses vélocités (manifeste de R20). */
export interface SamplerZone {
  /** Fichier (relatif au dossier de l'instrument) ou clé du registre audio. */
  file: string;
  /** Note racine (MIDI) et correction en cents à ajouter à la lecture. */
  root: number;
  tune?: number;
  /** Notes couvertes (incluses). */
  lo: number;
  hi: number;
  /** Vélocités couvertes (1-127, incluses). */
  velLo: number;
  velHi: number;
  /** Round-robin : index de la prise (0 = une seule). */
  rr?: number;
  /** Boucle (s dans l'échantillon). */
  loopStart?: number;
  loopEnd?: number;
  /** Début et fin jouées (s) : tranches d'un chop, début du sample perso. */
  offset?: number;
  end?: number;
  /** Tranche : jouée seulement sur sa note (pas de transposition des voisines). */
  exact?: boolean;
}

/**
 * Zone à jouer pour une note : celles qui couvrent la note et la vélocité ;
 * sinon la couche de vélocité la plus proche ; sinon la note la plus proche.
 * Plusieurs prises (round-robin) : `rrCounter` choisit à tour de rôle.
 */
export function pickZone<Z extends SamplerZone>(zones: Z[], pitch: number, vel127: number, rrCounter = 0): Z | null {
  if (!zones.length) return null;
  // Tranches : seulement leur propre note.
  if (zones[0].exact) return zones.find(z => pitch >= z.lo && pitch <= z.hi) || null;
  const v = Math.max(1, Math.min(127, Math.round(vel127)));
  let inKey = zones.filter(z => pitch >= z.lo && pitch <= z.hi);
  if (!inKey.length) {
    // Hors de la tessiture : l'échantillon dont la racine est la plus proche.
    let best = Infinity;
    zones.forEach(z => { const dd = Math.min(Math.abs(pitch - z.lo), Math.abs(pitch - z.hi)); if (dd < best) best = dd; });
    inKey = zones.filter(z => Math.min(Math.abs(pitch - z.lo), Math.abs(pitch - z.hi)) === best);
  }
  let layer = inKey.filter(z => v >= z.velLo && v <= z.velHi);
  if (!layer.length) {
    let best = Infinity;
    inKey.forEach(z => { const dd = v < z.velLo ? z.velLo - v : v - z.velHi; if (dd < best) best = dd; });
    layer = inKey.filter(z => (v < z.velLo ? z.velLo - v : v - z.velHi) === best);
  }
  // Plusieurs racines possibles (zones qui se chevauchent) : la plus proche de la note.
  const nearest = Math.min(...layer.map(z => Math.abs(pitch - z.root)));
  const pool = layer.filter(z => Math.abs(pitch - z.root) === nearest).sort((a, b) => (a.rr || 0) - (b.rr || 0));
  return pool[((rrCounter % pool.length) + pool.length) % pool.length] || null;
}

/** Vitesse de lecture d'une note sur une zone (accord fin et hauteur de la note compris). */
export function playbackRateFor(pitch: number, root: number, cents = 0): number {
  return Math.pow(2, (pitch - root + cents / 100) / 12);
}

/** Gain d'une vélocité (0-1) selon la sensibilité (0 = fixe). */
export const velocityGain = (velocity: number, sens: number) => {
  const v = Math.max(0, Math.min(1, velocity));
  return (1 - sens) + sens * v * v;
};

/** Note racine d'une hauteur mesurée (Hz) : note MIDI et écart en cents (à corriger : -écart). */
export function rootFromFrequency(freq: number): { midi: number; cents: number } | null {
  if (!(freq > 20 && freq < 5000)) return null;
  const m = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(m);
  return { midi, cents: Math.round((m - midi) * 1000) / 10 };
}

/** Nom d'une note MIDI (60 → « C4 », comme FL et Live). */
export function noteName(midi: number): string {
  const n = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((midi % 12) + 12) % 12];
  return `${n}${Math.floor(midi / 12) - 1}`;
}

/** Zones d'un sample perso : une zone chromatique, ou une zone par tranche (chop vers les notes). */
export function sampleZones(s: MelodicSamplerSettings, duration: number): SamplerZone[] {
  const file = s.sampleId ? samplerBufferKey(s.sampleId) : '';
  if (s.slices?.length) {
    const base = s.sliceBase ?? 48;
    return s.slices.map((t, i) => ({
      file, root: base + i, tune: 0, lo: base + i, hi: base + i, velLo: 1, velHi: 127, exact: true,
      offset: t.start * duration, end: t.end * duration,
    }));
  }
  return [{
    file, root: s.rootKey, tune: s.fineTune, lo: 0, hi: 127, velLo: 1, velHi: 127,
    ...(s.start ? { offset: s.start * duration } : {}),
    ...(s.loop && duration > 0 ? { loopStart: s.loopStart * duration, loopEnd: s.loopEnd * duration } : {}),
  }];
}

// ===== Tranches sur des notes (chop « vers les notes ») =====

/** Notes chromatiques des tranches d'un chop sur le sampler : la tranche 1 sur `base` (C3 = 48 par défaut). */
export const sliceNote = (sliceIndex: number, base = 48) => base + sliceIndex;
