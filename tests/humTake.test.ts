import { describe, it, expect } from 'vitest';
import { placeHumTake } from '../engine/humTake';

/** « Fredonne → MIDI » au micro : la voix est replacée comme une prise normale (latence retirée). */
describe('Fredonne → MIDI : placement de la prise', () => {
  const sr = 48000;
  it('retire le décompte et la latence : la voix chantée sur le temps 1 tombe sur le temps 1', () => {
    // Lecture : temps 0 du projet à l'horloge 10 s ; la prise démarre à 4 s (décompte d'une mesure depuis 2 s).
    const playStart = 10, from = 4, latency = 0.045;
    // L'enregistreur capte dès l'horloge 12,0 s (début du décompte) ; 3 s captées.
    const firstFrame = Math.round(12 * sr);
    const x = new Float32Array(3 * sr);
    // L'artiste chante pile sur le temps 4 s qu'il ENTEND : sa voix arrive à l'enregistreur 45 ms plus tard.
    const hit = Math.round((playStart + from + latency) * sr) - firstFrame;
    x[hit] = 1;
    const p = placeHumTake(x, sr, firstFrame, playStart, latency, from);
    expect(p.start).toBeCloseTo(from, 4);
    const k = p.data.findIndex(v => v === 1);
    expect(p.start + k / sr).toBeCloseTo(from, 4);
    expect(p.skipped).toBe(hit);
  });
  it('sans latence compensée, la voix serait en retard de la latence', () => {
    const playStart = 10, from = 4, latency = 0.06;
    const firstFrame = Math.round(12 * sr);
    const x = new Float32Array(3 * sr);
    const hit = Math.round((playStart + from + latency) * sr) - firstFrame;
    x[hit] = 1;
    const raw = placeHumTake(x, sr, firstFrame, playStart, 0, from);
    const k = raw.data.findIndex(v => v === 1);
    expect(raw.start + k / sr - from).toBeCloseTo(latency, 3);
  });
  it('enregistreur parti après la fin du décompte : rien n\'est retiré, le début est exact', () => {
    const p = placeHumTake(new Float32Array(1000), sr, Math.round(14.5 * sr), 10, 0.02, 4);
    expect(p.skipped).toBe(0);
    expect(p.start).toBeCloseTo(4.48, 6);
  });
  it('prise trop courte (arrêtée pendant le décompte) : vide', () => {
    const p = placeHumTake(new Float32Array(1000), sr, Math.round(12 * sr), 10, 0.02, 4);
    expect(p.data.length).toBe(0);
  });
});
