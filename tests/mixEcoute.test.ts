// @vitest-environment jsdom
/**
 * Outils d'écoute d'un ingé de mix (21/10/2026) :
 *  - section d'écoute : mono (−6 dB), côtés (S), Dim −20 dB, coupure, volume (utils/monitorSection) ;
 *  - polarité Ø par piste (tête de tranche, engine/meters/channelStrip) : elle, va à l'export ;
 *  - solo d'écoute AFL / PFL avec bus, VCA et solo safe (utils/soloListen) ;
 *  - l'export ne dépend d'AUCUN réglage d'écoute ;
 *  - réverbe : réponse impulsionnelle importée (utils/userIr), sauvée avec le projet, envoyée en collaboration.
 */
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIM_DB, applyMonitor, isMonitorNeutral, monitorBadges, monitorCoefs, monitorGain, monitorStore, NEUTRAL_MONITOR, type MonitorState,
} from '../utils/monitorSection';
import { listenTaps, liveSoloSilenced, tracksForRender } from '../utils/soloListen';
import { soloSilencedIds } from '../utils/soloMute';
import { engineView, makeVcaTrack } from '../utils/trackStructure';
import { buildStrip } from '../engine/meters/channelStrip';
import { irCalibration, shapeIr, trackUserIrKeys, userIrKey, isUserIrKey, USER_IR_MAX_SEC } from '../utils/userIr';
import { trackBufferIds } from '../utils/freeze';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { TrackType, type Track } from '../types';
import { makeState, makeTrack } from './helpers/fixtures';
import { makeBuffer } from './helpers/audio';
import { runEditCommand } from '../utils/editCommands';
import { installMonitorCommands } from '../utils/monitorCommands';
import { KEYMAP } from '../utils/keymap';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const ROOT = path.resolve(__dirname, '..');
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 1. Section d'écoute ────────────────────────────────────────────────────

