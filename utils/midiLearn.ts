/**
 * MIDI Learn (R16), comme le « Link to controller » de FL Studio, le MIDI
 * Map de Live et le MIDI Learn des plugins de Pro Tools : un bouton ou un
 * fader de ton clavier pilote un réglage de NOVA (volume, pan, réglage
 * d'effet). Clique « Apprendre », bouge le bouton, c'est relié.
 *
 * Les assignations sont gardées dans les préférences de cet appareil (elles
 * suivent ton clavier, pas le projet).
 *
 * Logique pure + petite mémoire : tests/midiLearn.test.ts.
 */

export type LearnKind = 'volume' | 'pan' | 'param';

export interface LearnTarget {
  kind: LearnKind;
  trackId: string;
  /** Réglage d'effet : effet et réglage. */
  pluginId?: string;
  paramId?: string;
  min?: number;
  max?: number;
  /** Libellé lisible (« BEAT · Volume »). */
  label: string;
}

export interface LearnMapping {
  id: string;
  /** Canal 1-16 (0 = tous). */
  channel: number;
  cc: number;
  target: LearnTarget;
}

const KEY = 'nova.midiLearn';

export const sameTarget = (a: LearnTarget, b: LearnTarget) =>
  a.kind === b.kind && a.trackId === b.trackId && (a.pluginId || '') === (b.pluginId || '') && (a.paramId || '') === (b.paramId || '');

/** CC 0-127 → volume de piste (0-1,5) : CC 100 = 0 dB, CC 127 ≈ +2 dB (loi du volume MIDI). */
export const ccToVolume = (v: number): number => {
  const x = Math.max(0, Math.min(127, v)) / 100;
  return Math.min(1.5, x * x);
};

/** CC 0-127 → pan −1…1 (64 = centre). */
export const ccToPan = (v: number): number => {
  const c = Math.max(0, Math.min(127, v));
  return c === 64 ? 0 : c < 64 ? (c - 64) / 64 : (c - 64) / 63;
};

/** Valeur du réglage pour un CC reçu. */
export function learnValue(t: LearnTarget, cc: number): number {
  if (t.kind === 'volume') return ccToVolume(cc);
  if (t.kind === 'pan') return ccToPan(cc);
  const min = t.min ?? 0, max = t.max ?? 1;
  return min + (Math.max(0, Math.min(127, cc)) / 127) * (max - min);
}

export interface LearnHit { mapping: LearnMapping; value: number }

export class MidiLearnStore {
  mappings: LearnMapping[] = [];
  /** Réglage en attente d'un bouton (« Apprendre » cliqué). */
  learning: LearnTarget | null = null;
  private listeners = new Set<() => void>();
  private storage: Pick<Storage, 'getItem' | 'setItem'> | null;

  constructor(storage?: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.storage = storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : storage;
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(this.storage?.getItem(KEY) || '[]');
      if (Array.isArray(raw)) this.mappings = raw.filter(m => m && typeof m.cc === 'number' && m.target && typeof m.target.trackId === 'string');
    } catch { this.mappings = []; }
  }

  private save() {
    try { this.storage?.setItem(KEY, JSON.stringify(this.mappings)); } catch { /* stockage indisponible */ }
    this.listeners.forEach(f => { try { f(); } catch { /* */ } });
  }

  subscribe(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }

  startLearn(target: LearnTarget) { this.learning = target; this.save(); }
  cancelLearn() { this.learning = null; this.save(); }

  remove(id: string) { this.mappings = this.mappings.filter(m => m.id !== id); this.save(); }
  clear() { this.mappings = []; this.save(); }

  mappingFor(target: LearnTarget): LearnMapping | undefined { return this.mappings.find(m => sameTarget(m.target, target)); }

  /**
   * Un CC est arrivé. En apprentissage : il est relié au réglage attendu (un
   * bouton ne pilote qu'un réglage, un réglage qu'un bouton). Sinon : les
   * réglages reliés et leur nouvelle valeur.
   */
  handleCc(channel: number, cc: number, value: number): { learned?: LearnMapping; hits: LearnHit[] } {
    if (this.learning) {
      const target = this.learning;
      this.learning = null;
      const m: LearnMapping = { id: `ml-${Date.now().toString(36)}-${cc}`, channel, cc, target };
      this.mappings = [...this.mappings.filter(x => !sameTarget(x.target, target) && !(x.cc === cc && (x.channel === channel || x.channel === 0 || channel === 0))), m];
      this.save();
      return { learned: m, hits: [{ mapping: m, value: learnValue(target, value) }] };
    }
    const hits = this.mappings
      .filter(m => m.cc === cc && (m.channel === 0 || m.channel === channel))
      .map(m => ({ mapping: m, value: learnValue(m.target, value) }));
    return { hits };
  }
}

export const midiLearn = new MidiLearnStore();
