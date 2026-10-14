import { describe, expect, it } from 'vitest';
import { analyzeFlowTake, analyzeHiss, clickLeak, flowAdvice, planDiction, planFlow, scoreFlow, VIRELANGUES, type Subdivision } from '../utils/flowDrill';

const SR = 48000;
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };

/**
 * Prise de rap simulée : une syllabe « ta » par instant (consonne = souffle
 * de 12 ms, puis voyelle voisée de 70 ms qui retombe), bruit de pièce.
 * Les instants sont donnés sur l'horloge des clics ; la capture commence à
 * `firstTime` et arrive avec `latency` de retard (sortie + entrée).
 */
function rapTake(times: number[], firstTime: number, latency: number, dur: number, opts: { noise?: number; clicks?: number[] } = {}): Float32Array {
  const x = new Float32Array(Math.round(dur * SR));
  const noise = opts.noise ?? 0.002;
  for (let i = 0; i < x.length; i++) x[i] = noise * rnd();
  const put = (t: number, gen: (k: number) => number, len: number) => {
    const a = Math.round((t - firstTime + latency) * SR);
    for (let k = 0; k < len && a + k < x.length; k++) if (a + k >= 0) x[a + k] += gen(k);
  };
  for (const t of times) {
    const amp = 0.25 + 0.15 * rnd();
    const f0 = 140 + 30 * rnd();
    const cons = Math.round(0.012 * SR), vow = Math.round(0.07 * SR);
    put(t, k => amp * 0.6 * rnd() * Math.min(1, k / 48), cons);
    put(t + cons / SR, k => amp * Math.exp(-k / (0.04 * SR)) * (Math.sin(2 * Math.PI * f0 * k / SR) + 0.5 * Math.sin(4 * Math.PI * f0 * k / SR)), vow);
  }
  // Clic entendu dans le micro (haut-parleurs) : bip court.
  for (const t of opts.clicks || []) put(t, k => 0.3 * Math.exp(-k / 150) * Math.sin(2 * Math.PI * 1175 * k / SR), 1500);
  return x;
}

describe('flow : plan du passage', () => {
  it('80 BPM croches : 4 clics de décompte, 16 syllabes sur 2 mesures', () => {
    const p = planFlow(80, 'croches', 1);
    expect(p.clicks.filter(c => c.countIn).length).toBe(4);
    expect(p.grid.length).toBe(16);
    expect(p.rapStart).toBeCloseTo(1 + 4 * 0.75, 6);
    expect(p.grid[1] - p.grid[0]).toBeCloseTo(0.375, 6);
    expect(planFlow(90, 'triolets').grid.length).toBe(24);
    expect(planFlow(140, 'doubles').grid.length).toBe(32);
  });

  it('virelangue : une syllabe par croche, les « · » sont des silences', () => {
    const v = VIRELANGUES.find(x => x.id === 'chasseur')!;
    const p = planDiction(v, 85);
    expect(p.grid.length).toBe(v.syllables.filter(s => s !== '·').length);
    expect(p.syllableAt[0]).toBe('Un');
    expect(p.syllableAt[13]).toBeNull();
  });
});

