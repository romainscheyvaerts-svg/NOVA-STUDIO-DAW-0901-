import { describe, expect, it } from 'vitest';
import {
  busKeyRef, guessKeySource, keyRoutes, keySourceLabel, keySourceOptions, keySourceTrackIds, latencyBefore, parseKeyRef, pdcKeysFor,
  resolveKeySource, setPluginKeySource, sidechainLoop, SIDECHAIN_PRESETS, sidechainPresetsFor, supportsSidechain, keyFilterOf,
} from '../engine/sidechain';
import { computePdc, PdcNode } from '../utils/pdc';
import { createNoiseGateCore } from '../engine/noiseGateCore';
import { createGateCore } from '../engine/gateCore';
import { gateToCore } from '../engine/v21Nodes';
import { DEFAULT_GATEFX, gatePattern, V21_SPECS, V21_PRESETS, V21_DEFAULTS } from '../engine/v21Params';
import { getRegisteredPlugin } from '../engine/pluginRegistry';
import { sanitizePlugin } from '../utils/sessionTemplate';
import { applyTrackPreset, makeTrackPreset } from '../utils/presets';
import { applyMixFields, mixFieldsOf } from '../utils/collabMerge';
import { createBus, setTrackOutput } from '../utils/trackStructure';
import type { PluginInstance, Track } from '../types';
import { TrackType } from '../types';

const comp = (id: string, extra: Partial<PluginInstance> = {}): PluginInstance => ({ id, name: 'Compresseur', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: {}, ...extra });
const tr = (id: string, name: string, extra: Partial<Track> = {}): Track => ({
  id, name, type: TrackType.AUDIO, color: '#0ff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...extra,
} as Track);
const master = () => tr('master', 'Master', { type: TrackType.BUS, outputTrackId: '' });

