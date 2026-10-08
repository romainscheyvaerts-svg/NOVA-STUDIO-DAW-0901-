import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createAnalogCompCore, AC } from '../engine/analogCompCore';
import { buildAnalogInternal } from '../engine/analogCompMaps';
import { ANALOG_PROFILES } from '../engine/analogProfiles';
import { ANALOG_SPECS, sanitizeAnalog, analogAutomatable } from '../engine/analogCompParams';
import { vuMaxGr, calibrateNova, bisectForTarget, grTraceFromIO, novaVuGr } from '../utils/grCalibration';
import { getRegisteredPlugin } from '../engine/pluginRegistry';

const SR = 48000;
const KINDS = Object.keys(ANALOG_SPECS);

/** Passe un signal stéréo dans le cœur, par blocs de 128 comme l'AudioWorklet. */
function run(kind: string, params: Record<string, number>, L: Float32Array, R = L) {
  const core = createAnalogCompCore(SR);
  core.setInternal(buildAnalogInternal(kind, params, ANALOG_PROFILES[kind], SR));
  const n = L.length;
  const oL = new Float32Array(n), oR = new Float32Array(n);
  let grMax = 0;
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i);
    core.process(L.subarray(i, i + m), R.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m);
    grMax = Math.max(grMax, core.takeMeters().grDb);
  }
  return { L: oL, R: oR, grMax };
}

const sine = (sec: number, dbfs: number, f = 1000) => {
  const n = Math.round(sec * SR), x = new Float32Array(n), a = Math.pow(10, dbfs / 20);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / SR);
  return x;
};
const rmsDb = (x: Float32Array, from = 0) => { let s = 0; for (let i = from; i < x.length; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (x.length - from) + 1e-30); };

/** Signal « voix » déterministe : syllabes de 150 à 400 ms, voyelles harmoniques, silences. */
function voiceLike(sec = 6, level = 0.3) {
  const n = Math.round(sec * SR), x = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let i = 0;
  while (i < n) {
    const len = Math.round((0.15 + 0.25 * rnd()) * SR), gap = Math.round(0.08 * rnd() * SR);
    const f0 = 140 + 120 * rnd(), amp = level * (0.3 + 0.7 * rnd());
    for (let k = 0; k < len && i + k < n; k++) {
      const env = Math.sin(Math.PI * k / len);
      const t = k / SR;
      x[i + k] = amp * env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.25 * Math.sin(6 * Math.PI * f0 * t));
    }
    i += len + gap;
  }
  return x;
}

describe('compresseurs analogiques NOVA : registre et réglages', () => {
  it('les quatre effets sont déclarés, nommés sans marque, avec leurs réglages automatisables', () => {
    for (const k of KINDS) {
      const reg = getRegisteredPlugin(k)!;
      expect(reg, k).toBeTruthy();
      expect(reg.name).not.toMatch(/1176|LA-?2A|Tube-?Tech|CL ?1B|Manley|VOXBOX|Teletronix|Universal Audio/i);
      expect(reg.automatable!.length).toBeGreaterThan(2);
      expect(analogAutomatable(k).map(a => a.id)).toEqual(ANALOG_SPECS[k].specs.filter(s => s.auto).map(s => s.id));
    }
  });

  it('bornes et choix : une valeur hors bornes est ramenée, un choix va au plus proche', () => {
    const s = sanitizeAnalog('OPTO_VINTAGE', { ratio: 50, mode: 1.4, scLowCut: 100, threshold: 'abc' });
    expect(s.ratio).toBe(10);
    expect(s.mode).toBe(1);
    expect(s.scLowCut).toBe(80);
    expect(s.threshold).toBeUndefined();
  });

  it('chaque profil se traduit en paramètres internes complets', () => {
    for (const k of KINDS) {
      const cfg = buildAnalogInternal(k, ANALOG_SPECS[k].defaults, ANALOG_PROFILES[k], SR);
      expect(cfg.P.length).toBe(AC.NP);
      expect(cfg.tab.length).toBeGreaterThan(10);
      for (let i = 0; i < AC.NP; i++) expect(Number.isFinite(cfg.P[i]), `${k} P[${i}]`).toBe(true);
    }
  });
});

