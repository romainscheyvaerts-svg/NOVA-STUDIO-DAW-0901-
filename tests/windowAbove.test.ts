/**
 * @vitest-environment jsdom
 *
 * Nova Pitch ouvert en bas + une vraie fenêtre par-dessus (Track Presets, palette) : le clavier est à la
 * fenêtre du dessus (avant : Échap fermait Nova Pitch et la fenêtre restait ouverte, qa/protools_ecarts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { windowAbove } from '../utils/windowAbove';

const shown = (el: HTMLElement) => !el.hidden && !el.closest('[hidden]');

describe('windowAbove : fenêtre ouverte par-dessus un panneau ancré', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('rien d’ouvert : le panneau garde le clavier', () => {
    document.body.innerHTML = '<div data-nova-pitch><div role="dialog" aria-label="Réglages de la note"></div></div>';
    expect(windowAbove(document.querySelector('[data-nova-pitch]'), document, shown)).toBe(false);
  });

  it('Track Presets (fenêtre modale) ouvert : le clavier est à la fenêtre', () => {
    document.body.innerHTML = '<div data-nova-pitch></div><div role="dialog" aria-modal="true" data-testid="track-preset-dialog"></div>';
    expect(windowAbove(document.querySelector('[data-nova-pitch]'), document, shown)).toBe(true);
  });

  it('fenêtre cachée, fenêtre dans le panneau ou menu du panneau : ne comptent pas', () => {
    document.body.innerHTML = '<div data-nova-pitch><div aria-modal="true"></div></div>'
      + '<div hidden><div aria-modal="true"></div></div>'
      + '<div data-nova-roll-menu="pitch-pop"><div aria-modal="true"></div></div>';
    expect(windowAbove(document.querySelector('[data-nova-pitch]'), document, shown)).toBe(false);
  });

  it('sans panneau (root absent) : toute fenêtre visible compte', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true" data-testid="command-palette"></div>';
    expect(windowAbove(null, document, shown)).toBe(true);
  });
});
