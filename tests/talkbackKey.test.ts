// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useTalkbackKey } from '../hooks/useTalkbackKey';
import { __resetKeymapForTests, keymapStore } from '../utils/keymapStore';
import { TalkbackLatch } from '../utils/talkback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Touche du talkback dans la page : appui / relâchement de la même touche physique,
 * répétitions ignorées, jamais pendant la saisie dans un champ texte, ni quand la batterie
 * ou le piano roll prennent les lettres ; fenêtre qui perd le focus = relâché.
 */
let host: HTMLDivElement;
let root: Root;
let log: string[];
const Probe: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  useTalkbackKey(enabled, () => log.push('appui'), () => log.push('relâche'));
  return null;
};
const render = (enabled = true) => act(() => { root.render(React.createElement(Probe, { enabled })); });
const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit, target: EventTarget = document.body) => {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(e); });
  return e;
};

beforeEach(() => {
  __resetKeymapForTests();
  log = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.querySelectorAll('[data-nova-transport], input').forEach(e => e.remove()); });

describe('touche du talkback (hooks/useTalkbackKey)', () => {
  it('N enfoncé → appui (défaut empêché : rien ne s’écrit), relâché → relâche ; répétitions ignorées', () => {
    render();
    const d = key('keydown', { key: 'n', code: 'KeyN' });
    expect(d.defaultPrevented).toBe(true);
    key('keydown', { key: 'n', code: 'KeyN', repeat: true });
    key('keydown', { key: 'n', code: 'KeyN', repeat: true });
    key('keyup', { key: 'n', code: 'KeyN' });
    expect(log).toEqual(['appui', 'relâche']);
  });

  it('relâchement de la même touche physique même si le caractère a changé (Maj lâché après)', () => {
    render();
    keymapStore.assign('nova.talkback', 'shift+n', { replaceIndex: 0 });
    key('keydown', { key: 'N', code: 'KeyN', shiftKey: true });
    key('keyup', { key: 'n', code: 'KeyN' });
    expect(log).toEqual(['appui', 'relâche']);
  });

  it('jamais pendant la saisie dans un champ texte', () => {
    render();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    key('keydown', { key: 'n', code: 'KeyN' }, input);
    key('keyup', { key: 'n', code: 'KeyN' }, input);
    expect(log).toEqual([]);
    // Un curseur (type range) n'est pas une saisie.
    const range = document.createElement('input');
    range.type = 'range';
    document.body.appendChild(range);
    key('keydown', { key: 'n', code: 'KeyN' }, range);
    key('keyup', { key: 'n', code: 'KeyN' }, range);
    expect(log).toEqual(['appui', 'relâche']);
  });

  it('batterie / piano roll ouverts (les lettres jouent des pads / des notes) : rien', () => {
    render();
    const panel = document.createElement('div');
    panel.setAttribute('data-nova-transport', '');
    document.body.appendChild(panel);
    key('keydown', { key: 'n', code: 'KeyN' });
    expect(log).toEqual([]);
  });

  it('autres touches et combinaisons (Ctrl+N du navigateur) : rien', () => {
    render();
    key('keydown', { key: 'b', code: 'KeyB' });
    key('keydown', { key: 'n', code: 'KeyN', ctrlKey: true });
    expect(log).toEqual([]);
  });

  it('fenêtre qui perd le focus pendant l’appui : relâché (le talkback ne reste pas bloqué ouvert)', () => {
    render();
    key('keydown', { key: 'n', code: 'KeyN' });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(log).toEqual(['appui', 'relâche']);
    key('keyup', { key: 'n', code: 'KeyN' });  // relâchement réel ensuite : rien de plus
    expect(log).toEqual(['appui', 'relâche']);
  });

  it('désactivé (mode simple hors collaboration) : la touche ne fait rien', () => {
    render(false);
    key('keydown', { key: 'n', code: 'KeyN' });
    expect(log).toEqual([]);
  });

  it('touche remappée : la nouvelle marche, N ne fait plus rien', () => {
    render();
    keymapStore.assign('nova.talkback', 'alt+t', { replaceIndex: 0 });
    key('keydown', { key: 'n', code: 'KeyN' });
    expect(log).toEqual([]);
    key('keydown', { key: 't', code: 'KeyT', altKey: true });
    key('keyup', { key: 't', code: 'KeyT' });
    expect(log).toEqual(['appui', 'relâche']);
  });

  it('appui court jugé sur l’heure des touches (event.timeStamp), pas sur le moment où le relâchement est traité', () => {
    // Le studio redessine après l'appui : sur un PC chargé, le relâchement d'un appui de 110 ms
    // était traité 400 ms plus tard et lu comme « maintenu » (le talkback se refermait).
    const latch = new TalkbackLatch();
    const Live: React.FC = () => { useTalkbackKey(true, at => latch.press('key', at), at => latch.release('key', at)); return null; };
    act(() => { root.render(React.createElement(Live)); });
    const d = key('keydown', { key: 'n', code: 'KeyN' });
    expect(latch.open).toBe(true);
    const busyUntil = Date.now() + 400;
    while (Date.now() < busyUntil) { /* rendu lourd entre l'appui et le relâchement */ }
    const u = new KeyboardEvent('keyup', { key: 'n', code: 'KeyN', bubbles: true, cancelable: true });
    Object.defineProperty(u, 'timeStamp', { value: d.timeStamp + 110 });
    act(() => { document.body.dispatchEvent(u); });
    expect(latch.open).toBe(true);
    expect(latch.latched).toBe(true);
  });
});