describe('section d’écoute : mono, côtés, Dim, coupure, volume', () => {
  const S = (p: Partial<MonitorState>): MonitorState => ({ ...NEUTRAL_MONITOR, ...p });
  const L = Float32Array.from([0.8, 0.3, -0.5, 0.2]);
  const R = Float32Array.from([0.8, -0.3, 0.5, 0.6]);

  it('stéréo neutre : le son passe tel quel', () => {
    const [l, r] = applyMonitor(L, R, S({}));
    expect(Array.from(l)).toEqual(Array.from(L));
    expect(Array.from(r)).toEqual(Array.from(R));
    expect(isMonitorNeutral(S({}))).toBe(true);
  });

  it('mono = (G + D) / 2 dans les deux enceintes (−6 dB) : un son centré garde son niveau, l’opposition de phase s’annule', () => {
    expect(monitorCoefs('mono')).toEqual({ ll: 0.5, rl: 0.5, lr: 0.5, rr: 0.5 });
    const [l, r] = applyMonitor(L, R, S({ matrix: 'mono' }));
    for (let i = 0; i < L.length; i++) {
      expect(close(l[i], (L[i] + R[i]) / 2)).toBe(true);
      expect(l[i]).toBe(r[i]);
    }
    // Centré (G = D) : inchangé. Opposition de phase (G = −D) : silence.
    expect(close(l[0], 0.8)).toBe(true);
    expect(close(l[1], 0)).toBe(true);
    expect(close(l[2], 0)).toBe(true);
  });

  it('côtés (S) = (G − D) / 2 : le centre disparaît, l’opposition de phase reste', () => {
    const [l, r] = applyMonitor(L, R, S({ matrix: 'side' }));
    for (let i = 0; i < L.length; i++) { expect(close(l[i], (L[i] - R[i]) / 2)).toBe(true); expect(l[i]).toBe(r[i]); }
    expect(close(l[0], 0)).toBe(true);
    expect(close(l[1], 0.3)).toBe(true);
    // M² + S² = (G² + D²) / 2 : rien ne se perd entre les deux écoutes.
    const [m] = applyMonitor(L, R, S({ matrix: 'mono' }));
    for (let i = 0; i < L.length; i++) expect(close(m[i] ** 2 + l[i] ** 2, (L[i] ** 2 + R[i] ** 2) / 2)).toBe(true);
  });

  it('Dim = −20 dB pile, coupure = silence, volume d’écoute en dB borné', () => {
    expect(DIM_DB).toBe(-20);
    expect(close(monitorGain(S({ dim: true })), 0.1, 1e-9)).toBe(true);
    expect(monitorGain(S({ cut: true, dim: true }))).toBe(0);
    expect(close(monitorGain(S({ volumeDb: -6 })), Math.pow(10, -6 / 20))).toBe(true);
    expect(close(monitorGain(S({ volumeDb: -6, dim: true })), Math.pow(10, -26 / 20))).toBe(true);
    expect(monitorGain(S({ volumeDb: 40 }))).toBeCloseTo(Math.pow(10, 6 / 20), 9);
    const [l] = applyMonitor(L, R, S({ dim: true }));
    expect(close(l[0], 0.08)).toBe(true);
  });

  it('pastilles : tout réglage actif se voit (mono, côtés, Dim, coupure, volume, AFL / PFL)', () => {
    expect(monitorBadges(S({}), 'sip', false)).toEqual([]);
    const ids = monitorBadges(S({ matrix: 'mono', dim: true, cut: true, volumeDb: -10 }), 'afl', true).map(b => b.id);
    expect(ids).toEqual(['cut', 'mono', 'dim', 'afl']); // volume : masqué quand l'écoute est coupée
    expect(monitorBadges(S({ matrix: 'side', volumeDb: -10 }), 'pfl', false).map(b => b.id)).toEqual(['side', 'vol']);
    for (const b of monitorBadges(S({ matrix: 'mono', dim: true, cut: true }), 'pfl', true)) expect(b.title).toMatch(/export|mix/);
  });

  it('magasin : mono / Dim / coupure repartent à zéro à l’ouverture ; le mode de solo et le volume restent (poste)', () => {
    localStorage.clear();
    monitorStore.reload();
    monitorStore.set({ matrix: 'mono', dim: true, cut: true, volumeDb: -12, listen: 'afl' });
    expect(localStorage.getItem('nova_solo_listen')).toBe('afl');
    expect(localStorage.getItem('nova_monitor_volume_db')).toBe('-12');
    monitorStore.reload();
    const s = monitorStore.get();
    expect([s.matrix, s.dim, s.cut, s.volumeDb, s.listen]).toEqual(['stereo', false, false, -12, 'afl']);
    monitorStore.set({ listen: 'sip', volumeDb: 0 });
  });

  it('raccourcis et palette : Alt+M, Ctrl+Alt+D, Alt+X et les 3 modes de solo passent par le bus de commandes', () => {
    localStorage.clear(); monitorStore.reload();
    installMonitorCommands();
    const keys = (id: string) => KEYMAP.find(k => k.id === id)?.keys;
    expect(keys('mon.mono')).toEqual(['alt+m']);
    expect(keys('mon.dim')).toEqual(['ctrl+alt+d']);
    expect(keys('mon.cut')).toEqual(['alt+x']);
    expect(runEditCommand('monitorMono')).toBe(true);
    expect(monitorStore.get().matrix).toBe('mono');
    runEditCommand('monitorSide');
    expect(monitorStore.get().matrix).toBe('side');
    runEditCommand('monitorDim'); runEditCommand('monitorCut');
    expect([monitorStore.get().dim, monitorStore.get().cut]).toEqual([true, true]);
    runEditCommand('monitorReset');
    expect(isMonitorNeutral(monitorStore.get())).toBe(true);
    runEditCommand('soloListen', { mode: 'pfl' });
    expect(monitorStore.get().listen).toBe('pfl');
    runEditCommand('soloListen', { mode: 'sip' });
    expect(monitorStore.get().listen).toBe('sip');
  });
});

// ── 2. Polarité Ø par piste (déjà dans NOVA : tête de tranche, lecture ET export) ──

