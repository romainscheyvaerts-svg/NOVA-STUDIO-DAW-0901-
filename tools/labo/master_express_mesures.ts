/**
 * Mesures du lot 4 (« Masteriser un morceau » + « Caler sur la référence »),
 * avec LE MÊME moteur que l'appli (utils/quickMaster.ts), sous Node :
 *
 *   npx vite-node tools/labo/master_express_mesures.ts -- <sortie> <référence> <morceau1> [<morceau2> …] [--paires <mix> <réf> …]
 *
 * Pour chaque morceau : master par style et cible, LUFS atteint, crête vraie
 * (×8), plage dynamique, écart spectral avec la référence avant / après (EQ
 * calée sur la référence), rendu identique d'une fois sur l'autre, et WAV
 * 24 bits relu comparé au tampon d'écoute (en LSB 16 bits). Des extraits de
 * 40 s avant / après (même passage) sont écrits dans <sortie>/fichiers.
 * « --paires » : paires mix / référence de plus, pour l'EQ calée seule (écart
 * avant, prévu, mesuré après l'EQ, et plancher d'une EQ idéale ±4 dB par tiers
 * d'octave). Les formats autres que WAV passent par ffmpeg (décodage seulement).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { decodeWav, encodeWav, dequantize } from '../../utils/audioFormats';
import { analyzeTrack, renderQuickMaster, QM_TARGETS, referenceTarget, QmStyleId, QmIntensity, QmTarget, QmCache } from '../../utils/quickMaster';
import { spectralDistance, curveDiff, thirdOctaveSpectrum, matchToReference, applyEq } from '../../utils/referenceMatch';

/** Extrait de 40 s à partir de 30 % du morceau (le même passage avant et après). */
const excerpt = (ch: Float32Array[], sr: number) => {
  const n = ch[0].length, len = Math.min(n, 40 * sr), s0 = Math.max(0, Math.min(n - len, Math.round(n * 0.3)));
  return ch.map(x => x.subarray(s0, s0 + len));
};

/** Plancher : écart restant avec une EQ idéale bornée à ±4 dB sur CHAQUE tiers d'octave. */
function floor4(a: number[], b: number[]): number {
  let best = Infinity;
  for (let off = -8; off <= 8; off += 0.1) {
    const d = curveDiff(a, b).map(v => v - off);
    best = Math.min(best, d.reduce((s, v) => s + Math.max(0, Math.abs(v) - 4), 0) / d.length);
  }
  return best;
}

