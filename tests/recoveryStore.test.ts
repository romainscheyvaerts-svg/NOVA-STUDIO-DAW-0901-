import { describe, expect, it } from 'vitest';
import { memoryBackend, RecoveryStore, versionsToPrune, KEEP_RECENT, AUDIO, VERSIONS, TAKES, TAKE_CHUNKS, markSessionOpen, markSessionClosed, previousSessionCrashed } from '../utils/recoveryStore';
import { addRecoveredTakes, snapshotOf, stateFromVersion } from '../utils/recoverySnapshot';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { TrackType } from '../types';

const HOUR = 3_600_000;
const tone = (n: number, v = 0.5) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = v * Math.sin(i / 10); return a; };
const audioOf = (n: number) => ({ sampleRate: 44100, length: n, channels: [tone(n)] });

function clockAt(t0: number) { let t = t0; const f = () => t; (f as any).set = (x: number) => { t = x; }; (f as any).add = (d: number) => { t += d; }; return f as (() => number) & { set(x: number): void; add(d: number): void }; }

function snapInput(state: ReturnType<typeof makeState>, reason: any = 'auto', getAudio = (id: string) => audioOf(1000 + id.length)) {
  const s = snapshotOf(state);
  return { projectId: state.id, name: state.name, json: s.json, audioIds: s.audioIds, getAudio, tracks: s.tracks, takes: s.takes, beatTitle: s.beatTitle, hasLyrics: s.hasLyrics, needsCatalogBeat: s.needsCatalogBeat, reason };
}

describe('Historique des versions : 20 dernières + une par heure', () => {
  it('garde les 20 plus récentes et la plus récente de chaque heure sur 7 jours', () => {
    const now = 100 * HOUR;
    const list = [] as { id: number; savedAt: number }[];
    // 10 heures de travail, une version toutes les 5 minutes (120 versions)
    for (let i = 0; i < 120; i++) { const t = now - i * 5 * 60_000; list.push({ id: t, savedAt: t }); }
    const drop = new Set(versionsToPrune(list, now));
    const kept = list.filter(v => !drop.has(v.id));
    // 20 récentes (1 h 40) + une par heure pour les heures plus anciennes
    expect(kept.slice(0, KEEP_RECENT).every(v => !drop.has(v.id))).toBe(true);
    const hours = new Set(list.map(v => Math.floor(v.savedAt / HOUR)));
    for (const h of hours) expect(kept.some(v => Math.floor(v.savedAt / HOUR) === h)).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(KEEP_RECENT + hours.size);
    expect(kept.length).toBeGreaterThanOrEqual(KEEP_RECENT);
  });
  it('au-delà de 7 jours : seules les 20 dernières restent', () => {
    const now = 1000 * HOUR;
    const list = Array.from({ length: 40 }, (_, i) => ({ id: now - 8 * 24 * HOUR - i * HOUR, savedAt: now - 8 * 24 * HOUR - i * HOUR }));
    expect(versionsToPrune(list, now)).toHaveLength(20);
  });
});

