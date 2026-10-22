/**
 * Nova Tune (22/10/2026) : réglages affichés = comportement mesuré, comparé à la référence du
 * marché mesurée en boîte noire (tools/novatune/boite_noire.py → CONTENU/nova-tune/boite_noire/).
 * Mêmes signaux et mêmes analyses des deux côtés (tests/helpers/tuneBench.ts).
 */
import { describe, expect, it } from 'vitest';
import { AutoTuneNode, targetNotesMask } from '../plugins/AutoTunePlugin';
import { centroid, constMidi, depthCents, pitchTrack, renderTune, tReach, vowelTrack } from './helpers/tuneBench';
import { retuneMsFromSpeed, speedFromRetuneMs } from '../utils/tuneSpeed';
import { NOVA_TUNE_PRESETS, novaTunePresetParams } from '../utils/novaTunePresets';
import { installMiniWebAudio, MiniOfflineAudioContext } from './helpers/miniWebAudio';

const SR = 48000;
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const median = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

async function run(x: Float32Array, p: Record<string, any>) {
  await tick();
  const { y, lat } = await renderTune(AutoTuneNode, SR, x, p, 0.2);
  return { y: y.subarray(lat), lat, full: y };
}
function deviation(y: Float32Array, target: number) {
  const { t, midi } = pitchTrack(y, SR);
  const tt: number[] = [], d: number[] = [];
  t.forEach((v, i) => { if (midi[i] > 0) { tt.push(v); d.push((midi[i] - target) * 100); } });
  return { t: tt, d };
}

/** Référence (boîte noire, mesures.json) : note tenue +40 cents, temps (ms) depuis le début du son. */
const REF_SPEED: Record<number, [number, number, number]> = {
  20: [40, 50, 85], 25: [45, 55, 105], 50: [70, 90, 185], 75: [95, 125, 265], 100: [120, 160, 350], 150: [170, 235, 515], 200: [220, 305, 675],
};
/** Référence (mesures2.json) : écart laissé (cents) par Flex 0–100 pour un écart chanté de 5 à 45 cents. */
const REF_FLEX: Record<number, number[]> = {
  10: [0, 0, 0, 0, 0, 0, 0, 0, 7.0], 20: [0, 0, 0, 0, 0, 0, 0, 3.5, 28.0], 30: [0, 0, 0, 0, 0, 0, 2.2, 18.6, 35.1],
  40: [0, 0, 0, 0, 0, 1.5, 13.8, 26.2, 38.6], 50: [0, 0, 0, 0, 1.1, 10.9, 20.8, 30.8, 40.7], 60: [0, 0, 0, 0.8, 9.0, 17.3, 25.6, 33.9, 42.2],
  70: [0, 0, 0.5, 7.6, 14.7, 21.8, 28.9, 36.0, 43.2], 80: [0, 0.3, 6.5, 12.8, 19.0, 25.2, 31.5, 37.7, 43.9], 90: [0.2, 5.7, 11.2, 16.8, 22.3, 27.9, 33.4, 39.0, 44.5],
  100: [5, 10, 15, 20, 25, 30, 35, 40, 45],
};

describe('Nova Tune : vitesse affichée = vitesse mesurée (convention du marché)', () => {
  it('conversion ms ↔ réglage : aller-retour, bornes', () => {
    expect(retuneMsFromSpeed(0)).toBe(0);
    expect(retuneMsFromSpeed(1)).toBeCloseTo(300 * Math.LN2, 6);
    for (const ms of [5, 12, 20, 50, 100, 200]) expect(Math.abs(retuneMsFromSpeed(speedFromRetuneMs(ms)) - ms) / ms).toBeLessThan(0.05);
  });

  it('temps de demi-correction, 63 % et 90 % = référence (±15 % ou ±10 ms)', async () => {
    const x = vowelTrack(constMidi(57.4, 2));
    for (const ms of [20, 50, 100, 200]) {
      const { y } = await run(x, { speed: speedFromRetuneMs(ms) });
      const { t, d } = deviation(y, 57);
      const fin = median(d.filter((_, i) => t[i] > 1.5 && t[i] < 1.9));
      const dd = d.map(v => v - fin);
      const got = [tReach(t, dd, 0.5, 40), tReach(t, dd, 1 / Math.E, 40), tReach(t, dd, 0.1, 40)];
      got.forEach((g, k) => expect(Math.abs(g - REF_SPEED[ms][k]), `${ms} ms, mesure ${k}`).toBeLessThanOrEqual(Math.max(10, 0.15 * REF_SPEED[ms][k])));
      // Demi-vie de la décroissance (pente entre 25 et 3 cents) = temps affiché, ±10 %.
      let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
      t.forEach((tv, i) => { if (tv > 0.04 && dd[i] < 25 && dd[i] > 3) { const l = Math.log(dd[i]); sx += tv; sy += l; sxx += tv * tv; sxy += tv * l; n++; } });
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const half = -1000 * Math.LN2 / slope;
      expect(Math.abs(half - ms) / ms, `demi-vie ${half.toFixed(1)} ms pour ${ms} ms affichés`).toBeLessThan(0.1);
    }
  }, 300_000);
});

