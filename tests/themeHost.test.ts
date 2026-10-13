// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hostThemeFromMessage, themeStore } from '../utils/themeStore';

/**
 * DAW intégré au site Make Music (13/10/2026) : le site envoie son réglage noir / blanc
 * par message ; seul le message NOVA_THEME avec un thème connu est retenu.
 */
describe('thème imposé par le site (DAW intégré)', () => {
  it('lit le message NOVA_THEME', () => {
    expect(hostThemeFromMessage({ type: 'NOVA_THEME', theme: 'light' })).toBe('light');
    expect(hostThemeFromMessage({ type: 'NOVA_THEME', theme: 'dark' })).toBe('dark');
  });

  it('ignore les autres messages et les valeurs inconnues', () => {
    expect(hostThemeFromMessage({ type: 'NOVA_SITE_AUTH', theme: 'light' })).toBeNull();
    expect(hostThemeFromMessage({ type: 'NOVA_THEME', theme: 'blanc' })).toBeNull();
    expect(hostThemeFromMessage({ type: 'NOVA_THEME' })).toBeNull();
    expect(hostThemeFromMessage(null)).toBeNull();
    expect(hostThemeFromMessage('NOVA_THEME')).toBeNull();
  });

  it('le choix s’applique tout de suite sur <html> et reste mémorisé', () => {
    themeStore.setPref('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('nova_theme')).toBe('light');
    themeStore.setPref('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
