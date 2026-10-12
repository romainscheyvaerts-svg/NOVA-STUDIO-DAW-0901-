import { describe, expect, it } from 'vitest';
import { EffectSleepManager, QUIET_S, type SleepHost } from '../engine/effectSleep';
import { createDeesserCore } from '../engine/deesserCore';
import { trackCpuView } from '../utils/cpuLoadView';
import { estimatedLoadPct, TRACK_BASE_MS } from '../utils/dspLoad';
import { makeClip, makeTrack } from './helpers/fixtures';
import type { PluginInstance } from '../types';

/** Nœud simulé : garde la liste de ses liens (connect / disconnect). */
class FakeNode {
  links = new Set<FakeNode>();
  port = { onmessage: null as any, postMessage: (_m: any) => {} };
  constructor(public name: string) {}
  connect(n: FakeNode) { this.links.add(n); return n; }
  disconnect(n?: FakeNode) { if (n) { if (!this.links.has(n)) throw new Error('pas relié'); this.links.delete(n); } else this.links.clear(); }
}

function setup(opts: { eligible?: boolean; rest?: boolean[]; busyUntil?: number; next?: number } = {}) {
  const ctx = { currentTime: 10, state: 'running', sampleRate: 48000 } as any;
  const start = new FakeNode('start'), first = new FakeNode('eq'), end = new FakeNode('ds'), out = new FakeNode('chainOut');
  start.connect(first); end.connect(out);
  const rest = opts.rest ?? [true, true];
  const instances = rest.map((r, i) => ({ isAtRest: () => r, sleeping: false, setSleeping(on: boolean) { this.sleeping = on; }, name: `fx${i}` }));
  let sentinel: FakeNode | null = null;
  const host: SleepHost = {
    ctx: () => ctx,
    trackIds: () => ['t1'],
    chainOf: () => ({ start: start as any, first: first as any, end: end as any, out: out as any, instances, latency: 0 }),
    eligible: () => opts.eligible ?? true,
    inputBusyUntil: () => opts.busyUntil ?? 0,
    nextActivityIn: () => opts.next ?? Infinity,
    makeSentinel: () => (sentinel = new FakeNode('sentinelle')) as any,
  };
  const m = new EffectSleepManager(host);
  m.setEnabled(true);
  m.tick();   // nouveau contexte : module prêt
  m.tick();   // sentinelle posée
  const quiet = (since: number) => sentinel?.port.onmessage?.({ data: { s: 0, q: 1, t: since } } as any);
  const loud = () => sentinel?.port.onmessage?.({ data: { s: 0, q: 0 } } as any);
  return { m, ctx, start, first, end, out, instances, quiet, loud, sentinel: () => sentinel };
}

