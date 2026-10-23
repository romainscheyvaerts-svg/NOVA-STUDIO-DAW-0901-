import { describe, it, expect } from 'vitest';
import { TrackType, type Clip, type Track } from '../types';
import { followTempo, type FollowState } from '../utils/tempoFollow';
import { noteFrameTime, noteRenderTimes } from '../utils/noteTiming';
import { Synthesizer } from '../engine/Synthesizer';

/**
 * Temps musical (qa/tempo_musical) : un projet passé de 90 à 140 BPM (« garder les notes en
 * musique ») et le même projet écrit directement à 140 BPM doivent sonner pareil AU BIT PRÈS.
 * Les positions en secondes diffèrent d'un ulp à une demi-nanoseconde (tempoFollow arrondit à la
 * nanoseconde, l'autre chemin multiplie directement) : les instants programmés, eux, sont posés
 * sur l'échantillon (utils/noteTiming) et doivent être IDENTIQUES, à l'export comme en lecture.
 */

const TS = { numerator: 4, denominator: 4 };
const BEAT0 = 60 / 90;

const track = (id: string, type: TrackType, clips: Clip[]): Track => ({ id, name: id, type, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 0.9, pan: 0, outputTrackId: 'master', sends: [], clips, plugins: [], automationLanes: [], totalLatency: 0 });
const clip = (id: string, type: TrackType, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({ id, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: id, color: '#0ff', type, ...extra });

/** Le projet du scénario : 16 doubles-croches à partir de la mesure 2, un sample à la mesure 3. */
function projet90(): FollowState {
  const notes = Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, pitch: 60 + (i * 5) % 12, start: i * BEAT0 / 4, duration: BEAT0 / 4 * (1 + i % 3) * 0.9, velocity: 0.8 }));
  return {
    bpm: 90, timeSignature: TS, tempoEvents: [], markers: [], loopStart: 4 * BEAT0, loopEnd: 12 * BEAT0,
    tracks: [
      track('piano', TrackType.MIDI, [clip('c-piano', TrackType.MIDI, 4 * BEAT0, 8 * BEAT0, { notes })]),
      track('sample', TrackType.AUDIO, [clip('c-sample', TrackType.AUDIO, 8 * BEAT0, 0.5, { bufferId: 'b' })]),
    ],
  };
}

/** Le même projet écrit DIRECTEMENT à `bpm` (calcul du scénario : secondes × 90 / bpm). */
function projetDirect(bpm: number): Clip {
  const k = 90 / bpm, c = projet90().tracks[0].clips[0];
  return { ...c, start: 4 * BEAT0 * k, duration: 8 * BEAT0 * k,
    notes: c.notes!.map((n, i) => ({ ...n, start: i * BEAT0 / 4 * k, duration: BEAT0 / 4 * (1 + i % 3) * 0.9 * k })) };
}

const changeTempo = (bpm: number): Clip => followTempo(projet90(), { bpm }, { keepAudio: false }).state.tracks[0].clips[0];

describe('instants des notes posés sur l’échantillon (utils/noteTiming)', () => {
  it('90 → 140 BPM par le changement de tempo = projet écrit à 140 BPM : mêmes instants au bit près', () => {
    const a = changeTempo(140), b = projetDirect(140);
    // Les deux chemins ne donnent PAS les mêmes secondes (c'était la cause du défaut)…
    const brut = a.notes!.filter((n, i) => a.start + n.start !== b.start + b.notes![i].start || n.duration !== b.notes![i].duration);
    expect(brut.length).toBeGreaterThan(8);
    expect(a.start).not.toBe(b.start);
    // … mais les instants programmés sont identiques, quelle que soit la fréquence ou le départ.
    for (const sr of [44100, 48000, 96000])
      for (const from of [0, 0.37, 1.9])
        for (const lat of [0, Math.round(0.003 * sr) / sr])
          a.notes!.forEach((n, i) => {
            const x = noteRenderTimes(a.start, n, from, lat, 14, sr), y = noteRenderTimes(b.start, b.notes![i], from, lat, 14, sr);
            expect(x.attackAt).toBe(y.attackAt);
            expect(x.releaseAt).toBe(y.releaseAt);
            expect(Math.abs(x.attackAt * sr - Math.round(x.attackAt * sr))).toBeLessThan(1e-6); // sur un échantillon
            // Justesse : au plus une demi-période d'échantillonnage.
            if (x.noteStart > 0) expect(Math.abs(x.attackAt - x.noteStart)).toBeLessThanOrEqual(0.5 / sr + 1e-12);
          });
  });

  it('tous les tempos de 60 à 200 BPM : mêmes instants que le projet écrit directement', () => {
    for (let bpm = 60; bpm <= 200; bpm += 7) {
      const a = changeTempo(bpm), b = projetDirect(bpm);
      a.notes!.forEach((n, i) => {
        const x = noteRenderTimes(a.start, n, 0, 0, 60, 48000), y = noteRenderTimes(b.start, b.notes![i], 0, 0, 60, 48000);
        expect([bpm, i, x.attackAt, x.releaseAt]).toEqual([bpm, i, y.attackAt, y.releaseAt]);
      });
    }
  });

  it('lecture (fenêtres de programmation) = export : même échantillon pour chaque note', () => {
    const sr = 48000, c = changeTempo(140), from = 0.5;
    const origin = noteFrameTime(12.3456789, sr);          // instant du contexte où joue `from`
    for (const win of [0.025, 0.1, 0.2]) {
      c.notes!.forEach(n => {
        const abs = c.start + n.start;
        const ws = from + Math.floor((abs - from) / win) * win; // fenêtre où la note est programmée
        const cst = origin + (ws - from);                      // comme scheduleMidi
        const live = noteFrameTime(cst + (abs - ws), sr);
        const off = noteRenderTimes(c.start, n, from, 0, 30, sr).attackAt;
        expect(Math.round(live * sr) - Math.round(origin * sr)).toBe(Math.round(off * sr));
      });
    }
  });
});

