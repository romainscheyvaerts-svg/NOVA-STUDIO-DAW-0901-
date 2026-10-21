import { arpSequence, arpRateBeats } from '../../services/MidiEffectsService';
import { quartersToTime, tempoAt, timeToQuarters, type TempoMap } from '../../utils/tempoMap';
import { applyMidiFx, type MidiFxSlot, type ProjectKey } from './index';

/**
 * L3 · Effets MIDI au clavier, en direct : un accord tenu donne un arpège, une
 * fausse note tombe dans la gamme, une touche joue un accord.
 *
 * Léger : rien ne tourne au repos. Un minuteur (25 ms, programmation 100 ms à
 * l'avance sur l'horloge audio) ne vit que tant qu'une touche est tenue sur
 * une piste avec arpège. En lecture, les pas tombent sur la grille du morceau
 * (piste tempo comprise) ; à l'arrêt, le premier pas part tout de suite.
 *
 * Les notes enregistrées restent celles jouées (les effets s'appliquent à la
 * lecture, comme sur une tranche d'instrument). Entrées / sorties injectées
 * (services/MidiInput) : module testable sans carte son (tests/midiFx.test.ts).
 */

export interface LiveIO {
  attack(trackId: string, pitch: number, velocity: number, at: number): void;
  release(trackId: string, pitch: number, at: number): void;
  /** Horloge audio (s). */
  now(): number;
  /** Instant du MORCEAU (s) à l'instant audio `ctxT` pendant la lecture, sinon null. */
  songAt(ctxT: number): number | null;
  map(): TempoMap;
  key(): ProjectKey | null;
}

interface ArpRun { timer: ReturnType<typeof setInterval> | null; next: number; counter: number; anchor: number | null; stepSec: number; startQ: number | null }

const LOOKAHEAD = 0.1;

/** Notes d'une seule touche après les effets SANS l'arpège (gamme, accord). */
function mapPitch(pitch: number, slots: MidiFxSlot[], key: ProjectKey | null, map: TempoMap): number[] {
  const out = applyMidiFx([{ id: 'k', pitch, start: 0, duration: 1, velocity: 1 }], slots.filter(s => s.on && s.type !== 'arp'), { clipStart: 0, clipDuration: 1, map, key, seed: 'live' });
  return Array.from(new Set(out.map(n => n.pitch)));
}

export class LiveMidiFx {
  private fx = new Map<string, MidiFxSlot[]>();
  /** Touches tenues par piste : hauteur jouée → vélocité, ordre d'appui. */
  private held = new Map<string, Map<number, { vel: number; order: number }>>();
  /** Sans arpège : touche → notes déclenchées (pour les relâcher). */
  private sounding = new Map<string, Map<number, number[]>>();
  private runs = new Map<string, ArpRun>();
  private order = 0;

  /** Effets ACTIFS de la piste (aucun : la piste passe en direct, comme avant). */
  setTrackFx(trackId: string, slots: MidiFxSlot[] | undefined) {
    const on = (slots || []).filter(s => s.on);
    if (on.length) this.fx.set(trackId, on);
    else { this.fx.delete(trackId); this.stopArp(trackId); }
  }

  has(trackId: string): boolean { return this.fx.has(trackId); }

  /** Minuteurs en marche (0 au repos : rien ne tourne). */
  activeTimers(): number { let n = 0; this.runs.forEach(r => { if (r.timer) n++; }); return n; }

  noteOn(trackId: string, pitch: number, velocity: number, io: LiveIO) {
    const slots = this.fx.get(trackId);
    if (!slots) { io.attack(trackId, pitch, velocity, io.now()); return; }
    const arpAt = slots.findIndex(s => s.type === 'arp');
    if (arpAt < 0) {
      const outs = mapPitch(pitch, slots, io.key(), io.map());
      const by = this.sounding.get(trackId) || new Map<number, number[]>();
      this.sounding.set(trackId, by);
      const prev = by.get(pitch);
      if (prev) prev.forEach(p => io.release(trackId, p, io.now()));
      const t = io.now();
      outs.forEach(p => io.attack(trackId, p, velocity, t));
      by.set(pitch, outs);
      return;
    }
    const h = this.held.get(trackId) || new Map();
    this.held.set(trackId, h);
    h.set(pitch, { vel: velocity, order: this.order++ });
    this.startArp(trackId, io);
  }