describe('R7 · side-chain : sources et boucles de routage', () => {
  it('effets à clé : Compresseur, Gate, Gate rythmique, De-esser (pas le limiteur)', () => {
    for (const t of ['COMPRESSOR', 'GATE', 'GATEFX', 'DEESSER']) expect(supportsSidechain(t)).toBe(true);
    expect(supportsSidechain('LIMITER')).toBe(false);
    expect(supportsSidechain('REVERB')).toBe(false);
  });
  it('source = une piste, ou un bus nommé (somme des pistes qui y sortent, même sans aux)', () => {
    let tracks = [tr('kick', 'Kick'), tr('kick2', 'Kick layer'), tr('808', '808'), master()];
    const b = createBus(tracks, 'Clé kick');
    tracks = setTrackOutput(setTrackOutput(b.tracks, 'kick', { kind: 'bus', id: b.bus.id }), 'kick2', { kind: 'bus', id: b.bus.id });
    expect(keySourceTrackIds(tracks, 'kick')).toEqual(['kick']);
    expect(keySourceTrackIds(tracks, busKeyRef(b.bus.id)).sort()).toEqual(['kick', 'kick2']);
    expect(keySourceLabel(tracks, busKeyRef(b.bus.id))).toBe('Bus Clé kick');
    expect(parseKeyRef(busKeyRef('x'))).toEqual({ kind: 'bus', id: 'x' });
    const opts = keySourceOptions(tracks, '808');
    expect(opts.some(o => o.ref === '808')).toBe(false);
    expect(opts.some(o => o.ref === 'master')).toBe(false);
    expect(opts.some(o => o.kind === 'bus')).toBe(true);
    // Bus « clé » sans aux qui l'écoute : la clé marche, rien ne part dans le vide côté routage.
    tracks = tracks.map(t => (t.id === '808' ? { ...t, plugins: [comp('c1', { sidechainSourceId: busKeyRef(b.bus.id) })] } : t));
    expect(keyRoutes(tracks)).toEqual([{ targetTrackId: '808', pluginId: 'c1', sources: ['kick', 'kick2'], tap: 'pre', hpf: 20, lpf: 20000 }]);
  });
  it('« 808 sous le kick » : aucune boucle', () => {
    const tracks = [tr('kick', 'Kick'), tr('808', '808'), master()];
    expect(sidechainLoop(tracks, '808', 'kick')).toBeNull();
  });
  it('refuse une piste comme sa propre clé', () => {
    const l = sidechainLoop([tr('808', '808'), master()], '808', '808');
    expect(l?.message).toMatch(/propre clé/);
  });
  it('refuse une piste qui écoute le bus où elle arrive (sortie ou envoi)', () => {
    const viaOut = [tr('voix', 'Voix', { outputTrackId: 'busv' }), tr('busv', 'Bus voix', { type: TrackType.BUS }), master()];
    const l1 = sidechainLoop(viaOut, 'voix', 'busv');
    expect(l1?.message).toMatch(/Boucle de routage refusée/);
    expect(l1?.message).toContain('« Voix »');
    expect(l1?.path).toEqual(['voix', 'busv']);
    const viaSend = [tr('voix', 'Voix', { sends: [{ id: 'rev', level: 0.5, isEnabled: true }] }), tr('rev', 'Reverb', { type: TrackType.SEND }), master()];
    expect(sidechainLoop(viaSend, 'voix', 'rev')).not.toBeNull();
    // Bus nommé : la piste sort sur le bus que la clé écoute.
    let tracks = [tr('beat', 'Beat'), master()];
    const b = createBus(tracks, 'Mix');
    tracks = setTrackOutput(b.tracks, 'beat', { kind: 'bus', id: b.bus.id });
    expect(sidechainLoop(tracks, 'beat', busKeyRef(b.bus.id))?.message).toMatch(/propre clé|Boucle/);
  });
  it('refuse les chaînes de clés circulaires (A écoute B qui écoute A)', () => {
    const tracks = [tr('a', 'Pad', { plugins: [comp('ca', { sidechainSourceId: 'b' })] }), tr('b', 'Nappe'), master()];
    expect(sidechainLoop(tracks, 'b', 'a', 'cb')?.message).toMatch(/Boucle de routage refusée/);
    // A → bus (audio) et le bus écoute A en clé : boucle aussi (chemin mixte audio + clé).
    const t2 = [tr('a', 'A', { plugins: [comp('ca', { sidechainSourceId: 'c' })] }), tr('c', 'C'), tr('bus', 'Bus', { type: TrackType.BUS }), master()];
    const t3 = t2.map(t => (t.id === 'c' ? { ...t, outputTrackId: 'bus' } : t));
    expect(sidechainLoop(t3, 'c', 'a', 'cc')).not.toBeNull();
  });
  it('setPluginKeySource : pose la clé (avec son nom) ou renvoie le message de boucle', () => {
    const tracks = [tr('kick', 'Kick'), tr('808', '808', { plugins: [comp('c1')] }), tr('bus', 'Bus 808', { type: TrackType.BUS }), master()];
    const ok = setPluginKeySource(tracks, '808', 'c1', 'kick');
    expect('tracks' in ok).toBe(true);
    const p = (ok as any).tracks.find((t: Track) => t.id === '808').plugins[0];
    expect(p.sidechainSourceId).toBe('kick');
    expect(p.sidechainSourceName).toBe('Kick');
    const looped = tracks.map(t => (t.id === '808' ? { ...t, outputTrackId: 'bus' } : t));
    const bad = setPluginKeySource(looped, '808', 'c1', 'bus');
    expect('error' in bad && bad.error).toMatch(/Boucle/);
    const off = setPluginKeySource((ok as any).tracks, '808', 'c1', null);
    expect((off as any).tracks.find((t: Track) => t.id === '808').plugins[0].sidechainSourceId).toBeUndefined();
  });
  it('keyRoutes : effet en bypass, inactif, source absente ou boucle = pas de clé câblée', () => {
    const base = [tr('kick', 'Kick'), master()];
    const mk = (p: PluginInstance) => [...base, tr('808', '808', { plugins: [p] })];
    expect(keyRoutes(mk(comp('c', { sidechainSourceId: 'kick' }))).length).toBe(1);
    expect(keyRoutes(mk(comp('c', { sidechainSourceId: 'kick', isEnabled: false }))).length).toBe(0);
    expect(keyRoutes(mk(comp('c', { sidechainSourceId: 'kick', isInactive: true }))).length).toBe(0);
    expect(keyRoutes(mk(comp('c', { sidechainSourceId: 'disparu' }))).length).toBe(0);
    const r = keyRoutes(mk(comp('c', { sidechainSourceId: 'kick', sidechainTap: 'post', params: { keyHpf: 40, keyLpf: 200 } })))[0];
    expect(r).toMatchObject({ tap: 'post', hpf: 40, lpf: 200 });
    expect(keyFilterOf({ keyHpf: 5, keyLpf: 99999 })).toEqual({ hpf: 20, lpf: 20000, listen: false });
  });
});