function readAudio(file: string): { ch: Float32Array[]; sr: number } {
  let wav = file;
  if (!/\.wav$/i.test(file)) {
    wav = path.join(os.tmpdir(), `qm_${path.basename(file).replace(/[^a-z0-9]+/gi, '_')}.wav`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-c:a', 'pcm_f32le', wav], { windowsHide: true });
  }
  const d = decodeWav(new Uint8Array(fs.readFileSync(wav)));
  const ch = d.floats ? d.floats : d.ints!.map(x => { const f = new Float32Array(x.length); for (let i = 0; i < x.length; i++) f[i] = dequantize(x[i], d.bits); return f; });
  return { ch: ch.length === 1 ? [ch[0], ch[0]] : ch.slice(0, 2), sr: d.sampleRate };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

async function main() {
  const all = process.argv.slice(2).filter(a => a !== '--');
  const cut = all.indexOf('--paires');
  const args = cut >= 0 ? all.slice(0, cut) : all;
  const pairs = cut >= 0 ? all.slice(cut + 1) : [];
  const [outDir, refFile, ...files] = args;
  fs.mkdirSync(path.join(outDir, 'fichiers'), { recursive: true });
  const ref = readAudio(refFile);
  const refA = analyzeTrack(ref.ch, ref.sr);
  const out: any = { reference: { fichier: path.basename(refFile), lufs: r2(refA.lufs), truePeak: r2(refA.truePeak) }, morceaux: [] };
  const plans: { style: QmStyleId; intensity: QmIntensity; target: QmTarget; ref: boolean }[] = [
    { style: 'rap', intensity: 'moyen', target: QM_TARGETS.find(t => t.id === 'spotify')!, ref: false },
    { style: 'rnb', intensity: 'leger', target: QM_TARGETS.find(t => t.id === 'apple')!, ref: false },
    { style: 'drill', intensity: 'fort', target: QM_TARGETS.find(t => t.id === 'club')!, ref: false },
    { style: 'pop', intensity: 'moyen', target: referenceTarget(refA.lufs), ref: true },
  ];
  for (const f of files) {
    const { ch, sr } = readAudio(f);
    const name = path.basename(f).replace(/\.[^.]+$/, '');
    const before = analyzeTrack(ch, sr);
    const rec: any = { fichier: path.basename(f), duree_s: r2(before.duration), sr, avant: { lufs: r2(before.lufs), truePeak: r2(before.truePeak), plr: r2(before.plr), lra: r2(before.lra) }, ecart_ref_avant: r2(spectralDistance(before.curve, refA.curve)), masters: [] };
    const store = new Map<string, QmCache>();
    const cache = { get: (k: string) => store.get(k), set: (c: QmCache) => { store.set(c.key, c); } };
    fs.writeFileSync(path.join(outDir, 'fichiers', `${name} - AVANT (extrait 40 s).wav`), encodeWav(excerpt(ch, sr), { sampleRate: sr, bits: 24 }));
    for (const p of plans) {
      const t0 = Date.now();
      const r = await renderQuickMaster(ch, sr, before, { style: p.style, intensity: p.intensity, target: p.target, refCurve: p.ref ? refA.curve : null }, {}, cache);
      const secs = (Date.now() - t0) / 1000;
      // Écoute = export : WAV 24 bits relu contre le tampon d'écoute.
      const bytes = encodeWav(r.out, { sampleRate: sr, bits: 24 });
      const dec = decodeWav(bytes);
      let maxLsb16 = 0;
      for (let c = 0; c < 2; c++) {
        const a = r.out[c], b = dec.ints![c];
        for (let i = 0; i < a.length; i++) { const d = Math.abs(Math.max(-1, Math.min(1, a[i])) - dequantize(b[i], 24)) * 32768; if (d > maxLsb16) maxLsb16 = d; }
      }
      // Rendu reproductible : un 2e rendu (sans cache) doit être identique au bit près.
      let identique: boolean | null = null;
      if (p === plans[0]) {
        const r2b = await renderQuickMaster(ch, sr, before, { style: p.style, intensity: p.intensity, target: p.target, refCurve: null });
        identique = r2b.out.every((x, c) => x.length === r.out[c].length && x.every((v, i) => v === r.out[c][i]));
      }
      const tag = `${p.style}-${p.intensity}-${p.target.id}${p.ref ? '-ref' : ''}`;
      fs.writeFileSync(path.join(outDir, 'fichiers', `${name} - APRES ${tag} (extrait 40 s).wav`), encodeWav(excerpt(r.out, sr), { sampleRate: sr, bits: 24 }));
      rec.masters.push({
        style: p.style, intensite: p.intensity, cible: p.target.id, cible_lufs: p.target.lufs, ref: p.ref, secondes: r2(secs),
        lufs: r2(r.after.lufs), ecart_lu: r2(r.after.lufs - p.target.lufs), truePeak: r2(r.after.truePeak), plr: r2(r.after.plr), lra: r2(r.after.lra),
        ecart_ref_apres: r2(spectralDistance(r.after.curve, refA.curve)), ecart_tonal_avant: r2(spectralDistance(before.curve, refA.curve, 2)), ecart_tonal_apres: r2(spectralDistance(r.after.curve, refA.curve, 2)), eq: r.eq.map(b => `${b.type}@${b.freq}:${b.gainDb}`), eq_source: r.eqSource,
        gain_limiteur: r.limiter.inputGainDb, ajustement_crete_db: r2(r.trimDb), iterations: r.iterations.length, wav24_ecart_max_lsb16: Math.round(maxLsb16 * 1000) / 1000,
        rendu_identique: identique, atteint: r.reached,
      });
      console.log(`${name} · ${tag} : ${r2(r.after.lufs)} LUFS (cible ${p.target.lufs}) · TP ${r2(r.after.truePeak)} dBTP · PLR ${r2(r.after.plr)} · écart réf ${rec.ecart_ref_avant} → ${r2(spectralDistance(r.after.curve, refA.curve))} dB · ${r2(secs)} s${identique !== null ? ` · identique=${identique}` : ''}`);
    }
    rec.plancher_eq_4db = r2(floor4(before.curve, refA.curve));
    out.morceaux.push(rec);
  }
  out.paires = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const a = readAudio(pairs[i]), b = readAudio(pairs[i + 1]);
    const ca = thirdOctaveSpectrum(a.ch, a.sr), cb = thirdOctaveSpectrum(b.ch, b.sr);
    const m = matchToReference(ca, cb, a.sr, 0.85);
    const cf = thirdOctaveSpectrum(applyEq(a.ch, a.sr, m.bands), a.sr);
    const row = {
      mix: path.basename(pairs[i]), reference: path.basename(pairs[i + 1]),
      avant: r2(spectralDistance(ca, cb)), prevu: r2(m.predicted), apres_eq_mesure: r2(spectralDistance(cf, cb)),
      tonal_avant: r2(spectralDistance(ca, cb, 2)), tonal_apres: r2(spectralDistance(cf, cb, 2)),
      plancher_eq_4db: r2(floor4(ca, cb)), eq: m.bands.map(x => `${x.type}@${x.freq}/Q${x.q}:${x.gainDb}`),
    };
    out.paires.push(row);
    console.log(`paire ${row.mix} → ${row.reference} : ${row.avant} → ${row.apres_eq_mesure} dB (tonal ${row.tonal_avant} → ${row.tonal_apres}, plancher ±4 dB ${row.plancher_eq_4db})`);
  }
  fs.writeFileSync(path.join(outDir, 'mesures.json'), JSON.stringify(out, null, 1));
}

main().catch(e => { console.error(e); process.exit(1); });
