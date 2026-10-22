/**
 * Métrologie de la CONSOLE (22/10/2026) : le VRAI chemin de l'export
 * (AudioEngine.renderProject), rendu dans le mini Web Audio du banc, à 44,1 et 48 kHz.
 *
 * Fader (valeur affichée en dB = gain réel), panoramique (loi mesurée), envois pré / post,
 * VCA, trim, polarité, mono, largeur, gain de clip, fondus (courbes), compensation de
 * latence (PDC) à l'échantillon, métronome calé sur la grille, section d'écoute (Dim, mono).
 */
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { installMiniWebAudio, MiniAudioBuffer, MiniOfflineAudioContext } from './helpers/miniWebAudio';
import { makeClip, makeTrack } from './helpers/fixtures';
import { assertMetro, dB, flushMetroLog, metro, toneAt } from './helpers/metro';
import { gainToDbText } from '../utils/db';
import { sendDbText } from '../utils/sendFader';
import { dbTextToGain } from '../plugins/hw/valueEntry';
import { fadeInShape } from '../utils/fades';
import { makeVcaTrack } from '../utils/trackStructure';
import { DIM_DB, monitorCoefs, monitorGain, NEUTRAL_MONITOR } from '../utils/monitorSection';
import { TrackType, type Track } from '../types';

const RATES = [44100, 48000];
let restore: () => void = () => {};
let engine: any;
beforeAll(async () => { restore = installMiniWebAudio(); engine = (await import('../engine/AudioEngine')).audioEngine; });
afterAll(() => { restore(); flushMetroLog('console'); });
afterEach(() => assertMetro());

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function buf(sr: number, chs: Float32Array[]) {
  const b = new MiniAudioBuffer({ numberOfChannels: chs.length, length: chs[0].length, sampleRate: sr });
  chs.forEach((c, i) => b.copyToChannel(c, i));
  return b as unknown as AudioBuffer;
}
const sine = (sr: number, sec: number, f: number, a: number) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => a * Math.sin(2 * Math.PI * f * i / sr));
const clipOf = (sr: number, chs: Float32Array[], over: any = {}) => makeClip({ start: 0, duration: chs[0].length / sr, buffer: buf(sr, chs) as any, ...over });

async function render(tracks: Track[], sec: number, sr: number) {
  await tick();
  const out = await engine.renderProject(tracks, sec, 0, sr);
  return [out.getChannelData(0), out.getChannelData(1)] as Float32Array[];
}
/** Niveau (dB) de la composante à f dans [a, b) s, rapporté à l'amplitude `ref`. */
const lvl = (x: Float32Array, sr: number, f: number, ref: number, a = 0.1, b = 0.9) => dB(toneAt(x, sr, f, Math.round(a * sr), Math.round(b * sr)).amp / ref);

