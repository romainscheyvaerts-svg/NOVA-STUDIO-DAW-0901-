/** Séance d'exemple pour les tests AAF (et les scripts de vérification avec pyaaf2). */
import type { AafExportInput } from '../utils/aaf/aafWrite';

/** Générateur déterministe (identifiants reproductibles). */
const seeded = (seed = 1) => (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; b[i] = seed >>> 24; } return b; };
const tone = (n: number, f: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / 48000));

export function sampleInput(embed = false): AafExportInput {
  return {
    name: 'Séance test', sampleRate: 48000, embed, trackVolumePan: true, date: new Date(2026, 9, 12, 10, 0, 0), random: seeded(7),
    media: [
      { id: 'm1', name: 'Lead prise 3', channels: [tone(96000, 220)], sampleRate: 48000, timeReference: 12345 },
      { id: 'm2', name: 'Beat', channels: [tone(144000, 110), tone(144000, 111)], sampleRate: 48000, timeReference: 0 },
    ],
    tracks: [
      { name: 'Lead', channels: 1, volume: 0.5, pan: -0.25, clips: [
        { name: 'Lead 1', position: 12345, length: 20001, mediaId: 'm1', offset: 0, gain: 1, fadeIn: { length: 480, shape: 'EQUAL_POWER' } },
        { name: 'Lead 2', position: 40000, length: 30000, mediaId: 'm1', offset: 33333, gain: 0.5, fadeOut: { length: 1000, shape: 'S_CURVE' } },
        { name: 'Lead 3', position: 70001, length: 9000, mediaId: 'm1', offset: 70000, gain: 2, fadeIn: { length: 300, shape: 'EXPONENTIAL' }, fadeOut: { length: 301, shape: 'LINEAR' } },
      ] },
      { name: 'Beat', channels: 2, volume: 1, pan: 0, clips: [
        { name: 'Beat', position: 0, length: 144000, mediaId: 'm2', offset: 0, gain: 1, gainPoints: [{ t: 0, gain: 1 }, { t: 72000, gain: 0.25 }, { t: 144000, gain: 1 }] },
      ] },
    ],
  };
}