describe('Opto Vintage : courbe statique et temps', () => {
  it('sous le seuil : passe-plat exact (mode Moderne, gain 0 dB)', () => {
    const x = sine(0.5, -40);
    const y = run('OPTO_VINTAGE', { threshold: -10, ratio: 4, attack: 3, release: 3, mode: 2, output: 0, mix: 100 }, x).L;
    let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i]));
    expect(d).toBeLessThan(1e-6);
  });

  it('au seuil, la réduction vaut ~1 dB (définition de l\'appareil d\'origine) ; elle croît avec le taux', () => {
    const at = (ratio: number, lvl: number) => {
      const x = sine(2.0, lvl);
      const y = run('OPTO_VINTAGE', { threshold: -30, ratio, attack: 3, release: 5, mode: 2, output: 0, mix: 100 }, x).L;
      return rmsDb(x, SR) - rmsDb(y, SR);
    };
    expect(at(4, -30)).toBeGreaterThan(0.6);
    expect(at(4, -30)).toBeLessThan(1.4);
    expect(at(10, -10)).toBeGreaterThan(at(2, -10) + 3);
  });

  it('relâchement plus long quand on tourne le bouton vers « slow »', () => {
    const n = Math.round(3 * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (i < SR ? 0.3 : 0.003) * Math.sin(2 * Math.PI * 1000 * i / SR);
    const recov = (release: number) => {
      const y = run('OPTO_VINTAGE', { threshold: -30, ratio: 4, attack: 2, release, mode: 2, output: 0, mix: 100 }, x).L;
      // temps pour revenir à -1 dB du gain unité après la chute
      for (let b = SR; b < n - 480; b += 480) {
        const g = rmsDb(y.subarray(b, b + 480)) - rmsDb(x.subarray(b, b + 480));
        if (g > -1) return (b - SR) / SR;
      }
      return 99;
    };
    expect(recov(2)).toBeLessThan(recov(6));
  });
});

describe('VU et calage « réduction cible »', () => {
  it('balistique VU : un palier tenu est lu en entier, un pic de 5 ms à peine', () => {
    const step = 128 / SR;
    const long = new Float32Array(400).fill(0); for (let i = 20; i < 380; i++) long[i] = 6;
    const short = new Float32Array(400).fill(0); short[20] = 6; short[21] = 6;
    expect(vuMaxGr(long, step)).toBeGreaterThan(5.8);
    expect(vuMaxGr(short, step)).toBeLessThan(1.5);
  });

  it('dichotomie : trouve la valeur qui donne la cible (fonction monotone)', async () => {
    const r = await bisectForTarget(v => Math.max(0, 0.7 * (v + 40)), -60, 0, 1, 5);
    expect(r.reached).toBe(true);
    expect(Math.abs(r.grDb - 5)).toBeLessThan(0.25);
  });

  it('Opto Vintage calé sur une voix : 5 dB max au VU (±0,25 dB), Leveler 2A : 2 dB', async () => {
    const v = voiceLike(6, 0.3);
    const o = await calibrateNova('OPTO_VINTAGE', { ...ANALOG_SPECS.OPTO_VINTAGE.defaults }, [v, v], SR);
    expect(o.reached).toBe(true);
    expect(Math.abs(o.grDb - 5)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(novaVuGr('OPTO_VINTAGE', { ...ANALOG_SPECS.OPTO_VINTAGE.defaults, threshold: o.value }, [v, v], SR) - o.grDb)).toBeLessThan(0.05);
    if (ANALOG_SPECS.LEVELER2A) {
      const l = await calibrateNova('LEVELER2A', { ...ANALOG_SPECS.LEVELER2A.defaults }, [v, v], SR);
      expect(l.reached).toBe(true);
      expect(Math.abs(l.grDb - 2)).toBeLessThanOrEqual(0.25);
    }
  }, 60_000); // calcul pur ≈ 4 s seul : > 5 s quand les tests tournent en parallèle sur une machine chargée.

  it('son trop faible : le calage le dit au lieu de mentir', async () => {
    const v = voiceLike(3, 0.0003);
    const o = await calibrateNova('OPTO_VINTAGE', { ...ANALOG_SPECS.OPTO_VINTAGE.defaults }, [v, v], SR);
    expect(o.reached).toBe(false);
    expect(o.why).toMatch(/faible/);
  });

  it('estimation de la réduction d\'un VST (entrée / sortie) : un gain fixe ne compte pas', () => {
    const v = voiceLike(2, 0.3);
    const y = v.map(s => s * 0.5) as Float32Array;
    const { trace } = grTraceFromIO(v, y, SR);
    expect(Math.max(...Array.from(trace))).toBeLessThan(0.05);
  });
});