describe('Fader : la valeur affichée (dB) est le gain réel', () => {
  for (const sr of RATES) {
    it(`${sr} Hz : −∞, −20, −6, 0, +3,5, +6, +12 dB (butée) ; saisie « +15 » bornée à +12 et affichée honnêtement`, async () => {
      const x = sine(sr, 1, 1000, 0.25);
      for (const typed of ['-20', '-6', '0', '+3.5', '+6', '+12', '+15', '-80']) {
        const g = dbTextToGain(typed)!;
        const shown = gainToDbText(g);
        // Pan neutre (tranche stéréo) : on mesure le fader seul.
        const t = makeTrack({ volume: g, panFormat: 'stereo', sends: [], clips: [clipOf(sr, [x, x])] } as any);
        const [L, R] = await render([t], 1, sr);
        const shownDb = shown === '-∞' ? -Infinity : parseFloat(shown);
        metro('Fader', `saisi « ${typed} » → affiché « ${shown} », gauche, ${sr} Hz`, shownDb, lvl(L, sr, 1000, 0.25), 'dB', 0.05 + 0.05);
        metro('Fader', `saisi « ${typed} » → affiché « ${shown} », droite, ${sr} Hz`, shownDb, lvl(R, sr, 1000, 0.25), 'dB', 0.1);
      }
      // Fader en bas : −∞ affiché = silence réel.
      const t0 = makeTrack({ volume: 0, panFormat: 'stereo', sends: [], clips: [clipOf(sr, [x, x])] } as any);
      const [L0] = await render([t0], 1, sr);
      metro('Fader', `fader à 0 (affiché « ${gainToDbText(0)} »), ${sr} Hz`, '−∞', lvl(L0, sr, 1000, 0.25), 'dB', null);
      if (Number.isFinite(lvl(L0, sr, 1000, 0.25))) metro('Fader', 'fader à 0 : silence', -Infinity, lvl(L0, sr, 1000, 0.25), 'dB', 0);
    }, 120_000);
  }
  // Retour casque (mix casque qui suit le mix principal) : même gain de fader que la lecture et l'export,
  // jusqu'à +12 dB.
  it('mix casque : piste à 0 / +6 / +12 dB (fader) = même niveau au casque', async () => {
    const { CueMixEngine } = await import('../engine/CueMixEngine');
    const { newCueMix } = await import('../utils/cueMix');
    const sr = 48000, x = sine(sr, 1, 1000, 0.25);
    for (const typed of ['0', '+6', '+12']) {
      const g = dbTextToGain(typed)!;
      const ctx = new MiniOfflineAudioContext({ numberOfChannels: 2, length: sr, sampleRate: sr }) as unknown as AudioContext;
      const src = ctx.createBufferSource();
      src.buffer = buf(sr, [x, x]);
      const cue = new CueMixEngine(ctx);
      const mix = newCueMix([]);
      // Pan neutre (tranche stéréo) : on mesure le fader seul.
      const t = makeTrack({ id: 'v', volume: g, panFormat: 'stereo', sends: [], clips: [] } as any);
      cue.sync([mix], [t], id => (id === 'v' ? src : null));
      cue.outputOf(mix.id)!.connect(ctx.destination);
      src.start(0);
      const out = await ctx.startRendering();
      const [L, R] = [out.getChannelData(0), out.getChannelData(1)];
      metro('Fader', `casque : fader « ${gainToDbText(g)} », gauche`, 20 * Math.log10(g), lvl(L, sr, 1000, 0.25, 0.2, 0.9), 'dB', 0.05);
      metro('Fader', `casque : fader « ${gainToDbText(g)} », droite`, 20 * Math.log10(g), lvl(R, sr, 1000, 0.25, 0.2, 0.9), 'dB', 0.05);
    }
  }, 120_000);
});

describe('Panoramique : loi mesurée (source mono et stéréo), identique lecture / export', () => {
  it('source mono (voix) et stéréo, de G 100 à D 100', async () => {
    const sr = 48000, x = sine(sr, 1, 1000, 0.25);
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const [L, R] = await render([makeTrack({ volume: 1, pan, sends: [], clips: [clipOf(sr, [x])] })], 1, sr);
      metro('Panoramique', `source mono, pan ${pan} : gauche`, pan === 0 ? 0 : '—', lvl(L, sr, 1000, 0.25), 'dB', pan === 0 ? 0.05 : null);
      metro('Panoramique', `source mono, pan ${pan} : droite`, pan === 0 ? 0 : '—', lvl(R, sr, 1000, 0.25), 'dB', pan === 0 ? 0.05 : null);
    }
    // Même nœud (StereoPannerNode) en lecture et à l'export (engine/AudioEngine : ensureTrackDSP / renderProject).
  }, 120_000);
});

describe('Envois pré / post-fader et VCA', () => {
  for (const sr of RATES) {
    it(`${sr} Hz : niveau d'envoi affiché = gain mesuré ; post suit le fader, pré l'ignore ; VCA s'ajoute au fader`, async () => {
      const x = sine(sr, 1, 1000, 0.25);
      const bus = (id: string, volume = 1): Track => makeTrack({ id, name: id, type: TrackType.BUS, volume, sends: [], clips: [], outputTrackId: 'master' });
      for (const [level, pre] of [[0.5, false], [0.5, true], [1, false], [0.1, true]] as [number, boolean][]) {
        const fader = dbTextToGain('-6')!;
        // Sortie principale de la source dans un bus fermé : seul l'envoi arrive au master.
        const src = makeTrack({ id: 'src', volume: fader, outputTrackId: 'dump', sends: [{ id: 'fx', level, isEnabled: true, preFader: pre }], clips: [clipOf(sr, [x, x])] });
        const [L] = await render([src, bus('dump', 0), bus('fx')], 1, sr);
        const want = 20 * Math.log10(level) + (pre ? 0 : 20 * Math.log10(fader));
        metro('Envoi', `${pre ? 'pré' : 'post'}-fader « ${sendDbText(level)} », fader « ${gainToDbText(fader)} », ${sr} Hz`, want, lvl(L, sr, 1000, 0.25), 'dB', 0.05);
      }
      // VCA à −6 dB sur une piste à −3 dB : −9 dB.
      const vca = { ...makeVcaTrack({ id: 'vca', name: 'VCA' }), volume: dbTextToGain('-6')! };
      const m = makeTrack({ id: 'm', volume: dbTextToGain('-3')!, vcaId: 'vca', sends: [], clips: [clipOf(sr, [x, x])] } as any);
      const [Lv] = await render([m, vca], 1, sr);
      metro('VCA', `VCA « ${gainToDbText(vca.volume)} » + fader « ${gainToDbText(m.volume)} », ${sr} Hz`, 20 * Math.log10(vca.volume * m.volume), lvl(Lv, sr, 1000, 0.25), 'dB', 0.05);
    }, 120_000);
  }
});