describe('Nova Tune : Flex (ne corrige que près de la note) = loi mesurée sur la référence', () => {
  it('écart laissé à ±1,5 cent de la référence, Flex 10 à 100 %', async () => {
    const offs = [5, 10, 15, 20, 25, 30, 35, 40, 45];
    for (const fl of [10, 30, 50, 70, 90, 100]) for (let k = 0; k < offs.length; k += 2) {
      const { y } = await run(vowelTrack(constMidi(57 + offs[k] / 100, 1.2)), { speed: speedFromRetuneMs(10), flex: fl / 100 });
      const { t, d } = deviation(y, 57);
      const got = median(d.filter((_, i) => t[i] > 0.7 && t[i] < 1.1));
      expect(Math.abs(got - REF_FLEX[fl][k]), `Flex ${fl}, écart ${offs[k]} c : ${got.toFixed(2)} (réf. ${REF_FLEX[fl][k]})`).toBeLessThan(1.5);
    }
  }, 300_000);
  it('Flex coupé : tout est corrigé (≤ 0,5 cent)', async () => {
    const { y } = await run(vowelTrack(constMidi(57.45, 1.2)), { speed: 0, flex: 0 });
    const { t, d } = deviation(y, 57);
    expect(Math.abs(median(d.filter((_, i) => t[i] > 0.5)))).toBeLessThan(0.5);
  }, 60_000);
});

describe('Nova Tune : vibrato naturel', () => {
  const tv = new Float64Array(Math.round(2.5 * SR));
  for (let i = 0; i < tv.length; i++) tv[i] = 57 + 0.4 * Math.sin(2 * Math.PI * 5.5 * i / SR);
  const x = vowelTrack(tv);
  const depth = async (p: any) => { const { y } = await run(x, p); const { t, midi } = pitchTrack(y, SR); return depthCents(midi.filter((v, i) => v > 0 && t[i] > 0.6 && t[i] < 2.3)); };
  it('vitesse 0 : vibrato aplati sans réglage, gardé à 100 % (±10 %) ou doublé (±20 %) avec Vibrato', async () => {
    const dIn = depthCents(pitchTrack(x, SR).midi.filter(v => v > 0));
    expect(await depth({ speed: 0 })).toBeLessThan(4);
    const keep = await depth({ speed: 0, vibrato: 1 });
    expect(Math.abs(keep / dIn - 1)).toBeLessThan(0.1);
    const dbl = await depth({ speed: 0, vibrato: 2 });
    expect(Math.abs(dbl / dIn - 2)).toBeLessThan(0.2);
  }, 120_000);
  it('le centre de la note reste juste avec le vibrato gardé (±3 cents)', async () => {
    const tv2 = new Float64Array(tv.length); for (let i = 0; i < tv.length; i++) tv2[i] = tv[i] + 0.3;
    const { y } = await run(vowelTrack(tv2), { speed: 0, vibrato: 1 });
    const { t, midi } = pitchTrack(y, SR);
    const m = midi.filter((v, i) => v > 0 && t[i] > 0.6 && t[i] < 2.3);
    expect(Math.abs((m.reduce((a, b) => a + b, 0) / m.length - 57) * 100)).toBeLessThan(3);
  }, 60_000);
});

