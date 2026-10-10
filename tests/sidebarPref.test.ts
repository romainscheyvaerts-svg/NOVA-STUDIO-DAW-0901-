// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSidebarOpen, initialSidebarOpen, rememberSidebar, sidebarAfterModeChange, WIDE_SCREEN_PX } from '../utils/sidebarPref';

/** Navigateur latéral (store) à la 1re séance : fermé pour l'ingé en mode avancé, même à 1600 px. */
describe('navigateur latéral par défaut', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* */ } });
  it('mode avancé : fermé à 1366 et 1600 px, ouvert seulement sur un très grand écran', () => {
    expect(defaultSidebarOpen(false, 1366)).toBe(false);
    expect(defaultSidebarOpen(false, 1600)).toBe(false);
    expect(defaultSidebarOpen(false, WIDE_SCREEN_PX)).toBe(true);
    expect(defaultSidebarOpen(true, 1024)).toBe(true);
  });
  it('le choix mémorisé passe avant tout', () => {
    rememberSidebar(true);
    expect(initialSidebarOpen(1366)).toBe(true);
    expect(sidebarAfterModeChange(true, false, 1600)).toBeNull();
  });
  it('passage en mode avancé après l’ouverture, sans choix : le store se replie', () => {
    expect(sidebarAfterModeChange(true, false, 1600)).toBe(false);
    expect(sidebarAfterModeChange(false, true, 1600)).toBe(true);
    expect(sidebarAfterModeChange(false, false, 1600)).toBeNull();
  });
});