/** Mini moteur Web Audio (gains, séparateur, fusion) pour vérifier la matrice de la tête de tranche. */
class FakeParam { value = 1; setValueAtTime(v: number) { this.value = v; } setTargetAtTime(v: number) { this.value = v; } cancelScheduledValues() { /* */ } }
type Edge = { from: FakeNode; out: number; inp: number };
class FakeNode {
  ins: Edge[] = [];
  gain = new FakeParam();
  channelCount = 2; channelCountMode = 'max'; channelInterpretation = 'speakers';
  constructor(public kind: 'gain' | 'split' | 'merge' | 'src', public frame: number[] = []) {}
  connect(dest: FakeNode, out = 0, inp = 0) { dest.ins.push({ from: this, out, inp }); return dest; }
  disconnect() { /* */ }
}
const mix = (chs: number[][], n: number): number[] => {
  const out = new Array(n).fill(0);
  for (const c of chs) {
    if (c.length === n) c.forEach((v, i) => { out[i] += v; });
    else if (c.length === 1 && n === 2) { out[0] += c[0]; out[1] += c[0]; }
    else if (c.length === 2 && n === 1) out[0] += 0.5 * (c[0] + c[1]);
  }
  return out;
};
function evalNode(n: FakeNode, out = 0): number[] {
  if (n.kind === 'src') return n.frame;
  const inputs = (inp?: number) => n.ins.filter(e => inp === undefined || e.inp === inp).map(e => evalNode(e.from, e.out));
  if (n.kind === 'gain') {
    const ch = n.channelCountMode === 'explicit' ? n.channelCount : Math.max(1, ...inputs().map(c => c.length));
    return mix(inputs(), ch).map(v => v * n.gain.value);
  }
  if (n.kind === 'split') return [mix(inputs(), 2)[out]];
  return [mix(inputs(0), 1)[0], mix(inputs(1), 1)[0]];
}
const fakeCtx = { currentTime: 0, createGain: () => new FakeNode('gain'), createChannelSplitter: () => new FakeNode('split'), createChannelMerger: () => new FakeNode('merge') } as unknown as BaseAudioContext;
function throughStrip(t: Partial<Track>, l: number, r: number): number[] {
  const s = buildStrip(fakeCtx, t)!;
  const src = new FakeNode('src', [l, r]);
  src.connect(s.input as unknown as FakeNode);
  return evalNode(s.output as unknown as FakeNode);
}

describe('polarité Ø par piste (tête de tranche)', () => {
  it('Ø inverse les deux canaux, exactement', () => {
    const [l, r] = throughStrip({ phaseInvert: true }, 0.3, -0.7);
    expect(close(l, -0.3)).toBe(true);
    expect(close(r, 0.7)).toBe(true);
  });
  it('Ø + mono : −(G + D) / 2 ; piste neutre : aucun nœud ajouté', () => {
    const [l, r] = throughStrip({ phaseInvert: true, monoSum: true }, 0.3, -0.7);
    expect(close(l, 0.2) && close(r, 0.2)).toBe(true);
    expect(buildStrip(fakeCtx, {})).toBeNull();
  });
  it('l’export câble la même tête de tranche que la lecture (Ø compris)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'engine/AudioEngine.ts'), 'utf8');
    expect(src).toMatch(/const strip = buildStrip\(offlineCtx, track\)/);
    expect(src).toMatch(/dsp\.strip = buildStrip\(this\.ctx, track\)/);
  });
});

// ── 3. Solo AFL / PFL ──────────────────────────────────────────────────────

const src = (id: string, o: Partial<Track> = {}) => makeTrack({ id, name: id, type: TrackType.AUDIO, outputTrackId: 'master', ...o });
const bus = (id: string, o: Partial<Track> = {}) => makeTrack({ id, name: id, type: TrackType.BUS, outputTrackId: 'master', ...o });
const master = () => bus('master', { outputTrackId: '' });
const isSource = (t: Track) => t.type === TrackType.AUDIO || t.type === TrackType.MIDI;