/**
 * Le cœur TypeScript (moteur NOVA) et le portage Python du labo (calage) sont
 * le MÊME algorithme : références produites par tools/labo/gen_ref_fixture.py.
 */
describe('identique au portage du labo', () => {
  const file = path.join(__dirname, 'fixtures', 'analogComp_ref.json');
  const ref = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  it.runIf(!!ref)('mêmes sorties que le portage Python (écart < 0,01 dB par segment)', () => {
    for (const c of ref.cases) {
      // signal : paliers [durée s, dBFS crête, fréquence Hz], phase continue
      const total = c.signal.reduce((a: number, sg: number[]) => a + Math.round(sg[0] * SR), 0);
      const x = new Float32Array(total);
      let i0 = 0, ph = 0;
      for (const [d, db, f] of c.signal) {
        const n = Math.round(d * SR), a = Math.pow(10, db / 20);
        for (let k = 0; k < n; k++) { x[i0 + k] = a * Math.sin(ph); ph += 2 * Math.PI * f / SR; }
        i0 += n;
      }
      const y = run(c.kind, c.params, x).L;
      const seg = Math.floor(x.length / c.rms_db.length);
      for (let s = 0; s < c.rms_db.length; s++) {
        const r = rmsDb(y.subarray(s * seg, (s + 1) * seg));
        expect(Math.abs(r - c.rms_db[s]), `${c.kind} segment ${s}`).toBeLessThan(0.01);
      }
    }
  });
});

describe('compresseurs analogiques NOVA : clé de side-chain (R7)', () => {
  /** Comme run(), avec une clé externe sur le détecteur. */
  function runKey(kind: string, L: Float32Array, key: Float32Array) {
    const core = createAnalogCompCore(SR);
    core.setInternal(buildAnalogInternal(kind, ANALOG_SPECS[kind].defaults as any, ANALOG_PROFILES[kind], SR));
    const n = L.length;
    const oL = new Float32Array(n), oR = new Float32Array(n);
    let grMax = 0;
    for (let i = 0; i < n; i += 128) {
      const m = Math.min(128, n - i);
      core.process(L.subarray(i, i + m), L.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m, key.subarray(i, i + m), key.subarray(i, i + m));
      grMax = Math.max(grMax, core.takeMeters().grDb);
    }
    return { L: oL, grMax };
  }

  it.each(KINDS)('%s : la clé seule décide de la compression', kind => {
    const loud = sine(1, -3), quiet = sine(1, -40), silence = new Float32Array(loud.length);
    const own = run(kind, ANALOG_SPECS[kind].defaults as any, loud);
    expect(own.grMax, 'sans clé, le son fort se compresse').toBeGreaterThan(1);
    // Son fort, clé muette : plus aucune réduction.
    expect(runKey(kind, loud, silence).grMax).toBeLessThan(0.05);
    // Son faible, clé forte : il est compressé comme le serait le son fort.
    const keyed = runKey(kind, quiet, loud);
    expect(keyed.grMax).toBeGreaterThan(1);
    expect(Math.abs(keyed.grMax - own.grMax)).toBeLessThan(Math.max(1, own.grMax * 0.35));
  });

  it('sans clé, le traitement est identique au dernier bit près (le labo reste calé)', () => {
    for (const kind of KINDS) {
      const x = voiceLike(1);
      const a = run(kind, ANALOG_SPECS[kind].defaults as any, x);
      const core = createAnalogCompCore(SR);
      core.setInternal(buildAnalogInternal(kind, ANALOG_SPECS[kind].defaults as any, ANALOG_PROFILES[kind], SR));
      const oL = new Float32Array(x.length), oR = new Float32Array(x.length);
      for (let i = 0; i < x.length; i += 128) {
        const m = Math.min(128, x.length - i);
        core.process(x.subarray(i, i + m), x.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m, null, null);
      }
      expect(oL).toEqual(a.L);
    }
  });
});