describe('R7 · side-chain : la clé passe par la PDC (alignée en lecture et à l’export)', () => {
  /** Instant réel (relatif) où la clé du kick et le son de la 808 arrivent à l'effet, pour une note du morceau à 0. */
  const arrivals = (Lk: number, pre808: number, post808: number, opts: { busLat?: number } = {}) => {
    const nodes = new Map<string, PdcNode>();
    nodes.set('kick', { latency: Lk, outputs: ['master'], keys: [{ id: 'c', target: '808', offset: pre808 }] });
    nodes.set('808', { latency: pre808 + post808, outputs: [opts.busLat !== undefined ? 'bus' : 'master'] });
    if (opts.busLat !== undefined) nodes.set('bus', { latency: opts.busLat, outputs: ['master'] });
    const r = computePdc(nodes);
    const kick = r.get('kick')!, b808 = r.get('808')!;
    // Clips : partent P plus tôt. Sortie de chaîne du kick à −down ; clé retardée de keyDelay.
    const keyAt = -kick.down + kick.keyDelays.get('c')!;
    // Entrée du compresseur : −P(808) + latence des effets avant lui.
    const compAt = -b808.total + pre808;
    // Sortie au master : le kick et la 808 restent alignés (même instant pour la même note).
    const kickMaster = -kick.total + Lk + kick.delays.get('master')!;
    const m808 = -b808.total + pre808 + post808 + (b808.delays.get(opts.busLat !== undefined ? 'bus' : 'master') || 0) + (opts.busLat !== undefined ? -0 : 0);
    return { keyAt, compAt, kick, b808, kickMaster, m808, r };
  };
  it('sans latence : clé et son arrivent ensemble, aucun retard', () => {
    const a = arrivals(0, 0, 0);
    expect(a.keyAt).toBeCloseTo(a.compAt, 12);
    expect(a.kick.keyDelays.get('c')).toBe(0);
  });
  it('limiteur sur le kick (latence en amont de la clé)', () => {
    const a = arrivals(0.0053, 0, 0);
    expect(a.keyAt).toBeCloseTo(a.compAt, 12);
  });
  it('limiteur AVANT le compresseur sur la 808', () => {
    const a = arrivals(0, 0.0053, 0);
    expect(a.keyAt).toBeCloseTo(a.compAt, 12);
    expect(a.kick.keyDelays.get('c')).toBeCloseTo(0, 12);
  });
  it('limiteur APRÈS le compresseur sur la 808 : le kick part plus tôt, ses sorties restent alignées', () => {
    const a = arrivals(0, 0, 0.0053);
    expect(a.keyAt).toBeCloseTo(a.compAt, 12);
    expect(a.kick.total).toBeCloseTo(0.0053, 12);
    expect(a.kickMaster).toBeCloseTo(0, 12);
    expect(a.m808).toBeCloseTo(0, 12);
  });
  it('808 sur un bus latent + kick latent', () => {
    const a = arrivals(0.003, 0.002, 0.004, { busLat: 0.01 });
    expect(a.keyAt).toBeCloseTo(a.compAt, 12);
    for (const [, v] of a.r) for (const [, d] of v.keyDelays) expect(d).toBeGreaterThanOrEqual(0);
  });
  it('pdcKeysFor / latencyBefore : offset = latence des effets avant l’effet à clé', () => {
    const lat: Record<string, number> = { lim: 0.005, comp: 0, rev: 0.02 };
    expect(latencyBefore(['lim', 'comp', 'rev'], 'comp', id => lat[id])).toBeCloseTo(0.005, 12);
    expect(latencyBefore(['comp', 'lim'], 'comp', id => lat[id])).toBe(0);
    const routes = [{ targetTrackId: '808', pluginId: 'comp', sources: ['kick', 'k2'], tap: 'pre' as const, hpf: 20, lpf: 20000 }];
    expect(pdcKeysFor(routes, 'k2', () => 0.005)).toEqual([{ id: 'comp', target: '808', offset: 0.005 }]);
    expect(pdcKeysFor(routes, '808', () => 0)).toEqual([]);
  });
});