// --- Synthétiseur simple : fin de voix à zéro exact, sommation dans un ordre fixe ---------------

class Param {
  ev: [string, number, number][] = [];
  value = 1;
  setValueAtTime(v: number, t: number) { this.ev.push(['set', v, t]); }
  linearRampToValueAtTime(v: number, t: number) { this.ev.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v: number, t: number) { this.ev.push(['exp', v, t]); }
  cancelAndHoldAtTime(t: number) { this.ev.push(['hold', 0, t]); }
  cancelScheduledValues(t: number) { this.ev.push(['cancel', 0, t]); }
}
let ids = 0;
const node = (kind: string, extra: object = {}) => ({ id: ++ids, kind, outs: [] as any[], connect(n: any) { this.outs.push(n); return n; }, disconnect() { this.outs = []; }, ...extra });
function fakeCtx() {
  const oscs: any[] = [];
  const ctx: any = {
    currentTime: 0,
    createGain: () => node('gain', { gain: new Param() }),
    createBiquadFilter: () => node('filter', { frequency: new Param(), Q: new Param(), detune: new Param() }),
    createOscillator: () => { const o = node('osc', { frequency: new Param(), detune: new Param(), t0: NaN, t1: Infinity, start(t: number) { this.t0 = t; }, stop(t: number) { this.t1 = t; } }); oscs.push(o); return o; },
  };
  return { ctx, oscs };
}

/** Joue un clip comme l'export (attaque puis relâchement de chaque note) ; relevé des voix. */
function play(c: Clip, sr: number) {
  const { ctx, oscs } = fakeCtx();
  const s = new Synthesizer(ctx);
  for (const n of c.notes!) {
    const t = noteRenderTimes(c.start, n, 0, 0, 30, sr);
    s.triggerAttack(n.pitch, n.velocity, t.attackAt);
    s.triggerRelease(n.pitch, t.releaseAt);
  }
  return { s, oscs, voices: oscs.map(o => { const filter = o.outs[0], env = filter.outs[0]; return { t0: o.t0, t1: o.t1, env, sum: env.outs[0] }; }) };
}

describe('Synthesizer : même son au bit près d’un rendu à l’autre', () => {
  it('chaque voix est à zéro exact quand son oscillateur s’arrête (débranchement sans effet sur le son)', () => {
    const { voices } = play(changeTempo(140), 48000);
    expect(voices.length).toBe(16);
    for (const v of voices) {
      const last = v.env.gain.ev[v.env.gain.ev.length - 1];
      expect(last).toEqual(['lin', 0, v.t1]);
    }
  });

  it('au plus une voix sonore par emplacement : chaque noeud n’additionne que deux signaux', () => {
    // Accords de 4 notes qui se chevauchent + motif du scénario : beaucoup de voix simultanées.
    const c = changeTempo(140);
    const chords: Clip = { ...c, notes: Array.from({ length: 24 }, (_, i) => ({ id: `a${i}`, pitch: 48 + (i % 4) * 4 + Math.floor(i / 4), start: Math.floor(i / 4) * 0.15, duration: 0.4, velocity: 0.7 })) };
    for (const clipX of [c, chords]) {
      const { voices } = play(clipX, 48000);
      const bySum = new Map<any, typeof voices>();
      voices.forEach(v => bySum.set(v.sum, [...(bySum.get(v.sum) || []), v]));
      for (const vs of bySum.values()) {
        const sorted = [...vs].sort((x, y) => x.t0 - y.t0);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i].t0).toBeGreaterThanOrEqual(sorted[i - 1].t1);
      }
      // Chaîne : chaque emplacement va vers le précédent, le premier vers la sortie.
      const sums = [...new Set(voices.map(v => v.sum))];
      expect(sums.length).toBeGreaterThan(1);
      sums.forEach(sum => expect(sum.outs.length).toBe(1));
    }
  });

  it('les deux chemins programment les mêmes voix, aux mêmes instants, dans les mêmes emplacements', () => {
    const sig = (c: Clip) => { const { voices } = play(c, 48000); const order = [...new Set(voices.map(v => v.sum))];
      return voices.map(v => [v.t0, v.t1, order.indexOf(v.sum), JSON.stringify(v.env.gain.ev)]); };
    expect(sig(changeTempo(140))).toEqual(sig(projetDirect(140)));
  });
});
