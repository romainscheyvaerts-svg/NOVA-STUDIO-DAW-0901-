// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { duplicateClip } from '../utils/mobileDuplicate';
import MobileArrangementPage from '../components/MobileArrangementPage';
import { makeClip, makeTrack } from './helpers/fixtures';

/**
 * Page Arrangement du téléphone : « Dupliquer » ne dit « dupliqué » que si la copie est
 * vraiment demandée à l'appli. Avant, sans onDuplicateClip, « ✨ Clip dupliqué » s'affichait
 * alors que rien n'était copié.
 */

describe('duplicateClip (règle)', () => {
  it('copie demandée à l\'appli : succès annoncé', () => {
    const fn = vi.fn();
    const r = duplicateClip({ trackId: 't1', clip: { id: 'c1' } }, fn);
    expect(fn).toHaveBeenCalledWith('t1', 'c1');
    expect(r).toEqual({ ok: true, message: '✨ Clip dupliqué juste après' });
  });
  it('sans fonction de duplication : aucun faux « dupliqué »', () => {
    const r = duplicateClip({ trackId: 't1', clip: { id: 'c1' } }, undefined);
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/dupliqué/i);
  });
  it('sans clip choisi : on dit quoi faire', () => {
    const fn = vi.fn();
    const r = duplicateClip(null, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Touche d'abord un clip/);
  });
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

const track = makeTrack({ id: 'voix', name: 'Voix', clips: [makeClip({ id: 'c1', start: 1, duration: 2 })] });
const render = (props: Record<string, unknown>) => act(() => {
  root.render(React.createElement(MobileArrangementPage as any, {
    tracks: [track], currentTime: 0, isPlaying: false, selectedTrackId: 'voix',
    onSelectTrack: () => {}, onSeek: () => {}, onUpdateClip: () => {}, ...props,
  }));
});
const selectClip = () => act(() => {
  el.querySelector('[data-clip-id="c1"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
});

describe('page Arrangement du téléphone : bouton DUP', () => {
  it('avec la duplication de l\'appli : DUP copie le clip et le dit', () => {
    const onDuplicateClip = vi.fn();
    render({ onDuplicateClip });
    selectClip();
    const dup = el.querySelector<HTMLButtonElement>('[data-testid="mobile-dup"]');
    expect(dup).not.toBeNull();
    act(() => { dup!.click(); });
    expect(onDuplicateClip).toHaveBeenCalledWith('voix', 'c1');
    expect(el.textContent).toContain('Clip dupliqué juste après');
  });

  it('sans duplication possible : ni bouton DUP, ni outil Dupliquer, ni faux message', () => {
    render({});
    selectClip();
    expect(el.querySelector('[data-clip-id="c1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="mobile-dup"]')).toBeNull();
    expect(el.querySelector('[aria-label="Dupliquer"], [title="Dupliquer"]')).toBeNull();
    expect(el.textContent).not.toMatch(/dupliqué/i);
  });
});
