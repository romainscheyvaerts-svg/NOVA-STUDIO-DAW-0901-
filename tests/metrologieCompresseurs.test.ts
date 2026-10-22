/**
 * Banc de métrologie (22/10/2026) : Compresseur, compresseurs analogiques, de-esser.
 *
 * Tout est mesuré sur le SON rendu par le code réel, au même chemin que l'export :
 *  - Compresseur : le code du worklet (chaîne sérialisée) exécuté tel quel, réglages du cœur
 *    calculés par le vrai CompressorNode (workletCfg), gain de compensation appliqué après ;
 *  - analogiques et de-esser : leurs cœurs purs (ceux que l'AudioWorklet sérialise).
 * À 44,1 et 48 kHz. Conventions : niveau d'un sinus = sa crête (dBFS) ; gain = rapport des raies
 * (moindres carrés) en régime établi ; temps = 63,2 % (et 90 %) de l'écart de réduction (dB).
 * Tolérances : gain ±0,1 dB, ratio ±1 %, temps ±5 %, fréquence ±1 %.
 * METRO_DUMP=fichier.json : écrit toutes les mesures (rapport D:\1 WORK\CONTENU\nova-metrologie).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import { CompressorNode, __compWorkletCodeForTests, compCurveOutDb, compModeDynamics, compRelease63, compAutoMakeupDb, compRealText } from '../plugins/CompressorPlugin';
import { createAnalogCompCore } from '../engine/analogCompCore';
import { buildAnalogInternal } from '../engine/analogCompMaps';
import { ANALOG_PROFILES } from '../engine/analogProfiles';
import { ANALOG_SPECS } from '../engine/analogCompParams';
import { formatAnalog } from '../plugins/AnalogCompPlugin';
import { createDeesserCore } from '../engine/deesserCore';
import { deesserResponseDb, deesserMaxRangeDb, DEESS_ABS_SINE_OFFSET_DB } from '../plugins/DeEsserPlugin';
import { loadWorkletCode, runProcessor, sendMsg, sine, tone, dbOf, linOf, timeToPct, pinkNoise, rmsDb, maxOf, tonesDb } from './metrologie/outils';

const RATES = [44100, 48000];
const mesures: Record<string, any> = {};
const note = (k: string, v: any) => { mesures[k] = v; };
afterAll(() => { if (process.env.METRO_DUMP) fs.writeFileSync(process.env.METRO_DUMP, JSON.stringify(mesures, null, 1)); });

// ═══════════════════════════════════ Compresseur ═══════════════════════════════════
class FP { value = 0; setValueAtTime(v: number) { this.value = v; return this; } setTargetAtTime(v: number) { this.value = v; return this; }
  cancelScheduledValues() { return this; } linearRampToValueAtTime(v: number) { this.value = v; return this; } }
function fakeCtx(sr: number): any {
  const node = () => ({ connect() { /* */ }, disconnect() { /* */ }, gain: new FP(), frequency: new FP(), Q: new FP(), delayTime: new FP(),
    threshold: new FP(), ratio: new FP(), knee: new FP(), attack: new FP(), release: new FP(), channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers', curve: null, type: '', oversample: 'none' });
  return {
    sampleRate: sr, currentTime: 0, state: 'running',
    createGain: node, createWaveShaper: node, createBiquadFilter: node, createDelay: node, createAnalyser: node, createDynamicsCompressor: node,
    // Module jamais chargé : seuls les réglages calculés par le nœud servent (le cœur tourne ci-dessous).
    audioWorklet: { addModule: () => new Promise(() => { /* */ }) },
  };
}

/** Compresseur NOVA tel qu'exporté : cœur (worklet, version légère ou complète) puis gain de compensation. */
function comp(params: Record<string, any>, sr: number, full = false) {
  const node: any = new CompressorNode(fakeCtx(sr));
  node.updateParams(params);
  const run = loadWorkletCode(__compWorkletCodeForTests(), sr);
  const P = run.classes[full ? 'vocal-compressor-processor-r' : 'vocal-compressor-processor-r-lite'];
  const cfg = node.workletCfg();
  const proc = new P({ processorOptions: { cfg, curve: Array.from(node.curveData), trim: node.trimTarget() } });
  const p = node.params;
  const makeup = p.autoMakeup ? node.calculateAutoMakeup() : p.makeupGain;
  const process = (x: Float32Array, key?: Float32Array) => {
    const ins = key ? [[x, x], [key, key]] : [[x, x]];
    const o = runProcessor(run, proc, ins, 2, full ? { threshold: cfg.threshold, ratio: cfg.ratio } : {});
    return o.map(c => { const r = new Float32Array(c.length); for (let i = 0; i < c.length; i++) r[i] = c[i] * makeup; return r; });
  };
  return { node, proc, run, process, makeup, cfg };
}

/** Gain statique (dB) d'un sinus de crête L dBFS, mesuré sur les 200 dernières ms d'une tenue de 0,6 s. */
function compGain(params: Record<string, any>, sr: number, L: number, f = 1000) {
  const c = comp(params, sr);
  const n = Math.round(sr * 0.6), from = Math.round(sr * 0.4);
  const x = sine(f, sr, n, L, Math.PI / 2);
  const [y] = c.process(x);
  return tone(y, f, sr, from, n).db - tone(x, f, sr, from, n).db;
}