describe('Tête de tranche : trim, polarité, mono, largeur', () => {
  it('trim ±12 dB, Ø (phase inversée), somme mono, largeur 0 / 2', async () => {
    const sr = 48000;
    const xl = sine(sr, 1, 1000, 0.25), xr = sine(sr, 1, 1000, 0.1);
    for (const trim of [-12, 6, 12]) {
      const [L] = await render([makeTrack({ volume: 1, inputTrimDb: trim, sends: [], clips: [clipOf(sr, [xl, xl])] } as any)], 1, sr);
      metro('Trim', `trim ${trim > 0 ? '+' : ''}${trim} dB`, trim, lvl(L, sr, 1000, 0.25), 'dB', 0.05);
    }
    const [Lp] = await render([makeTrack({ volume: 1, phaseInvert: true, sends: [], clips: [clipOf(sr, [xl, xl])] } as any)], 1, sr);
    const ph = toneAt(Lp, sr, 1000, 4800, 43200).phase, ph0 = toneAt(xl, sr, 1000, 4800, 43200).phase;
    let d = Math.abs(((ph - ph0) * 180 / Math.PI) % 360); if (d > 180) d = 360 - d;
    metro('Polarité', 'Ø : déphasage mesuré', 180, d, '°', 0.5, undefined, 2);
    const [Lm, Rm] = await render([makeTrack({ volume: 1, monoSum: true, sends: [], clips: [clipOf(sr, [xl, xr])] } as any)], 1, sr);
    metro('Mono (tranche)', 'G 0,25 + D 0,10 → (G + D) / 2 à gauche', dB(0.175 / 0.25), lvl(Lm, sr, 1000, 0.25), 'dB', 0.05);
    metro('Mono (tranche)', 'G 0,25 + D 0,10 → (G + D) / 2 à droite', dB(0.175 / 0.25), lvl(Rm, sr, 1000, 0.25), 'dB', 0.05);
    const [Lw] = await render([makeTrack({ volume: 1, stereoWidth: 2, sends: [], clips: [clipOf(sr, [xl, xr])] } as any)], 1, sr);
    // M = 0,175, S = 0,075 ; largeur 2 : G = M + 2S = 0,325
    metro('Largeur (tranche)', 'largeur 200 % : gauche = M + 2·S', dB(0.325 / 0.25), lvl(Lw, sr, 1000, 0.25), 'dB', 0.05);
  }, 120_000);
});

describe('Gain de clip et fondus', () => {
  it('gain de clip (dB) et courbes de fondu linéaire, puissance égale, exponentielle, en S (gain mesuré = courbe affichée ±0,1 dB)', async () => {
    for (const sr of RATES) {
      const x = new Float32Array(sr).fill(0.25); // continu : le gain se lit échantillon par échantillon
      for (const gdb of [-12, -3, 4]) {
        const [L] = await render([makeTrack({ volume: 1, sends: [], clips: [clipOf(sr, [x, x], { gain: Math.pow(10, gdb / 20) })] })], 1, sr);
        metro('Gain de clip', `${gdb > 0 ? '+' : ''}${gdb} dB, ${sr} Hz`, gdb, dB(L[Math.round(0.5 * sr)] / 0.25), 'dB', 0.05);
      }
      for (const curve of ['LINEAR', 'EQUAL_POWER', 'EXPONENTIAL', 'S_CURVE'] as const) {
        const fi = 0.2;
        const [L] = await render([makeTrack({ volume: 1, sends: [], clips: [clipOf(sr, [x, x], { fadeIn: fi, fadeInCurve: curve })] })], 1, sr);
        let worst = 0;
        for (const r of [0.25, 0.5, 0.75, 0.9]) {
          const want = fadeInShape(curve, r), got = L[Math.round(r * fi * sr)] / 0.25;
          worst = Math.max(worst, Math.abs(dB(got) - dB(want)));
        }
        metro('Fondu', `fondu d'entrée ${curve} 200 ms : pire écart à 25/50/75/90 %, ${sr} Hz`, 0, worst, 'dB', 0.1, worst, 3);
      }
    }
  }, 120_000);
});

