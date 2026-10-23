/**
 * Banc de mesure de l'éditeur de notes (Nova Pitch).
 *
 *   npx vite-node scripts/novaPitchBench.ts
 *
 * Écrit D:\1 WORK\CONTENU\nova-pitch\mesures.json et les fichiers d'écoute
 * (avant / après, même voix) dans D:\1 WORK\CONTENU\nova-pitch\ecoute\.
 * Voix réelle : prise chantée du studio (REC_210, 44,1 kHz) et la voix
 * complète de « Silence blanc » (3 min 10, pour le temps d'analyse).
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { readWav, writeWav } from '../tests/helpers/wavio';
import { analyzePitch, monoOf, segmentNotes, type PitchNote } from '../utils/pitchAnalysis';
import { autoCorrect, guessKey, nearestScaleNote, type NoteEdit } from '../utils/pitchCorrect';
import { voiceMarks } from '../engine/pitch/marks';
import { noteShape } from '../engine/pitch/notes';
import { buildPlan } from '../engine/pitch/plan';
import { outputPitchCurve, renderVoice } from '../engine/pitch/render';
import { analyzeVoice, voiceTrack } from '../engine/pitch/analysis';
import { quietLenFrom, silenceFloor, stretchEnd } from '../engine/pitch/elastic';
import { synthVoice } from '../tests/helpers/synthVoice';
import { clickDb, diffDb, envelopeGap, harmonicEnvelope, meanPitch, pitchByAnalysis, pitchBySpectrum, vibratoRate, vibratoRateAc, bestLag, pairedCents } from '../tests/helpers/pitchMeasure';

const OUT = 'D:/1 WORK/CONTENU/nova-pitch';
const ECOUTE = `${OUT}/ecoute`;
const SESSION = 'D:/1 WORK/2 SESSIONS PROTOOLS/OneDrive/13 mini 22 04 vs 2/Audio Files';
mkdirSync(ECOUTE, { recursive: true });

const R: Record<string, any> = { date: new Date().toISOString() };
const r2 = (v: number): any => (v === -Infinity ? '-inf (identique)' : Math.round(v * 100) / 100);
const E = (shift: number, extra: Partial<NoteEdit> = {}): NoteEdit => ({ shift, drift: 0, vibrato: 1, ...extra });
const now = () => performance.now();

function prep(x: Float32Array, sr: number) {
  const track = voiceTrack(x, sr);
  const notes = segmentNotes(track);
  const shapes = notes.map(n => noteShape(track, n));
  const marks = voiceMarks(x, track);
  return { track, notes, shapes, marks };
}
type P = ReturnType<typeof prep>;
const render = (chs: Float32Array[], p: P, edits: (NoteEdit | undefined)[], extend = 0) =>
  renderVoice(chs, p.marks, buildPlan({ track: p.track, notes: p.notes, shapes: p.shapes, edits, extend }));

// ---------------------------------------------------------------- 1. Synthétique
{
  const sr = 48000;
  const rows: any[] = [];
  for (const m of [45.3, 57.4, 64.1, 71.8]) for (const vib of [0, 40]) {
    const x = synthVoice(sr, 1.4, [{ midi: m, at: 0.1, len: 1.2, vibratoCents: vib, vibratoHz: 5.5 }]);
    const p = prep(x, sr);
    for (const sh of [0.02, -0.02, 1, 3.5, -5]) {
      const y = render([x], p, p.notes.map(() => E(sh)))[0];
      const ty = analyzePitch(y, sr);
      const a = 0.3, b = 0.3 + 5 / 5.5;
      const errA = (meanPitch(ty, a, b) - meanPitch(p.track, a, b) - sh) * 100;
      const errS = vib ? NaN : (pitchBySpectrum(y, sr, 0.3, 1.1, m + sh) - pitchBySpectrum(x, sr, 0.3, 1.1, m) - sh) * 100;
      rows.push({ midi: m, vibrato_c: vib, decalage_c: Math.round(sh * 100), err_analyse_c: r2(errA), err_spectre_c: Number.isNaN(errS) ? null : r2(errS), duree_identique: y.length === x.length });
    }
  }
  R.synthese_hauteur = { lignes: rows, max_err_analyse_c: r2(Math.max(...rows.map(r => Math.abs(r.err_analyse_c)))), max_err_spectre_c: r2(Math.max(...rows.filter(r => r.err_spectre_c !== null).map(r => Math.abs(r.err_spectre_c)))) };
  // Pas de 2 cents.
  const x = synthVoice(sr, 1.0, [{ midi: 62, at: 0.1, len: 0.8 }]);
  const p = prep(x, sr);
  const got: number[] = [];
  for (let k = 0; k <= 10; k++) got.push(pitchBySpectrum(render([x], p, p.notes.map(() => E(0.02 * k)))[0], sr, 0.25, 0.8, 62));
  const steps = got.slice(1).map((g, k) => r2((g - got[k]) * 100));
  R.pas_2_cents = { pas_mesures_c: steps, ecart_max_c: r2(Math.max(...steps.map(s => Math.abs(s - 2)))) };
  // Sinus pur et glissando : analyse.
  const gl = new Float32Array(sr * 2);
  let ph = 0;
  for (let i = 0; i < gl.length; i++) { const m = 55 + (12 * i) / gl.length; ph += 440 * 2 ** ((m - 69) / 12) / sr; gl[i] = 0.3 * Math.sin(2 * Math.PI * ph); }
  const tg = voiceTrack(gl, sr);
  let gmax = 0;
  for (let i = 40; i < tg.midi.length - 40; i++) { const t = (i * tg.hop) / sr; const m = 55 + (12 * t) / 2; if (!Number.isNaN(tg.midi[i])) gmax = Math.max(gmax, Math.abs(tg.midi[i] - m) * 100); }
  R.glissando_analyse_max_c = r2(gmax);
  const s = new Float32Array(sr);
  for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 440 * 2 ** ((60.37 - 69) / 12) * i) / sr);
  R.sinus_analyse_err_c = r2((pitchByAnalysis(s, sr, 0.2, 0.8, voiceTrack(s, sr)) - 60.37) * 100);
}

// ---------------------------------------------------------------- 2. Voix réelle
const realPath = `${SESSION}/REC_210.wav`;
if (existsSync(realPath)) {
  const { sr, ch } = readWav(realPath);
  const A = Math.round(41.0 * sr), B = Math.round(55.0 * sr);
  const chs = ch.map(c => c.slice(A, B));
  const x = monoOf(chs);
  const t0 = now();
  const p = prep(x, sr);
  R.voix_reelle = { fichier: 'REC_210.wav (41,0–55,0 s)', sr, duree_s: r2(x.length / sr), notes: p.notes.length, analyse_ms: Math.round(now() - t0) };
  const stable = p.notes.map((n, k) => ({ n, k })).filter(({ n }) => n.end - n.start >= 0.3 && n.spread < 0.3);
  // Hauteur demandée : écart trame par trame (sortie − entrée − décalage) au cœur de chaque note
  // de plus de 0,2 s, puis moyenne par note (mesure appariée : la voix bouge, l'écart est relatif).
  const notesM = p.notes.filter(n => n.end - n.start >= 0.2);
  const hopS = p.track.hop / sr;
  const rows: any[] = [];
  for (const sh of [0.02, -0.02, 1, -2, 3.5]) {
    const y = render(chs, p, p.notes.map(() => E(sh)))[0];
    const ty = analyzePitch(y, sr);
    for (const n of notesM) {
      const a = n.start + 0.2 * (n.end - n.start), b = n.end - 0.2 * (n.end - n.start);
      const pc = pairedCents(p.track.midi, ty.midi, hopS, a, b);
      if (pc.frames >= 8) rows.push({ note_s: r2(n.start + 41), decalage_c: Math.round(sh * 100), err_c: r2(pc.mean - sh * 100) });
    }
  }
  const errs = rows.map(r => Math.abs(r.err_c)).sort((a, b) => a - b);
  R.voix_reelle.hauteur = { notes_mesurees: notesM.length, mesures: rows.length, moyenne_abs_c: r2(errs.reduce((s, v) => s + v, 0) / errs.length), mediane_abs_c: r2(errs[errs.length >> 1]), p95_abs_c: r2(errs[Math.floor(errs.length * 0.95)]), max_abs_c: r2(errs[errs.length - 1]) };
  // Pas de 2 cents sur la voix réelle : 0 → 8 cents par pas de 2, moyenne sur toutes les notes.
  const g: number[] = [];
  for (let k = 0; k <= 4; k++) {
    const ty = analyzePitch(render(chs, p, p.notes.map(() => E(0.02 * k)))[0], sr);
    const v = notesM.map(n => pairedCents(p.track.midi, ty.midi, hopS, n.start + 0.2 * (n.end - n.start), n.end - 0.2 * (n.end - n.start)).mean).filter(q => !Number.isNaN(q));
    g.push(v.reduce((s, q) => s + q, 0) / v.length);
  }
  R.voix_reelle.pas_2_cents = g.slice(1).map((v, k) => r2(v - g[k]));
  // Durée inchangée, consonnes et souffle identiques (trames sans hauteur), formants, clics.
  const y3 = render(chs, p, p.notes.map(() => E(3)))[0];
  const ym = render(chs, p, p.notes.map(() => E(-3)))[0];
  let e = 0, d = 0;
  const hop = p.track.hop;
  for (let i = 0; i < p.track.midi.length; i++) {
    if (!Number.isNaN(p.track.midi[i])) continue;
    // Trame sans hauteur éloignée d'au moins 20 ms d'une note (les fondus de grains débordent de 1 période).
    let near = false;
    for (let q = Math.max(0, i - 4); q <= Math.min(p.track.midi.length - 1, i + 4); q++) if (!Number.isNaN(p.track.midi[q])) near = true;
    if (near) continue;
    for (let s = i * hop; s < Math.min(x.length, (i + 1) * hop); s++) { e += x[s] * x[s]; d += (x[s] - y3[s]) ** 2; }
  }
  R.voix_reelle.duree_identique = y3.length === x.length;
  R.voix_reelle.consonnes_ecart_db = e > 0 ? (d > 0 ? r2(10 * Math.log10(d / e)) : '-inf (identiques)') : null;
  const gaps: number[] = [], chip: number[] = [];
  for (const { n } of stable) {
    const a1 = n.start + 0.2 * (n.end - n.start), b1 = n.end - 0.2 * (n.end - n.start);
    const f0 = 440 * 2 ** ((n.center - 69) / 12);
    const ref = harmonicEnvelope(x, sr, a1, b1, f0);
    for (const [yy, sh] of [[y3, 3], [ym, -3]] as const) {
      const env = harmonicEnvelope(yy, sr, a1, b1, f0 * 2 ** (sh / 12));
      gaps.push(envelopeGap(env.db, ref.db));
      const rr = 2 ** (sh / 12);
      const z = new Float32Array(Math.floor(x.length / rr));
      for (let i = 0; i < z.length; i++) { const q = i * rr, k = Math.floor(q); z[i] = x[k] + ((x[k + 1] ?? 0) - x[k]) * (q - k); }
      chip.push(envelopeGap(harmonicEnvelope(z, sr, a1 / rr, b1 / rr, f0 * rr).db, ref.db));
    }
  }
  R.voix_reelle.formants = { ecart_moyen_db_nova: r2(gaps.reduce((s, v) => s + v, 0) / gaps.length), ecart_moyen_db_vitesse_changee: r2(chip.reduce((s, v) => s + v, 0) / chip.length), note: 'enveloppe aux harmoniques 300–4000 Hz, ±3 demi-tons, comparée à la note d’origine' };
  const zones: [number, number][] = p.notes.flatMap(n => [[n.start - 0.02, n.start + 0.02], [n.end - 0.02, n.end + 0.02]] as [number, number][]);
  const moved = render(chs, p, p.notes.map((_, k) => E(k % 2 ? -2 : 2)))[0];
  R.voix_reelle.clics = { bords_avant_db: r2(clickDb(x, sr, zones)), bords_apres_db: r2(clickDb(moved, sr, zones)), note: 'énergie > 6 kHz (différence seconde) par blocs de 1 ms aux bords des notes, pire bloc, dB sous le niveau moyen' };

  // Écoute : avant / corrigée dans la gamme / notes déplacées.
  const key = guessKey(p.notes);
  R.voix_reelle.gamme_devinee = key;
  const auto = autoCorrect(p.notes, key || {}, 1, 'naturel');
  const corrected = render(chs, p, auto);
  writeWav(`${ECOUTE}/01_voix_reelle_avant.wav`, sr, chs);
  writeWav(`${ECOUTE}/02_voix_reelle_justesse_corrigee_100pc.wav`, sr, corrected);
  writeWav(`${ECOUTE}/03_voix_reelle_notes_deplacees_+2_-2_demi-tons.wav`, sr, render(chs, p, p.notes.map((_, k) => E(k % 2 ? -2 : 2))));
  const cy = analyzePitch(corrected[0], sr);
  const after = p.notes.filter(n => n.end - n.start > 0.3).map(n => {
    const target = nearestScaleNote(n.center, key?.root, key?.scale);
    return Math.abs(pitchByAnalysis(corrected[0], sr, n.start + 0.1 * (n.end - n.start), n.end - 0.1 * (n.end - n.start), cy) - target) * 100;
  });
  R.voix_reelle.corrigee_100pc_ecart_moyen_c = r2(after.reduce((s, v) => s + v, 0) / after.length);

  // Élastique sur la voix réelle : la longue note à vibrato (43,8 s) ×2 et ×0,5, la suite décalée.
  // La plus longue note avec vibrato de l'extrait.
  let k = -1;
  p.notes.forEach((n, i) => { if (i + 1 < p.notes.length && p.shapes[i].vibRate > 0 && (k < 0 || n.end - n.start > p.notes[k].end - p.notes[k].start)) k = i; });
  if (k >= 0) {
    const n = p.notes[k];
    const quiet = quietLenFrom(p.track.rmsDb, hop / sr, silenceFloor(p.track.rmsDb));
    const el: any = { note_s: r2(n.start + 41), duree_s: r2(n.end - n.start), vibrato_hz: r2(p.shapes[k].vibRate) };
    for (const factor of [2, 0.5]) {
      const L = n.end - n.start;
      const res = stretchEnd({ notes: p.notes, edits: p.notes.map(() => undefined), quietLen: quiet, regionLen: x.length / sr, extend: 0, ripple: true }, k, n.start + L * factor);
      const out = render(chs, p, res.edits, res.extend);
      const y = out[0];
      const D = Math.round(((res.edits[k]?.dt1) || 0) * sr);
      // Suite (note suivante et consonnes) retrouvée exactement Δ plus loin.
      const nx = p.notes[k + 1];
      const lag = bestLag(x, y, Math.round((nx.start - 0.05) * sr), Math.round((nx.start + 0.3) * sr), 64, D);
      const ty = analyzePitch(y, sr);
      const a1 = n.start + 0.15, b1 = n.start + L * factor - 0.15;
      el[`x${factor}`] = {
        duree_demandee_ms: Math.round(L * factor * 1000), duree_obtenue_ms: r2((L * sr + D) / sr * 1000),
        suite_decalee_ech: lag - D, suite_ecart_db: r2(diffDb(x, y, Math.round((nx.start + 0.3) * sr), Math.round(Math.min(x.length / sr - 0.1, nx.start + 1.0) * sr), D)),
        hauteur_vs_visee_c: (() => { const tg = outputPitchCurve(buildPlan({ track: p.track, notes: p.notes, shapes: p.shapes, edits: res.edits, extend: res.extend }), true); const pc = pairedCents(tg, ty.midi, hop / sr, a1, b1); return { moyenne: r2(pc.mean), mediane_abs: r2(pc.medianAbs), trames: pc.frames }; })(),
        vibrato_avant_hz: r2(vibratoRateAc(p.track, p.shapes[k].s0, p.shapes[k].s1)), vibrato_apres_hz: r2(vibratoRateAc(ty, p.shapes[k].s0, p.shapes[k].s1 + (L * factor - L))),
        clics_jonctions_db: r2(clickDb(y, sr, [[n.start - 0.02, n.start + 0.02], [n.start + L * factor - 0.03, n.start + L * factor + 0.03]])),
      };
      const from = Math.max(0, Math.round((n.start - 1.5) * sr)), to = Math.min(x.length, Math.round((n.end + 2) * sr));
      writeWav(`${ECOUTE}/0${factor === 2 ? 4 : 6}_voix_reelle_note_avant.wav`, sr, chs.map(c => c.slice(from, to)));
      writeWav(`${ECOUTE}/0${factor === 2 ? 5 : 7}_voix_reelle_note_${factor === 2 ? 'allongee_x2' : 'raccourcie_x0,5'}.wav`, sr, out.map(c => c.slice(from, Math.min(c.length, to + D))));
    }
    R.voix_reelle.elastique = el;
  }
}

// ---------------------------------------------------------------- 3. Temps d'analyse : 3 min de voix
const long = `${SESSION}/Silence blanc (Vocals).L.wav`;
if (existsSync(long)) {
  const { sr, ch } = readWav(long);
  const x = ch[0].slice(0, Math.min(ch[0].length, 180 * sr));
  const t0 = now();
  const a = analyzeVoice([x], sr);
  const t1 = now();
  const marks = voiceMarks(x, a.track);
  const t2 = now();
  const shapes = a.notes.map(n => noteShape(a.track, n));
  const edits = a.notes.map((_, k) => (k % 3 === 0 ? E(0.5) : undefined));
  const t3 = now();
  renderVoice([x], marks, buildPlan({ track: a.track, notes: a.notes, shapes, edits }));
  const t4 = now();
  R.trois_minutes = {
    duree_s: r2(x.length / sr), notes: a.notes.length,
    analyse_s: r2((t1 - t0) / 1000), marques_s: r2((t2 - t1) / 1000), rendu_apres_retouche_s: r2((t4 - t3) / 1000),
    note: 'un seul fil, ce PC ; dans NOVA : dans un worker (interface fluide), marques calculées une fois par analyse',
  };
}

// ---------------------------------------------------------------- 4. Élastique synthétique (×2, ×0,5) : fichiers d'écoute
{
  const sr = 48000;
  const x = synthVoice(sr, 4.2, [{ midi: 60.3, at: 0.2, len: 1.6, vibratoCents: 45, vibratoHz: 5.6 }, { midi: 64.1, at: 2.05, len: 1.2 }]);
  const p = prep(x, sr);
  writeWav(`${ECOUTE}/08_synthese_avant.wav`, sr, [x]);
  const L = p.notes[0].end - p.notes[0].start;
  for (const f of [2, 0.5]) {
    const dd = Math.round(L * (f - 1) * sr) / sr;
    const y = render([x], p, p.notes.map((_, k) => (k === 0 ? E(0, { dt1: dd }) : E(0, { dt0: dd, dt1: dd }))), dd)[0];
    writeWav(`${ECOUTE}/0${f === 2 ? 9 : '9b'}_synthese_note_${f === 2 ? 'x2' : 'x0,5'}.wav`, sr, [y]);
  }
}

writeFileSync(`${OUT}/mesures.json`, JSON.stringify(R, null, 1));
console.log(JSON.stringify(R, null, 1));
