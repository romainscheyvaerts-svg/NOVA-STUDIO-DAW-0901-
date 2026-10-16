// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { shouldSuspendFollow, useFollowPlayhead, USER_SCROLL_WINDOW_MS, type FollowPlayhead } from '../hooks/useFollowPlayhead';

/**
 * Suivi de la tête de lecture (arrangement) : un défilement À LA MAIN pendant la lecture le
 * suspend (on n'est plus ramené de force), il reprend au prochain Play ou avec « Suivre ».
 * Les défilements faits par NOVA (le suivi lui-même, le zoom) ne suspendent rien.
 */

describe('shouldSuspendFollow (règle)', () => {
  const base = { auto: false, playing: true, dx: 300, sinceGesture: 50 };
  it('geste de l\'utilisateur + défilement horizontal pendant la lecture : suspend', () => {
    expect(shouldSuspendFollow(base)).toBe(true);
    expect(shouldSuspendFollow({ ...base, dx: -40 })).toBe(true);
  });
  it('à l\'arrêt, défilement de NOVA, vertical seulement, ou sans geste récent : ne suspend pas', () => {
    expect(shouldSuspendFollow({ ...base, playing: false })).toBe(false);
    expect(shouldSuspendFollow({ ...base, auto: true })).toBe(false);
    expect(shouldSuspendFollow({ ...base, dx: 0 })).toBe(false);
    expect(shouldSuspendFollow({ ...base, sinceGesture: USER_SCROLL_WINDOW_MS + 1 })).toBe(false);
    expect(shouldSuspendFollow({ ...base, sinceGesture: Infinity })).toBe(false);
  });
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let api: FollowPlayhead;
let auto: { current: boolean };
let scroller: HTMLDivElement;

const Probe: React.FC<{ playing: boolean }> = ({ playing }) => {
  const ref = useRef<HTMLDivElement>(null);
  const autoRef = useRef(false);
  auto = autoRef;
  api = useFollowPlayhead(ref, playing, autoRef);
  return React.createElement('div', { ref, 'data-testid': 'scroll', 'data-follow': api.suspended ? 'suspendu' : 'actif' });
};
const render = (playing: boolean) => act(() => { root.render(React.createElement(Probe, { playing })); });
const scrollTo = (left: number) => act(() => { scroller.scrollLeft = left; scroller.dispatchEvent(new Event('scroll')); });
const wheel = (opts: WheelEventInit = {}) => act(() => { scroller.dispatchEvent(new WheelEvent('wheel', { deltaX: 120, bubbles: true, ...opts })); });

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render(true);
  scroller = host.querySelector('[data-testid="scroll"]') as HTMLDivElement;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('useFollowPlayhead', () => {
  it('molette (ou pavé tactile) qui fait défiler pendant la lecture : suivi suspendu', () => {
    wheel();
    scrollTo(400);
    expect(api.suspended).toBe(true);
    expect(api.suspendedRef.current).toBe(true);
    expect(scroller.dataset.follow).toBe('suspendu');
  });

  it('le suivi lui-même défile (autoScroll) : rien n\'est suspendu', () => {
    auto.current = true;
    scrollTo(900);
    expect(api.suspended).toBe(false);
    expect(auto.current).toBe(false);
  });

  it('Ctrl + molette (zoom) puis recalage du zoom : rien n\'est suspendu', () => {
    wheel({ ctrlKey: true });
    scrollTo(250);
    expect(api.suspended).toBe(false);
  });

  it('défilement au doigt et via la minimap : suspendu aussi', () => {
    act(() => { scroller.dispatchEvent(new Event('touchmove')); });
    scrollTo(120);
    expect(api.suspended).toBe(true);
    act(() => api.resume());
    act(() => api.noteUserScroll());
    scrollTo(600);
    expect(api.suspended).toBe(true);
  });

  it('« Suivre » reprend le suivi', () => {
    wheel(); scrollTo(400);
    act(() => api.resume());
    expect(api.suspended).toBe(false);
    expect(api.suspendedRef.current).toBe(false);
  });

  it('à l\'arrêt : défiler ne suspend rien ; le prochain Play repart toujours en suivi', () => {
    wheel(); scrollTo(400);
    expect(api.suspended).toBe(true);
    render(false);
    expect(api.suspended).toBe(true);
    wheel(); scrollTo(800);
    render(true);
    expect(api.suspended).toBe(false);
  });
});