describe('R7 · préréglages trap, presets de chaîne, modèles et collaboration', () => {
  it('trois préréglages trap du compresseur + un pour le Gate', () => {
    const names = sidechainPresetsFor('COMPRESSOR').map(p => p.name);
    expect(names).toEqual(['808 sous le kick', 'Voix qui creuse le beat', 'Pompe']);
    expect(sidechainPresetsFor('GATE').length).toBe(1);
    // « Voix qui creuse le beat » : jamais plus de ~3 dB (compression parallèle à 30 %).
    const v = SIDECHAIN_PRESETS.find(p => p.id === 'voix-creuse-beat')!;
    expect(20 * Math.log10(1 - (v.params.mix as number))).toBeGreaterThan(-3.2);
  });
  it('la clé est devinée d’après le nom des pistes', () => {
    const tracks = [tr('t1', 'Lead voix'), tr('t2', 'KICK 808 trap'), tr('t3', 'Beat'), master()];
    expect(guessKeySource(tracks, 't3', SIDECHAIN_PRESETS[0])).toBe('t2');
    expect(guessKeySource(tracks, 't3', SIDECHAIN_PRESETS[1])).toBe('t1');
    expect(guessKeySource([tr('a', 'Pad'), master()], 'b', SIDECHAIN_PRESETS[0])).toBeNull();
  });
  it('modèle de session : la clé est gardée (sanitizePlugin)', () => {
    const p = sanitizePlugin(comp('c', { sidechainSourceId: 'kick', sidechainSourceName: 'Kick', sidechainTap: 'post', params: { keyHpf: 40 } }));
    expect(p).toMatchObject({ sidechainSourceId: 'kick', sidechainSourceName: 'Kick', sidechainTap: 'post' });
    expect(p.params.keyHpf).toBe(40);
  });
  it('preset de chaîne : la clé est retrouvée par son nom dans une autre session, sinon signalée', () => {
    const src = [tr('kick-a', 'Kick'), tr('808', '808', { plugins: [comp('c1', { sidechainSourceId: 'kick-a', params: { threshold: -14 } })] }), master()];
    const preset = makeTrackPreset(src[1], src, '808 duck');
    expect(preset.plugins[0].sidechainSourceName).toBe('Kick');
    const other = [tr('k-autre', 'Kick'), tr('basse', 'Basse 808'), master()];
    const r = applyTrackPreset(other, 'basse', preset);
    expect(r.tracks.find(t => t.id === 'basse')!.plugins[0].sidechainSourceId).toBe('k-autre');
    const none = applyTrackPreset([tr('basse', 'Basse'), master()], 'basse', preset);
    expect(none.tracks.find(t => t.id === 'basse')!.plugins[0].sidechainSourceId).toBeUndefined();
    expect(none.report.messages.join(' ')).toMatch(/Clé de side-chain absente/);
    expect(resolveKeySource(other, 'kick-a', 'Kick', 'basse')).toBe('k-autre');
  });
  it('collaboration : la clé voyage avec l’effet', () => {
    const t = tr('808', '808', { plugins: [comp('c1', { sidechainSourceId: 'kick', sidechainSourceName: 'Kick', params: { keyLpf: 200 } })] });
    const fields = JSON.parse(JSON.stringify(mixFieldsOf(t)));
    const other = tr('808', '808', { plugins: [comp('c1')] });
    applyMixFields(other, fields, () => true);
    expect(other.plugins[0].sidechainSourceId).toBe('kick');
    expect(other.plugins[0].params.keyLpf).toBe(200);
  });
});

