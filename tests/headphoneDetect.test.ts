import { describe, expect, it } from 'vitest';
import { classifyOutputLabel, pickOutput } from '../utils/headphoneDetect';

describe('« Tu as un casque ? » : détection par le nom de la sortie', () => {
  it('casques, écouteurs, Bluetooth connus', () => {
    for (const l of ['Casque (Realtek(R) Audio)', 'Headphones (2- High Definition Audio Device)', 'AirPods Pro de Romain', 'Galaxy Buds2', 'Écouteurs (Jabra Evolve)', 'WH-1000XM4'])
      expect(classifyOutputLabel(l)).toBe('casque');
  });
  it('carte son de studio : on y branche un casque, même nommée « Haut-parleurs » par Windows', () => {
    for (const l of ['Haut-parleurs (Focusrite USB Audio)', 'Speakers (Scarlett 2i2 USB)', 'Universal Audio Volt 2', 'Apollo Twin X', 'RME Babyface Pro'])
      expect(classifyOutputLabel(l)).toBe('casque');
  });
  it('haut-parleurs, écran HDMI : retour coupé (larsen)', () => {
    for (const l of ['Haut-parleurs (Realtek(R) Audio)', 'Speakers (Conexant SmartAudio HD)', 'LG HDR 4K (NVIDIA High Definition Audio)'])
      expect(classifyOutputLabel(l)).toBe('haut-parleurs');
  });
  it('nom vide ou ambigu : on pose la question', () => {
    expect(classifyOutputLabel('')).toBeNull();
    expect(classifyOutputLabel('Realtek Digital Output')).toBeNull();
    expect(classifyOutputLabel(undefined)).toBeNull();
  });
  it('sortie utilisée : celle choisie, sinon « default », sinon la 1re', () => {
    const d = [
      { deviceId: 'a', kind: 'audioinput', label: 'Micro' },
      { deviceId: 'default', kind: 'audiooutput', label: 'Par défaut - Casque (Realtek)' },
      { deviceId: 'x', kind: 'audiooutput', label: 'Haut-parleurs (Realtek)' },
    ];
    expect(pickOutput(d)?.deviceId).toBe('default');
    expect(pickOutput(d, 'x')?.deviceId).toBe('x');
    expect(pickOutput(d.slice(0, 1))).toBeNull();
  });
});
