/**
 * Métronome et contexte audio recréé (fréquence du projet, 12/10/2026).
 *
 * Ouvrir un projet d'avant le réglage (44,1 kHz) quand le moteur tourne à 48 kHz
 * recrée le contexte audio. Le métronome gardait la sortie « main » de l'ancien
 * contexte : connect() levait InvalidAccessError dans ensureAudioEngine et le
 * projet ne s'ouvrait pas (l'ancien restait affiché, « Projet chargé » quand même).
 */
import { describe, expect, it } from 'vitest';
import { metronomeService } from '../services/MetronomeService';

class FakeNode {
  out = new Set<FakeNode>();
  gain = { value: 1, setTargetAtTime() { /* */ } };
  constructor(public context: FakeCtx) {}
  connect(n: FakeNode) {
    if (n.context !== this.context) throw new Error("InvalidAccessError: cannot connect to an AudioNode belonging to a different audio context.");
    this.out.add(n);
    return n;
  }
  disconnect(n?: FakeNode) { if (n) this.out.delete(n); else this.out.clear(); }
}
class FakeCtx {
  currentTime = 0;
  destination: FakeNode = new FakeNode(this);
  createGain() { return new FakeNode(this); }
}

const outputOf = () => (metronomeService as unknown as { outputGain: FakeNode }).outputGain;

describe('métronome : contexte audio recréé', () => {
  it('passe sur le nouveau contexte sans lever, sortie de l\'ancien oubliée', () => {
    const a = new FakeCtx();
    metronomeService.init(a as unknown as AudioContext);
    const mainA = new FakeNode(a);
    metronomeService.setOutputs({ main: mainA as unknown as AudioNode, system: a.destination as unknown as AudioNode });
    expect(outputOf().out.has(mainA)).toBe(true);

    const b = new FakeCtx();
    expect(() => metronomeService.init(b as unknown as AudioContext)).not.toThrow();
    // Pas encore de sortie « main » sur le nouveau contexte : la sortie de l'ordinateur.
    expect(outputOf().context).toBe(b);
    expect(outputOf().out.has(b.destination)).toBe(true);

    const mainB = new FakeNode(b);
    metronomeService.setOutputs({ main: mainB as unknown as AudioNode, system: b.destination as unknown as AudioNode });
    expect(outputOf().out.has(mainB)).toBe(true);
  });

  it('une sortie d\'un autre contexte est ignorée (repli sur la sortie du contexte)', () => {
    const a = new FakeCtx(), b = new FakeCtx();
    metronomeService.init(b as unknown as AudioContext);
    expect(() => metronomeService.setOutputs({ main: new FakeNode(a) as unknown as AudioNode })).not.toThrow();
    expect(outputOf().out.has(b.destination)).toBe(true);
  });
});