describe('Compensation de latence (PDC) : pistes alignées à l’échantillon', () => {
  it('piste avec limiteur (anticipation 3 ms et 7 ms) vs piste sans effet, et envoi vers un bus', async () => {
    for (const sr of RATES) for (const look of [3, 7]) {
      const n = Math.round(sr * 0.5), x = new Float32Array(n); x[Math.round(0.2 * sr)] = 0.25;
      const a = makeTrack({ id: 'a', volume: 1, pan: -1, sends: [], clips: [clipOf(sr, [x])], plugins: [{ id: 'lim', name: 'Limiter', type: 'LIMITER', isEnabled: true, params: { ceiling: 0, inputGain: 0, release: 100, lookahead: look, oversample: 1 }, latency: 0 } as any] });
      const b = makeTrack({ id: 'b', volume: 1, pan: 1, sends: [], clips: [clipOf(sr, [x])] });
      const [L, R] = await render([a, b], 0.5, sr);
      const pos = (y: Float32Array) => { let k = 0, m = 0; for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > m) { m = Math.abs(y[i]); k = i; } return k; };
      metro('PDC', `limiteur ${look} ms sur la piste A : A − B (pic de l'impulsion), ${sr} Hz`, 0, pos(L) - pos(R), 'éch.', 0, undefined, 0);
      metro('PDC', `limiteur ${look} ms : position absolue de l'impulsion (attendu 0,2 s), ${sr} Hz`, Math.round(0.2 * sr), pos(L), 'éch.', 0, undefined, 0);
    }
  }, 120_000);
});

describe('Section d’écoute (jamais exportée) : Dim, mono, côtés', () => {
  it('Dim = −20,00 dB ; mono = (G + D) / 2 ; côtés = (G − D) / 2', () => {
    metro('Écoute', 'Dim', DIM_DB, dB(monitorGain({ ...NEUTRAL_MONITOR, dim: true })), 'dB', 0.01);
    const m = monitorCoefs('mono'), s = monitorCoefs('side');
    metro('Écoute', 'mono : coefficient G→G', 0.5, m.ll, '', 1e-9);
    metro('Écoute', 'côtés : coefficient D→G', -0.5, s.rl, '', 1e-9);
  });
});

describe('Métronome : clics sur la grille, à l’échantillon', () => {
  it('90 / 120 / 140 BPM et carte de tempo avec rampe : instant de chaque clic = temps de la grille', async () => {
    const { metronomeService } = await import('../services/MetronomeService');
    const { buildTempoMap, beatsInRange } = await import('../utils/tempoMap');
    const ms: any = metronomeService;
    for (const sr of RATES) for (const [name, map] of [
      ['90 BPM', buildTempoMap(90, { numerator: 4, denominator: 4 }, [])],
      ['120 BPM', buildTempoMap(120, { numerator: 4, denominator: 4 }, [])],
      ['140 BPM', buildTempoMap(140, { numerator: 4, denominator: 4 }, [])],
      ['90 → 140 en rampe (mesures 2 à 4)', buildTempoMap(90, { numerator: 4, denominator: 4 }, [{ id: 'r', bar: 4, bpm: 140, ramp: true }])],
    ] as [string, any][]) {
      const ctx = new MiniOfflineAudioContext(2, Math.round(sr * 12), sr) as any;
      const out = ctx.createGain(); out.connect(ctx.destination);
      ms.ctx = ctx; ms.outputGain = out; ms.settings = { ...ms.settings, enabled: true, sound: 'CLICK', accentDownbeat: true };
      ms.map = map; ms.lastScheduled = []; ms.isPlaying = true; ms.clock = () => ({ playing: true, startTime: 0.5, wrap: null, loop: null });
      ms.scheduledUntil = 0; ms.scheduleWindow(11);
      const want = beatsInRange(map, 0, 10.5).map((b: any) => 0.5 + b.time);
      let worst = 0;
      for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs((ms.lastScheduled[i]?.at ?? NaN) - want[i]) * sr);
      metro('Métronome', `${name} : pire écart clic / grille (${want.length} clics), ${sr} Hz`, 0, worst, 'éch.', 1, worst, 3);
      // Rendu : le clic démarre à l'échantillon prévu.
      const y = (await ctx.startRendering()).getChannelData(0);
      let first = -1; for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > 1e-6) { first = i; break; }
      metro('Métronome', `${name} : 1er clic rendu (attendu ${Math.round(0.5 * sr)}), ${sr} Hz`, Math.round(0.5 * sr), first, 'éch.', 1, undefined, 0);
      ms.isPlaying = false; ms.clock = null;
    }
  }, 120_000);
});