describe('Nova Tune : formant et transposition', () => {
  const x = vowelTrack(constMidi(57, 1));
  const cIn = centroid(x, SR, SR / 4);
  const pitchOf = (y: Float32Array) => { const { t, midi } = pitchTrack(y, SR); return median(midi.filter((v, i) => v > 0 && t[i] > 0.3 && t[i] < 0.8)); };
  it('transposition ±5 et ±12 demi-tons : note exacte (±1 cent), formants gardés (centre spectral ±6 % à ±5, ±30 % à l’octave au lieu de ×2)', async () => {
    for (const tr of [5, -5, 12, -12]) {
      const { y } = await run(x, { speed: 0, transpose: tr });
      expect(Math.abs((pitchOf(y) - 57 - tr) * 100), `transposition ${tr}`).toBeLessThan(1);
      // À l'octave, les harmoniques (deux fois plus espacées) échantillonnent l'enveloppe autrement :
      // le centre spectral bouge même formants gardés ; sans préservation il doublerait (ou diminuerait de moitié).
      expect(Math.abs(centroid(y, SR, SR / 4) / cIn - 1), `formants, transposition ${tr}`).toBeLessThan(Math.abs(tr) > 6 ? 0.3 : 0.06);
    }
  }, 120_000);
  it('formant ±3 / ±6 demi-tons : timbre déplacé dans le bon sens, hauteur inchangée (±1 cent)', async () => {
    let prev = 0;
    for (const f of [-6, -3, 0, 3, 6]) {
      const { y } = await run(x, { speed: 0, formant: f });
      expect(Math.abs((pitchOf(y) - 57) * 100), `formant ${f}`).toBeLessThan(1);
      const c = centroid(y, SR, SR / 4);
      if (prev) expect(c, `formant ${f}`).toBeGreaterThan(prev * 1.04);
      prev = c;
    }
  }, 120_000);
});

describe('Nova Tune : notes cibles', () => {
  it('notes choisies (Do, Sol) : Do#4 + 40 cents → Do4 ; masque 12 bits', async () => {
    expect(targetNotesMask([0, 7, 19])).toBe(1 | 128);
    const { y } = await run(vowelTrack(constMidi(61.4, 1)), { speed: 0, targetNotes: [0, 7] });
    const { t, midi } = pitchTrack(y, SR);
    expect(Math.abs((median(midi.filter((v, i) => v > 0 && t[i] > 0.3)) - 60) * 100)).toBeLessThan(1);
  }, 60_000);
  it('accords du morceau : Ré#4 + 30 cents sur un accord de Do majeur → Mi4 ; sans accord → la gamme', async () => {
    const x = vowelTrack(constMidi(63.3, 1.2));
    const restore = installMiniWebAudio();
    try {
      const ctx = new MiniOfflineAudioContext(1, x.length + 9600, SR) as unknown as AudioContext;
      const at = new AutoTuneNode(ctx);
      await at.ready;
      at.updateParams({ speed: 0, humanize: 0, mix: 1, isEnabled: true, rootKey: 0, scale: 'CHROMATIC', followChords: true });
      expect(at.followsChords()).toBe(true);
      const ap = at.chordParam()!;
      ap.setValueAtTime(0, 0);
      ap.setValueAtTime(0 * 4096 + (1 | 16 | 128), 0.5);   // Do majeur à partir de 0,5 s
      const b = ctx.createBuffer(1, x.length, SR); b.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
      const src = ctx.createBufferSource(); src.buffer = b; src.connect(at.input); at.output.connect(ctx.destination); src.start(0);
      const out = (await (ctx as unknown as OfflineAudioContext).startRendering()).getChannelData(0).subarray(Math.round(at.latency * SR));
      const { t, midi } = pitchTrack(out, SR);
      const before = median(midi.filter((v, i) => v > 0 && t[i] > 0.15 && t[i] < 0.4));
      const after = median(midi.filter((v, i) => v > 0 && t[i] > 0.7 && t[i] < 1.1));
      expect(Math.abs((before - 63) * 100)).toBeLessThan(1);   // chromatique : Ré#4
      expect(Math.abs((after - 64) * 100)).toBeLessThan(1);    // accord : Mi4
    } finally { restore(); }
  }, 60_000);
});

