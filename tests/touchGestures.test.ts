// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWN_LONG_PRESS_ATTR, ownsLongPress, swallowReleaseClick } from '../utils/touchGestures';

const click = (target: Element, x: number, y: number) => {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y });
  target.dispatchEvent(ev);
  return ev;
};

describe('gestes au doigt : un seul arbitre par zone', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

  it('une zone qui gère son appui long le déclare ; "off" rend une sous-zone au gestionnaire global', () => {
    document.body.innerHTML = `<div ${OWN_LONG_PRESS_ATTR}><span id="piste"></span><div ${OWN_LONG_PRESS_ATTR}="off"><span id="entete"></span></div></div><p id="ailleurs"></p>`;
    expect(ownsLongPress(document.getElementById('piste'))).toBe(true);
    expect(ownsLongPress(document.getElementById('entete'))).toBe(false);
    expect(ownsLongPress(document.getElementById('ailleurs'))).toBe(false);
    expect(ownsLongPress(null)).toBe(false);
  });

  it('le clic du lever du doigt, après un appui long, n’active pas l’entrée du menu sous le doigt', () => {
    document.body.innerHTML = '<button id="normaliser">Normaliser</button>';
    const b = document.getElementById('normaliser')!;
    const onClick = vi.fn();
    b.addEventListener('click', onClick);
    swallowReleaseClick(100, 200);
    window.dispatchEvent(new Event('pointerup'));
    const ev = click(b, 102, 198);
    expect(onClick).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    // Un seul clic avalé : le toucher suivant sur l'entrée agit.
    click(b, 102, 198);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('un clic loin du doigt, ou plus tard que le lever, passe', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">B</button>';
    const b = document.getElementById('b')!;
    const onClick = vi.fn();
    b.addEventListener('click', onClick);
    swallowReleaseClick(100, 200);
    click(b, 400, 200);                 // loin du doigt
    expect(onClick).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pointerup'));
    vi.advanceTimersByTime(450);        // 400 ms après le lever : l'avaleur est retiré
    click(b, 100, 200);
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
