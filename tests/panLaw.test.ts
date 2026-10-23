/**
 * Loi de pan pro et double pan des pistes stéréo (22/10/2026) : module pur utils/panLaw,
 * conversion des anciens projets, voies « Pan G » / « Pan D », collaboration, scènes, réparation,
 * DAWproject, liens G / D. Les mesures sur le son rendu sont dans tests/metrologieConsole.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  bufferIsStereo, convertPanLane, DEFAULT_PAN_LAW, isStereoTrack, lanesForFormat, legacyPanToStereo, monoMatrix, PAN_L, PAN_LAWS, PAN_R,
  panGains, panShort, parsePanText, sanitizePanLaw, stereoMatrix, stereoPanOf, stereoToLegacyPan, withStereoPan,
} from '../utils/panLaw';
import { interpolateCurve, paramSpec, playedLanes, staticParamValue, withStaticParamValue, laneDisplayName } from '../utils/automationWrite';
import { applyPanStereo, mixFieldsOf, panStereoOf } from '../utils/collabMerge';
import { applyScene, captureScene } from '../utils/mixSnapshots';
import { repairProject } from '../utils/projectRepair';
import { cuePanPositions } from '../utils/cueMix';
import { sanitizeSongField, SONG_FIELDS } from '../utils/collabContent';
import { linkedPan } from '../components/DualPan';
import { makeTrack } from './helpers/fixtures';
import { TrackType, type AutomationLane } from '../types';

const dB = (x: number) => 20 * Math.log10(x);

describe('loi de pan (pistes mono)', () => {
  it('−3 dB par défaut : sin / cos, centre −3,01 dB, bords 0 dB / rien, puissance constante sur toute la course', () => {
    expect(DEFAULT_PAN_LAW).toBe(-3);
    const [l, r] = panGains(0);
    expect(dB(l)).toBeCloseTo(-3.0103, 4);
    expect(dB(r)).toBeCloseTo(-3.0103, 4);
    expect(panGains(-1)).toEqual([1, 0]);
    expect(panGains(1)).toEqual([0, 1]);
    for (let p = -1; p <= 1.0001; p += 0.01) {
      const [a, b] = panGains(p);
      expect(10 * Math.log10(a * a + b * b)).toBeCloseTo(0, 6);
    }
  });
  it('−4,5 / −6 / 0 dB : centres exacts, bords à 0 dB ; −6 dB = somme d’amplitude constante', () => {
    expect(dB(panGains(0, -4.5)[0])).toBeCloseTo(-4.5154, 4);
    expect(dB(panGains(0, -6)[0])).toBeCloseTo(-6.0206, 4);
    expect(panGains(0, 0)).toEqual([1, 1]);
    for (const law of [-4.5, -6, 0] as const) { expect(panGains(-1, law)).toEqual([1, 0]); expect(panGains(1, law)).toEqual([0, 1]); }
    for (let p = -1; p <= 1.0001; p += 0.05) { const [a, b] = panGains(p, -6); expect(a + b).toBeCloseTo(1, 9); }
    // 0 dB (balance) : le côté visé reste à 0 dB, l'autre baisse.
    expect(panGains(-0.5, 0)).toEqual([1, 0.5]);
  });
  it('matrice d’une piste mono : sur une source mono (G = D), sortie = loi exacte ; image stéréo gardée au centre', () => {
    for (const law of [-3, -4.5, -6, 0] as const) for (let p = -1; p <= 1.0001; p += 0.125) {
      const m = monoMatrix(p, law);
      const [gl, gr] = panGains(p, law);
      expect(m.ll + m.rl).toBeCloseTo(gl, 12);
      expect(m.lr + m.rr).toBeCloseTo(gr, 12);
    }
    const c = monoMatrix(0);
    expect([c.ll, c.rl, c.lr, c.rr].map(v => Math.round(v * 1e9) / 1e9)).toEqual([0.707106781, 0, 0, 0.707106781]);
  });
  it('réglage du projet : 4 lois proposées, valeurs inconnues ramenées à −3 dB', () => {
    expect(PAN_LAWS.map(x => x.law)).toEqual([-3, -4.5, -6, 0]);
    expect(sanitizePanLaw(-4.5)).toBe(-4.5);
    expect(sanitizePanLaw('x')).toBe(-3);
    expect(sanitizePanLaw(undefined)).toBe(-3);
    expect(SONG_FIELDS).toContain('panLaw');
    expect(sanitizeSongField('panLaw', -6)).toBe(-6);
    expect(sanitizeSongField('panLaw', -5)).toBeUndefined();
  });
});

describe('double pan des pistes stéréo', () => {
  it('défaut G 100 / D 100 : matrice identité exacte ; les deux au centre = mono à la loi', () => {
    expect(stereoMatrix(-1, 1)).toEqual({ ll: 1, rl: 0, lr: 0, rr: 1 });
    const m = stereoMatrix(0, 0);
    expect(m.ll).toBeCloseTo(Math.SQRT1_2, 12); expect(m.rl).toBeCloseTo(Math.SQRT1_2, 12);
    expect(stereoMatrix(1, -1)).toEqual({ ll: 0, rl: 1, lr: 1, rr: 0 }); // canaux inversés
  });
  it('ancien pan unique → G / D (règle de conversion) et retour exact', () => {
    expect(legacyPanToStereo(0)).toEqual({ l: -1, r: 1 });
    expect(legacyPanToStereo(-0.5)).toEqual({ l: -1, r: 0 });
    expect(legacyPanToStereo(0.25)).toEqual({ l: -0.5, r: 1 });
    expect(legacyPanToStereo(-1)).toEqual({ l: -1, r: -1 });
    for (const b of [-1, -0.7, -0.3, 0, 0.2, 0.9, 1]) { const s = legacyPanToStereo(b); expect(stereoToLegacyPan(s.l, s.r)).toBeCloseTo(b, 12); }
    // Même matrice que l'ancienne balance (loi −3 dB) : canal droit replié à gauche de cos((b+1)π/2).
    for (const b of [-0.8, -0.4, 0.3, 0.6]) {
      const s = legacyPanToStereo(b), m = stereoMatrix(s.l, s.r);
      const x = b <= 0 ? b + 1 : b, c = Math.cos(x * Math.PI / 2), sn = Math.sin(x * Math.PI / 2);
      if (b <= 0) { expect(m.ll).toBe(1); expect(m.lr).toBe(0); expect(m.rl).toBeCloseTo(c, 12); expect(m.rr).toBeCloseTo(sn, 12); }
      else { expect(m.rr).toBe(1); expect(m.rl).toBe(0); expect(m.ll).toBeCloseTo(c, 12); expect(m.lr).toBeCloseTo(sn, 12); }
    }
  });
  it('G / D écrits gardés tant que le pan unique n’a pas changé ailleurs (ancienne version, surface, mix auto)', () => {
    const t = withStereoPan(makeTrack({ id: 's' }), -0.2, 0.6);
    expect(stereoPanOf(t)).toEqual({ l: -0.2, r: 0.6 });
    expect(t.pan).toBeCloseTo(0.2, 12);
    const moved = { ...t, pan: -0.5 };
    expect(stereoPanOf(moved)).toEqual({ l: -1, r: 0 });
  });
  it('format : choix à la main, sinon d’après le son (instrument / bus = stéréo, prise mono ou double mono = mono)', () => {
    const buf = (a: number[], b?: number[]) => ({ numberOfChannels: b ? 2 : 1, length: a.length, getChannelData: (c: number) => Float32Array.from(c ? b! : a) });
    expect(isStereoTrack(makeTrack({ type: TrackType.MIDI }))).toBe(true);
    expect(isStereoTrack(makeTrack({ type: TrackType.BUS }))).toBe(true);
    expect(isStereoTrack(makeTrack({ type: TrackType.AUDIO }))).toBe(false);
    expect(isStereoTrack(makeTrack({ recordInput: { ch: 0, stereo: true } }))).toBe(true);
    expect(bufferIsStereo(buf([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]))).toBe(false);
    expect(bufferIsStereo(buf([0.1, 0.2, 0.3], [0.1, -0.2, 0.3]))).toBe(true);
    expect(isStereoTrack(makeTrack({ clips: [{ id: 'c', buffer: buf([0, 0.5], [0, -0.5]) } as any] }))).toBe(true);
    expect(isStereoTrack(makeTrack({ type: TrackType.MIDI, panFormat: 'mono' }))).toBe(false);
    expect(isStereoTrack(makeTrack({ panFormat: 'stereo' }))).toBe(true);
  });
  it('saisie « 100G », « 30D », « C », « G 20 », « R15 », « -40 » et affichage court', () => {
    expect(parsePanText('100G')).toBe(-1);
    expect(parsePanText('30D')).toBeCloseTo(0.3, 12);
    expect(parsePanText('C')).toBe(0);
    expect(parsePanText('G 20')).toBeCloseTo(-0.2, 12);
    expect(parsePanText('R15')).toBeCloseTo(0.15, 12);
    expect(parsePanText('-40')).toBeCloseTo(-0.4, 12);
    expect(parsePanText('250D')).toBe(1);
    expect(parsePanText('abc')).toBeNull();
    expect([panShort(-1), panShort(0), panShort(0.3)]).toEqual(['100G', 'C', '30D']);
  });
  it('lien G / D : même sens (écart gardé, borné) et miroir (symétrique)', () => {
    expect(linkedPan(-1, 1, 'l', -0.5)).toEqual({ l: -0.5, r: 1 });
    expect(linkedPan(-0.5, 0.5, 'l', -0.2, 'same')).toEqual({ l: -0.2, r: 0.8 });
    expect(linkedPan(-0.5, 0.5, 'l', 0.2, 'same')).toEqual({ l: 0, r: 1 }); // borné : D en butée
    const m = linkedPan(-1, 1, 'l', -0.4, 'mirror');
    expect(m.l).toBeCloseTo(-0.4, 12); expect(m.r).toBeCloseTo(0.4, 12);
    const m2 = linkedPan(-1, 1, 'r', 0.5, 'mirror');
    expect(m2.l).toBeCloseTo(-0.5, 12); expect(m2.r).toBeCloseTo(0.5, 12);
  });
});

describe('automation « Pan G » / « Pan D »', () => {
  const lane = (points: [number, number, string?][]): AutomationLane => ({ id: 'p', parameterName: 'pan', color: '#fff', isExpanded: true, min: -1, max: 1,
    points: points.map(([time, value, c], i) => ({ id: `x${i}`, time, value, ...(c ? { curveType: c as any } : {}) })) });
  const valueAt = (l: AutomationLane, t: number) => {
    const p = [...l.points].sort((a, b) => a.time - b.time);
    if (t <= p[0].time) return p[0].value;
    for (let i = 0; i < p.length - 1; i++) if (t <= p[i + 1].time) return interpolateCurve(p[i].value, p[i + 1].value, (t - p[i].time) / (p[i + 1].time - p[i].time), p[i].curveType || 'LINEAR');
    return p[p.length - 1].value;
  };
  it('ancienne voie convertie : à chaque instant G / D = conversion de l’ancien pan (linéaire exact, courbes à 0,2 % près)', () => {
    for (const curve of [undefined, 'S_CURVE', 'EXPONENTIAL', 'HOLD']) {
      const old = lane([[0, -0.8, curve], [1, 0.6, curve], [2, -0.2]]);
      const { l, r } = convertPanLane(old, interpolateCurve);
      expect(l.parameterName).toBe(PAN_L); expect(r.parameterName).toBe(PAN_R);
      for (let t = 0; t <= 2; t += 0.01) {
        const want = legacyPanToStereo(valueAt(old, t));
        const tol = curve && curve !== 'HOLD' ? 0.01 : 1e-9;
        if (curve === 'HOLD' && Math.abs(t - Math.round(t)) < 1e-9) continue;
        expect(Math.abs(valueAt(l, t) - want.l)).toBeLessThanOrEqual(tol);
        expect(Math.abs(valueAt(r, t) - want.r)).toBeLessThanOrEqual(tol);
      }
    }
  });
  it('voies jouées selon le format : stéréo = G / D (ancienne voie convertie), mono = « pan »', () => {
    const old = lane([[0, -0.5], [1, 0.5]]);
    const stereo = makeTrack({ type: TrackType.BUS, automationLanes: [old] });
    expect(playedLanes(stereo).map(l => l.parameterName)).toEqual([PAN_L, PAN_R]);
    const mono = makeTrack({ automationLanes: [old, { ...old, id: 'g', parameterName: PAN_L }] });
    expect(playedLanes(mono).map(l => l.parameterName)).toEqual(['pan']);
    // Mémorisé par tableau de voies : la lecture ne reconvertit pas à chaque image.
    const lanes = [old];
    expect(lanesForFormat(lanes, true, interpolateCurve)).toBe(lanesForFormat(lanes, true, interpolateCurve));
  });
  it('course, valeur fixe, écriture et nom des voies G / D', () => {
    expect(paramSpec(PAN_L)).toEqual({ min: -1, max: 1, kind: 'pan' });
    const t = withStereoPan(makeTrack({ type: TrackType.BUS }), -0.3, 0.7);
    expect(staticParamValue(t, PAN_L)).toBeCloseTo(-0.3, 12);
    expect(staticParamValue(t, PAN_R)).toBeCloseTo(0.7, 12);
    const t2 = withStaticParamValue(t, PAN_R, 0.1);
    expect(stereoPanOf(t2)).toEqual({ l: -0.3, r: 0.1 });
    expect(laneDisplayName(PAN_L)).toBe('Pan G');
    expect(laneDisplayName(PAN_R)).toBe('Pan D');
  });
});

describe('anciens projets, collaboration, scènes, casque', () => {
  it('collaboration : le double pan voyage dans les champs de mix (vérifié à l’arrivée) ; une ancienne version garde le pan unique', () => {
    const t = { ...withStereoPan(makeTrack({ id: 's', type: TrackType.BUS }), -0.5, 0.5), panLink: 'mirror' as const };
    const f = mixFieldsOf(t);
    expect(f.panStereo).toEqual({ sp: { l: -0.5, r: 0.5, at: 0 }, link: 'mirror' });
    expect(f.pan).toBe(0);
    const other = makeTrack({ id: 's', type: TrackType.BUS });
    applyPanStereo(other, { sp: { l: -9, r: 0.5, at: 0 }, link: 'x', format: 'stereo' });
    expect(other.stereoPan).toEqual({ l: -1, r: 0.5, at: 0 });
    expect(other.panLink).toBeUndefined();
    expect(other.panFormat).toBe('stereo');
    applyPanStereo(other, null);
    expect(other.stereoPan).toBeUndefined();
    expect(panStereoOf(makeTrack())).toBeNull();
  });
  it('scènes : G / D capturés et rappelés ; une scène d’avant (sans G / D) rend le pan unique', () => {
    const t = withStereoPan(makeTrack({ id: 's', type: TrackType.BUS }), -0.2, 0.4);
    const scene = captureScene([t], 1 as any);
    const reset = { ...t, pan: 0, stereoPan: undefined };
    const back = applyScene([reset], scene, ['pans']).tracks[0];
    expect(stereoPanOf(back)).toEqual({ l: -0.2, r: 0.4 });
    const oldScene = { ...scene, tracks: { s: { ...scene.tracks.s, stereoPan: undefined, pan: -0.5 } } };
    expect(stereoPanOf(applyScene([t], oldScene as any, ['pans']).tracks[0])).toEqual({ l: -1, r: 0 });
  });
  it('réparation : loi illisible → −3 dB ; G / D illisibles retirés, bornés sinon', () => {
    const raw = { name: 'x', bpm: 120, panLaw: 7, tracks: [
      { id: 'a', name: 'A', type: 'BUS', volume: 1, pan: 0, stereoPan: { l: -3, r: 0.5, at: 0 }, panLink: 'zz', clips: [], plugins: [], sends: [], automationLanes: [] },
      { id: 'b', name: 'B', type: 'BUS', volume: 1, pan: 0, stereoPan: { l: 'x' }, clips: [], plugins: [], sends: [], automationLanes: [] },
    ] };
    const r = repairProject(raw as any);
    const s: any = (r as any).state ?? raw;
    expect(s.panLaw).toBeUndefined();
    expect(s.tracks[0].stereoPan).toEqual({ l: -1, r: 0.5, at: 0 });
    expect(s.tracks[0].panLink).toBeUndefined();
    expect(s.tracks[1].stereoPan).toBeUndefined();
  });
  it('mix casque : piste stéréo = G / D du mix principal, ou pan propre au mix converti ; piste mono = son pan', () => {
    const t = withStereoPan(makeTrack({ id: 's', type: TrackType.BUS }), -0.4, 0.2);
    expect(cuePanPositions({ levels: {} }, t, true)).toEqual([-0.4, 0.2]);
    expect(cuePanPositions({ levels: { s: { level: 1, pan: -0.5 } } }, t, true)).toEqual([-1, 0]);
    expect(cuePanPositions({ levels: {} }, { ...t, pan: 0.3 }, false)).toEqual([0.3, 1]);
  });
});

describe('écriture d’automation depuis les boutons G / D', () => {
  it('piste stéréo en Touch : bouger G écrit la voie « Pan G » (pas « pan ») ; piste mono : « pan »', async () => {
    const { AutomationRecorder } = await import('../services/AutomationManager');
    const base = makeTrack({ id: 's', type: TrackType.BUS, automationMode: 'touch' });
    let tracks = [base];
    const overrides: [string, number | null][] = [];
    const rec = new AutomationRecorder();
    rec.configure({
      getTracks: () => tracks, getTime: () => 1, isPlaying: () => true,
      setOverride: (_t, p, v) => { overrides.push([p, v]); }, beginUndoStep: () => {}, commit: () => {},
      setTrackMode: () => {}, wallClock: () => 0,
    });
    rec.onPlay();
    const moved = withStereoPan(base, -0.3, 1);
    expect(rec.captureTrackUpdate(base, moved)).toBe(true);
    expect([...new Set(overrides.map(o => o[0]))]).toEqual([PAN_L]);
    tracks = [makeTrack({ id: 'm', automationMode: 'touch' })];
    overrides.length = 0;
    expect(rec.captureTrackUpdate(tracks[0], { ...tracks[0], pan: 0.4 })).toBe(true);
    expect([...new Set(overrides.map(o => o[0]))]).toEqual(['pan']);
  });
});
