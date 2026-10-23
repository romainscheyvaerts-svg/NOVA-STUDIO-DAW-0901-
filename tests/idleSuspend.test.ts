import { describe, expect, it } from 'vitest';
import { IdleSuspender } from '../engine/idleSuspend';

/**
 * Veille du moteur à l'arrêt (engine/idleSuspend, audit de nuit 22/10/2026) : le contexte n'est
 * suspendu qu'après le calme demandé, jamais quand quelque chose a besoin du son, et repart au
 * premier geste, à la première source démarrée ou à la première commande qui produit du son.
 */

class FakeSource {
  private listeners: (() => void)[] = [];
  started = false;
  start() { this.started = true; }
  addEventListener(_t: string, fn: () => void) { this.listeners.push(fn); }
  end() { this.listeners.forEach(f => f()); this.listeners = []; }
}

class FakeCtx {
  state: 'running' | 'suspended' | 'closed' = 'running';
  suspends = 0; resumes = 0;
  private stateListeners: (() => void)[] = [];
  lastSource: FakeSource | null = null;
  createBufferSource() { this.lastSource = new FakeSource(); return this.lastSource; }
  createMediaStreamSource(_s: any) { return {}; }
  createMediaElementSource(_e: any) { return {}; }
  addEventListener(t: string, fn: () => void) { if (t === 'statechange') this.stateListeners.push(fn); }
  /** Suspension lente (vrai périphérique sous charge) : l'état ne change qu'à `finishSuspend()`. */
  slow = false;
  private pending: (() => void) | null = null;
  async suspend() {
    this.suspends++;
    if (this.slow) { await new Promise<void>(r => { this.pending = r; }); }
    this.state = 'suspended'; this.stateListeners.forEach(f => f());
  }
  finishSuspend() { const r = this.pending; this.pending = null; r?.(); }
  async resume() { this.resumes++; this.state = 'running'; this.stateListeners.forEach(f => f()); }
  /** Reprise faite par quelqu'un d'autre (ctx.resume() direct d'une fenêtre). */
  externalResume() { this.state = 'running'; this.stateListeners.forEach(f => f()); }
}

function setup(o: { busy?: () => string | null; enabled?: boolean; work?: boolean; slow?: boolean; visible?: boolean } = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  let onInput: () => void = () => {};
  const idle = new IdleSuspender({ busy: o.busy || (() => null) }, {
    idleMs: 20_000, visibleIdleMs: 300_000, hidden: () => !o.visible, checkMs: 2_000, now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    enabled: () => o.enabled !== false,
    workWindowOpen: () => !!o.work,
    listen: (fn) => { onInput = fn; },
  });
  const ctx = new FakeCtx();
  ctx.slow = !!o.slow;
  idle.attach(ctx as any);
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
      await Promise.resolve();
    }
    t = end;
  };
  return { idle, ctx, advance, input: () => onInput(), pending: () => timers.length };
}