  noteOff(trackId: string, pitch: number, io: LiveIO) {
    const by = this.sounding.get(trackId);
    const outs = by?.get(pitch);
    if (outs) { outs.forEach(p => io.release(trackId, p, io.now())); by!.delete(pitch); return; }
    const h = this.held.get(trackId);
    if (h && h.has(pitch)) { h.delete(pitch); if (!h.size) this.stopArp(trackId); return; }
    // Touche jouée avant la pose des effets : relâchée telle quelle.
    io.release(trackId, pitch, io.now());
  }

  panic(io?: LiveIO) {
    this.runs.forEach((_, id) => this.stopArp(id));
    if (io) this.sounding.forEach((by, id) => by.forEach(ps => ps.forEach(p => io.release(id, p, io.now()))));
    this.sounding.clear();
    this.held.clear();
  }

  private stopArp(trackId: string) {
    const r = this.runs.get(trackId);
    if (r?.timer) clearInterval(r.timer);
    this.runs.delete(trackId);
  }

  private startArp(trackId: string, io: LiveIO) {
    if (this.runs.get(trackId)?.timer) return;
    const run: ArpRun = { timer: null, next: 0, counter: 0, anchor: null, stepSec: 0.25, startQ: null };
    this.runs.set(trackId, run);
    this.tick(trackId, io);
    run.timer = setInterval(() => this.tick(trackId, io), 25);
  }

  /** Programme les pas des 100 prochaines millisecondes. */
  private tick(trackId: string, io: LiveIO) {
    const run = this.runs.get(trackId);
    const slots = this.fx.get(trackId);
    const h = this.held.get(trackId);
    if (!run || !slots || !h || !h.size) { this.stopArp(trackId); return; }
    const arpIdx = slots.findIndex(s => s.type === 'arp');
    const arp = slots[arpIdx]?.arp || { rate: '1/8', pattern: 'UP', octaves: 1, gate: 90 };
    const pre = slots.slice(0, arpIdx), post = slots.slice(arpIdx + 1);
    const map = io.map(), key = io.key();
    const stepQ = arpRateBeats(arp.rate) || 0.5;
    const now = io.now();
    const song = io.songAt(now);
    // Grille : celle du morceau en lecture, sinon un pas libre parti de la première touche.
    const stepTime = (k: number): number => {
      if (song !== null) return now + (quartersToTime(map, k * stepQ) - song);
      return (run.anchor as number) + k * run.stepSec;
    };
    if (run.anchor === null && song === null) { run.anchor = now; run.stepSec = (60 / tempoAt(map, 0)) * stepQ; run.next = 0; }
    if (song !== null && run.startQ === null) { run.startQ = timeToQuarters(map, song); run.next = Math.ceil(run.startQ / stepQ - 1e-6); }
    for (let guard = 0; guard < 64; guard++) {
      const at = stepTime(run.next);
      if (at > now + LOOKAHEAD) break;
      const k = run.next++;
      if (at < now - 0.05) continue; // pas manqué (onglet en arrière-plan) : on ne rattrape pas
      const keys = [...h.entries()].sort((a, b) => (arp.pattern === 'ORDER' ? a[1].order - b[1].order : a[0] - b[0]));
      const pitches = Array.from(new Set(keys.flatMap(([p]) => mapPitch(p, pre, key, map))));
      const seq = arpSequence(pitches, arp.pattern === 'RANDOM' ? 'UP' : arp.pattern, arp.octaves);
      if (!seq.length) continue;
      const idx = arp.pattern === 'RANDOM' ? Math.floor(Math.random() * seq.length) : run.counter % seq.length;
      run.counter++;
      const vel = Math.max(...keys.map(([, v]) => v.vel));
      const len = Math.max(0.005, (stepTime(k + 1) - at) * Math.max(5, Math.min(100, arp.gate)) / 100);
      const t0 = Math.max(at, now);
      for (const p of mapPitch(seq[idx], post, key, map)) {
        io.attack(trackId, p, vel, t0);
        io.release(trackId, p, t0 + len);
      }
    }
  }
}

export const liveMidiFx = new LiveMidiFx();