describe('solo d’écoute AFL / PFL', () => {
  it('solo dans le mix : rien sur le bus d’écoute, la règle d’avant (pistes coupées, solo safe respecté)', () => {
    const tr = [master(), src('voix', { isSolo: true }), src('beat'), src('clic', { soloSafe: true })];
    expect(listenTaps(tr, 'sip')).toEqual([]);
    expect([...liveSoloSilenced(tr, isSource, 'sip')]).toEqual(['beat']);
  });

  it('AFL : après fader ; PFL : avant fader ; rien n’est coupé dans le mix', () => {
    const tr = [master(), src('voix', { isSolo: true }), src('beat'), src('clic', { soloSafe: true })];
    expect(listenTaps(tr, 'afl')).toEqual([{ id: 'voix', point: 'post' }]);
    expect(listenTaps(tr, 'pfl')).toEqual([{ id: 'voix', point: 'pre' }]);
    expect(liveSoloSilenced(tr, isSource, 'afl').size).toBe(0);
    expect(liveSoloSilenced(tr, isSource, 'pfl').size).toBe(0);
  });

  it('bus : soloer un bus fait entendre sa sortie ; une piste qui y passe n’est pas prélevée en double', () => {
    const tr = [master(), bus('bus-voix', { isSolo: true }), src('lead', { outputTrackId: 'bus-voix', isSolo: true }),
      src('back', { outputTrackId: 'bus-voix' }), bus('rev', { isSolo: false }), src('beat', { isSolo: true })];
    expect(listenTaps(tr, 'afl').map(t => t.id).sort()).toEqual(['beat', 'bus-voix']);
    // Chaîne de bus : piste → sous-bus → bus en solo : prélevée une fois, au bout.
    const chain = [master(), bus('b2', { isSolo: true }), bus('b1', { outputTrackId: 'b2' }), src('x', { outputTrackId: 'b1', isSolo: true })];
    expect(listenTaps(chain, 'pfl')).toEqual([{ id: 'b2', point: 'pre' }]);
    // Envoi vers une réverbe : la voix est prélevée seule ; le retour seulement s'il est en solo.
    const send = [master(), bus('rev'), src('v', { isSolo: true, sends: [{ id: 'rev', level: 0.5, isEnabled: true }] as any })];
    expect(listenTaps(send, 'afl').map(t => t.id)).toEqual(['v']);
  });

  it('VCA : soloer le VCA prélève ses pistes (vue du moteur) ; le VCA lui-même n’a pas de son', () => {
    const vca = { ...makeVcaTrack({ id: 'vca-voix', name: 'VCA voix' }), isSolo: true };
    const tr = [master(), vca, src('lead', { vcaId: 'vca-voix' } as any), src('back', { vcaId: 'vca-voix' } as any), src('beat')];
    const view = engineView(tr).tracks;
    expect(listenTaps(view, 'afl').map(t => t.id).sort()).toEqual(['back', 'lead']);
    expect(liveSoloSilenced(view, isSource, 'afl').size).toBe(0);
    // En solo dans le mix, le même VCA coupe le beat (comportement d'avant inchangé).
    expect([...liveSoloSilenced(view, isSource, 'sip')]).toEqual(['beat']);
  });

  it('solo safe : sans objet en AFL / PFL (jamais ajouté à l’écoute sans être en solo)', () => {
    const tr = [master(), src('voix', { isSolo: true }), bus('rev', { soloSafe: true }), src('clic', { soloSafe: true })];
    expect(listenTaps(tr, 'afl').map(t => t.id)).toEqual(['voix']);
  });

  it('le master n’est jamais prélevé ; sans solo, rien', () => {
    expect(listenTaps([{ ...master(), isSolo: true }, src('a')], 'afl')).toEqual([]);
    expect(listenTaps([master(), src('a')], 'pfl')).toEqual([]);
  });
});

// ── 4. L'export ne dépend d'aucun réglage d'écoute ─────────────────────────

