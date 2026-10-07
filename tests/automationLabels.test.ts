import { describe, expect, it } from 'vitest';
import { automationParamLabel, automationRangeText, automationValueText } from '../utils/automationLabels';

describe('automationLabels (G22 : volume en dB, en français)', () => {
  it('noms des paramètres', () => {
    expect(automationParamLabel('volume')).toBe('Volume');
    expect(automationParamLabel('pan')).toBe('Panoramique');
    expect(automationParamLabel('send::send-verb-short')).toBe('Envoi Reverb courte');
  });
  it('valeurs en vraies unités', () => {
    expect(automationValueText('volume', 0.5)).toBe('−6,0 dB');
    expect(automationValueText('volume', 0)).toBe('−∞ dB');
    expect(automationValueText('pan', -0.3)).toBe('G 30');
  });
  it('plage lisible au lieu de « 0.0 - 1.5 »', () => {
    expect(automationRangeText('volume', 0, 1.5)).toBe('−∞ dB à +3,5 dB');
  });
});
