import { describe, it, expect } from 'vitest';
import { TrackType, type AutomationLane, type Clip, type Track } from '../types';
import { ENV_BLOCK_SEC, blockPeaks, envSourcesOf, envUnit, envUnitAt, followEnvelope } from '../utils/envelopeFollower';
import { defaultEnvFollower, modulateLane, modulatedLanes, sanitizeModulators, envelopeOf, type Modulator } from '../utils/modulators';
import { playedLanes, valueAtPoints } from '../utils/automationWrite';
import { buildTempoMap } from '../utils/tempoMap';

/**
 * Suiveur d'enveloppe (modulateur, 22/10/2026) : le niveau d'une piste source pilote un réglage.
 * Crêtes par bloc de 1 ms des clips (gain, fondus), attaque / relâchement exacts, 0…1 en dB,
 * ajouté à la voie comme un LFO (même courbe en lecture et à l'export), source cherchée dans le projet.
 */
const SR = 48000;
const fakeBuffer = (x: Float32Array): AudioBuffer => ({ numberOfChannels: 1, sampleRate: SR, length: x.length, duration: x.length / SR, getChannelData: () => x } as unknown as AudioBuffer);
/** Grosse caisse : 1,0 pendant 20 ms toutes les 0,5 s (sur 4 s), silence ailleurs. */
function kicks(seconds = 4, every = 0.5, len = 0.02, amp = 1): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let t = 0; t < seconds; t += every) for (let i = 0; i < len * SR; i++) x[Math.round(t * SR) + i] = amp;
  return x;
}
const audioClip = (x: Float32Array, over: Partial<Clip> = {}): Clip => ({
  id: 'c-kick', type: TrackType.AUDIO, start: 0, duration: x.length / SR, offset: 0, fadeIn: 0, fadeOut: 0, gain: 1, name: 'kick', color: '#fff',
  buffer: fakeBuffer(x), ...over,
} as Clip);
const lane = (parameterName: string, min: number, max: number): AutomationLane =>
  ({ id: `l-${parameterName}`, parameterName, color: '#fff', isExpanded: false, min, max, points: [] } as AutomationLane);
const trackOf = (id: string, extra: Partial<Track> = {}): Track => ({
  id, name: id, type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
  outputTrackId: 'master', sends: [], clips: [], automationLanes: [], totalLatency: 0, plugins: [], ...extra,
});
const map = buildTempoMap(120, { numerator: 4, denominator: 4 }, []);

describe('suiveur d’enveloppe : mesure du niveau', () => {
  it('crête par bloc de 1 ms : grosse caisse aux bons blocs, gain et décalage du clip compris', () => {
    const src = envSourcesOf(trackOf('k', { clips: [audioClip(kicks(), { gain: 0.5 })] }), c => c.buffer);
    const pk = blockPeaks(src, 4);
    expect(pk.length).toBe(Math.ceil(4 / ENV_BLOCK_SEC));
    expect(pk[5]).toBeCloseTo(0.5, 6);          // 5 ms : dans le coup
    expect(pk[100]).toBe(0);                    // 100 ms : silence
    expect(pk[505]).toBeCloseTo(0.5, 6);        // 2e coup
    // Clip posé à 1 s, lu depuis 0,5 s dans le son : le 2e coup du son tombe à 1,0 s du morceau.
    const moved = blockPeaks(envSourcesOf(trackOf('k', { clips: [audioClip(kicks(), { start: 1, offset: 0.5, duration: 1 })] }), c => c.buffer), 4);
    expect(moved[1005]).toBeCloseTo(1, 6);
    expect(moved[505]).toBe(0);
    expect(moved[2505]).toBe(0);                // après la fin du clip
    // Clip muet, clip MIDI : ignorés.
    expect(envSourcesOf(trackOf('k', { clips: [audioClip(kicks(), { isMuted: true })] }), c => c.buffer)).toHaveLength(0);
  });

  it('attaque et relâchement : constantes de temps exactes (63,2 % en `attaque`, 36,8 % après `relâchement`)', () => {
    const step = new Float32Array(1000); step.fill(1, 0, 500);
    const e = followEnvelope(step, 10, 100);
    expect(e[9]).toBeCloseTo(1 - Math.exp(-1), 3);              // 10 ms après le début
    const top = e[499];
    expect(e[599] / top).toBeCloseTo(Math.exp(-1), 3);          // 100 ms après la fin
    const inst = followEnvelope(step, 0, 1);
    expect(inst[0]).toBe(1);                                     // attaque 0 : immédiat
  });

  it('niveau → 0…1 : −60 dBFS = 0, −6 dBFS = 0,9, 0 dBFS = 1 ; suiveur en dB, interpolé entre deux blocs', () => {
    expect(envUnit(0)).toBe(0);
    expect(envUnit(0.001)).toBeCloseTo(0, 6);
    expect(envUnit(0.5)).toBeCloseTo(1 - 6.0206 / 60, 4);
    expect(envUnit(1)).toBe(1);
    expect(envUnit(2)).toBe(1);
    const env = followEnvelope(new Float32Array([0.5, 0.5, 1, 1]), 0, 0);
    expect(env[0]).toBeCloseTo(envUnit(0.5), 6);
    expect(envUnitAt(env, 0.002)).toBeCloseTo((envUnit(0.5) + 1) / 2, 6);
    // Relâchement en dB : 120 ms après un coup à 0 dBFS suivi du silence, 36,8 % de la course reste (pas 0,8 s de traîne).
    const hit = new Float32Array(1000); hit[0] = 1;
    const r = followEnvelope(hit, 0, 120);
    expect(r[120]).toBeCloseTo(Math.exp(-1), 2);
    expect(r[500]).toBeLessThan(0.02);
  });
});

