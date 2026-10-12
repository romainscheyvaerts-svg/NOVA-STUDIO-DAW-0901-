import { describe, expect, it } from 'vitest';
import {
  classifySupabaseError, createPresetSync, ERROR_PAUSE_MS, MISSING_RETRY_MS, presetFromRow, rowOf,
  type CloudRow, type LocalPresets, type MetaStore, type PresetCloudApi,
} from '../services/PresetCloud';
import type { AnyPreset } from '../utils/presets';

/**
 * Presets synchronisés entre postes : un faux serveur (règles de la migration
 * nova_presets : RLS par compte, la plus récente gagne, ligne « supprimée »,
 * curseur updated_at) et deux postes (rangement et réglages séparés).
 */
function fakeServer() {
  const rows = new Map<string, CloudRow & { user_id: string; updated_at: string }>();
  let clock = 0;
  const calls = { pull: 0, push: 0 };
  const mode = { missing: false, offline: false, error: false };
  const api = (uid: string | null): PresetCloudApi => ({
    userId: async () => uid,
    async pull(since, limit, exceptDevice) {
      calls.pull++;
      if (mode.offline) return { error: { kind: 'offline' } };
      if (mode.missing) return { error: { kind: 'missing' } };
      if (mode.error) return { error: { kind: 'server' } };
      const mine = [...rows.values()].filter(r => r.user_id === uid && (!since || r.updated_at > since) && (!exceptDevice || r.device_id !== exceptDevice)).sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
      return { rows: mine.slice(0, limit).map(r => ({ ...r, body: JSON.parse(JSON.stringify(r.body)) })) };
    },
    async push(rs) {
      calls.push++;
      if (mode.offline) return { error: { kind: 'offline' } };
      if (mode.missing) return { error: { kind: 'missing' } };
      for (const r of rs) if (r.user_id !== uid) return { error: { kind: 'auth' } }; // RLS
      for (const r of rs) {
        const key = `${uid}/${r.preset_id}`;
        const old = rows.get(key);
        if (old && r.client_updated_at < old.client_updated_at) continue; // la plus récente gagne
        rows.set(key, { ...r, user_id: uid!, body: r.deleted ? {} : JSON.parse(JSON.stringify(r.body)), updated_at: new Date(1.7e12 + ++clock * 1000).toISOString() });
      }
      return {};
    },
  });
  return { rows, calls, mode, api };
}

let devSeq = 0;
function device(api: PresetCloudApi, clock = { t: 1000 }) {
  const store = new Map<string, AnyPreset>();
  const meta = new Map<string, string>();
  let remoteNotified = 0;
  const local: LocalPresets = {
    all: async () => [...store.values()].map(p => JSON.parse(JSON.stringify(p))),
    put: async p => { store.set(p.id, JSON.parse(JSON.stringify(p))); },
    remove: async id => { store.delete(id); },
    changed: () => { remoteNotified++; },
  };
  const m: MetaStore = { get: k => meta.get(k) ?? null, set: (k, v) => { if (v) meta.set(k, v); else meta.delete(k); } };
  const sync = createPresetSync({ api, local, meta: m, now: () => clock.t, deviceId: `poste-${++devSeq}` });
  /** Enregistrement par l'utilisateur (PresetStore + écouteur de PresetCloud). */
  const save = (p: AnyPreset) => { clock.t += 1000; const q = { ...p, updatedAt: clock.t } as AnyPreset; store.set(q.id, q); sync.markChanged(q.id, clock.t); return q; };
  const del = (id: string) => { clock.t += 1000; store.delete(id); sync.markDeleted(id, clock.t); };
  return { store, meta, sync, save, del, clock, remote: () => remoteNotified };
}

const plugin = (id: string, name: string, ratio = 4): AnyPreset => ({
  format: 'novapreset', version: 1, id, name, target: { type: 'COMPRESSOR' }, settings: { threshold: -18, ratio }, createdAt: 1, updatedAt: 1,
} as any);
const chain = (id: string, name: string): AnyPreset => ({
  format: 'novachain', version: 1, id, name, plugins: [{ type: 'EQ', params: { lowCut: 80 } }], sends: [], volume: 0.8, pan: 0, createdAt: 1, updatedAt: 1,
} as any);