describe('flow : score de placement sur des prises témoins décalées de 0, 20 et 50 ms', () => {
  const cases: [number, Subdivision][] = [[80, 'croches'], [90, 'triolets'], [140, 'croches'], [140, 'doubles']];
  for (const [bpm, sub] of cases) {
    it(`${bpm} BPM ${sub}`, () => {
      const first = 10.0, lat = 0.034;
      const plan = planFlow(bpm, sub, first + 0.3);
      const scores: number[] = [];
      for (const off of [0, 20, 50]) {
        // Doubles croches à 140 BPM : 107 ms entre syllabes ; 50 ms de retard tombe presque entre deux points.
        if (sub === 'doubles' && off === 50) continue;
        const x = rapTake(plan.grid.map(g => g + off / 1000), first, lat, plan.end - first + 0.5);
        const s = analyzeFlowTake(x, SR, first, lat, plan);
        expect(s.hits, `${bpm} ${sub} +${off} ms : syllabes`).toBe(plan.grid.length);
        expect(Math.abs(s.meanOffsetMs - off), `${bpm} ${sub} +${off} ms : écart moyen ${s.meanOffsetMs}`).toBeLessThan(3);
        expect(s.spreadMs).toBeLessThan(3);
        expect(s.extras).toBe(0);
        scores.push(s.score);
        if (off === 0) { expect(s.tendency).toBe('calé'); expect(s.score).toBeGreaterThanOrEqual(97); }
        if (off === 20) { expect(s.tendency).toBe('en retard'); expect(s.score).toBeGreaterThan(85); expect(s.score).toBeLessThan(97); }
        if (off === 50) { expect(s.tendency).toBe('en retard'); expect(s.score).toBeLessThan(80); }
      }
      for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
    });
  }

  it('en avance de 20 ms : tendance « en avance », écart négatif', () => {
    const plan = planFlow(90, 'croches', 0.5);
    const x = rapTake(plan.grid.map(g => g - 0.02), 0, 0.02, plan.end + 0.5);
    const s = analyzeFlowTake(x, SR, 0, 0.02, plan);
    expect(s.meanOffsetMs).toBeCloseTo(-20, -0.5);
    expect(s.tendency).toBe('en avance');
    expect(flowAdvice(s)).toMatch(/devant le temps|précipites/);
  });

  it('jeu humain (±10 ms au hasard), syllabes oubliées, syllabes en trop', () => {
    const plan = planFlow(80, 'croches', 0.5);
    const human = plan.grid.map(g => g + 0.01 * 2 * rnd());
    const s1 = analyzeFlowTake(rapTake(human, 0, 0.02, plan.end + 0.5), SR, 0, 0.02, plan);
    expect(s1.hits).toBe(16);
    expect(s1.meanAbsMs).toBeLessThan(11);
    expect(s1.score).toBeGreaterThan(90);
    const missing = plan.grid.filter((_, i) => i % 4 !== 3);
    const s2 = analyzeFlowTake(rapTake(missing, 0, 0.02, plan.end + 0.5), SR, 0, 0.02, plan);
    expect(s2.hits).toBe(12);
    expect(s2.score).toBeLessThan(s1.score - 10);
    const extra = [...plan.grid, ...plan.grid.slice(0, 4).map(g => g + 0.18)];
    const s3 = scoreFlow(extra, plan.grid);
    expect(s3.extras).toBe(4);
    expect(s3.score).toBeLessThan(100);
  });

  it('rien au micro : 0, conseil clair', () => {
    const plan = planFlow(80, 'croches', 0.5);
    const s = analyzeFlowTake(rapTake([], 0, 0.02, plan.end + 0.5), SR, 0, 0.02, plan);
    expect(s.score).toBe(0);
    expect(flowAdvice(s)).toMatch(/Aucune syllabe/);
  });

  it('clic entendu dans le micro (haut-parleurs) : repéré pendant le décompte', () => {
    const plan = planFlow(90, 'croches', 0.5);
    const clicks = plan.clicks.map(c => c.t);
    const leak = rapTake(plan.grid, 0, 0.02, plan.end + 0.5, { clicks });
    expect(clickLeak(leak, SR, 0, 0.02, plan)).toBe(true);
    const casque = rapTake(plan.grid, 0, 0.02, plan.end + 0.5);
    expect(clickLeak(casque, SR, 0, 0.02, plan)).toBe(false);
  });
});

describe('souffle tenu', () => {
  function hiss(sec: number, wobbleDb = 0): Float32Array {
    const x = new Float32Array(Math.round((sec + 2) * SR));
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const on = t >= 1 && t < 1 + sec;
      const g = on ? 0.1 * Math.pow(10, (wobbleDb * Math.sin(2 * Math.PI * 0.7 * t)) / 20) : 0.001;
      x[i] = g * rnd();
    }
    return x;
  }
  it('durée mesurée à 0,1 s près, régularité', () => {
    const a = analyzeHiss(hiss(12), SR);
    expect(a.seconds).toBeGreaterThan(11.8);
    expect(a.seconds).toBeLessThan(12.2);
    expect(a.steadiness).toBeGreaterThan(80);
    const b = analyzeHiss(hiss(24), SR);
    expect(b.score).toBeGreaterThan(a.score);
    const c = analyzeHiss(hiss(12, 8), SR);
    expect(c.steadiness).toBeLessThan(a.steadiness);
    expect(analyzeHiss(new Float32Array(SR * 3), SR).seconds).toBe(0);
  });
});