describe('Nova Tune : latence annoncée = latence réelle, propreté, compatibilité', () => {
  /** Retard de l'enveloppe (ms) : redressement + lissage 5 ms, intercorrélation. */
  function envDelayMs(x: Float32Array, y: Float32Array) {
    const env = (a: Float32Array) => { const o = new Float64Array(a.length); let s = 0; const k = 1 - Math.exp(-1 / (0.005 * SR)); for (let i = 0; i < a.length; i++) { s += k * (Math.abs(a[i]) - s); o[i] = s; } return o; };
    const ex = env(x), ey = env(y);
    let best = 0, bv = -Infinity;
    for (let l = 0; l < 0.1 * SR; l += 4) { let c = 0; for (let i = 0; i + l < ey.length && i < ex.length; i += 8) c += ex[i] * ey[i + l]; if (c > bv) { bv = c; best = l; } }
    for (let l = Math.max(0, best - 4); l <= best + 4; l++) { let c = 0; for (let i = 0; i + l < ey.length && i < ex.length; i += 2) c += ex[i] * ey[i + l]; if (c > bv) { bv = c; best = l; } }
    return best / SR * 1000;
  }
  it('mode qualité : enveloppe en retard de la latence annoncée (±0,5 ms) ; mode direct ≤ 5 ms', async () => {
    // Voyelle hachée (syllabes de 120 ms) : les attaques fixent le retard.
    const x = vowelTrack(constMidi(57, 2));
    for (let i = 0; i < x.length; i++) if (Math.floor(i / (0.12 * SR)) % 2) x[i] *= 0.05;
    for (const ll of [false, true]) {
      await tick();
      const { y: full, lat } = await renderTune(AutoTuneNode, SR, x, { speed: 0, lowLatency: ll }, 0.2);
      const d = envDelayMs(x, full);
      if (!ll) expect(Math.abs(d - lat / SR * 1000), `qualité : ${d.toFixed(2)} ms mesurés, ${(lat / SR * 1000).toFixed(2)} annoncés`).toBeLessThan(0.5);
      else expect(d, `direct : ${d.toFixed(2)} ms`).toBeLessThan(5);
    }
  }, 120_000);

  it('aucun clic : robot sur glissando, transitions, formant et transposition', async () => {
    const m = new Float64Array(3 * SR); for (let i = 0; i < m.length; i++) m[i] = 50 + 12 * i / m.length;
    const x = vowelTrack(m);
    let refMax = 0; for (let i = 2; i < x.length; i++) refMax = Math.max(refMax, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
    for (const p of [{ speed: 0 }, { speed: 0, formant: 6 }, { speed: 0, formant: -6, transpose: -7 }, { speed: speedFromRetuneMs(20), transpose: 12, flex: 0.5 }]) {
      const { y } = await run(x, p);
      let mx = 0; for (let i = 2; i < y.length - SR / 10; i++) mx = Math.max(mx, Math.abs(y[i] - 2 * y[i - 1] + y[i - 2]));
      // Un clic (discontinuité) donnerait une dérivée seconde bien au-dessus de celle de la voix.
      expect(mx, JSON.stringify(p)).toBeLessThan(refMax * (p.transpose === 12 ? 4.5 : 2.5));
    }
  }, 120_000);

  it('réglages avancés neutres = son d’un ancien projet (au bit près) ; lecture répétée identique', async () => {
    const x = vowelTrack(constMidi(57.3, 1));
    const a = (await run(x, { speed: 0.2 })).y;
    const b = (await run(x, { speed: 0.2, flex: 0, vibrato: 0, formant: 0, transpose: 0, voiceType: 'auto', targetNotes: [], followChords: false })).y;
    const c = (await run(x, { speed: 0.2 })).y;
    let diff = 0, rep = 0; for (let i = 0; i < a.length; i++) { diff = Math.max(diff, Math.abs(a[i] - b[i])); rep = Math.max(rep, Math.abs(a[i] - c[i])); }
    expect(diff).toBe(0);
    expect(rep).toBe(0);
  }, 60_000);
});

describe('Nova Tune : préréglages sourcés', () => {
  it('chaque préréglage cite une source, reste dans la plage publiée et se convertit sans perte', () => {
    expect(NOVA_TUNE_PRESETS.length).toBeGreaterThan(5);
    for (const p of NOVA_TUNE_PRESETS) {
      expect(p.sources.length, p.id).toBeGreaterThan(0);
      for (const s of p.sources) expect(s.url).toMatch(/^https:\/\//);
      if (p.plage) { expect(p.ms).toBeGreaterThanOrEqual(p.plage[0]); expect(p.ms).toBeLessThanOrEqual(p.plage[1]); }
      const q = novaTunePresetParams(p);
      expect(Math.abs(retuneMsFromSpeed(q.speed) - p.ms)).toBeLessThan(Math.max(0.6, p.ms * 0.05));
      expect(p.name).not.toMatch(/auto-?tune|antares|waves|slate|metatune|melodyne/i);
    }
  });
});