describe('presets synchronisés entre postes', () => {
  it('un preset d’effet et un modèle de piste enregistrés sur le poste A se retrouvent sur le poste B (même compte)', async () => {
    const srv = fakeServer();
    const clock = { t: 1000 };
    const A = device(srv.api('u1'), clock), B = device(srv.api('u1'), clock);
    A.save(plugin('pre-1', 'Voix rap 2:1', 2));
    A.save(chain('chain-1', 'Lead LENNON'));
    expect((await A.sync.sync()).state).toBe('ok');
    expect(A.sync.status().pushed).toBe(2);
    const s = await B.sync.sync();
    expect(s.state).toBe('ok');
    expect(s.pulled).toBe(2);
    expect([...B.store.values()].map(p => p.name).sort()).toEqual(['Lead LENNON', 'Voix rap 2:1']);
    expect((B.store.get('pre-1') as any).settings.ratio).toBe(2);
    expect(B.remote()).toBe(1); // les listes ouvertes sur B se rafraîchissent
  });

  it('renommer sur B, supprimer sur A : chaque poste finit pareil', async () => {
    const srv = fakeServer();
    const clock = { t: 1000 };
    const A = device(srv.api('u1'), clock), B = device(srv.api('u1'), clock);
    A.save(plugin('pre-1', 'Voix'));
    A.save(plugin('pre-2', 'Backs'));
    await A.sync.sync(); await B.sync.sync();
    B.save({ ...B.store.get('pre-1')!, name: 'Voix lead' });
    await B.sync.sync(); await A.sync.sync();
    expect(A.store.get('pre-1')!.name).toBe('Voix lead');
    A.del('pre-2');
    await A.sync.sync(); await B.sync.sync();
    expect(B.store.has('pre-2')).toBe(false);
    expect(srv.rows.get('u1/pre-2')!.deleted).toBe(true);
    expect(srv.rows.get('u1/pre-2')!.body).toEqual({});
  });

  it('hors ligne : rien n’est perdu ; au retour, la modification la plus récente gagne partout', async () => {
    const srv = fakeServer();
    const clock = { t: 1000 };
    const A = device(srv.api('u1'), clock), B = device(srv.api('u1'), clock);
    A.save(plugin('pre-1', 'Voix', 4));
    await A.sync.sync(); await B.sync.sync();
    srv.mode.offline = true;
    A.save({ ...A.store.get('pre-1')!, name: 'Voix (A)' });
    B.save({ ...B.store.get('pre-1')!, name: 'Voix (B, plus tard)' });
    expect((await A.sync.sync()).state).toBe('offline');
    expect(A.store.get('pre-1')!.name).toBe('Voix (A)');
    srv.mode.offline = false;
    // A revient en premier, B ensuite : la version de B (plus récente) gagne, même chez A.
    await A.sync.sync(); await B.sync.sync(); await A.sync.sync();
    expect(A.store.get('pre-1')!.name).toBe('Voix (B, plus tard)');
    expect(B.store.get('pre-1')!.name).toBe('Voix (B, plus tard)');
    // Un poste en retard qui renvoie une vieille version n'écrase rien.
    await srv.api('u1').push([{ ...rowOf(plugin('pre-1', 'Ancienne'), 'u1'), client_updated_at: 5 }]);
    expect(srv.rows.get('u1/pre-1')!.name).toBe('Voix (B, plus tard)');
  });

  it('table absente en ligne : « bientôt disponible », une seule requête, aucun envoi, puis redemandée après 6 h', async () => {
    const srv = fakeServer();
    srv.mode.missing = true;
    const A = device(srv.api('u1'));
    A.save(plugin('pre-1', 'Voix'));
    const s = await A.sync.sync();
    expect(s.state).toBe('soon');
    expect(s.message).toMatch(/bientôt disponible/);
    await A.sync.sync(); await A.sync.sync();
    expect(srv.calls).toEqual({ pull: 1, push: 0 });
    // Toujours sur l'appareil, et encore dans la file d'envoi.
    expect(A.store.has('pre-1')).toBe(true);
    A.clock.t += MISSING_RETRY_MS + 1;
    srv.mode.missing = false;
    expect((await A.sync.sync()).state).toBe('ok');
    expect(srv.rows.has('u1/pre-1')).toBe(true);
  });

  it('serveur en erreur : pause de 15 min (aucune requête), les presets restent sur le poste', async () => {
    const srv = fakeServer();
    const A = device(srv.api('u1'));
    srv.mode.error = true;
    expect((await A.sync.sync()).state).toBe('error');
    await A.sync.sync();
    expect(srv.calls.pull).toBe(1);
    A.clock.t += ERROR_PAUSE_MS + 1;
    srv.mode.error = false;
    expect((await A.sync.sync()).state).toBe('ok');
  });

  it('non connecté : état « off », aucune requête', async () => {
    const srv = fakeServer();
    const A = device(srv.api(null));
    A.save(plugin('pre-1', 'Voix'));
    const s = await A.sync.sync();
    expect(s.state).toBe('off');
    expect(s.message).toMatch(/Connecte-toi/);
    expect(srv.calls).toEqual({ pull: 0, push: 0 });
  });

  it('1re connexion : les presets déjà sur le poste partent ; deux comptes sur le même PC ne se mélangent pas', async () => {
    const srv = fakeServer();
    const meta = new Map<string, string>();
    const store = new Map<string, AnyPreset>();
    const local: LocalPresets = { all: async () => [...store.values()], put: async p => { store.set(p.id, p); }, remove: async id => { store.delete(id); } };
    const m: MetaStore = { get: k => meta.get(k) ?? null, set: (k, v) => { if (v) meta.set(k, v); else meta.delete(k); } };
    store.set('old', { ...plugin('old', 'Avant connexion'), updatedAt: 500 } as AnyPreset);
    // Compte X : reçoit aussi un preset de son autre poste.
    await srv.api('X').push([rowOf({ ...plugin('x-only', 'Preset de X'), updatedAt: 700 } as AnyPreset, 'X')]);
    await createPresetSync({ api: srv.api('X'), local, meta: m }).sync();
    expect(srv.rows.has('X/old')).toBe(true);
    expect(store.has('x-only')).toBe(true);
    // Compte Y se connecte sur le même PC : le preset reçu de X ne part pas chez Y.
    await createPresetSync({ api: srv.api('Y'), local, meta: m }).sync();
    expect(srv.rows.has('Y/x-only')).toBe(false);
    expect(srv.rows.has('Y/old')).toBe(false);
  });

  it('beaucoup de presets : lecture par pages de 200, une synchronisation à la fois', async () => {
    const srv = fakeServer();
    const rows = Array.from({ length: 450 }, (_, i) => rowOf({ ...plugin(`p${i}`, `P${i}`), updatedAt: 10 + i } as AnyPreset, 'u1'));
    for (let i = 0; i < rows.length; i += 50) await srv.api('u1').push(rows.slice(i, i + 50));
    srv.calls.pull = 0;
    const B = device(srv.api('u1'));
    const [a, b] = await Promise.all([B.sync.sync(), B.sync.sync()]);
    expect(a.state).toBe('ok');
    expect(b).toBe(a);
    expect(B.store.size).toBe(450);
    // 3 pages ; le 2e appel (pendant la 1re) relance UNE synchro, qui ne lit qu'une page vide.
    await new Promise(r => setTimeout(r, 20));
    expect(srv.calls.pull).toBe(4);
    // Rien n'est renvoyé : ces presets viennent du compte (seulement les 9 envois de la mise en place).
    expect(srv.calls.push).toBe(9);
  });

  it('un poste ne relit jamais ce qu’il vient d’envoyer (egress)', async () => {
    const srv = fakeServer();
    const clock = { t: 1000 };
    const A = device(srv.api('u1'), clock), B = device(srv.api('u1'), clock);
    A.save(plugin('pre-1', 'Voix'));
    await A.sync.sync();
    const s = await A.sync.sync();
    expect(s.pulled).toBe(0);
    expect(srv.rows.get('u1/pre-1')!.device_id).toMatch(/^poste-/);
    expect((await B.sync.sync()).pulled).toBe(1);
  });

  it('lignes abîmées ignorées ; erreurs Supabase reconnues', () => {
    expect(presetFromRow({ preset_id: 'x', kind: 'plugin', name: 'x', body: { format: 'autre' }, deleted: false, client_updated_at: 1 })).toBeNull();
    expect(presetFromRow({ preset_id: 'x', kind: 'plugin', name: 'x', body: null, deleted: false, client_updated_at: 1 })).toBeNull();
    expect(presetFromRow({ preset_id: 'x', kind: 'plugin', name: 'N', body: { format: 'novapreset', name: '' }, deleted: false, client_updated_at: 9 })).toMatchObject({ id: 'x', name: 'N', updatedAt: 9 });
    expect(classifySupabaseError({ code: 'PGRST205', message: "Could not find the table 'public.nova_presets' in the schema cache" }, 404).kind).toBe('missing');
    expect(classifySupabaseError({ code: '42P01', message: 'relation "nova_presets" does not exist' }, 400).kind).toBe('missing');
    expect(classifySupabaseError({ message: 'TypeError: Failed to fetch' }, 0).kind).toBe('offline');
    expect(classifySupabaseError({ code: 'PGRST301', message: 'JWT expired' }, 401).kind).toBe('auth');
    expect(classifySupabaseError({ message: 'exceed_egress_quota' }, 402).kind).toBe('server');
  });
});