describe('veille du moteur à l\'arrêt', () => {
  it('suspend le contexte après 20 s sans geste ni son, et plus rien ne tourne ensuite', async () => {
    const { ctx, advance, pending, idle } = setup();
    await advance(19_000);
    expect(ctx.state).toBe('running');
    await advance(4_000);
    expect(ctx.state).toBe('suspended');
    expect(ctx.suspends).toBe(1);
    expect(pending()).toBe(0); // aucune minuterie en veille
    expect(idle.getStats().asleep).toBe(true);
  });

  it('un geste réveille tout de suite et repousse la veille de 20 s', async () => {
    const { ctx, advance, input } = setup();
    await advance(25_000);
    expect(ctx.state).toBe('suspended');
    input();
    expect(ctx.resumes).toBe(1);
    await Promise.resolve();
    expect(ctx.state).toBe('running');
    await advance(15_000);
    expect(ctx.state).toBe('running');
    await advance(10_000);
    expect(ctx.state).toBe('suspended');
  });

  it('jamais pendant que le moteur a besoin du son (lecture, piste armée…)', async () => {
    let busy: string | null = 'lecture';
    const { ctx, advance } = setup({ busy: () => busy });
    await advance(120_000);
    expect(ctx.state).toBe('running');
    busy = null;
    await advance(10_000);
    expect(ctx.state).toBe('running'); // le calme se compte à partir de la fin de la lecture
    await advance(15_000);
    expect(ctx.state).toBe('suspended');
  });

  it('une source démarrée sur le contexte (pré-écoute d\'une fenêtre) réveille et tient éveillé jusqu\'à sa fin', async () => {
    const { ctx, advance } = setup();
    await advance(25_000);
    expect(ctx.state).toBe('suspended');
    const src = (ctx as any).createBufferSource() as FakeSource;
    src.start();
    await Promise.resolve();
    expect(ctx.state).toBe('running');
    await advance(60_000);
    expect(ctx.state).toBe('running'); // la pré-écoute dure : pas de veille
    src.end();
    await advance(19_000);
    expect(ctx.state).toBe('running');
    await advance(4_000);
    expect(ctx.state).toBe('suspended');
  });

  it('flux micro branché et vivant : pas de veille ; flux arrêté : veille', async () => {
    const { ctx, advance } = setup();
    const stream = { active: true };
    (ctx as any).createMediaStreamSource(stream);
    await advance(60_000);
    expect(ctx.state).toBe('running');
    stream.active = false;
    await advance(25_000);
    expect(ctx.state).toBe('suspended');
  });

  it('raison externe (collaboration) et fenêtre d\'instrument ouverte : pas de veille', async () => {
    const a = setup();
    a.idle.setBlocker('collaboration', true);
    await a.advance(60_000);
    expect(a.ctx.state).toBe('running');
    a.idle.setBlocker('collaboration', false);
    await a.advance(25_000);
    expect(a.ctx.state).toBe('suspended');
    const b = setup({ work: true });
    await b.advance(60_000);
    expect(b.ctx.state).toBe('running');
  });

  it('réglage coupé (nova_veille_moteur = 0) : jamais de veille', async () => {
    const { ctx, advance } = setup({ enabled: false });
    await advance(120_000);
    expect(ctx.state).toBe('running');
  });

  it('repris par quelqu\'un d\'autre (ctx.resume() direct) : la veille le sait et recompte le calme', async () => {
    const { ctx, advance, idle } = setup();
    await advance(25_000);
    expect(ctx.state).toBe('suspended');
    ctx.externalResume();
    expect(idle.getStats().asleep).toBe(false);
    await advance(10_000);
    expect(ctx.state).toBe('running');
    await advance(15_000);
    expect(ctx.state).toBe('suspended');
    expect(ctx.suspends).toBe(2);
  });

  it('réveil PENDANT la suspension (contexte encore « running ») : le contexte repart dès que la suspension aboutit', async () => {
    let busy: string | null = null;
    const { ctx, advance, input } = setup({ slow: true, busy: () => busy });
    await advance(25_000);
    expect(ctx.suspends).toBe(1);
    expect(ctx.state).toBe('running'); // suspension pas encore aboutie
    input(); busy = 'lecture';           // Espace : la lecture part
    ctx.finishSuspend();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ctx.resumes).toBe(1);
    expect(ctx.state).toBe('running');
  });

  it('suspendu par erreur pendant la lecture (hors veille) : il repart tout seul', async () => {
    const { ctx } = setup({ busy: () => 'lecture' });
    await ctx.suspend();
    expect(ctx.resumes).toBe(1);
    expect(ctx.state).toBe('running');
  });

  it('page au premier plan : veille seulement après 5 min sans rien faire', async () => {
    const { ctx, advance } = setup({ visible: true });
    await advance(60_000);
    expect(ctx.state).toBe('running');
    await advance(250_000);
    expect(ctx.state).toBe('suspended');
  });

  it('garde de l’horloge : « au repos » pendant la veille et la reprise, puis prévenue à la reprise (onWake)', async () => {
    let woke = 0;
    let t = 0;
    const timers: { at: number; fn: () => void }[] = [];
    let onInput = () => {};
    const idle = new IdleSuspender({ busy: () => null, onWake: () => { woke++; } }, {
      idleMs: 20_000, visibleIdleMs: 20_000, hidden: () => true, checkMs: 2_000, now: () => t,
      setTimeout: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length; }, clearTimeout: () => {},
      enabled: () => true, workWindowOpen: () => false, listen: fn => { onInput = fn; },
    });
    const ctx = new FakeCtx();
    idle.attach(ctx as any);
    expect(idle.isResting()).toBe(false);
    while (timers.length && ctx.state === 'running') { timers.sort((a, b) => a.at - b.at); const n = timers.shift()!; t = n.at; n.fn(); await Promise.resolve(); }
    expect(ctx.state).toBe('suspended');
    expect(idle.isResting()).toBe(true);
    onInput();
    expect(idle.isResting()).toBe(true); // reprise en cours
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ctx.state).toBe('running');
    expect(idle.isResting()).toBe(false);
    expect(woke).toBe(1);
  });
});