describe('Veille automatique des effets (engine/effectSleep)', () => {
  it('sentinelle branchée sur la sortie de la chaîne', () => {
    const s = setup();
    expect(s.sentinel()).not.toBeNull();
    expect(s.out.links.has(s.sentinel()!)).toBe(true);
  });

  it('chaîne au repos depuis assez longtemps : décâblée (entrée et sortie), vumètres débranchés', () => {
    const s = setup();
    s.quiet(10 - QUIET_S - 0.05);
    s.m.tick();
    expect(s.m.isAsleep('t1')).toBe(true);
    expect(s.start.links.has(s.first)).toBe(false);
    expect(s.end.links.has(s.out)).toBe(false);
    expect(s.instances.every(i => i.sleeping)).toBe(true);
    expect(s.m.stats()).toMatchObject({ asleep: 1, sleeps: 1, asleepIds: ['t1'] });
  });

  it('réveil : chaîne rebranchée telle quelle, effets prévenus', () => {
    const s = setup();
    s.quiet(9); s.m.tick();
    expect(s.m.wake('t1')).toBe(true);
    expect(s.start.links.has(s.first)).toBe(true);
    expect(s.end.links.has(s.out)).toBe(true);
    expect(s.instances.every(i => !i.sleeping)).toBe(true);
    expect(s.m.wake('t1')).toBe(false);   // déjà réveillée : rien
  });

  it('pas de veille : sortie qui sonne, silence trop récent, source en cours ou à venir, cœur pas au repos, piste inéligible', () => {
    let s = setup(); s.loud(); s.m.tick(); expect(s.m.isAsleep('t1')).toBe(false);
    s = setup(); s.quiet(10 - QUIET_S / 2); s.m.tick(); expect(s.m.isAsleep('t1')).toBe(false);
    s = setup({ busyUntil: Infinity }); s.quiet(5); s.m.tick(); expect(s.m.isAsleep('t1')).toBe(false);
    s = setup({ busyUntil: 9.95 }); s.quiet(5); s.m.tick(); expect(s.m.isAsleep('t1')).toBe(false);
    s = setup({ next: 0.2 }); s.quiet(5); s.m.tick(); expect(s.m.isAsleep('t1')).toBe(false);
    s = setup({ rest: [true, false] }); s.quiet(5); s.m.tick(); expect(s.m.isAsleep('t1')).toBe(false);
    s = setup({ eligible: false }); s.quiet(5); s.m.tick(); expect(s.m.isAsleep('t1')).toBe(false);
  });

  it('veille coupée (réglage) : tout est rebranché', () => {
    const s = setup();
    s.quiet(9); s.m.tick();
    s.m.setEnabled(false);
    expect(s.m.isAsleep('t1')).toBe(false);
    expect(s.start.links.has(s.first)).toBe(true);
    s.quiet(5); s.m.tick();
    expect(s.m.isAsleep('t1')).toBe(false);
  });
});

describe('De-esser : rattrapage après la veille = calcul bloc par bloc', () => {
  it('état identique au bit près, que les blocs muets soient calculés ou sautés', () => {
    const mk = () => { const c = createDeesserCore(48000); c.setParams({ frequency: 7000, reduction: 0.8, detection: 'ABSOLUTE', threshold: -40 }); return c; };
    const a = mk(), b = mk();
    const n = 128, loud = new Float32Array(n), zero = new Float32Array(n), out = new Float32Array(n);
    for (let i = 0; i < n; i++) loud[i] = 0.6 * Math.sin(i * 0.9);
    for (let k = 0; k < 40; k++) { a.process(loud, loud, out, out, n); b.process(loud, loud, out, out, n); }
    // Jusqu'au repos (filtre de bande vide, détecteur sous le seuil), calculé des deux côtés.
    let guard = 0;
    while (!(a.atRest() && b.atRest()) && guard++ < 2000) { a.process(zero, zero, out, out, n); b.process(zero, zero, out, out, n); }
    expect(a.atRest()).toBe(true);
    // a calcule 300 blocs muets ; b les saute (veille) puis rattrape.
    for (let k = 0; k < 300; k++) a.process(zero, zero, out, out, n);
    b.catchUp(300 * n);
    const oa = new Float32Array(n), ob = new Float32Array(n);
    for (let k = 0; k < 5; k++) { a.process(loud, loud, oa, oa, n); b.process(loud, loud, ob, ob, n); }
    let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(oa[i] - ob[i]));
    expect(d).toBeLessThan(1e-12);
  });
});

describe('Charge processeur par piste (utils/cpuLoadView)', () => {
  const fx = (type: string): PluginInstance => ({ id: type, name: type, type: type as any, isEnabled: true, params: {} });
  it('détail par effet ; en veille, seule la base compte ; conseil « geler » sur une piste lourde', () => {
    const t = makeTrack({ clips: [makeClip()], plugins: [fx('PROEQ12'), fx('COMPRESSOR'), fx('REVERB')] });
    const v = trackCpuView(t, false);
    expect(v.effects.map(e => e.id)).toEqual(['PROEQ12', 'COMPRESSOR', 'REVERB']);
    expect(v.level).toBe('forte');
    expect(v.advice).toMatch(/Geler cette piste/);
    const z = trackCpuView(t, true);
    expect(z.asleep).toBe(true);
    expect(z.pct).toBeLessThan(v.pct);
    expect(z.advice).toMatch(/veille/);
    expect(estimatedLoadPct([t], 700, new Set([t.id]))).toBe(Math.round(Math.min(TRACK_BASE_MS, 1e9) / 700 * 100));
  });
});