describe('Sauvegarde incrémentale', () => {
  it('chaque son est écrit une seule fois ; les versions suivantes ne réécrivent que le projet', async () => {
    const db = memoryBackend();
    const clock = clockAt(10 * HOUR);
    const store = new RecoveryStore(db, clock);
    const voix = makeTrack({ id: 'voix', clips: [makeClip({ id: 'c1', bufferId: 'b1' }), makeClip({ id: 'c2', bufferId: 'b2' })] });
    let state = makeState([voix]);
    let reads = 0;
    const get = (id: string) => { reads++; return audioOf(500); };
    const r1 = await store.saveVersion(snapInput(state, 'auto', get));
    expect(r1!.audioWritten).toBe(2);
    clock.add(15_000);
    state = { ...state, bpm: 128 };
    const r2 = await store.saveVersion(snapInput(state, 'auto', get));
    expect(r2!.audioWritten).toBe(0);
    expect(reads).toBe(2);
    // Une nouvelle prise : seul son nouveau écrit
    clock.add(15_000);
    state = { ...state, tracks: [{ ...voix, clips: [...voix.clips, makeClip({ id: 'c3', bufferId: 'b3' })] }] };
    const r3 = await store.saveVersion(snapInput(state, 'take', get));
    expect(r3!.audioWritten).toBe(1);
    const versions = await store.listVersions();
    expect(versions.map(v => v.reason)).toEqual(['take', 'auto', 'auto']);
    expect((await db.keys(AUDIO)).map(String).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('les sons ne sont pas copiés par référence (le son modifié ensuite ne change pas la version)', async () => {
    const db = memoryBackend();
    const store = new RecoveryStore(db, clockAt(HOUR));
    const ch = tone(100);
    await store.saveVersion(snapInput(makeState([makeTrack({ clips: [makeClip({ bufferId: 'x' })] })]), 'auto', () => ({ sampleRate: 44100, length: 100, channels: [ch] })));
    ch.fill(0);
    const stored = await db.get<any>(AUDIO, 'x');
    expect(Math.max(...Array.from(stored.channels[0] as Float32Array).map(Math.abs))).toBeGreaterThan(0.1);
  });

  it('beat du catalogue non acheté : jamais copié, rechargé depuis le catalogue', async () => {
    const beat = makeTrack({ id: 'instrumental', instrumentId: 'beat-42', clips: [makeClip({ name: 'Mon beat', bufferId: 'beat-buf' })] });
    const voix = makeTrack({ id: 'voix', clips: [makeClip({ bufferId: 'v1' })] });
    const s = snapshotOf(makeState([beat, voix]), []);
    expect(s.audioIds).toEqual(['v1']);
    expect(s.needsCatalogBeat).toBe(true);
    expect(s.beatTitle).toBe('Mon beat');
    const owned = snapshotOf(makeState([beat, voix]), ['beat-42']);
    expect(owned.audioIds.sort()).toEqual(['beat-buf', 'v1']);
  });

  it('élagage : les sons que plus aucune version ne référence sont effacés', async () => {
    const db = memoryBackend();
    const clock = clockAt(50 * HOUR);
    const store = new RecoveryStore(db, clock);
    // 25 versions, chacune avec un son propre, dans la même heure
    for (let i = 0; i < 25; i++) {
      clock.add(10_000);
      await store.saveVersion(snapInput(makeState([makeTrack({ clips: [makeClip({ bufferId: `s${i}` })] })])));
    }
    const versions = await store.listVersions();
    expect(versions).toHaveLength(KEEP_RECENT);
    const audio = (await db.keys(AUDIO)).map(String);
    expect(audio).toHaveLength(KEEP_RECENT);
    expect(audio).not.toContain('s0');
    expect(audio).toContain('s24');
  });

  it('restauration : projet relu, sons recréés sous leur identifiant, son manquant signalé', async () => {
    const db = memoryBackend();
    const store = new RecoveryStore(db, clockAt(HOUR));
    const voix = makeTrack({ id: 'voix', isTrackArmed: true, clips: [makeClip({ id: 'c1', bufferId: 'b1', start: 3 }), makeClip({ id: 'c2', bufferId: 'b2' })] });
    const st = makeState([voix], { isPlaying: true });
    const r = await store.saveVersion(snapInput(st));
    await db.delete(AUDIO, 'b2'); // son perdu (stockage abîmé)
    const v = await store.loadVersion(r!.versionId);
    expect(v!.missing).toEqual(['b2']);
    const reg = new Map<string, any>();
    const { state, report } = stateFromVersion(v!.record, v!.audio, a => ({ len: a.length }), (b, id) => reg.set(id, b));
    expect(reg.has('b1')).toBe(true);
    expect(state.isPlaying).toBe(false);
    expect(state.tracks[0].isTrackArmed).toBe(false);
    expect(state.tracks[0].clips[0].start).toBe(3);
    expect(state.tracks[0].clips[1].isOffline).toBe(true);
    expect(report.join(' ')).toMatch(/1 clip sans son/);
    expect(JSON.stringify(state)).not.toMatch(/"buffer"/);
  });
});

describe('Prise en cours écrite au fil de l\'eau', () => {
  it('morceaux d\'environ une seconde ; après un plantage, la prise revient jusqu\'au dernier morceau écrit', async () => {
    const db = memoryBackend();
    const clock = clockAt(20 * HOUR);
    const store = new RecoveryStore(db, clock);
    const j = store.beginTake({ takeId: 't1', projectId: 'proj-1', trackId: 'voix', trackName: 'VOIX', sampleRate: 44100, recordedAt: 12.5, latency: 0.02 });
    // 12,3 s de prise, par morceaux de 16 384 échantillons (comme l'enregistreur)
    const total = Math.round(12.3 * 44100);
    let sent = 0;
    while (sent < total) { const n = Math.min(16384, total - sent); j.push(tone(n, 0.3)); sent += n; }
    await j.flush();
    // Plantage : pas de finish(). Les morceaux pleins sont écrits ; le dernier aussi après flush.
    const rec = await store.takesToRecover();
    expect(rec).toHaveLength(1);
    expect(rec[0].seconds).toBeCloseTo(12.3, 1);
    expect(rec[0].meta.chunks).toBeGreaterThanOrEqual(12);
  });

  it('sans flush final (onglet tué) : on perd au plus le dernier morceau (< 1 s)', async () => {
    const db = memoryBackend();
    const store = new RecoveryStore(db, clockAt(HOUR));
    const j = store.beginTake({ takeId: 't2', projectId: 'p', trackId: 'voix', trackName: 'VOIX', sampleRate: 44100, recordedAt: 0, latency: 0 });
    const total = Math.round(9.7 * 44100);
    for (let s = 0; s < total; s += 16384) j.push(tone(Math.min(16384, total - s)));
    // on laisse les écritures déjà parties se terminer, sans flush (plantage)
    await new Promise(r => setTimeout(r, 10));
    const [t] = await store.takesToRecover();
    expect(9.7 - t.seconds).toBeLessThan(1.0);
    expect(t.seconds).toBeGreaterThan(8.6);
  });

  it('prise terminée puis incluse dans une version : ses morceaux sont effacés, rien à récupérer', async () => {
    const db = memoryBackend();
    const clock = clockAt(HOUR);
    const store = new RecoveryStore(db, clock);
    const j = store.beginTake({ takeId: 't3', projectId: 'proj-1', trackId: 'voix', trackName: 'VOIX', sampleRate: 44100, recordedAt: 0, latency: 0 });
    j.push(tone(50000));
    clock.add(5000);
    await j.finish();
    clock.add(1000);
    await store.saveVersion(snapInput(makeState([makeTrack({ clips: [makeClip({ bufferId: 'rec-1' })] })]), 'take'));
    expect(await store.takesToRecover()).toHaveLength(0);
    expect(await db.keys(TAKES)).toHaveLength(0);
    expect(await db.keys(TAKE_CHUNKS)).toHaveLength(0);
  });

  it('prise terminée mais plantage AVANT la version suivante : elle est récupérée', async () => {
    const db = memoryBackend();
    const clock = clockAt(HOUR);
    const store = new RecoveryStore(db, clock);
    await store.saveVersion(snapInput(makeState([makeTrack()])));
    clock.add(2000);
    const j = store.beginTake({ takeId: 't4', projectId: 'proj-1', trackId: 'voix', trackName: 'VOIX', sampleRate: 44100, recordedAt: 4, latency: 0 });
    j.push(tone(44100 * 3));
    clock.add(3000);
    await j.finish();
    const rec = await store.takesToRecover();
    expect(rec.map(r => r.meta.takeId)).toEqual(['t4']);
  });

  it('prises récupérées posées sur leur piste (ou une nouvelle piste), à leur position moins la latence', () => {
    const st = makeState([makeTrack({ id: 'voix', name: 'VOIX', clips: [makeClip({ id: 'old' })] })]);
    const mk = (trackId: string, sec: number) => ({ meta: { takeId: 'x' + trackId, projectId: 'p', trackId, trackName: 'Lead', sampleRate: 44100, recordedAt: 10, latency: 0.025, startedAt: Date.UTC(2026, 9, 8, 14, 5), endedAt: null, samples: sec * 44100, chunks: 3 }, samples: new Float32Array(sec * 44100), seconds: sec });
    const { state, report } = addRecoveredTakes(st, [{ take: mk('voix', 12), bufferId: 'rb1' }, { take: mk('disparue', 4), bufferId: 'rb2' }]);
    const voix = state.tracks.find(t => t.id === 'voix')!;
    expect(voix.clips).toHaveLength(2);
    expect(voix.clips[1]).toMatchObject({ bufferId: 'rb1', duration: 12 });
    expect(voix.clips[1].start).toBeCloseTo(9.975, 6);
    const nouvelle = state.tracks.find(t => t.id === 'disparue')!;
    expect(nouvelle.type).toBe(TrackType.AUDIO);
    expect(report.join(' ; ')).toMatch(/12,0 s récupérée sur « VOIX »/);
  });
});

describe('Session ouverte / fermée (détection du plantage)', () => {
  it('drapeau resté posé = séance coupée ; fermeture normale = rien', () => {
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
    try {
      markSessionOpen('proj-9', true);
      expect(previousSessionCrashed()).toMatchObject({ projectId: 'proj-9', recording: true });
      markSessionClosed();
      expect(previousSessionCrashed()).toBeNull();
    } finally { delete (globalThis as any).localStorage; }
  });
});

describe('Stockage', () => {
  it('versions durables et triées de la plus récente à la plus ancienne', async () => {
    const db = memoryBackend();
    const clock = clockAt(HOUR);
    const store = new RecoveryStore(db, clock);
    for (let i = 0; i < 3; i++) { clock.add(1000); await store.saveVersion(snapInput(makeState([makeTrack()]))); }
    const v = await store.listVersions();
    expect(v.map(x => x.savedAt)).toEqual([...v.map(x => x.savedAt)].sort((a, b) => b - a));
    expect((await db.keys(VERSIONS))).toHaveLength(3);
  });
});