/** Échelon −50 → −20 dBFS (porteuse 4 kHz) tenu `hold` s puis retour : temps 63 % / 90 % d'attaque et de relâche (s). */
function stepTimes(params: Record<string, any>, sr: number, tail: number, hold = 1.5) {
  const c = comp(params, sr);
  const lo = linOf(-50), hi = linOf(-20);
  const n1 = Math.round(sr * 0.3), n2 = Math.round(sr * hold), n3 = Math.round(sr * tail);
  const x = new Float32Array(n1 + n2 + n3), a = new Float32Array(x.length);
  const w = 2 * Math.PI * 4000 / sr;
  for (let i = 0; i < x.length; i++) { a[i] = i < n1 ? lo : i < n1 + n2 ? hi : lo; x[i] = a[i] * Math.cos(w * i); }
  const [y] = c.process(x);
  // Attaque : rapport instantané aux crêtes de la porteuse (le gain est appliqué échantillon par échantillon).
  const g = new Float64Array(x.length); let last = 0;
  for (let i = 0; i < x.length; i++) { if (Math.abs(x[i]) > 0.7 * a[i]) last = dbOf(y[i] / x[i]); g[i] = last; }
  const g0 = g[n1 - 1], gn = Array.from(g, v => v - g0);
  const grEnd = gn[n1 + n2 - 1];
  // Relâche : raie ajustée sur 2 ms (insensible à la traîne sub-audio du filtre anti-continu à 8 Hz).
  const rel = (pct: number) => {
    const h = Math.round(sr * 0.001), start = n1 + n2, target = grEnd * (1 - pct / 100);
    let pt = 0, pg = grEnd;
    for (let i = start + h; i + h < x.length; i += 4) {
      const gg = tone(y, 4000, sr, i - h, i + h).db - tone(x, 4000, sr, i - h, i + h).db - g0, t = (i - start) / sr;
      if (gg >= target) return pt + (t - pt) * (target - pg) / (gg - pg);
      pt = t; pg = gg;
    }
    return NaN;
  };
  return { gr: -grEnd, a63: timeToPct(gn, n1, sr, 63.2, grEnd), a90: timeToPct(gn, n1, sr, 90, grEnd), r63: rel(63.2), r90: rel(90) };
}

