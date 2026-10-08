// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.mock('../utils/errorLog', () => ({ logClientError: vi.fn() }));
vi.mock('../services/feedback', () => ({ openFeedback: vi.fn() }));

import { PanelBoundary } from '../components/PanelBoundary';
import { logClientError } from '../utils/errorLog';

/**
 * Isolation des erreurs par panneau : une panne (injectée via __novaFaults, ou un
 * composant qui lève au rendu) ne remplace QUE ce panneau ; les voisins restent
 * affichés ; « Relancer ce panneau » le remonte ; après 3 plantages en 30 s,
 * « Fermer ce panneau » est proposé.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let el: HTMLDivElement;
const faults = new Set<string>();
const h = React.createElement;

beforeEach(() => {
  (globalThis as any).__novaFaults = faults;
  faults.clear();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  delete (globalThis as any).__novaFaults;
});

const studio = (extra?: { onClose?: () => void; mixerChild?: React.ReactNode }) => h('div', null,
  h(PanelBoundary, { name: 'la barre de transport', compact: true }, h('button', { id: 'play' }, 'Lecture')),
  h(PanelBoundary, { name: 'la console de mixage', onClose: extra?.onClose }, extra?.mixerChild ?? h('div', { id: 'mixer' }, 'Console')),
  h(PanelBoundary, { name: "l'arrangement" }, h('div', { id: 'arr' }, 'Pistes')),
);
const text = () => el.textContent || '';
const btn = (label: string) => Array.from(el.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement | undefined;

describe('PanelBoundary', () => {
  it('panne injectée dans la console : seul ce panneau est remplacé, les voisins restent', () => {
    faults.add('la console de mixage');
    act(() => root.render(studio()));
    expect(text()).toContain('La console de mixage a rencontré un problème.');
    expect(text()).toContain('Le son et le reste du studio continuent.');
    expect(el.querySelector('#mixer')).toBeNull();
    expect(el.querySelector('#play')).not.toBeNull();
    expect(el.querySelector('#arr')).not.toBeNull();
    expect(el.querySelector('[data-panel-crash="la console de mixage"]')).not.toBeNull();
    expect(logClientError).toHaveBeenCalledWith(expect.any(Error), 'panneau:la console de mixage');
  });

  it('« Relancer ce panneau » le remonte quand la panne est partie', () => {
    faults.add('la console de mixage');
    act(() => root.render(studio()));
    faults.delete('la console de mixage');
    act(() => btn('Relancer ce panneau')!.click());
    expect(el.querySelector('#mixer')).not.toBeNull();
    expect(text()).not.toContain('a rencontré un problème');
  });

  it('vraie exception au rendu (pas seulement injectée) : isolée aussi', () => {
    const Boom = () => { throw new Error('undefined is not an object'); };
    act(() => root.render(studio({ mixerChild: h(Boom) })));
    expect(text()).toContain('La console de mixage a rencontré un problème.');
    expect(text()).toContain('undefined is not an object');
    expect(el.querySelector('#arr')).not.toBeNull();
  });

  it('3 plantages en 30 s : « Fermer ce panneau » proposé et appelle onClose', () => {
    const onClose = vi.fn();
    faults.add('la console de mixage');
    act(() => root.render(studio({ onClose })));
    expect(btn('Fermer ce panneau')).toBeUndefined();
    act(() => btn('Relancer ce panneau')!.click());
    act(() => btn('Relancer ce panneau')!.click());
    expect(text()).toContain('plante à répétition');
    act(() => btn('Fermer ce panneau')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sans panne : coût nul, contenu rendu tel quel', () => {
    act(() => root.render(studio()));
    expect(el.querySelectorAll('[role=alert]').length).toBe(0);
    expect(text()).toContain('Console');
  });
});
