import { describe, it, expect } from 'vitest';
import { AudioClockWatch, type ClockWatchHost } from '../engine/audioClockWatch';

/** Contexte simulé : horloge et état pilotés par le test. */
function fakeCtx() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    currentTime: 0,
    state: 'running' as string,
    addEventListener(t: string, f: () => void) { (listeners[t] ||= []).push(f); },
    removeEventListener(t: string, f: () => void) { listeners[t] = (listeners[t] || []).filter(x => x !== f); },
    fire(t: string) { (listeners[t] || []).forEach(f => f()); },
  };
}

function setup(opts: { active?: boolean; recording?: boolean; busy?: boolean } = {}) {
  let now = 0;
  let ctx = fakeCtx();
  const notes: string[] = [];
  const restarts: string[] = [];
  let resumes = 0;
  const flags = { active: opts.active ?? true, recording: opts.recording ?? false, busy: opts.busy ?? false };
  const host: ClockWatchHost = {
    ctx: () => ctx as any,
    active: () => flags.active,
    recording: () => flags.recording,
    busy: () => flags.busy,
    visible: () => true,
    restart: async (r) => { restarts.push(r); ctx = fakeCtx(); w.attach(ctx as any); return true; },
    resume: async () => { resumes++; ctx.state = 'running'; },
    notify: (m) => { notes.push(m); },
  };
  const w = new AudioClockWatch(host, { now: () => now, setInterval: () => 1, clearInterval: () => {} });
  w.attach(ctx as any);
  return {
    w, flags, notes, restarts, get ctx() { return ctx; }, get resumes() { return resumes; },
    advance(ms: number, clock = true) { now += ms; if (clock) ctx.currentTime += ms / 1000; w.tick(); },
    wait(ms: number) { now += ms; w.tick(); },
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('garde de l\'horloge audio', () => {
  it('horloge qui avance : aucun message, aucune relance', () => {
    const s = setup();
    for (let i = 0; i < 20; i++) s.advance(500);
    expect(s.notes).toEqual([]);
    expect(s.restarts).toEqual([]);
  });

  it('démarrage lent (service audio de Windows en panne) : messages, JAMAIS de contexte recréé, « Son rétabli » quand il démarre', async () => {
    const s = setup();
    s.wait(1000); s.wait(1000);
    expect(s.notes.length).toBe(1);
    expect(s.notes[0]).toMatch(/tarde à démarrer/);
    // 200 s sans démarrage (batterie r1516e, 23/10/2026) : avant, 8 contextes recréés pour rien.
    for (let i = 0; i < 400; i++) s.wait(500);
    expect(s.restarts).toEqual([]);
    expect(s.notes.filter(n => /ne démarre pas/.test(n)).length).toBe(1);
    s.advance(500);
    expect(s.notes.at(-1)).toMatch(/Son rétabli/);
    expect(s.w.status().incident).toBeNull();
  });

  it('horloge qui se fige pendant la lecture : relance après 3 s, pas avant', async () => {
    const s = setup();
    s.advance(500); s.advance(500);
    s.wait(500); s.wait(500); s.wait(500); s.wait(500); s.wait(500);
    expect(s.restarts).toEqual([]);
    s.wait(500);
    expect(s.restarts).toEqual(['arret']);
  });

  it("armement en cours (attente du micro) : la relance attend la fin de l'armement", async () => {
    const s = setup({ busy: true });
    s.advance(500);
    s.ctx.fire('error');
    for (let i = 0; i < 10; i++) s.wait(500);
    expect(s.restarts).toEqual([]);
    s.flags.busy = false;
    s.wait(500);
    expect(s.restarts).toEqual(['erreur']);
  });

  it('erreur du périphérique : relance immédiate', () => {
    const s = setup();
    s.advance(500);
    s.ctx.fire('error');
    expect(s.restarts).toEqual(['erreur']);
  });

  it('jamais de relance pendant une prise : message, puis relance après la prise', async () => {
    const s = setup({ recording: true });
    s.advance(500);
    s.wait(2000); s.wait(1500);
    expect(s.restarts).toEqual([]);
    expect(s.notes.some(n => /Arrête la prise/.test(n))).toBe(true);
    s.flags.recording = false;
    s.wait(500);
    expect(s.restarts).toEqual(['arret']);
  });

  it('contexte suspendu pendant la lecture : reprise, pas de relance', () => {
    const s = setup();
    s.advance(500);
    s.ctx.state = 'suspended';
    s.wait(500);
    expect(s.resumes).toBe(1);
    expect(s.restarts).toEqual([]);
  });

  it('pannes à répétition : au plus 2 relances en 5 min, 30 s au moins entre deux, puis un message clair', async () => {
    const s = setup();
    for (let k = 0; k < 8; k++) {
      s.advance(500);              // le nouveau contexte démarre…
      s.ctx.fire('error');         // … et retombe en panne
      await flush();
      for (let i = 0; i < 20; i++) s.wait(500);
      await flush();
    }
    expect(s.restarts.length).toBe(2);
    expect(s.notes.some(n => /Aucune sortie audio ne répond/.test(n))).toBe(true);
  });

  it('à l\'arrêt (rien à surveiller), un contexte qui a démarré ne déclenche rien', () => {
    const s = setup({ active: false });
    s.advance(500);
    for (let i = 0; i < 10; i++) s.wait(500);
    expect(s.restarts).toEqual([]);
    expect(s.notes).toEqual([]);
  });
});
