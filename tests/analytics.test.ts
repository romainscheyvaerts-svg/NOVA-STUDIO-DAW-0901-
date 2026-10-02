// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Mesure d'audience : Supabase simulé, module rechargé à chaque test (file d'attente propre). */

const h = vi.hoisted(() => ({
  insert: vi.fn(async (_rows: any[]) => ({ error: null })),
  getSession: vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } })),
}));
vi.mock('../services/supabase', () => ({
  catalogSupabase: { auth: { getSession: h.getSession }, from: vi.fn(() => ({ insert: h.insert })) },
}));

type Analytics = typeof import('../utils/analytics');
const load = async (): Promise<Analytics> => { vi.resetModules(); return import('../utils/analytics'); };
const rows = () => h.insert.mock.calls.flatMap(c => c[0]);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('nova_track_local', '1'); // mesure activée malgré localhost
  h.insert.mockClear();
  h.getSession.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('track', () => {
  it('aucune mesure en local sans le drapeau nova_track_local', async () => {
    localStorage.removeItem('nova_track_local');
    expect(window.location.hostname).toBe('localhost');
    const a = await load();
    a.track('daw_open');
    for (let i = 0; i < 25; i++) a.track('rec_started');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('envoi groupé après 4 s, ligne complète avec l\'utilisateur connecté', async () => {
    const a = await load();
    a.track('daw_open');
    a.track('beat_tried', { id: 'b1' });
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.insert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.insert).toHaveBeenCalledTimes(1);
    const [r1, r2] = rows();
    expect(r1).toMatchObject({ app: 'daw', event: 'daw_open', props: null, path: '/', user_id: 'user-1' });
    expect(r2).toMatchObject({ event: 'beat_tried', props: { id: 'b1' } });
    expect(r1.visitor).toMatch(/^[0-9a-z]{8,32}$/);
    expect(r1.session).toMatch(/^[0-9a-z]{8,32}$/);
    expect(r1.visitor).toBe(r2.visitor);
    expect(r1.session).toBe(r2.session);
  });

  it('sans session : user_id null', async () => {
    h.getSession.mockResolvedValueOnce({ data: { session: null } } as any);
    const a = await load();
    a.track('daw_open');
    await vi.advanceTimersByTimeAsync(4000);
    expect(rows()[0].user_id).toBeNull();
  });

  it.each(['Daw_open', 'daw-open', 'a', 'x'.repeat(41), 'événement', 'daw open', ''])('nom invalide ignoré : « %s »', async (name) => {
    const a = await load();
    a.track(name);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('noms limites acceptés (2 et 40 caractères)', async () => {
    const a = await load();
    a.track('ab');
    a.track('x'.repeat(40));
    await vi.advanceTimersByTimeAsync(4000);
    expect(rows().map(r => r.event)).toEqual(['ab', 'x'.repeat(40)]);
  });

  it('props : 8 clés max, clés à 30 car., textes à 80, objets convertis en texte', async () => {
    const a = await load();
    const props: Record<string, unknown> = {
      ['k'.repeat(40)]: 'v'.repeat(200), n: 3.5, b: false, o: { x: 1 }, nul: null, u: undefined, s: 's', t: 't', neuf: 9,
    };
    a.track('mix_style_applied', props);
    await vi.advanceTimersByTimeAsync(4000);
    const p = rows()[0].props;
    expect(Object.keys(p)).toHaveLength(8);
    expect(p).not.toHaveProperty('neuf');
    expect(p['k'.repeat(30)]).toBe('v'.repeat(80));
    expect(p.n).toBe(3.5);
    expect(p.b).toBe(false);
    expect(p.o).toBe('[object Object]');
    expect(p.nul).toBe('null');
    expect(p.u).toBe('undefined');
  });

  it('20 événements : envoi immédiat sans attendre le minuteur', async () => {
    const a = await load();
    for (let i = 0; i < 20; i++) a.track('take_recorded', { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.insert.mock.calls[0][0]).toHaveLength(20);
  });

  it('25 événements : 20 tout de suite, les 5 suivants au minuteur', async () => {
    const a = await load();
    for (let i = 0; i < 25; i++) a.track('take_recorded', { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.insert.mock.calls.map(c => c[0].length)).toEqual([20]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.insert.mock.calls.map(c => c[0].length)).toEqual([20, 5]);
    expect(rows().map(r => r.props.i)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('envoi quand on quitte la page (pagehide / onglet caché)', async () => {
    const a = await load();
    a.track('export_done');
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(rows().map(r => r.event)).toEqual(['export_done']);
  });

  it('erreur réseau : jamais d\'exception', async () => {
    h.insert.mockRejectedValueOnce(new Error('offline'));
    const a = await load();
    expect(() => a.track('daw_open')).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(4000)).resolves.toBeDefined();
  });
});

describe('trackOnce / identifiants', () => {
  it('trackOnce : une seule fois par session', async () => {
    const a = await load();
    a.trackOnce('rec_started');
    a.trackOnce('rec_started');
    a.trackOnce('take_recorded');
    await vi.advanceTimersByTimeAsync(4000);
    expect(rows().map(r => r.event)).toEqual(['rec_started', 'take_recorded']);
  });

  it('visiteur gardé dans le navigateur, session nouvelle à chaque chargement', async () => {
    const a = await load();
    a.track('daw_open');
    await vi.advanceTimersByTimeAsync(4000);
    const first = rows()[0];
    expect(localStorage.getItem('nova_visitor_id')).toBe(first.visitor);
    h.insert.mockClear();
    const b = await load();
    b.track('daw_open');
    await vi.advanceTimersByTimeAsync(4000);
    const second = rows()[0];
    expect(second.visitor).toBe(first.visitor);
    expect(second.session).not.toBe(first.session);
  });
});
