/**
 * Banc « avant → après » de Nova Tune (outil de mesure, pas un test de non-régression) :
 * mêmes signaux et analyses que la mesure boîte noire de la référence du marché.
 *
 *   NOVATUNE_BANC=apres NOVATUNE_OUT=dossier npx vitest run tests/novaTuneBanc.test.ts
 *   NOVATUNE_BANC=avant … (nécessite la copie du moteur précédent plugins/_AutoTuneAvant.tsx,
 *   non versionnée : `git show <commit>:plugins/AutoTunePlugin.tsx`, processeur renommé).
 *
 * Sans NOVATUNE_BANC, le fichier est ignoré. Écrit <dossier>/banc_<avant|apres>.json et, avec
 * NOVATUNE_VOIX=fichier.wav, les rendus d'écoute dans NOVATUNE_ECOUTE (défaut <dossier>/ecoute).
 */
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { centroid, constMidi, delayOf, depthCents, pitchTrack, renderTune, tReach, vowelTrack } from './helpers/tuneBench';
import { speedFromRetuneMs } from '../utils/tuneSpeed';

const which = process.env.NOVATUNE_BANC;
const SR = 48000;

async function engine(): Promise<any> {
  if (which === 'avant') {
    const p = '../plugins/_AutoTuneAvant';
    return (await import(/* @vite-ignore */ p)).AutoTuneNode;
  }
  return (await import('../plugins/AutoTunePlugin')).AutoTuneNode;
}

/** Réglage « vitesse » pour un temps AFFICHÉ (ms) : convention de l'écran de chaque version. */
const speedFor = (ms: number) => (which === 'avant' ? Math.sqrt(ms / 300) : speedFromRetuneMs(ms));

function readWav(file: string): { x: Float32Array; sr: number } {
  const b = fs.readFileSync(file);
  let o = 12, fmt: any = null, data: Buffer | null = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, o + 8 + len);
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV illisible');
  const bps = fmt.bits / 8, n = Math.floor(data.length / (bps * fmt.ch));
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const p = (i * fmt.ch + c) * bps;
      s += fmt.tag === 3 ? data.readFloatLE(p) : bps === 2 ? data.readInt16LE(p) / 32768 : bps === 3 ? (data.readIntLE(p, 3)) / 8388608 : data.readInt32LE(p) / 2147483648;
    }
    x[i] = s / fmt.ch;
  }
  return { x, sr: fmt.sr };
}