describe('métrologie · Compresseur (cœur du worklet, chemin de l’export)', () => {
  it('courbe statique mesurée = courbe dessinée à l’écran (seuil, ratio, genou ; ratios extrêmes), ±0,1 dB', () => {
    const cases = [
      { threshold: -18, ratio: 4, knee: 12 }, { threshold: -30, ratio: 2, knee: 0 }, { threshold: -10, ratio: 20, knee: 0 },
      { threshold: -40, ratio: 1.5, knee: 40 }, { threshold: -24, ratio: 1, knee: 6 }, { threshold: -60, ratio: 8, knee: 6 },
    ];
    const rows: any[] = [];
    for (const sr of RATES) for (const c of cases) for (const L of [-50, -27, -21, -15, -3]) {
      const meas = compGain({ ...c, attack: 0.003, release: 0.25, makeupGain: 1, mode: 'CLEAN', scHpFreq: 80 }, sr, L);
      const disp = compCurveOutDb(L, c.threshold, c.ratio, c.knee) - L;
      rows.push({ sr, ...c, L, affiche: +disp.toFixed(3), mesure: +meas.toFixed(3) });
      expect(Math.abs(meas - disp), `${sr} ${JSON.stringify(c)} L=${L}`).toBeLessThan(0.1);
    }
    note('comp_statique', rows);
  });

  it('ratio mesuré (pente au-dessus du genou) = ratio affiché à ±1 %, y compris 20:1 ; 1:1 ne touche à rien', () => {
    const rows: any[] = [];
    for (const sr of RATES) for (const ratio of [1.5, 2, 4, 10, 20]) {
      const p = { threshold: -40, ratio, knee: 0, attack: 0.003, release: 0.25, makeupGain: 1, mode: 'CLEAN' };
      const g1 = compGain(p, sr, -30), g2 = compGain(p, sr, -6);
      const measR = 24 / (24 + (g2 - g1));
      rows.push({ sr, ratio, mesure: +measR.toFixed(4) });
      expect(Math.abs(measR / ratio - 1), `${sr} ${ratio}:1 → ${measR}`).toBeLessThan(0.01);
    }
    for (const sr of RATES) expect(Math.abs(compGain({ threshold: -60, ratio: 1, knee: 0, mode: 'CLEAN', makeupGain: 1 }, sr, -6))).toBeLessThan(0.01);
    note('comp_ratio', rows);
  });

  it('gain de compensation : manuel (1,4 = +2,92 dB) et automatique (valeur maintenant affichée) = gain mesuré', () => {
    const rows: any[] = [];
    for (const sr of RATES) {
      const man = compGain({ threshold: -20, ratio: 4, knee: 0, makeupGain: 1.4, mode: 'CLEAN' }, sr, -40);
      expect(Math.abs(man - 20 * Math.log10(1.4))).toBeLessThan(0.01);
      for (const [T, R] of [[-20, 4], [-30, 2], [-12, 8]]) {
        const auto = compGain({ threshold: T, ratio: R, knee: 0, makeupGain: 1, autoMakeup: true, mode: 'CLEAN' }, sr, -55);
        rows.push({ sr, T, R, affiche: compAutoMakeupDb(T, R), mesure: +auto.toFixed(3) });
        expect(Math.abs(auto - compAutoMakeupDb(T, R)), `auto ${T}/${R}`).toBeLessThan(0.02);
      }
    }
    note('comp_makeup', rows);
  });

  it('caractères : genou, compensation et saturation réellement appliqués = ce qu’affiche la fenêtre', () => {
    const rows: any[] = [];
    for (const sr of RATES) for (const mode of ['CLEAN', 'VCA', 'OPTO', 'FET']) {
      const p = { threshold: -30, ratio: 4, knee: 12, attack: 0.003, release: 0.25, makeupGain: 1, mode };
      const d = compModeDynamics(p as any);
      // Compensation du caractère : gain sous le seuil (petit signal, saturation négligeable).
      const trim = compGain(p, sr, -60);
      rows.push({ sr, mode, compensationAffichee: d.trimDb, compensationMesuree: +trim.toFixed(3) });
      expect(Math.abs(trim - d.trimDb), `${mode} trim`).toBeLessThan(0.02);
      // Genou effectif : courbe statique au voisinage du seuil.
      for (const L of [-36, -33, -30, -27, -24]) {
        const meas = compGain(p, sr, L) - trim;
        const dispEff = compCurveOutDb(L, -30, 4, d.knee) - L;
        const dispAvant = compCurveOutDb(L, -30, 4, 12) - L;
        rows.push({ sr, mode, L, genouEffectif: d.knee, avant: +dispAvant.toFixed(3), apres: +dispEff.toFixed(3), mesure: +meas.toFixed(3) });
        expect(Math.abs(meas - dispEff), `${mode} L=${L}`).toBeLessThan(0.1);
      }
    }
    // Avant le 22/10/2026 l'écran dessinait le genou RÉGLÉ : en FET (genou réel 4 dB) l'écart au seuil était de 0,75 dB.
    const fet = rows.find(r => r.mode === 'FET' && r.L === -30);
    expect(Math.abs(fet.mesure - fet.avant)).toBeGreaterThan(0.5);
    note('comp_caracteres', rows);
  });

  it('crête (Clean, FET) contre RMS (VCA, Opto) : même seuil pour un sinus ; bruit rose ≈ RMS + 3 dB en VCA', () => {
    const rows: any[] = [];
    for (const sr of RATES) {
      for (const mode of ['VCA', 'OPTO']) {
        const p = { threshold: -30, ratio: 4, knee: 0, attack: 0.003, release: 0.25, makeupGain: 1, mode };
        const trim = compGain(p, sr, -60);
        const g = compGain(p, sr, -18) - trim; // 12 dB au-dessus : 9 dB de réduction attendus
        rows.push({ sr, mode, signal: 'sinus 1 kHz −18 dBFS', attendu: -9, mesure: +g.toFixed(3) });
        expect(Math.abs(g + 9), `${mode} sinus`).toBeLessThan(0.15);
      }
      // Bruit rose −24 dB RMS : VCA (RMS + 3,01 dB) attend 0,75·(−24 + 3,01 + 30) = 6,74 dB de réduction ; Clean réagit aux crêtes.
      const n = Math.round(sr * 2), x = pinkNoise(n, -24, 3), from = Math.round(sr * 1);
      for (const mode of ['VCA', 'CLEAN']) {
        const c = comp({ threshold: -30, ratio: 4, knee: 0, attack: 0.003, release: 0.25, makeupGain: 1, mode, scHpFreq: 20 }, sr);
        const [y] = c.process(x);
        const gr = rmsDb(x, from, n) - rmsDb(y, from, n) + (mode === 'VCA' ? 0.3 : 0);
        rows.push({ sr, mode, signal: 'bruit rose −24 dB RMS', attenduSiRms: 6.74, mesure: +gr.toFixed(2) });
        // VCA : RMS court (4 ms) dont le détecteur garde les pointes (maintien + relâche) : un peu plus que
        // la réduction « RMS long terme » ; Clean (crête) : le facteur de crête du bruit compte en entier.
        if (mode === 'VCA') { expect(gr).toBeGreaterThan(6.74); expect(gr).toBeLessThan(6.74 + 2); }
        else expect(gr).toBeGreaterThan(9);
      }
    }
    note('comp_detection', rows);
  });

  it('temps : attaque = constante de temps affichée (63 %), relâche mesurée = valeur affichée sous les boutons, ±5 %', () => {
    const rows: any[] = [], bad: string[] = [];
    for (const sr of RATES) for (const mode of ['CLEAN', 'FET', 'VCA', 'OPTO']) for (const [att, rel] of (mode === 'CLEAN' || mode === 'FET' ? [[0.001, 0.01], [0.003, 0.05], [0.01, 0.25], [0.03, 1]] : sr === 48000 ? [[0.003, 0.05], [0.01, 0.25]] : [])) {
      const p = { threshold: -40, ratio: 4, knee: 0, attack: att, release: rel, makeupGain: 1, mode, scHpFreq: 20 };
      const d = compModeDynamics(p as any);
      const peakMode = mode === 'CLEAN' || mode === 'FET';
      const r = stepTimes(p, sr, Math.min(mode === 'OPTO' ? 6.5 : 3.5, (mode === 'OPTO' ? 6 : 2.5) * d.release + 0.2), peakMode ? 0.4 + 6 * d.attack : 1.5);
      const r63 = compRelease63(d.release, d.attack);
      rows.push({ sr, mode, attaqueReglee: att * 1000, releaseReglee: rel * 1000, attaqueAffichee: +(d.attack * 1000).toFixed(2), attaqueMesuree: +(r.a63 * 1000).toFixed(2),
        attaque90: +(r.a90 * 1000).toFixed(2), releaseAffichee: +(r63 * 1000).toFixed(1), releaseMaxAffichee: +(compRelease63(d.release * d.releaseMax, d.attack) * 1000).toFixed(1), releaseMesuree: +(r.r63 * 1000).toFixed(1) });
      const tag = `${sr} ${mode} ${att * 1000}/${rel * 1000} ms`;
      if (peakMode) {
        // Détection crête : définitions exactes.
        if (!(Math.abs(r.a63 / d.attack - 1) < 0.05)) bad.push(`${tag} attaque 63 % ${r.a63}`);
        if (!(Math.abs(r.a90 - d.attack * Math.log(10)) < Math.max(0.05 * d.attack * Math.log(10), 3 / sr))) bad.push(`${tag} attaque 90 % ${r.a90}`); // résolution : 3 échantillons
        if (!(Math.abs(r.r63 / r63 - 1) < 0.05)) bad.push(`${tag} relâche ${r.r63} ≠ ${r63}`);
      } else {
        // RMS : l'attaque mesurée s'allonge de la moyenne RMS (affichée) ; relâche dépendante du programme,
        // entre la valeur affichée et la valeur « si la réduction dure » (affichée aussi).
        if (!(r.a63 > d.attack * 0.95 && r.a63 < d.attack + 2 * d.rmsMs / 1000)) bad.push(`${tag} attaque ${r.a63}`);
        if (!(r.r63 > r63 * 0.95 && r.r63 < compRelease63(d.release * d.releaseMax, d.attack) * 1.2 + 2 * d.rmsMs / 1000)) bad.push(`${tag} relâche ${r.r63}`);
      }
    }
    note('comp_temps', rows);
    expect(bad).toEqual([]);
  });

  it('vumètre de réduction : la valeur envoyée à la fenêtre = la réduction mesurée sur le son, ±0,1 dB', () => {
    const rows: any[] = [];
    for (const sr of RATES) for (const L of [-24, -12, 0]) {
      const c = comp({ threshold: -30, ratio: 4, knee: 6, attack: 0.003, release: 0.25, makeupGain: 1, mode: 'CLEAN' }, sr);
      sendMsg(c.proc, { meters: true });
      const n = Math.round(sr * 0.6), from = Math.round(sr * 0.4);
      const x = sine(1000, sr, n, L, Math.PI / 2);
      const [y] = c.process(x);
      const meas = tone(x, 1000, sr, from, n).db - tone(y, 1000, sr, from, n).db;
      const msgs = c.proc.port.messages.filter((m: any) => Number.isFinite(m.gr));
      const shown = -msgs[msgs.length - 1].peak;
      rows.push({ sr, L, vumetre: +shown.toFixed(3), mesure: +meas.toFixed(3) });
      expect(Math.abs(shown - meas), `VU ${L}`).toBeLessThan(0.1);
    }
    note('comp_vumetre', rows);
  });

  it('anticipation : latence annoncée au PDC = retard réel du son = retard de la voie sèche (nombre entier d’échantillons)', () => {
    const rows: any[] = [];
    for (const sr of RATES) for (const look of [0.001, 0.0023, 0.005]) {
      const c = comp({ threshold: -60, ratio: 1, lookahead: look, makeupGain: 1, mode: 'CLEAN' }, sr);
      const n = 4096, x = new Float32Array(n); x[1000] = 0.5;
      const [y] = c.process(x);
      let at = 0; for (let i = 0; i < n; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
      const real = at - 1000;
      const announced = c.node.latency * sr;
      const dry = c.node.effectiveLookahead() * sr; // valeur posée sur le retard de la voie sèche
      rows.push({ sr, anticipationMs: look * 1000, reelEch: real, annonceEch: +announced.toFixed(3), voieSecheEch: +dry.toFixed(3), avantAnnonceEch: +(look * sr).toFixed(2) });
      expect(Math.abs(announced - real), `${sr} ${look}`).toBeLessThan(1e-6);
      expect(Math.abs(dry - real), `${sr} ${look} sec`).toBeLessThan(1e-6);
    }
    note('comp_anticipation', rows);
  });

  it('clé externe : la réduction suit la clé (même courbe) ; écoute de la clé = la clé seule', () => {
    const rows: any[] = [];
    for (const sr of RATES) {
      const n = Math.round(sr * 0.6), from = Math.round(sr * 0.4);
      const x = sine(500, sr, n, -40);
      for (const K of [-40, -18, -6]) {
        const key = sine(1000, sr, n, K, Math.PI / 2);
        const c = comp({ threshold: -30, ratio: 4, knee: 0, makeupGain: 1, mode: 'CLEAN' }, sr, true);
        c.node.keyActive = true;
        sendMsg(c.proc, { cfg: c.node.workletCfg() });
        const [y] = c.process(x, key);
        const gr = tone(x, 500, sr, from, n).db - tone(y, 500, sr, from, n).db;
        const exp = -(compCurveOutDb(K, -30, 4, 0) - K);
        rows.push({ sr, cleDbfs: K, attendu: exp, mesure: +gr.toFixed(3) });
        expect(Math.abs(gr - exp), `clé ${K}`).toBeLessThan(0.1);
      }
      const c = comp({ threshold: -30, ratio: 4, knee: 0, makeupGain: 1, mode: 'CLEAN', keyListen: 1 }, sr, true);
      c.node.keyActive = true;
      sendMsg(c.proc, { cfg: c.node.workletCfg() });
      const key = sine(1000, sr, n, -12);
      const [y] = c.process(x, key);
      expect(Math.abs(tone(y, 1000, sr, from, n).db - (-12))).toBeLessThan(0.02);
      expect(tone(y, 500, sr, from, n).db).toBeLessThan(-100);
    }
    note('comp_cle', rows);
  });

  it('la fenêtre dit ce que fait le cœur (texte « Réel »)', () => {
    note('comp_textes', ['CLEAN', 'VCA', 'OPTO', 'FET'].map(m => compRealText({ mode: m as any, attack: 0.003, release: 0.25, knee: 12 })));
    expect(compRealText({ mode: 'FET', attack: 0.003, release: 0.25, knee: 12 })).toMatch(/attaque 1,5 ms · relâche 18\d ms \(63 %\) · genou 4 dB · détection crête · \+0,6 dB/);
    expect(compRealText({ mode: 'OPTO', attack: 0.003, release: 0.25, knee: 0 })).toMatch(/attaque 10 ms · relâche 2\d\d ms \(63 %\), jusqu’à 1,2\d s si la réduction dure · genou 10 dB · détection RMS \(moyenne 10 ms\)/);
    expect(compRealText({ mode: 'CLEAN', attack: 0.003, release: 0.25, knee: 12 })).toMatch(/^Réel : attaque 3,0 ms · relâche 25\d ms \(63 %\) · genou 12 dB · détection crête$/);
  });
});

// ═══════════════════════════════ Compresseurs analogiques ═══════════════════════════════
function analogRun(kind: string, p: Record<string, number>, sr: number, x: Float32Array) {
  const c = createAnalogCompCore(sr);
  c.setInternal(buildAnalogInternal(kind, { ...ANALOG_SPECS[kind].defaults, ...p }, ANALOG_PROFILES[kind], sr));
  const n = x.length, y = new Float32Array(n), yr = new Float32Array(n);
  for (let i = 0; i < n; i += 128) { const m = Math.min(128, n - i); c.process(x.subarray(i, i + m), x.subarray(i, i + m), y.subarray(i, i + m), yr.subarray(i, i + m), m); }
  return { y, vu: c.takeMeters().grNowDb };
}
function analogGain(kind: string, p: Record<string, number>, sr: number, L: number) {
  const n = Math.round(sr * 2.5), from = Math.round(sr * 2);
  const x = sine(1000, sr, n, L);
  const { y, vu } = analogRun(kind, p, sr, x);
  return { g: tone(y, 1000, sr, from, n).db - tone(x, 1000, sr, from, n).db, vu };
}
/** Gain affiché (dB) par la fenêtre dans le texte d'un bouton (« … · +14,5 dB »). */
const shownDb = (txt: string) => { const m = txt.match(/([+−-]?\d+(?:,\d+)?) dB/); return m ? parseFloat(m[1].replace('−', '-').replace(',', '.')) : NaN; };

describe('métrologie · compresseurs analogiques (cœurs du worklet)', () => {
  it('vumètre de réduction = réduction mesurée sur le son (petit signal comme référence), ±0,15 dB', () => {
    const rows: any[] = [];
    const sets: [string, Record<string, number>, number[]][] = [
      ['OPTO_VINTAGE', { threshold: -30, ratio: 4, mode: 2 }, [-28, -20, -8]],
      ['FET76', { input: -28, output: -15, ratio: 4 }, [-25, -20, -15]],
      ['LEVELER2A', { peakReduction: 50, gain: 50 }, [-25, -15, -5]],
      ['VOXSTRIP', {}, [-25, -15]],
    ];
    for (const sr of RATES) for (const [k, p, levels] of sets) {
      const g0 = analogGain(k, p, sr, -80).g;
      for (const L of levels) {
        const r = analogGain(k, p, sr, L);
        rows.push({ sr, effet: k, L, vumetre: +r.vu.toFixed(2), mesure: +(g0 - r.g).toFixed(2) });
        expect(Math.abs(r.vu - (g0 - r.g)), `${k} ${L}`).toBeLessThan(0.15);
      }
    }
    note('analog_vumetre', rows);
  });

  it('gains affichés par les boutons (dB) = gain petit signal mesuré à 1 kHz', () => {
    const rows: any[] = [];
    const spec = (k: string, id: string) => ANALOG_SPECS[k].specs.find(s => s.id === id)!;
    for (const sr of RATES) {
      for (const out of [-18, 0, 12, 28]) {
        const meas = analogGain('OPTO_VINTAGE', { output: out, threshold: 20 }, sr, -70).g;
        rows.push({ sr, effet: 'OPTO_VINTAGE', reglage: `sortie ${out}`, affiche: shownDb(formatAnalog('OPTO_VINTAGE', spec('OPTO_VINTAGE', 'output'), out)), mesure: +meas.toFixed(2) });
      }
      for (const g of [5, 25, 50, 75, 100]) {
        const meas = analogGain('LEVELER2A', { gain: g, peakReduction: 0 }, sr, -80).g;
        rows.push({ sr, effet: 'LEVELER2A', reglage: `gain ${g}`, affiche: shownDb(formatAnalog('LEVELER2A', spec('LEVELER2A', 'gain'), g)), mesure: +meas.toFixed(2) });
      }
      for (const i of [2, 5, 7]) {
        const meas = analogGain('VOXSTRIP', { input: i, compOn: 0, eqOn: 0, output: 0, transformer: 0 }, sr, -80).g;
        rows.push({ sr, effet: 'VOXSTRIP', reglage: `entrée ${i}`, affiche: shownDb(formatAnalog('VOXSTRIP', spec('VOXSTRIP', 'input'), i)), mesure: +meas.toFixed(2) });
      }
      for (const [inp, out] of [[-60, -24], [-28, -24], [0, -24], [-24, -40], [-24, -6]]) {
        const meas = analogGain('FET76', { input: inp, output: out, ratio: 0 }, sr, -80).g;
        const disp = shownDb(formatAnalog('FET76', spec('FET76', 'input'), inp)) + shownDb(formatAnalog('FET76', spec('FET76', 'output'), out));
        rows.push({ sr, effet: 'FET76', reglage: `entrée ${inp} / sortie ${out}`, affiche: +disp.toFixed(2), mesure: +meas.toFixed(2) });
      }
    }
    note('analog_gains', rows);
    for (const r of rows) {
      // FET 76 / Vox Strip : réponse en fréquence de l'appareil modélisé à 1 kHz (couleur mesurée au labo), ≤ 0,2 dB.
      const tol = r.effet === 'FET76' || r.effet === 'VOXSTRIP' ? 0.2 : 0.1;
      expect(Math.abs(r.mesure - r.affiche), `${r.effet} ${r.reglage} ${r.sr}`).toBeLessThan(tol);
    }
  });

  it('Opto Vintage : seuil (≈ 1 dB de réduction en Manuel 4:1) et taux réels selon le mode (relevés pour le rapport)', () => {
    const rows: any[] = [];
    const sr = 48000;
    for (const mode of [0, 1, 2]) for (const ratio of [2, 4, 10]) {
      const p = { threshold: -30, ratio, mode, output: 0 };
      const g0 = analogGain('OPTO_VINTAGE', p, sr, -70).g;
      const at = g0 - analogGain('OPTO_VINTAGE', p, sr, -30).g;
      const a = g0 - analogGain('OPTO_VINTAGE', p, sr, -20).g, b = g0 - analogGain('OPTO_VINTAGE', p, sr, -8).g;
      rows.push({ mode: ['Fixe', 'Fixe/Manuel', 'Manuel'][mode], tauxAffiche: ratio, reductionAuSeuil: +at.toFixed(2), tauxMesure_m20_m8: +(12 / (12 - (b - a))).toFixed(2) });
    }
    note('analog_opto_seuil_taux', rows);
    const man4 = rows.find(r => r.mode === 'Manuel' && r.tauxAffiche === 4);
    expect(Math.abs(man4.reductionAuSeuil - 1)).toBeLessThan(0.15);
  });

  it('FET 76 et Leveler 2A : taux mesurés (pente entre ~5 et ~15 dB de réduction) — relevés pour le rapport', () => {
    const rows: any[] = [];
    const sr = 48000;
    for (const ratio of [2, 4, 8, 20, 24]) {
      const p = { input: -28, output: -15, ratio };
      const g0 = analogGain('FET76', p, sr, -80).g;
      const a = g0 - analogGain('FET76', p, sr, -20).g, b = g0 - analogGain('FET76', p, sr, -10).g;
      rows.push({ effet: 'FET76', tauxAffiche: ratio === 24 ? 'Écrasé' : `${ratio}:1`, reduction: [+a.toFixed(1), +b.toFixed(1)], tauxMesure: +(10 / (10 - (b - a))).toFixed(2) });
    }
    for (const limit of [0, 1]) {
      const p = { peakReduction: 50, gain: 50, limit };
      const g0 = analogGain('LEVELER2A', p, sr, -80).g;
      const a = g0 - analogGain('LEVELER2A', p, sr, -20).g, b = g0 - analogGain('LEVELER2A', p, sr, -5).g;
      rows.push({ effet: 'LEVELER2A', tauxAffiche: limit ? 'Limit' : 'Compress', reduction: [+a.toFixed(1), +b.toFixed(1)], tauxMesure: +(15 / (15 - (b - a))).toFixed(2) });
    }
    note('analog_taux', rows);
  });

  it('temps : plus aucun temps de l’appareil d’origine affiché comme celui de NOVA ; extrêmes des infobulles = mesurés (±15 %)', () => {
    const spec = (k: string, id: string) => ANALOG_SPECS[k].specs.find(s => s.id === id)!;
    for (const k of ['OPTO_VINTAGE', 'FET76']) for (const id of ['attack', 'release']) for (const v of [1, 3, 5, 7]) {
      expect(formatAnalog(k, spec(k, id), v), `${k} ${id}`).not.toMatch(/\d\s*(ms|s)\b/);
    }
    // Extrêmes mesurés sur NOVA (réduction lue sur la cellule, saut d'un sinus 1 kHz de −70 dBFS à 15 dB au-dessus du seuil).
    const sr = 48000;
    const t63 = (kind: string, p: Record<string, number>, L: number, phase: 'a' | 'r', obs: number) => {
      const c = createAnalogCompCore(sr);
      c.setInternal(buildAnalogInternal(kind, { ...ANALOG_SPECS[kind].defaults, ...p }, ANALOG_PROFILES[kind], sr));
      const n0 = Math.round(0.5 * sr), n1 = Math.round(2 * sr), n2 = Math.round(obs * sr);
      const lo = linOf(-70), hi = linOf(L), w = 2 * Math.PI * 1000 / sr;
      const x = new Float32Array(1), y = new Float32Array(1), y2 = new Float32Array(1);
      const tr = new Float64Array(n0 + n1);
      let end = 0;
      for (let i = 0; i < n0 + n1 + n2; i++) {
        x[0] = (i >= n0 && i < n0 + n1 ? hi : lo) * Math.sin(w * i);
        c.process(x, x, y, y2, 1);
        const gr = 20 * Math.log10(c.attenuation());
        if (i < n0 + n1) tr[i] = gr;
        if (i === n0 + n1 - 1) { end = gr; if (phase === 'a') { for (let j = n0; j < n0 + n1; j++) if (tr[j] >= 0.632 * end) return (j - n0) / sr * 1000; } }
        if (phase === 'r' && i >= n0 + n1 && gr <= end * (1 - 0.632)) return (i - n0 - n1) / sr * 1000;
      }
      return NaN;
    };
    const rows = {
      optoAtt0: t63('OPTO_VINTAGE', { threshold: -30, ratio: 4, mode: 2, attack: 0 }, -15, 'a', 0),
      optoAtt10: t63('OPTO_VINTAGE', { threshold: -30, ratio: 4, mode: 2, attack: 10 }, -15, 'a', 0),
      optoRel0: t63('OPTO_VINTAGE', { threshold: -30, ratio: 4, mode: 2, release: 0 }, -15, 'r', 1),
      optoRel10: t63('OPTO_VINTAGE', { threshold: -30, ratio: 4, mode: 2, release: 10 }, -15, 'r', 14),
      fetAtt7: t63('FET76', { input: -28, ratio: 4, attack: 7 }, -20, 'a', 0),
      fetAtt1: t63('FET76', { input: -28, ratio: 4, attack: 1 }, -20, 'a', 0),
      fetSlo: t63('FET76', { input: -28, ratio: 4, slo: 1 }, -20, 'a', 0),
      fetRel7: t63('FET76', { input: -28, ratio: 4, release: 7 }, -20, 'r', 1),
      fetRel1: t63('FET76', { input: -28, ratio: 4, release: 1 }, -20, 'r', 4),
    };
    note('analog_temps_extremes_ms', rows);
    const near = (v: number, ref: number, what: string) => expect(Math.abs(v / ref - 1), `${what} : ${v} ≈ ${ref}`).toBeLessThan(0.15);
    // Valeurs écrites dans les infobulles (engine/analogCompParams.ts).
    near(rows.optoAtt0, 1.2, 'opto att 0'); near(rows.optoAtt10, 140, 'opto att 10'); near(rows.optoRel0, 13, 'opto rel 0'); near(rows.optoRel10, 9600, 'opto rel 10');
    near(rows.fetAtt7, 0.2, 'fet att 7'); near(rows.fetAtt1, 6, 'fet att 1'); near(rows.fetSlo, 25, 'fet slo');
    near(rows.fetRel7, 15, 'fet rel 7'); near(rows.fetRel1, 1500, 'fet rel 1');
  });
});

// ═══════════════════════════════════ De-esser ═══════════════════════════════════
function deessRun(p: Record<string, any>, sr: number, x: Float32Array) {
  const c = createDeesserCore(sr);
  c.setParams({ isEnabled: true, ...p });
  const n = x.length, y = new Float32Array(n), yr = new Float32Array(n);
  let gr = 0;
  for (let i = 0; i < n; i += 128) { const m = Math.min(128, n - i); c.process(x.subarray(i, i + m), x.subarray(i, i + m), y.subarray(i, i + m), yr.subarray(i, i + m), m); gr = c.takeMeters().grNowDb; }
  return { y, gr };
}

describe('métrologie · de-esser (cœur du worklet)', () => {
  it('réduction au centre = « dB max » affiché ; forme mesurée = courbe dessinée (à la VRAIE fréquence d’échantillonnage), ±0,1 dB', () => {
    const rows: any[] = [];
    for (const sr of RATES) for (const [f0, q, r] of [[6000, 1, 0.6], [8000, 2, 1], [10000, 0.5, 0.25], [14000, 1, 0.6]]) {
      // Un sinus fort au centre déclenche la réduction maximale ; des sondes faibles relèvent la forme du creux.
      const n = Math.round(sr * 0.5), from = Math.round(sr * 0.3);
      const probes = [1500, 3000, 4500, f0 * 0.7, f0 * 0.9, f0 * 1.1, f0 * 1.3, Math.min(19000, f0 * 1.6)].map(f => Math.round(f / 10) * 10);
      const x = sine(f0, sr, n, -10);
      for (const f of probes) { const s = sine(f, sr, n, -60); for (let i = 0; i < n; i++) x[i] += s[i]; }
      const { y, gr } = deessRun({ mode: 'BELL', frequency: f0, q, reduction: r, detection: 'RELATIVE', relThreshold: -6 }, sr, x);
      const all = [f0, ...probes], ty = tonesDb(y, all, sr, from, n), tx = tonesDb(x, all, sr, from, n);
      const center = ty[0] - tx[0];
      rows.push({ sr, f0, q, f: f0, reductionMaxAffichee: deesserMaxRangeDb(r), mesure: +center.toFixed(3) });
      expect(Math.abs(-center - deesserMaxRangeDb(r)), `centre ${f0}`).toBeLessThan(0.1);
      expect(Math.abs(gr - deesserMaxRangeDb(r))).toBeLessThan(0.1);
      for (const [j, f] of probes.entries()) {
        const meas = ty[j + 1] - tx[j + 1];
        const shown = deesserResponseDb(f, { mode: 'BELL', frequency: f0, q }, gr, sr);
        const shown48 = deesserResponseDb(f, { mode: 'BELL', frequency: f0, q }, gr);
        rows.push({ sr, f0, q, f, mesure: +meas.toFixed(3), affiche: +shown.toFixed(3), afficheAvant48k: +shown48.toFixed(3) });
        expect(Math.abs(meas - shown), `${sr} f0=${f0} f=${f}`).toBeLessThan(0.1);
      }
      // Fréquence du creux = fréquence affichée (±1 %)
      const fmin = maxOf(f => -deesserResponseDb(f, { mode: 'BELL', frequency: f0, q }, gr, sr), f0 / 2, Math.min(sr * 0.45, f0 * 2)).f;
      expect(Math.abs(fmin / f0 - 1)).toBeLessThan(0.01);
    }
    note('deess_forme', rows);
  });

  it('seuils : point de déclenchement absolu (crête d’un sinus au centre) et relatif (écart bande / reste de la voix)', () => {
    const rows: any[] = [];
    for (const sr of RATES) {
      const n = Math.round(sr * 0.4);
      // Réduction au seuil (dépassement nul, genou de 6 dB) : k·6/8.
      const r = 0.6, k = 1 - 1 / (1 + 19 * r), atThr = k * 6 / 8;
      const grAt = (L: number) => deessRun({ mode: 'BELL', frequency: 8000, q: 1, reduction: r, detection: 'ABSOLUTE', threshold: -25 }, sr, sine(8000, sr, n, L)).gr;
      let lo = -40, hi = 0;
      for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (grAt(m) < atThr) lo = m; else hi = m; }
      rows.push({ sr, mode: 'absolu', seuilAffiche: -25, sinusCreteAuSeuil_dBFS: +((lo + hi) / 2).toFixed(2) });
      const grRel = (d: number) => { const x = sine(1000, sr, n, -20); const s = sine(8000, sr, n, -20 + d); for (let i = 0; i < n; i++) x[i] += s[i]; return deessRun({ mode: 'BELL', frequency: 8000, q: 1, reduction: r, detection: 'RELATIVE', relThreshold: -6 }, sr, x).gr; };
      lo = -30; hi = 10;
      for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (grRel(m) < atThr) lo = m; else hi = m; }
      rows.push({ sr, mode: 'relatif', sensibiliteAffichee: 6, ecartBandeResteAuSeuil_dB: +((lo + hi) / 2).toFixed(2) });
    }
    note('deess_seuils', rows);
    // Le bouton affiche maintenant le repère « sinus ≈ seuil + 6 dBFS » : vérifié à ±0,5 dB.
    for (const r of rows.filter(r => r.mode === 'absolu')) expect(Math.abs(r.sinusCreteAuSeuil_dBFS - (-25 + DEESS_ABS_SINE_OFFSET_DB))).toBeLessThan(0.5);
    // Relatif : seuil sur l'écart d'énergies lissées (enveloppes 0,3 / 10 ms) ; avec deux sinus, à 1,5 dB près.
    for (const r of rows.filter(r => r.mode === 'relatif')) expect(Math.abs(r.ecartBandeResteAuSeuil_dB - -6)).toBeLessThan(1.5);
  });

  it('latence nulle et transparence exacte quand il ne travaille pas', () => {
    for (const sr of RATES) {
      const x = sine(1000, sr, 4096, -12);
      const { y } = deessRun({ mode: 'BELL', frequency: 8000, q: 1, reduction: 0.6, detection: 'ABSOLUTE', threshold: 0 }, sr, x);
      for (let i = 0; i < x.length; i++) expect(y[i]).toBe(x[i]);
    }
  });
});