describe('export identique avec et sans écoute (mono, Dim, coupure, AFL / PFL)', () => {
  const project = () => {
    const vca = { ...makeVcaTrack({ id: 'vca', name: 'VCA' }), isSolo: true };
    return [master(), vca, bus('bus', { isSolo: true }), src('lead', { outputTrackId: 'bus', vcaId: 'vca' } as any), src('beat', { isSolo: true }), src('clic', { soloSafe: true })];
  };
  const noSolo = () => project().map(t => ({ ...t, isSolo: false }));

  it('AFL / PFL : les pistes rendues sont celles du mix SANS aucun solo (pistes, bus, VCA)', () => {
    for (const mode of ['afl', 'pfl'] as const) {
      const out = tracksForRender(project(), mode);
      expect(out).toEqual(noSolo());
      // Ce que le rendu coupe : rien.
      expect(soloSilencedIds(engineView(out).tracks, isSource).size).toBe(0);
    }
  });

  it('solo dans le mix : le rendu garde le solo, comme avant (même tableau)', () => {
    const p = project();
    expect(tracksForRender(p, 'sip')).toBe(p);
  });

  it('la section d’écoute est hors du rendu : renderProject ne lit ni mono, ni Dim, ni volume d’écoute', () => {
    const eng = fs.readFileSync(path.join(ROOT, 'engine/AudioEngine.ts'), 'utf8');
    const start = eng.indexOf('public async renderProject(');
    const end = eng.indexOf('\n  public ', start + 10);
    expect(end).toBeGreaterThan(start);
    const body = eng.slice(start, end);
    expect(body).toContain('tracksForRender(tracks, monitorStore.get().listen)');
    for (const banned of ['monOut', 'monMain', 'monSolo', 'monSum', 'monitorGain(', 'monitorCoefs(', 'listenBus', 'applyMonitor', 'volumeDb']) expect(body.includes(banned), banned).toBe(false);
    // La sortie d'écoute est branchée APRÈS les mètres du master (mainOut → section → sortie).
    expect(eng).toMatch(/this\.mainOut\.connect\(this\.monMain\)/);
    expect(eng).toMatch(/this\.monOut!\.connect\(this\.browserOutput\)/);
  });

  it('export (ExportPipeline) : solos d’écoute retirés à l’entrée, ceux des stems / voix seules respectés', () => {
    const ep = fs.readFileSync(path.join(ROOT, 'services/ExportPipeline.ts'), 'utf8');
    expect(ep.match(/tracksForRender\(withoutGuides\(allTracks\), monitorStore\.get\(\)\.listen\)/g)?.length).toBe(2);
    expect(ep).toContain('{ soloIsDeliberate: true }');
  });
});

// ── 5. Réverbe : réponse impulsionnelle importée ───────────────────────────

describe('réponse impulsionnelle importée (mise en forme)', () => {
  const SR = 48000;
  const decaying = (n: number, seed = 1) => { const a = new Float32Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 16807) % 2147483647; a[i] = ((x / 2147483647) * 2 - 1) * Math.exp(-i / (SR * 0.4)); } return a; };

  it('mono → stéréo, longueur rognée, fondu en cosinus jusqu’à 0', () => {
    const ir = decaying(SR * 2);
    const out = shapeIr([ir], SR, { lengthSec: 0.5, fadeSec: 0.1 });
    expect(out.length).toBe(2);
    expect(out[0].length).toBe(SR / 2);
    expect(Array.from(out[0])).toEqual(Array.from(out[1]));
    expect(Math.abs(out[0][out[0].length - 1])).toBe(0);
    const k = irCalibration([ir], SR);
    // Avant le fondu : échantillons identiques à la réponse × calibration.
    for (const i of [0, 100, 12000, SR * 0.39]) expect(close(out[0][i], ir[i] * k, 1e-5)).toBe(true);
  });

  it('niveau calibré sur la réponse ENTIÈRE : raccourcir ne fait pas monter le niveau', () => {
    const ir = [decaying(SR * 3, 7), decaying(SR * 3, 9)];
    const full = shapeIr(ir, SR, { fadeSec: 0 });
    const short = shapeIr(ir, SR, { lengthSec: 0.3, fadeSec: 0 });
    for (const i of [0, 50, 5000]) expect(short[0][i]).toBe(full[0][i]);
  });

  it('calibration = règle du convolveur de Chrome (1 / RMS, −58 dB, ramenée à 44,1 kHz)', () => {
    const ir = new Float32Array(1000).fill(0.5);
    expect(irCalibration([ir], 44100)).toBeCloseTo((1 / 0.5) * Math.pow(10, -58 / 20), 9);
    expect(irCalibration([ir], 48000)).toBeCloseTo((1 / 0.5) * Math.pow(10, -58 / 20) * 44100 / 48000, 9);
    expect(Number.isFinite(irCalibration([new Float32Array(10)], SR))).toBe(true);
  });

  it('jamais plus de USER_IR_MAX_SEC ; plus de 2 canaux : les deux premiers', () => {
    const long = new Float32Array(Math.round((USER_IR_MAX_SEC + 3) * 1000)).fill(0.1);
    expect(shapeIr([long], 1000)[0].length).toBe(USER_IR_MAX_SEC * 1000);
    const four = [1, 2, 3, 4].map(v => new Float32Array(10).fill(v));
    const o = shapeIr(four, 1000, { fadeSec: 0 });
    expect(o[1][0] / o[0][0]).toBeCloseTo(2, 9);
  });
});