function writeWav(file: string, x: Float32Array, sr: number) {
  const n = x.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) b.writeFloatLE(x[i], 44 + 4 * i);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b);
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe.skipIf(!which)(`Banc Nova Tune (${which})`, () => {
  it('mesures', async () => {
    const Node = await engine();
    const R: any = { moteur: which, sr: SR };
    const run = async (x: Float32Array, p: any) => { await tick(); const { y, lat } = await renderTune(Node, SR, x, p, 0.2); return { y: y.subarray(lat), lat }; };
    const dev = (y: Float32Array, target: number) => { const { t, midi } = pitchTrack(y, SR); const tt: number[] = [], d: number[] = []; t.forEach((v, i) => { if (midi[i] > 0) { tt.push(v); d.push((midi[i] - target) * 100); } }); return { t: tt, d }; };
    const median = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

    // Latence annoncée / mesurée (voyelle juste modulée en amplitude, intercorrélation).
    R.latence = {};
    let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const am = new Float32Array(2 * SR); let a1 = 0; for (let i = 0; i < am.length; i++) { a1 += 0.003 * (rnd() - a1 * 0.003); am[i] = a1; }
    let amx = 1e-9; for (const v of am) amx = Math.max(amx, Math.abs(v));
    const xl = vowelTrack(constMidi(57, 2)); for (let i = 0; i < xl.length; i++) xl[i] *= 0.5 + 0.5 * am[i] / amx;
    for (const ll of [false, true]) {
      await tick();
      const { y, lat } = await renderTune(Node, SR, xl, { speed: speedFor(20), lowLatency: ll }, 0.2);
      const d = delayOf(xl, y, 4000);
      R.latence[ll ? 'faible_latence' : 'qualite'] = { annoncee_ech: lat, mesuree_ech: Math.round(d * 100) / 100, mesuree_ms: Math.round(d / SR * 1e5) / 100 };
    }

    // Vitesse : note tenue 40 cents trop haut.
    R.vitesse = [];
    const x40 = vowelTrack(constMidi(57.4, 2));
    for (const ms of [0, 5, 10, 20, 25, 50, 75, 100, 150, 200]) {
      const { y } = await run(x40, { speed: speedFor(ms) });
      const { t, d } = dev(y, 57);
      const fin = median(d.filter((_, i) => t[i] > 1.5 && t[i] < 1.9));
      const dd = d.map(v => v - fin);
      R.vitesse.push({ affiche_ms: ms, ecart_final_cents: fin, t50_ms: tReach(t, dd, 0.5, 40), t63_ms: tReach(t, dd, 1 / Math.E, 40), t90_ms: tReach(t, dd, 0.1, 40) });
    }

    // Vibrato ±40 cents à 5,5 Hz autour d'une note juste.
    R.vibrato = [];
    const vibIn = new Float64Array(Math.round(2.5 * SR)); for (let i = 0; i < vibIn.length; i++) vibIn[i] = 57 + 0.4 * Math.sin(2 * Math.PI * 5.5 * i / SR);
    const xv = vowelTrack(vibIn);
    for (const ms of [0, 10, 25, 50, 100, 200]) for (const vib of which === 'avant' ? [0] : [0, 1]) {
      const { y } = await run(xv, { speed: speedFor(ms), vibrato: vib });
      const { t, midi } = pitchTrack(y, SR);
      const m = midi.filter((v, i) => v > 0 && t[i] > 0.5 && t[i] < 2.3);
      R.vibrato.push({ affiche_ms: ms, vibrato: vib, profondeur_sortie_cents: depthCents(m) });
    }

    // Flex : écart 5 à 45 cents, vitesse 10 ms.
    if (which !== 'avant') {
      R.flex = [];
      for (const fl of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) for (const off of [5, 10, 15, 20, 25, 30, 35, 40, 45]) {
        const { y } = await run(vowelTrack(constMidi(57 + off / 100, 1.2)), { speed: speedFor(10), flex: fl / 100 });
        const { t, d } = dev(y, 57);
        R.flex.push({ flex: fl, ecart_entree: off, ecart_sortie: median(d.filter((_, i) => t[i] > 0.7 && t[i] < 1.1)) });
      }
    }

    // Transition : La +40 c, glissé de 80 ms vers Si juste.
    R.transition = [];
    {
      const n1 = Math.round(0.8 * SR), ng = Math.round(0.08 * SR), n2 = Math.round(0.8 * SR);
      const m = new Float64Array(n1 + ng + n2);
      for (let i = 0; i < m.length; i++) m[i] = i < n1 ? 57.4 : i < n1 + ng ? 57.4 + 1.6 * (0.5 - 0.5 * Math.cos(Math.PI * (i - n1) / ng)) : 59;
      const xt = vowelTrack(m);
      for (const ms of [0, 20, 50, 100]) {
        const { y } = await run(xt, { speed: speedFor(ms) });
        const { t, midi } = pitchTrack(y, SR);
        R.transition.push({ affiche_ms: ms, courbe: t.map((v, i) => [Math.round(v * 1000) / 1000, Math.round(midi[i] * 1000) / 1000]).filter(p => p[0] > 0.7 && p[0] < 1.3) });
      }
    }

    // Robot (vitesse 0) sur une voix qui dérive lentement (±30 cents à 0,7 Hz).
    {
      const m = new Float64Array(2 * SR); for (let i = 0; i < m.length; i++) m[i] = 57 + 0.3 * Math.sin(2 * Math.PI * 0.7 * i / SR);
      const { y } = await run(vowelTrack(m), { speed: 0 });
      const { t, midi } = pitchTrack(y, SR);
      const e = midi.filter((v, i) => v > 0 && t[i] > 0.2 && t[i] < 1.8).map(v => Math.abs(v - 57) * 100);
      R.robot_derive = { ecart_max_cents: Math.max(...e), ecart_rms_cents: Math.sqrt(e.reduce((a, b) => a + b * b, 0) / e.length) };
    }

    // Glissando d'une octave en 3 s (escalier).
    R.glissando = [];
    {
      const m = new Float64Array(3 * SR); for (let i = 0; i < m.length; i++) m[i] = 50 + 12 * i / m.length;
      const xg = vowelTrack(m);
      for (const ms of [0, 20, 75]) {
        const { y } = await run(xg, { speed: speedFor(ms) });
        const { t, midi } = pitchTrack(y, SR);
        const s = midi.filter((v, i) => v > 0 && t[i] > 0.3 && t[i] < 2.7);
        R.glissando.push({ affiche_ms: ms, part_sur_note: s.filter(v => Math.abs(v - Math.round(v)) < 0.1).length / s.length });
      }
    }

    // Formants : centre de gravité spectral (entrée 57 juste).
    R.formants = {};
    {
      const x = vowelTrack(constMidi(57, 1));
      R.formants.entree = centroid(x, SR, SR / 4);
      const cases: [string, any][] = which === 'avant' ? [['robot', {}]] : [['robot', {}], ['transpose+5', { transpose: 5 }], ['transpose-5', { transpose: -5 }],
        ['formant+3', { formant: 3 }], ['formant-3', { formant: -3 }], ['formant+6', { formant: 6 }], ['formant-6', { formant: -6 }], ['transpose+5_formant+5', { transpose: 5, formant: 5 }]];
      for (const [k, p] of cases) {
        const { y } = await run(x, { speed: 0, ...p });
        const { t, midi } = pitchTrack(y, SR);
        R.formants[k] = { centroide_hz: centroid(y, SR, SR / 4), hauteur_midi: median(midi.filter((v, i) => v > 0 && t[i] > 0.3 && t[i] < 0.9)) };
      }
    }

    // Charge de calcul : temps de rendu de 10 s de voyelle (vitesse 20 ms).
    {
      const x = vowelTrack(constMidi(57.3, 10));
      const t0 = performance.now();
      await renderTune(Node, SR, x, { speed: speedFor(20) }, 0);
      R.charge = { rendu_10s_ms: Math.round(performance.now() - t0) };
    }

    const out = process.env.NOVATUNE_OUT;
    if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `banc_${which}.json`), JSON.stringify(R, null, 1)); }

    // Rendus d'écoute sur une vraie voix.
    const voix = process.env.NOVATUNE_VOIX;
    if (out && voix && fs.existsSync(voix)) {
      const dir = process.env.NOVATUNE_ECOUTE || path.join(out, 'ecoute');
      const { x, sr } = readWav(voix);
      const presets: [string, any][] = which === 'avant'
        ? [['robot_0ms', { speed: 0 }], ['naturel_20ms', { speed: speedFor(20), humanize: 0.2 }], ['doux_50ms', { speed: speedFor(50), humanize: 0.4 }]]
        : [['robot_0ms', { speed: 0 }], ['naturel_20ms', { speed: speedFor(20), humanize: 0.2 }], ['doux_50ms', { speed: speedFor(50), humanize: 0.4 }],
          ['naturel_20ms_flex50', { speed: speedFor(20), humanize: 0.2, flex: 0.5 }], ['naturel_20ms_vibrato_garde', { speed: speedFor(20), humanize: 0.2, vibrato: 1 }], ['robot_formant_moins3', { speed: 0, formant: -3 }],
          ['robot_transpose_plus12_formant_garde', { speed: 0, transpose: 12 }]];
      for (const [name, p] of presets) {
        await tick();
        const { y, lat } = await renderTune(Node, sr, x, p, 0.1);
        writeWav(path.join(dir, `${which}_${name}.wav`), y.subarray(lat, lat + x.length), sr);
      }
      writeWav(path.join(dir, `original.wav`), x, sr);
    }
  }, 1_800_000);
});