describe('R7 · cœurs à clé (Gate, Gate rythmique)', () => {
  const SR = 48000;
  const run = (core: any, x: Float32Array, key: Float32Array | null, listen = false) => {
    const y = new Float32Array(x.length);
    for (let s = 0; s < x.length; s += 128) {
      const n = Math.min(128, x.length - s);
      core.setKey?.(key ? key.subarray(s, s + n) : null, key ? key.subarray(s, s + n) : null, !!key, listen);
      core.process(x.subarray(s, s + n), x.subarray(s, s + n), y.subarray(s, s + n), null, n);
    }
    return y;
  };
  const ones = (sec: number) => new Float32Array(Math.round(sec * SR)).fill(0.5);
  const burst = (sec: number, a: number, z: number, amp = 0.8) => { const k = new Float32Array(Math.round(sec * SR)); for (let i = Math.round(a * SR); i < Math.round(z * SR); i++) k[i] = amp; return k; };
  it('Gate : fermé sans signal au-dessus du seuil, ouvert quand la CLÉ dépasse le seuil', () => {
    const c = createNoiseGateCore(SR);
    c.setParams({ threshold: -30, range: 80, attack: 0.1, hold: 0, release: 5 });
    const y = run(c, ones(0.6), burst(0.6, 0.2, 0.3));
    expect(Math.abs(y[Math.round(0.1 * SR)])).toBeLessThan(0.5 * 0.01);
    expect(y[Math.round(0.25 * SR)]).toBeCloseTo(0.5, 2);
    expect(Math.abs(y[Math.round(0.5 * SR)])).toBeLessThan(0.5 * 0.01);
  });
  it('Gate sans clé : détection sur le son (porte de bruit)', () => {
    const c = createNoiseGateCore(SR);
    c.setParams({ threshold: -20, range: 60, attack: 0.1, hold: 10, release: 5 });
    const x = burst(0.5, 0.1, 0.2, 0.5);
    for (let i = Math.round(0.3 * SR); i < Math.round(0.4 * SR); i++) x[i] = 0.01; // bruit de fond −40 dB
    const y = run(c, x, null);
    expect(y[Math.round(0.15 * SR)]).toBeCloseTo(0.5, 2);
    expect(Math.abs(y[Math.round(0.38 * SR)])).toBeLessThan(0.0001);
  });
  it('écoute de la clé : on entend la clé', () => {
    const c = createNoiseGateCore(SR);
    const key = burst(0.2, 0.05, 0.1, 0.3);
    const y = run(c, ones(0.2), key, true);
    expect(y[Math.round(0.07 * SR)]).toBeCloseTo(0.3, 6);
    expect(y[Math.round(0.15 * SR)]).toBe(0);
  });
  it('Gate rythmique avec clé : le motif est remplacé par la clé', () => {
    const c = createGateCore(SR);
    c.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([0]), depth: 1, attack: 0.2, release: 2, keyThreshold: -30, bpm: 120 }));
    c.setClock(0);
    const y = run(c, ones(0.6), burst(0.6, 0.2, 0.3));
    expect(Math.abs(y[Math.round(0.1 * SR)])).toBeLessThan(0.01);
    expect(y[Math.round(0.25 * SR)]).toBeCloseTo(0.5, 2);
    // Sans clé : le motif « tout fermé » reste fermé.
    const c2 = createGateCore(SR);
    c2.setParams(gateToCore({ ...DEFAULT_GATEFX, ...gatePattern([0]), depth: 1, attack: 0.2, release: 2, bpm: 120 }));
    c2.setClock(0);
    expect(Math.abs(run(c2, ones(0.6), null)[Math.round(0.25 * SR)])).toBeLessThan(0.01);
  });
  it('le Gate est un effet NOVA du registre, réglages bornés et préréglages valides', () => {
    const reg = getRegisteredPlugin('GATE')!;
    expect(reg.name).toBe('Gate');
    expect(reg.automatable!.map(a => a.id)).toEqual(['threshold', 'range', 'attack', 'hold', 'release']);
    for (const pr of V21_PRESETS.GATE) for (const [k, v] of Object.entries(pr.params)) {
      const s = V21_SPECS.GATE.find(x => x.id === k)!;
      expect(v as number).toBeGreaterThanOrEqual(s.min); expect(v as number).toBeLessThanOrEqual(s.max);
    }
    expect(V21_DEFAULTS.GATEFX().keyThreshold).toBe(-30);
  });
});
