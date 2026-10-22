// @vitest-environment jsdom
/**
 * Chantier 5 — sauvegardes qui ne disparaissent jamais :
 *  - persistance du stockage demandée, état lisible, conseil clair si refusée, quota surveillé ;
 *  - effacement par le navigateur détecté (marque hors du stockage effaçable) ;
 *  - Nova Studio : copie de chaque version sur le disque (seuls les sons manquants partent,
 *    une copie à la fois, la plus récente gagne), relecture depuis le disque vers l'appareil,
 *    « Récupérer » propose la plus récente des deux ;
 *  - fermeture d'onglet : fenêtre seulement s'il reste du non-sauvegardé ;
 *  - deux onglets sur le même projet : un seul sauvegarde.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quotaLevel, requestPersistence, refreshStorageStatus, isQuotaError, storageAdvice, resetStorageProtectionForTests,
  markLocalSaves, clearLocalSavesMark, localSavesMarked, evictionSuspected, type StorageStatus,
} from '../utils/storageProtection';
import { DiskMirror, pickMostRecent, importFromDisk, latestOnDisk, audioFrom, type DiskBackend } from '../services/DiskProjectStore';
import { RecoveryStore, memoryBackend, type VersionRecord } from '../utils/recoveryStore';
import { needsUnloadWarning, projectSignature } from '../utils/autosavePolicy';
import { ProjectTabLock, type LockChannel } from '../utils/tabLock';

const MB = 1024 * 1024;

describe('persistance du stockage (navigator.storage)', () => {
  beforeEach(() => resetStorageProtectionForTests());

  it('niveau de quota : ok, presque plein (80 % ou < 300 Mo libres), plein (95 %)', () => {
    expect(quotaLevel(100 * MB, 10_000 * MB)).toBe('ok');
    expect(quotaLevel(8_100 * MB, 10_000 * MB)).toBe('warn');
    expect(quotaLevel(400 * MB, 600 * MB)).toBe('warn');
    expect(quotaLevel(9_600 * MB, 10_000 * MB)).toBe('full');
    expect(quotaLevel(null, null)).toBe('unknown');
  });

  it('demandée une seule fois ; accordée / refusée / indisponible', async () => {
    const persist = vi.fn(async () => true);
    const api = { persisted: async () => false, persist, estimate: async () => ({ usage: 1, quota: 100 }) };
    expect(await requestPersistence(api)).toBe('granted');
    expect(await requestPersistence(api)).toBe('granted');
    expect(persist).toHaveBeenCalledTimes(1);
    resetStorageProtectionForTests();
    expect(await requestPersistence({ persisted: async () => false, persist: async () => false })).toBe('denied');
    resetStorageProtectionForTests();
    expect(await requestPersistence(null)).toBe('unsupported');
    resetStorageProtectionForTests();
    const st = await refreshStorageStatus({ persisted: async () => true, estimate: async () => ({ usage: 9_700 * MB, quota: 10_000 * MB }) });
    expect(st).toMatchObject({ persist: 'granted', level: 'full' });
  });

  it('un refus connu reste « refusé » même si une relecture tombe pendant la demande', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const api = { persisted: async () => false, persist: async () => { await gate; return false; }, estimate: async () => ({ usage: 1, quota: 1000 * MB }) };
    const ask = requestPersistence(api);
    const refresh = refreshStorageStatus({ ...api, estimate: async () => { release(); await new Promise(r => setTimeout(r, 0)); return { usage: 1, quota: 1000 * MB }; } });
    await Promise.all([ask, refresh]);
    expect((await refreshStorageStatus(api)).persist).toBe('denied');
  });

  it('conseils : protégés ; refusé sur le site → exporter le .zip ou Nova Studio ; quota plein → quoi faire', () => {
    const s = (over: Partial<StorageStatus>): StorageStatus => ({ persist: 'unknown', usage: 10 * MB, quota: 1000 * MB, level: 'ok', checkedAt: 0, ...over });
    const ok = storageAdvice(s({ persist: 'granted' }), false);
    expect(ok[0].title).toBe('Tes projets sont protégés contre l’effacement automatique du navigateur');
    const denied = storageAdvice(s({ persist: 'denied' }), false);
    expect(denied[0].tone).toBe('warn');
    expect(denied[0].text).toMatch(/\.zip/);
    expect(denied[0].text).toMatch(/Nova Studio/);
    const full = storageAdvice(s({ persist: 'granted', level: 'full', usage: 990 * MB }), false);
    expect(full.some(a => a.tone === 'danger' && /Exporte/.test(a.text))).toBe(true);
    const desk = storageAdvice(s({ persist: 'denied' }), true, true);
    expect(desk[0].title).toMatch(/sur le disque/);
    expect(desk[1].tone).toBe('info');
  });

  it("reconnaît l'erreur « stockage plein » de chaque navigateur", () => {
    expect(isQuotaError(new DOMException('x', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError({ name: 'Error', code: 22 })).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError(new Error('The quota has been exceeded.'))).toBe(true);
    expect(isQuotaError(new Error('Transaction annulée'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it('effacement détecté : la marque (cookie) survit au vidage du stockage du site', () => {
    clearLocalSavesMark();
    expect(evictionSuspected(false)).toBe(false);
    markLocalSaves();
    localStorage.clear(); // le navigateur vide le stockage du site…
    expect(localSavesMarked()).toBe(true); // …le cookie reste
    expect(evictionSuspected(false)).toBe(true);
    expect(evictionSuspected(true)).toBe(false);
    clearLocalSavesMark();
  });
});

// --------------------------------------------------------------------------- disque (Nova Studio)

function fakeDisk() {
  const audio = new Map<string, { sampleRate: number; channels: Float32Array[] }>();
  const versions = new Map<string, any[]>();
  const log: string[] = [];
  let gate: Promise<void> | null = null;
  const backend: DiskBackend & { audio: typeof audio; versions: typeof versions; log: string[]; hold(): () => void; up: boolean } = {
    audio, versions, log, up: true,
    hold() { let release!: () => void; gate = new Promise(r => { release = r; }); return () => { gate = null; release(); }; },
    available() { return backend.up; },
    async missingAudio(_p, _n, ids) { if (gate) await gate; return ids.filter(i => !audio.has(i)); },
    async putAudio(_p, _n, id, sr, ch) { log.push(`son ${id}`); audio.set(id, { sampleRate: sr, channels: ch.map(c => c.slice()) }); },
    async saveVersion(p, _n, r) { log.push(`version ${r.id}`); versions.set(p, [...(versions.get(p) || []), structuredClone(r)]); return { folder: `C:/Projets/${r.name}`, versionId: r.id }; },
    async listProjects() {
      return [...versions.entries()].map(([projectId, list]) => {
        const last = list[list.length - 1];
        const { json: _j, audioIds: _a, ...latest } = last;
        return { projectId, name: last.name, folder: `C:/Projets/${last.name}`, versions: list.length, latest };
      });
    },
    async loadVersion(p, vid) {
      const list = versions.get(p) || [];
      const record = vid ? list.find(v => v.id === vid) : list[list.length - 1];
      const missing = record.audioIds.filter((i: string) => !audio.has(i));
      return { record, missing, audio: record.audioIds.filter((i: string) => audio.has(i)).map((id: string) => ({ id, ...audio.get(id)! })) };
    },
  };
  return backend;
}

const rec = (id: number, audioIds: string[], over: Partial<VersionRecord> = {}): VersionRecord => ({
  id, projectId: 'p1', name: 'Séance', savedAt: id, reason: 'auto', tracks: 2, takes: 1, beatTitle: null, hasLyrics: false,
  needsCatalogBeat: false, json: JSON.stringify({ v: id }), audioIds, ...over,
});
const tone = (n: number, v: number) => ({ sampleRate: 48000, channels: [new Float32Array(n).fill(v), new Float32Array(n).fill(-v)] });

describe('copie sur le disque (services/DiskProjectStore)', () => {
  it("chaque son n'est envoyé qu'une fois ; la version part après ses sons", async () => {
    const disk = fakeDisk();
    const m = new DiskMirror(disk, async () => {});
    const src = (id: string) => tone(10, id === 'a' ? 0.5 : 0.25);
    await m.mirror(rec(1, ['a', 'b']), src);
    await m.mirror(rec(2, ['a', 'b', 'c']), src);
    expect(disk.log).toEqual(['son a', 'son b', 'version 1', 'son c', 'version 2']);
    expect(m.status.last).toMatchObject({ versionId: 2, audioSent: 1 });
    expect(m.status.error).toBeNull();
  });

  it('versions arrivées pendant une copie : seule la plus récente est copiée ensuite', async () => {
    const disk = fakeDisk();
    const m = new DiskMirror(disk, async () => {});
    const release = disk.hold();
    const p1 = m.mirror(rec(1, []), () => null);
    void m.mirror(rec(2, []), () => null);
    void m.mirror(rec(3, []), () => null);
    release();
    await p1;
    await m.idle();
    expect(disk.log).toEqual(['version 1', 'version 3']);
  });

  it("pont absent : rien n'est tenté ; erreur du pont : notée, la suivante repart", async () => {
    const disk = fakeDisk();
    disk.up = false;
    const m = new DiskMirror(disk, async () => {});
    await m.mirror(rec(1, ['a']), () => tone(4, 1));
    expect(disk.log).toEqual([]);
    disk.up = true;
    const save = disk.saveVersion;
    disk.saveVersion = async () => { throw new Error('disque plein'); };
    await m.mirror(rec(2, ['a']), () => tone(4, 1));
    expect(m.status.error).toBe('disque plein');
    disk.saveVersion = save;
    await m.mirror(rec(3, ['a']), () => tone(4, 1));
    expect(m.status.error).toBeNull();
  });

  it("stockage du navigateur VIDÉ : la séance revient du disque, sons compris (Nova Studio)", async () => {
    const disk = fakeDisk();
    const before = new RecoveryStore(memoryBackend());
    const getAudio = (id: string) => (id === 'voix' ? { sampleRate: 48000, length: 6, channels: [new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])] } : null);
    const saved = await before.saveVersion({ projectId: 'p1', name: 'Séance', json: '{"tracks":[1]}', audioIds: ['voix'], getAudio, tracks: 1, takes: 1, beatTitle: null, hasLyrics: false, needsCatalogBeat: false, reason: 'auto' });
    const m = new DiskMirror(disk, async () => {});
    const record = (await before.getRecord(saved!.versionId))!;
    await m.mirror(record, audioFrom(() => null, id => before.getAudio(id)));
    // Éviction : un magasin tout neuf (IndexedDB vidé).
    const after = new RecoveryStore(memoryBackend());
    expect(await after.latest()).toBeNull();
    const onDisk = await latestOnDisk(disk);
    const pick = pickMostRecent(await after.latest(), onDisk);
    expect(pick?.source).toBe('disque');
    const r = await importFromDisk(disk, after, pick!.meta.projectId, pick!.meta.id);
    expect(r.missing).toEqual([]);
    const back = await after.loadVersion(saved!.versionId);
    expect(back!.record.json).toBe('{"tracks":[1]}');
    expect(Array.from(back!.audio.get('voix')!.channels[0])).toEqual(Array.from(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])));
  });

  it('après un plantage : la version sur le disque du projet qui était OUVERT, pas celle du dernier projet enregistré', async () => {
    const backend = {
      available: () => true,
      listProjects: async () => [
        { projectId: 'autre', name: 'Autre', folder: '', versions: 1, latest: { id: 20, savedAt: 20 } },
        { projectId: 'ouvert', name: 'Ouvert', folder: '', versions: 1, latest: { id: 10, savedAt: 10 } },
      ],
    } as any;
    expect((await latestOnDisk(backend))?.projectId).toBe('autre');
    expect((await latestOnDisk(backend, 'ouvert'))?.projectId).toBe('ouvert');
    // Projet ouvert absent du disque (jamais copié) : la plus récente, comme avant.
    expect((await latestOnDisk(backend, 'inconnu'))?.projectId).toBe('autre');
  });

  it('« Récupérer » : la plus récente des deux ; égalité → l’appareil (rien à relire)', () => {
    const dev = { id: 5, savedAt: 5, projectId: 'p1' } as any;
    const disk = { projectId: 'p1', name: 'S', folder: '', versions: 1, latest: { id: 9, savedAt: 9 } } as any;
    expect(pickMostRecent(dev, disk)?.source).toBe('disque');
    expect(pickMostRecent({ ...dev, savedAt: 9 }, disk)?.source).toBe('appareil');
    expect(pickMostRecent(dev, null)?.source).toBe('appareil');
    expect(pickMostRecent(null, null)).toBeNull();
  });
});

// --------------------------------------------------------------------------- fermeture d'onglet

describe("fermeture d'onglet : « Quitter la page ? » seulement s'il reste du non-sauvegardé", () => {
  const st = (over: any = {}) => ({ id: 'p', name: 'S', bpm: 120, markers: [], isRecording: false, tracks: [{ id: 'voix', clips: [{ id: 'c' }] }], ...over }) as any;
  it('déjà écrit par la sauvegarde automatique : pas de fenêtre', () => {
    const s = st();
    expect(needsUnloadWarning(s, projectSignature(s), { hasUserContent: true })).toBe(false);
  });
  it('modifié depuis la dernière version, ou prise en cours : fenêtre', () => {
    const s = st();
    expect(needsUnloadWarning({ ...s, bpm: 90 }, projectSignature(s), { hasUserContent: true })).toBe(true);
    expect(needsUnloadWarning({ ...s, isRecording: true }, projectSignature(s), { hasUserContent: true })).toBe(true);
  });
  it('projet vide : jamais de fenêtre', () => {
    expect(needsUnloadWarning(st({ tracks: [] }), null, { hasUserContent: false })).toBe(false);
  });
});

// --------------------------------------------------------------------------- deux onglets

function bus() {
  const chans: LockChannel[] = [];
  return () => {
    const c: LockChannel = {
      onmessage: null,
      postMessage(m) { for (const o of chans) if (o !== c) queueMicrotask(() => o.onmessage?.({ data: structuredClone(m) })); },
      close() { const i = chans.indexOf(c); if (i >= 0) chans.splice(i, 1); },
    };
    chans.push(c);
    return c;
  };
}
const tick = () => new Promise(r => setTimeout(r, 0));

describe('deux onglets sur le même projet (utils/tabLock)', () => {
  it("le 2e onglet est prévenu et ne sauvegarde pas ; « Travailler ici » inverse les rôles", async () => {
    const ch = bus();
    let t = 1000;
    const a = new ProjectTabLock({ channel: ch(), tabId: 'a', now: () => t++ });
    const b = new ProjectTabLock({ channel: ch(), tabId: 'b', now: () => t++ });
    a.open('p1'); await tick();
    b.open('p1'); await tick(); await tick();
    expect(a.canSave()).toBe(true);
    expect(b.canSave()).toBe(false);
    expect(b.state.reason).toBe('opened-elsewhere');
    b.takeOver(); await tick();
    expect(b.canSave()).toBe(true);
    expect(a.canSave()).toBe(false);
    expect(a.state.reason).toBe('taken-over');
    b.close(); await tick();
    expect(a.state.ownerGone).toBe(true);
  });

  it('projets différents : aucun conflit ; ouverture simultanée : un seul propriétaire', async () => {
    const ch = bus();
    const a = new ProjectTabLock({ channel: ch(), tabId: 'a', now: () => 5 });
    const b = new ProjectTabLock({ channel: ch(), tabId: 'b', now: () => 5 });
    const c = new ProjectTabLock({ channel: ch(), tabId: 'c', now: () => 6 });
    c.open('autre');
    a.open('p1'); b.open('p1');
    for (let i = 0; i < 5; i++) await tick();
    expect([a.canSave(), b.canSave()].filter(Boolean)).toHaveLength(1);
    expect(c.canSave()).toBe(true);
  });

  it('sans BroadcastChannel : pas de verrou (comme avant)', () => {
    const solo = new ProjectTabLock({ channel: null });
    solo.open('p1');
    expect(solo.canSave()).toBe(true);
  });
});

describe("2e onglet au démarrage : le drapeau d'un onglet vivant n'est pas un plantage", () => {
  it('isOpenElsewhere : vrai si un autre onglet a ce projet ouvert, faux sinon', async () => {
    const ch = bus();
    const a = new ProjectTabLock({ channel: ch(), tabId: 'a' });
    const b = new ProjectTabLock({ channel: ch(), tabId: 'b' });
    a.open('p1');
    expect(await b.isOpenElsewhere('p1', 200)).toBe(true);
    expect(await b.isOpenElsewhere('p2', 50)).toBe(false);
    a.close();
    expect(await b.isOpenElsewhere('p1', 50)).toBe(false);
    expect(await new ProjectTabLock({ channel: null }).isOpenElsewhere('p1')).toBe(false);
  });
});
