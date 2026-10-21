// @vitest-environment jsdom
/**
 * Console sur un 2e écran (écart 17) : la fenêtre détachée reçoit les styles (y compris
 * ceux ajoutés ensuite) et le thème, renvoie ses touches au studio, retient sa place,
 * se ferme avec le studio ; fenêtre bloquée = false (l'appelant le dit).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePopout, openPopout, popoutStore, savedGeometry, togglePopout } from '../utils/popoutWindow';

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
/** Ouvre et attend que la page fille soit prête (la vue s'y installe). */
async function openReady() {
  expect(openPopout('console')).toBe(true);
  await tick();
  return popoutStore.get('console')!;
}

/** Fausse fenêtre fille : un vrai document (jsdom), événements, fermeture. */
function fakeChild() {
  const doc = document.implementation.createHTMLDocument('');
  Object.defineProperty(doc, 'readyState', { get: () => 'complete' });
  const target = new EventTarget();
  const w: any = {
    document: doc, closed: false, location: { pathname: '/popout.html' }, screenX: 1920, screenY: 40, outerWidth: 1400, outerHeight: 800, innerWidth: 1400, innerHeight: 760,
    focus: vi.fn(), close() { w.closed = true; target.dispatchEvent(new Event('pagehide')); },
    addEventListener: (t: string, f: any) => target.addEventListener(t, f), removeEventListener: (t: string, f: any) => target.removeEventListener(t, f),
    dispatch: (e: Event) => target.dispatchEvent(e),
  };
  return w;
}

afterEach(() => { closePopout('console'); vi.restoreAllMocks(); localStorage.clear(); document.head.innerHTML = ''; document.documentElement.className = ''; });

describe('fenêtre détachée', () => {
  it('styles et thème copiés, puis suivis ; conteneur prêt pour le portail', async () => {
    const st = document.createElement('style'); st.textContent = '.a{color:red}'; document.head.appendChild(st);
    document.documentElement.className = 'dark';
    const child = fakeChild();
    const open = vi.spyOn(window, 'open').mockReturnValue(child);
    const h = await openReady();
    expect(String(open.mock.calls[0][0])).toMatch(/popout[.]html$/);
    expect(open.mock.calls[0][1]).toBe('nova-console');
    expect(String(open.mock.calls[0][2])).toMatch(/width=1280,height=720/);
    expect(h.container.getAttribute('data-nova-popout')).toBe('console');
    expect(child.document.head.querySelectorAll('style').length).toBe(1);
    expect(child.document.documentElement.className).toBe('dark');
    expect(child.document.title).toBe('Console · NOVA');
    expect(popoutStore.isOpen('console')).toBe(true);
    // Style chargé plus tard (vue à la demande) et changement de thème : suivis.
    const st2 = document.createElement('style'); st2.textContent = '.b{color:blue}'; document.head.appendChild(st2);
    document.documentElement.className = 'light';
    await new Promise(r => setTimeout(r, 0));
    expect(child.document.head.querySelectorAll('style').length).toBe(2);
    expect(child.document.documentElement.className).toBe('light');
  });

  it('touches de la fenêtre fille rejouées au studio (pas celles des champs de saisie)', async () => {
    const child = fakeChild();
    vi.spyOn(window, 'open').mockReturnValue(child);
    await openReady();
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(`${e.ctrlKey ? 'ctrl+' : ''}${e.key}`);
    window.addEventListener('keydown', onKey);
    child.dispatch(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    child.dispatch(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    window.removeEventListener('keydown', onKey);
    expect(seen).toEqual([' ', 'ctrl+z']);
  });

  it('fermer la fenêtre fille rend la console et retient sa place ; rouverte au même endroit', async () => {
    const child = fakeChild();
    vi.spyOn(window, 'open').mockReturnValue(child);
    await openReady();
    child.close();
    expect(popoutStore.isOpen('console')).toBe(false);
    expect(savedGeometry('console')).toEqual({ x: 1920, y: 40, w: 1400, h: 800 });
    const child2 = fakeChild();
    const open = vi.spyOn(window, 'open').mockReturnValue(child2);
    await openReady();
    expect(String(open.mock.calls[0][2])).toMatch(/width=1400,height=800,left=1920,top=40/);
    expect(togglePopout('console')).toBe(true);
    expect(child2.closed).toBe(true);
    expect(popoutStore.isOpen('console')).toBe(false);
  });

  it('fenêtre bloquée : false, rien d\'ouvert', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPopout('console')).toBe(false);
    expect(popoutStore.isOpen('console')).toBe(false);
  });
});
