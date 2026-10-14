import { describe, expect, it } from 'vitest';
import { applyOneKnob, ONE_KNOB_MACROS, resetOneKnob, knobAmount, knobMacro, selectKnobMacro, knobText } from '../utils/oneKnob';
import { applyVoicePreset, findVoicePreset, EQ_BAND } from '../utils/voicePresets';
import { TrackType, type Track } from '../types';

const blank = (over: Partial<Track> = {}): Track => ({
  id: 'v1', name: 'Voix lead', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...over,
} as Track);
const returns = ['send-delay', 'send-verb-short', 'send-verb-long'];
const withPreset = (id = 'trap-lead') => applyVoicePreset(blank(), findVoicePreset(id)!, { allTracks: returns.map(r => blank({ id: r, type: TrackType.SEND })), inputLufs: -20 }).track;
const pl = (t: Track, type: string) => t.plugins.find(p => p.type === type)!;
const strip = (t: Track) => JSON.parse(JSON.stringify({ plugins: t.plugins.map(p => ({ type: p.type, params: p.params })), sends: t.sends }));

describe('One Knob (lot 8c)', () => {
  it('8 macros nommées en français, chacune avec son aide', () => {
    expect(ONE_KNOB_MACROS.map(m => m.name)).toEqual(['Présence', 'Chaleur', 'Brillance', 'Compression', 'Espace', 'Autotune', 'Largeur', 'Saturation']);
    for (const m of ONE_KNOB_MACROS) expect(m.hint.length).toBeGreaterThan(20);
  });

  it('réversible : chaque macro ramenée à 0 % rend exactement la chaîne d’avant', () => {
    const t0 = withPreset();
    for (const m of ONE_KNOB_MACROS) {
      const up = applyOneKnob(t0, m.id, 0.8, { returns }).track;
      expect(strip(up), `${m.id} à 80 % change quelque chose`).not.toEqual(strip(t0));
      const back = applyOneKnob(up, m.id, 0, { returns }).track;
      expect(strip(back), m.id).toEqual(strip(t0));
    }
    // Toutes ensemble puis remise à zéro
    let t = t0;
    for (const m of ONE_KNOB_MACROS) t = applyOneKnob(t, m.id, 0.7, { returns }).track;
    expect(strip(resetOneKnob(t, { returns }))).toEqual(strip(t0));
  });

  it('courbe Présence : +5 dB à 3,5 kHz et −3 dB de boue à 100 %, réverbes réduites', () => {
    const t0 = withPreset();
    const base = pl(t0, 'PROEQ12').params.bands;
    const t1 = applyOneKnob(t0, 'presence', 1, { returns }).track;
    const b = pl(t1, 'PROEQ12').params.bands;
    expect(b[EQ_BAND.presence].gain - base[EQ_BAND.presence].gain).toBeCloseTo(5, 3);
    expect(b[EQ_BAND.mud].gain - base[EQ_BAND.mud].gain).toBeCloseTo(-3, 3);
    expect(t1.sends.find(s => s.id === 'send-verb-short')!.level).toBeCloseTo(t0.sends.find(s => s.id === 'send-verb-short')!.level * 0.6, 3);
    // monotone
    let prev = -Infinity;
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      const g = pl(applyOneKnob(t0, 'presence', a, { returns }).track, 'PROEQ12').params.bands[EQ_BAND.presence].gain;
      expect(g).toBeGreaterThanOrEqual(prev); prev = g;
    }
  });

  it('Compression : à 100 % les marges calées au labo, jamais plus (règle 5 dB par étage)', () => {
    const p = findVoicePreset('trap-lead')!;
    const t0 = withPreset();
    const t1 = applyOneKnob(t0, 'compression', 1, { returns }).track;
    expect(pl(t1, 'COMPRESSOR').params.threshold).toBeCloseTo(pl(t0, 'COMPRESSOR').params.threshold - 2 * (4.8 - p.calib.gr1), 3);
    expect(pl(t0, 'OPTO_VINTAGE').params.threshold - pl(t1, 'OPTO_VINTAGE').params.threshold).toBeCloseTo(p.calib.head2, 3);
    expect(pl(t1, 'OPTO_VINTAGE').params.ratio).toBe(2);
    expect(pl(t1, 'COMPRESSOR').params.ratio).toBe(2);
  });

  it('Espace : seulement des envois (aucun effet temporel en insert)', () => {
    const t0 = withPreset();
    const t1 = applyOneKnob(t0, 'espace', 1, { returns }).track;
    expect(t1.plugins.map(p => p.type)).toEqual(t0.plugins.map(p => p.type));
    expect(t1.sends.find(s => s.id === 'send-verb-short')!.level).toBeCloseTo(Math.min(1, t0.sends.find(s => s.id === 'send-verb-short')!.level + 0.25), 3);
    // sur une piste sans envoi : créés vers les retours du projet seulement
    const nu = applyOneKnob(blank(), 'espace', 0.4, { returns: ['send-verb-short'] }).track;
    expect(nu.sends.map(s => s.id)).toEqual(['send-verb-short']);
  });

  it('Autotune : ajouté s’il manque (correction douce), 100 % = robot, retiré à 0 %', () => {
    const t0 = withPreset('conscient-lead');
    expect(t0.plugins.some(p => p.type === 'AUTOTUNE')).toBe(false);
    const a = applyOneKnob(t0, 'autotune', 0.2, { returns, projectKey: 9, projectScale: 'MINOR' });
    const at = pl(a.track, 'AUTOTUNE');
    expect(a.added.length).toBe(1);
    expect(at.params.speed).toBeCloseTo(0.45 * 0.8, 3);
    expect(at.params.rootKey).toBe(9);
    expect(a.track.plugins.findIndex(p => p.type === 'AUTOTUNE')).toBeLessThan(a.track.plugins.findIndex(p => p.type === 'PROEQ12'));
    expect(pl(applyOneKnob(a.track, 'autotune', 1, { returns }).track, 'AUTOTUNE').params.speed).toBe(0);
    const off = applyOneKnob(a.track, 'autotune', 0, { returns });
    expect(off.track.plugins.some(p => p.type === 'AUTOTUNE')).toBe(false);
    expect(off.removed.length).toBe(1);
  });

  it('Largeur, Saturation, Chaleur sur une piste sans effet : effets ajoutés à leur place', () => {
    let t = applyOneKnob(blank(), 'largeur', 0.5).track;
    t = applyOneKnob(t, 'saturation', 0.5).track;
    t = applyOneKnob(t, 'chaleur', 0.5).track;
    const types = t.plugins.map(p => p.type);
    expect(types).toContain('DOUBLER'); expect(types).toContain('VOCALSATURATOR'); expect(types).toContain('PROEQ12');
    expect(types.indexOf('PROEQ12')).toBeLessThan(types.indexOf('VOCALSATURATOR'));
    expect(types.indexOf('VOCALSATURATOR')).toBeLessThan(types.indexOf('DOUBLER'));
    expect(pl(t, 'VOCALSATURATOR').params.mix).toBeCloseTo(0.25 + 0.125, 3);
    const z = resetOneKnob(t);
    expect(z.plugins).toEqual([]);
  });

  it('une retouche à la main devient le nouveau départ de la macro', () => {
    const t0 = withPreset();
    const t1 = applyOneKnob(t0, 'brillance', 0.5, { returns }).track;
    // l'artiste remonte lui-même l'air dans la fenêtre de l'égaliseur
    const eq = pl(t1, 'PROEQ12');
    const edited: Track = { ...t1, plugins: t1.plugins.map(p => p.id === eq.id ? { ...p, params: { ...p.params, bands: p.params.bands.map((b: any, i: number) => i === EQ_BAND.air ? { ...b, gain: 6 } : b) } } : p) };
    const t2 = applyOneKnob(edited, 'brillance', 0.5, { returns }).track;
    expect(pl(t2, 'PROEQ12').params.bands[EQ_BAND.air].gain).toBeCloseTo(6 + 1.5, 3);
  });

  it('macro affichée, position, texte', () => {
    const t = applyOneKnob(withPreset(), 'saturation', 0.42).track;
    expect(knobMacro(t)).toBe('saturation');
    expect(knobAmount(t, 'saturation')).toBeCloseTo(0.42);
    expect(knobMacro(selectKnobMacro(t, 'espace'))).toBe('espace');
    expect(knobText('saturation', 0.42)).toBe('Saturation 42 %');
    expect(knobMacro(blank())).toBe('presence');
  });
});
