/**
 * Course armement ↔ reconstruction du contexte (régression du 23/10/2026, batterie r1516e) :
 * la garde de l'horloge recréait le contexte PENDANT l'armement (attente du micro) ; la
 * reconstruction remettait `inputRouter` à null et l'armement finissait par
 * « TypeError: Cannot read properties of null (reading 'arm') » : plus de prise possible.
 *
 * On joue le VRAI code d'AudioEngine (armTrack, _armTrackInternal, rebuildContext) sur un moteur
 * simulé : micro qui met du temps à répondre, reconstruction qui remplace le routeur d'entrée.
 */
import { describe, it, expect } from 'vitest';

function deferred<T = void>() { let resolve!: (v: T) => void; const p = new Promise<T>(r => { resolve = r; }); return { p, resolve }; }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function fakeEngine() {
  const { AudioEngine } = await import('../engine/AudioEngine');
  const e: any = Object.create(AudioEngine.prototype);
  const routers: any[] = [];
  const mkRouter = (n: number) => { const r = { n, armed: [] as string[], arm(id: string) { this.armed.push(id); return { trackId: id, channels: [0] }; }, ids() { return this.armed; }, has(id: string) { return this.armed.includes(id); }, get size() { return this.armed.length; } }; routers.push(r); return r; };
  Object.assign(e, {
    ctx: { state: 'running', resume: async () => {} },
    idle: { wake() {} },
    armedSpecs: new Map(), armErrors: new Map(), armingPromise: null, rebuilding: null, ctxGen: 0,
    tracksDSP: new Map([['voix', {}]]),
    inputRouter: mkRouter(0),
    mic: null as null | { p: Promise<void> },
    rebuilds: 0,
  });
  // Armement simulé comme le vrai : ensureInputSource crée le routeur s'il manque, attend le micro
  // (getUserMedia), puis _armTrackOnce branche la piste sur `this.inputRouter!` (null si reconstruit entre-temps).
  e._armTrackOnce = async function (id: string) {
    try {
      if (!this.inputRouter) this.inputRouter = mkRouter(100 + this.ctxGen);
      if (this.mic) await this.mic.p;
      this.inputRouter!.arm(id);
    } catch (err) { this.armErrors.set(id, String(err)); }
  };
  // Reconstruction simulée : tout est désarmé, le routeur disparaît puis renaît avec le nouveau contexte.
  e.rebuildContextNow = async function () {
    this.rebuilds++;
    this.inputRouter = null;
    await tick(5);
    this.inputRouter = mkRouter(this.rebuilds);
  };
  return { e, routers };
}

describe('armement et reconstruction du contexte', () => {
  it('reconstruction demandée PENDANT l\'attente du micro : elle attend la fin de l\'armement (plus de « reading \'arm\' » sur null)', async () => {
    const { e } = await fakeEngine();
    const mic = deferred();
    e.mic = mic;
    const arming = e.armTrack('voix');
    await tick();
    const rebuilding = e.rebuildContext();           // la garde de l'horloge (ou un changement de fréquence) se déclenche
    await tick(10);
    expect(e.rebuilds).toBe(0);                        // la reconstruction attend : l'armement n'est pas coupé
    mic.resolve();
    const err = await arming;
    await rebuilding;
    expect(err).toBeNull();
    expect(e.rebuilds).toBe(1);
    expect(e.inputRouter).not.toBeNull();
  }, 60_000);

  it('armement demandé PENDANT une reconstruction : il attend le nouveau contexte et s\'arme dessus', async () => {
    const { e } = await fakeEngine();
    const rebuilding = e.rebuildContext();
    const err = await e.armTrack('voix');
    await rebuilding;
    expect(err).toBeNull();
    expect(e.inputRouter.n).toBe(1);                  // le routeur du NOUVEAU contexte
    expect(e.inputRouter.has('voix')).toBe(true);
  }, 60_000);

  it('deux demandes de reconstruction en même temps : une seule reconstruction', async () => {
    const { e } = await fakeEngine();
    await Promise.all([e.rebuildContext(), e.rebuildContext()]);
    expect(e.rebuilds).toBe(1);
  }, 60_000);

  it('contexte changé malgré tout pendant l\'armement : l\'armement recommence sur le nouveau', async () => {
    const { e } = await fakeEngine();
    const mic = deferred();
    e.mic = mic;
    const arming = e.armTrack('voix');
    await tick();
    // Changement de contexte qui ne passerait pas par rebuildContext (sécurité) : nouveau routeur, nouvelle génération.
    e.inputRouter = null; e.ctxGen++;
    e.mic = null;
    mic.resolve();
    // 1er essai : routeur disparu → erreur notée puis effacée ; 2e essai : routeur du nouveau contexte.
    const err = await arming;
    expect(err).toBeNull();
    expect(e.inputRouter.has('voix')).toBe(true);
  }, 60_000);
});