describe('réponse importée : projet, mémoire, collaboration', () => {
  beforeEach(() => audioBufferRegistry.clear());
  const key = userIrKey('test1');
  const withIr = () => makeTrack({ id: 'rev-bus', type: TrackType.BUS, plugins: [
    { id: 'p1', type: 'REVERB', name: 'Réverbe', isEnabled: true, params: { mix: 1, irUser: key, irName: 'Ma salle', irLength: 1.2, irFade: 0.2 } } as any,
    { id: 'p2', type: 'REVERB', name: 'Réverbe 2', isEnabled: true, params: { mix: 1 } } as any,
  ] });

  it('clés : reconnues, listées par piste, gardées par la mémoire (trackBufferIds)', () => {
    expect(isUserIrKey(key)).toBe(true);
    expect(isUserIrKey('buffer-123')).toBe(false);
    expect(trackUserIrKeys(withIr())).toEqual([key]);
    expect(trackBufferIds(withIr())).toContain(key);
  });

  it('sauvegarde .zip : un WAV, la référence dans le réglage ; réouverture : le son revient sous la même clé', async () => {
    const { ProjectIO } = await import('../services/ProjectIO');
    audioBufferRegistry.register(makeBuffer(2, 4410, 44100, (c, i) => (i === 0 ? 0.9 : Math.exp(-i / 800) * 0.2 * (c ? -1 : 1))), key);
    const st = makeState([withIr()]);
    const blob = await ProjectIO.saveProject(st, []);
    const zip = await JSZip.loadAsync(blob);
    const files = Object.keys(zip.files).filter(f => !zip.files[f].dir);
    expect(files).toContain('audio/userir-test1.wav');
    const json = JSON.parse(await zip.file('project.json')!.async('string'));
    expect(json.tracks[0].plugins[0].params.irAudioRef).toBe('audio/userir-test1.wav');
    expect(json.tracks[0].plugins[0].params.irUser).toBe(key);
    audioBufferRegistry.clear();
    const loaded = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const pp = (loaded.tracks[0].plugins[0].params as any);
    expect(pp.irAudioRef).toBeUndefined();
    expect(pp.irUser).toBe(key);
    expect(pp.irLength).toBe(1.2);
    const b = audioBufferRegistry.get(key)!;
    expect(b.length).toBe(4410);
    expect(b.numberOfChannels).toBe(2);
    expect(Math.abs(b.getChannelData(0)[0] - 0.9)).toBeLessThan(1e-3);
  });

  it('collaboration : le son de la réponse part avec le contenu de la piste', async () => {
    const { contentBufferIds, contentOf } = await import('../services/Collab');
    expect(contentBufferIds(withIr())).toContain(key);
    expect((contentOf(withIr()) as any).userIrs).toEqual([key]);
    // Sans réponse importée : contenu identique à celui d'une version précédente (champ absent).
    expect('userIrs' in (contentOf(makeTrack({ id: 'a' })) as any)).toBe(false);
  });

  it('le registre prévient la réverbe quand le son arrive (collaboration, ouverture)', () => {
    let n = 0;
    const off = audioBufferRegistry.whenRegistered(key, () => { n++; });
    expect(n).toBe(0);
    audioBufferRegistry.register(makeBuffer(1, 10), key);
    audioBufferRegistry.register(makeBuffer(1, 10), key);
    expect(n).toBe(1);
    off();
    let m = 0;
    audioBufferRegistry.whenRegistered(key, () => { m++; });
    expect(m).toBe(1);
  });
});