describe('suiveur d’enveloppe : modulation d’un réglage', () => {
  const kickTrack = trackOf('kick', { clips: [audioClip(kicks())] });
  const fol = (over: Partial<Modulator> = {}): Modulator => ({ ...defaultEnvFollower('volume', 'kick', 'env1'), attack: 1, release: 50, depth: 0.5, polarity: 'down', ...over });

  it('la grosse caisse creuse le volume de la basse pendant chaque coup, rien entre les coups', () => {
    const env = envelopeOf(kickTrack, fol(), 4)!;
    const pts = modulateLane(lane('volume', 0, 1.5), 1, [fol()], map, 4, () => env)!;
    // Plage 50 % de 0…1,5 = 0,75 ; coup à 0 dBFS (u ≈ 1) : 1 − 0,75 ≈ 0,25.
    for (const k of [0, 1, 2, 3, 4, 5]) expect(valueAtPoints(pts, k * 0.5 + 0.015, 1)).toBeLessThan(0.3);
    for (const k of [0, 1, 2, 3, 4, 5]) expect(valueAtPoints(pts, k * 0.5 + 0.45, 1)).toBeCloseTo(1, 3);
    // Paliers plats gardés par leurs deux bouts : moins de points que la grille de 5 ms (800 sur 4 s).
    const fast = fol({ release: 10 });
    const sparse = modulateLane(lane('volume', 0, 1.5), 1, [fast], map, 4, () => envelopeOf(kickTrack, fast, 4))!;
    expect(sparse.length).toBeLessThan(300);
    expect(valueAtPoints(sparse, 0.3, 1)).toBe(1);
  });

  it('« pousse » / « autour » / plage 0 ; borné à la plage du réglage', () => {
    const env = envelopeOf(kickTrack, fol(), 4)!;
    const up = modulateLane(lane('volume', 0, 1.5), 0.2, [fol({ polarity: 'up' })], map, 4, () => env)!;
    expect(valueAtPoints(up, 0.015, 0)).toBeGreaterThan(0.9);
    expect(valueAtPoints(up, 0.45, 0)).toBeCloseTo(0.2, 3);
    const bi = modulateLane(lane('pan', -1, 1), 0, [fol({ target: 'pan', polarity: 'bi', depth: 1 })], map, 4, () => env)!;
    expect(valueAtPoints(bi, 0.45, 0)).toBeCloseTo(-1, 3);       // silence : u = 0 → −plage/2
    expect(modulateLane(lane('volume', 0, 1.5), 1, [fol({ depth: 0 })], map, 4, () => env)).toBeNull();
    const sat = modulateLane(lane('volume', 0, 1.5), 0.1, [fol({ depth: 1 })], map, 4, () => env)!;
    expect(Math.min(...sat.map(p => p.value))).toBeGreaterThanOrEqual(0);
  });

  it('dans playedLanes (lecture ET export) : source cherchée dans le projet ; recalcul quand ses clips changent', () => {
    let project: Track[] = [kickTrack];
    const resolve = (id: string) => project.find(t => t.id === id);
    const bass = trackOf('basse', { automationLanes: [lane('volume', 0, 1.5)], modulators: [fol()] });
    const a = modulatedLanes(bass, playedLanes({ automationLanes: bass.automationLanes }), map, 4, resolve);
    expect(valueAtPoints(a[0].points, 0.515, 1)).toBeLessThan(0.3);
    // Même entrée : même tableau (mémorisé, rien recalculé pendant la lecture).
    expect(modulatedLanes(bass, playedLanes({ automationLanes: bass.automationLanes }), map, 4, resolve)).toBe(a);
    // La grosse caisse déplacée de 0,25 s : la courbe suit.
    project = [{ ...kickTrack, clips: [{ ...kickTrack.clips[0], start: 0.25 }] }];
    const b = modulatedLanes(bass, playedLanes({ automationLanes: bass.automationLanes }), map, 4, resolve);
    expect(b).not.toBe(a);
    expect(valueAtPoints(b[0].points, 0.2, 1)).toBeCloseTo(1, 3);
    expect(valueAtPoints(b[0].points, 0.265, 1)).toBeLessThan(0.3);
    // Source introuvable ou sans son : le réglage ne bouge pas.
    project = [];
    const c = modulatedLanes(bass, playedLanes({ automationLanes: bass.automationLanes }), map, 4, resolve);
    expect(c[0].points).toHaveLength(0);
  });

  it('sauvegarde : le suiveur et ses réglages survivent, bornés (attaque ≤ 500 ms, relâchement ≤ 3 s)', () => {
    const [m] = sanitizeModulators([{ ...fol(), attack: 9999, release: -5 }]);
    expect(m).toMatchObject({ kind: 'env', source: 'kick', attack: 500, release: 1, depth: 0.5, polarity: 'down', target: 'volume' });
    const [lfo] = sanitizeModulators([{ id: 'x', target: 'volume', kind: 'env' }]);
    expect(lfo.kind).toBeUndefined();   // suiveur sans source : redevient un LFO neutre
  });
});
