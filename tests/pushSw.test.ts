/**
 * Lot 7 · public/sw.js : réception d'une notification et clic (service worker chargé tel quel
 * dans un faux contexte de service worker).
 *  - NOVA au premier plan : pas de notification système, la page reçoit la nouveauté ;
 *  - sinon : notification (titre, texte, regroupement par sujet, chemin relatif gardé) ;
 *  - clic : la fenêtre NOVA ouverte revient devant et reçoit la cible (jamais rechargée en pleine prise) ;
 *    aucune fenêtre : NOVA s'ouvre sur la séance, à l'instant du commentaire ;
 *  - une adresse étrangère dans un message n'est jamais ouverte.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(path.resolve(__dirname, '..', 'public', 'sw.js'), 'utf-8');
const ORIGIN = 'https://nova-studio-daw-0901-9kzo.vercel.app';

interface FakeClient { url: string; visibilityState: 'visible' | 'hidden'; focused: boolean; posted: any[]; focusCalls: number; focus: () => Promise<void>; postMessage: (m: any) => void }
const client = (over: Partial<FakeClient> = {}): FakeClient => {
  const c: FakeClient = {
    url: `${ORIGIN}/`, visibilityState: 'visible', focused: true, posted: [], focusCalls: 0,
    focus: async () => { c.focusCalls++; }, postMessage: (m) => { c.posted.push(m); }, ...over,
  } as FakeClient;
  return c;
};

function loadSw(wins: FakeClient[]) {
  const handlers: Record<string, (e: any) => void> = {};
  const shown: { title: string; opts: any }[] = [];
  const opened: string[] = [];
  const self: any = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (t: string, h: (e: any) => void) => { handlers[t] = h; },
    skipWaiting: () => undefined,
    clients: { matchAll: async () => wins, claim: async () => undefined, openWindow: async (u: string) => { opened.push(u); return null; } },
    registration: { showNotification: async (title: string, opts: any) => { shown.push({ title, opts }); } },
  };
  vm.runInNewContext(SRC, { self, caches: {}, fetch: () => Promise.reject(new Error('réseau')), URL, Response, console });
  const fire = async (type: string, e: any) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...e, waitUntil: (x: Promise<unknown>) => { p = x; } });
    await p;
  };
  return { handlers, shown, opened, fire };
}

const pushEvent = (d: unknown) => ({ data: { json: () => d, text: () => JSON.stringify(d) } });
const DATA = { v: 1, type: 'comment', title: '💬 Nina a commenté à 1:12', body: '« le s siffle »', tag: 'nova-comment-cm-1', url: '/?session=abcdefgh1234.sec&nova_s=abcdefgh1234&nova_c=cm-1&nova_at=72', s: 'abcdefgh1234', c: 'cm-1', at: 72 };

describe('service worker : réception', () => {
  it('écoute push et notificationclick', () => {
    const sw = loadSw([]);
    expect(typeof sw.handlers.push).toBe('function');
    expect(typeof sw.handlers.notificationclick).toBe('function');
    expect(typeof sw.handlers.fetch).toBe('function'); // le cache existant est toujours là
  });

  it('NOVA fermée ou en arrière-plan : notification système', async () => {
    const bg = client({ visibilityState: 'hidden', focused: false });
    const sw = loadSw([bg]);
    await sw.fire('push', pushEvent(DATA));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe(DATA.title);
    expect(sw.shown[0].opts).toMatchObject({ body: DATA.body, tag: DATA.tag, renotify: true, icon: '/icons/icon-192.png', lang: 'fr' });
    expect(sw.shown[0].opts.data.url).toBe(DATA.url);
    expect(bg.posted).toEqual([]);
  });

  it('NOVA au premier plan : pas de notification système, la page reçoit la nouveauté', async () => {
    const front = client();
    const sw = loadSw([front]);
    await sw.fire('push', pushEvent(DATA));
    expect(sw.shown).toHaveLength(0);
    expect(front.posted).toEqual([{ type: 'nova-push', data: DATA }]);
  });

  it('l’essai s’affiche toujours (même NOVA devant)', async () => {
    const sw = loadSw([client()]);
    await sw.fire('push', pushEvent({ title: 'essai', tag: 'nova-test', url: '/' }));
    expect(sw.shown).toHaveLength(1);
  });

  it('contenu illisible ou adresse étrangère : notification neutre, chemin « / »', async () => {
    const sw = loadSw([]);
    await sw.fire('push', { data: { json: () => { throw new Error('x'); }, text: () => 'texte brut' } });
    expect(sw.shown[0]).toMatchObject({ title: 'NOVA', opts: { body: 'texte brut' } });
    await sw.fire('push', pushEvent({ title: 'x', url: 'https://evil.example/' }));
    expect(sw.shown[1].opts.data.url).toBe('/');
    await sw.fire('push', pushEvent({ title: 'x', url: '//evil.example/' }));
    expect(sw.shown[2].opts.data.url).toBe('/');
  });
});

describe('service worker : clic', () => {
  const click = (data: unknown) => {
    let closed = false;
    return { ev: { notification: { data, close: () => { closed = true; } } }, closed: () => closed };
  };

  it('fenêtre NOVA ouverte : elle revient devant et reçoit la cible, sans rechargement', async () => {
    const w = client({ visibilityState: 'hidden', focused: false });
    const sw = loadSw([w]);
    const c = click(DATA);
    await sw.fire('notificationclick', c.ev);
    expect(c.closed()).toBe(true);
    expect(w.focusCalls).toBe(1);
    expect(w.posted).toEqual([{ type: 'nova-notif-open', data: { ...DATA, url: DATA.url } }]);
    expect(sw.opened).toEqual([]);
  });

  it('aucune fenêtre : NOVA s’ouvre sur la séance, à l’instant du commentaire', async () => {
    const sw = loadSw([]);
    await sw.fire('notificationclick', click(DATA).ev);
    expect(sw.opened).toEqual([DATA.url]);
    const q = new URLSearchParams(sw.opened[0].slice(2));
    expect(q.get('nova_c')).toBe('cm-1');
    expect(q.get('nova_at')).toBe('72');
  });

  it('une fenêtre d’un autre site n’est pas utilisée ; adresse étrangère jamais ouverte', async () => {
    const foreign = client({ url: 'https://autre.example/' });
    const sw = loadSw([foreign]);
    await sw.fire('notificationclick', click({ url: 'https://evil.example/' }).ev);
    expect(foreign.posted).toEqual([]);
    expect(sw.opened).toEqual(['/']);
  });
});
