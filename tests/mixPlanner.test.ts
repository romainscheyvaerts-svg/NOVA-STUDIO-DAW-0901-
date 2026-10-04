import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { classifyPlugin, paramRoles, supportsRatio, toSetting } from '../utils/vstKnowledge';
import { describeIntent, parseMixIntent, suggestStyles } from '../utils/mixStyles';
import { candidatesFor, eqBands, KnownPlugin, planVoiceMix, slotOfPlugin, SLOT_ORDER, estimateLoudDb } from '../utils/mixPlanner';
import { applyMixPlan } from '../utils/mixApply';
import { toVstParams, VstParam } from '../utils/autotuneVst';
import { DAWState, PluginInstance, TrackType } from '../types';
import { parseVstCommand } from '../utils/novaVstCommands';

/**
 * Mix piloté par Nova sur les plugins tiers : paramètres RÉELS lus par le pont sur le
 * PC du studio (tests/fixtures/vst-knowledge.sample.json, extrait de
 * data/vst-knowledge/plugins.json généré par introspection).
 */
const KB = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vst-knowledge.sample.json'), 'utf8')).plugins as any[];
const known = (re: RegExp): KnownPlugin => {
  const e = KB.find(x => re.test(x.name));
  if (!e) throw new Error(`fixture absente : ${re}`);
  return { key: e.key, name: e.name, vendor: e.vendor, path: e.path, pluginName: e.pluginName, category: e.category, compType: e.compType, params: toVstParams(e.params || []), latency: e.latency, unavailable: e.status === 'ok' ? null : 'non disponible' };
};
const INSTALLED: KnownPlugin[] = KB.map((e: any) => known(new RegExp(`^${e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)));

const plug = (type: string, extra: Partial<PluginInstance> = {}): PluginInstance => ({ id: `${type}-1`, name: type, type: type as any, isEnabled: true, params: {}, latency: 0, ...extra });

describe('styles combinables', () => {
  it('phrase libre → styles et intensités', () => {
    const it1 = parseMixIntent('je veux un mix spatial et saturé avec beaucoup de delay');
    expect(it1.styles.map(s => s.id).sort()).toEqual(['delais', 'sature', 'spatial']);
    expect(it1.styles.find(s => s.id === 'delais')!.intensity).toBe(1);
    expect(it1.dims.space!).toBeGreaterThan(0.5);
    expect(it1.dims.saturation!).toBeGreaterThan(0.5);
    expect(it1.dims.delay!).toBeGreaterThan(0.8);
    expect(describeIntent(it1)).toMatch(/délais marqués \(fort\)/);
    const neutre = parseMixIntent('un mix neutre');
    expect(neutre.styles.map(s => s.id)).toEqual(['neutre']);
    expect(neutre.dims.delay ?? 0).toBe(0);
    expect(parseMixIntent('rends ma voix plus pro').tweakOnly).toBe(true);
    expect(parseMixIntent("plus d'air").styles[0].id).toBe('air');
    expect(parseMixIntent('moins de sifflantes').dims.deess!).toBeGreaterThan(0.6);
    expect(parseMixIntent('un peu de reverb').styles[0].intensity).toBe(0.4);
    expect(parseMixIntent('bonjour').unknown).toBe(true);
  });
  it('propose 2 ou 3 styles quand on ne sait pas', () => {
    expect(suggestStyles('drill', 140).map(s => s.id)).toEqual(['drill', 'sature', 'neutre']);
    expect(suggestStyles(null, 140).length).toBe(3);
  });
});

describe('connaissance des plugins (paramètres réels)', () => {
  it('classe et trouve les rôles sans index codé en dur', () => {
    const proc = known(/Pro-C/);
    expect(proc.category).toBe('compressor');
    const roles = paramRoles('compressor', proc.params);
    expect(roles.ratio).toBeTruthy();
    expect(roles.threshold).toBeTruthy();
    expect(supportsRatio(proc.params, 2)).toBe(true);
    expect(eqBands(known(/Pro-Q 4/).params).length).toBeGreaterThanOrEqual(8);
    expect(classifyPlugin('uaudio_teletronix_la-2a_silver').compType).toBe('opto');
    expect(classifyPlugin('uaudio_ua_1176ae').compType).toBe('fet');
    expect(classifyPlugin('ValhallaDelay').category).toBe('delay');
    expect(classifyPlugin('ValhallaRoom').category).toBe('reverb');
    expect(classifyPlugin('Weiss DS1-MK3', 'Softube').category).toBe('deesser');
  });
  it('ratio 2:1 impossible sur une liste 4/8/12/20 (1176) : refusé', () => {
    const p: VstParam = { name: 'ratio', value: 0, text: '4', values: ['4', '8', '12', '20', 'All'] };
    expect(toSetting(p, { value: 2, unit: 'ratio' }, 'ratio')).toBeNull();
    const q: VstParam = { name: 'ratio', value: 0, text: '4:1', values: ['1.5:1', '2:1', '4:1'] };
    expect(toSetting(q, { value: 2, unit: 'ratio' }, 'ratio')!.text).toBe('2:1');
    const r: VstParam = { name: 'ratio', value: 0, text: '4.00:1', range: [1, 100, null] };
    expect(toSetting(r, { value: 2, unit: 'ratio' }, 'ratio')!.real).toBe(2);
  });
  it('conversion d’unités : s ↔ ms, kHz ↔ Hz, % 0–1', () => {
    expect(toSetting({ name: 'attack_s', value: 0, text: '0.01 s', range: [0, 1, null] }, { value: 10, unit: 'ms' }, 'x')!.real).toBe(0.01);
    expect(toSetting({ name: 'freq_khz', value: 0, text: '6 kHz', range: [1, 20, null] }, { value: 6500, unit: 'hz' }, 'x')!.real).toBe(6.5);
    expect(toSetting({ name: 'mix', value: 0, text: '0.5', range: [0, 1, null] }, { value: 30, unit: 'pct' }, 'x')!.real).toBe(0.3);
  });
});

describe('logique de chaîne et règles maison', () => {
  const ctx = (dims: any, extra: any = {}) => planVoiceMix({
    installed: INSTALLED, dims, loudDb: -16, bpm: 140,
    voice: { id: 'track-rec-main', name: 'REC', plugins: [plug('COMPRESSOR'), plug('DEESSER'), plug('AUTOTUNE')] },
    bus: { id: 'bus-vox', name: 'BUS VOX', plugins: [] },
    sendTracks: [{ id: 'send-verb-short', name: 'VERB PRO', plugins: [plug('REVERB', { id: 'rv' })] }, { id: 'send-verb-long', name: 'HALL', plugins: [plug('REVERB', { id: 'rv2' })] }, { id: 'send-delay', name: 'DELAY', plugins: [plug('DELAY', { id: 'dl' })] }],
    ...extra,
  });

  it('2 compresseurs voix : prise + bus voix, types différents, jamais le même modèle, ratio 2:1', () => {
    const plan = ctx({ compression: 0.6 }, { tweakOnly: true });
    const c1 = plan.tracks[0].vst.find(v => v.slot === 'comp1')!;
    const c2 = plan.tracks.find(t => t.trackId === 'bus-vox')!.vst.find(v => v.slot === 'comp2')!;
    expect(c1).toBeTruthy();
    expect(c2).toBeTruthy();
    expect(c1.plugin.name).not.toBe(c2.plugin.name);
    expect(c1.plugin.compType).not.toBe(c2.plugin.compType);
    for (const c of [c1, c2]) {
      const ratioName = paramRoles('compressor', c.plugin.params).ratio!;
      const s = c.settings.find(x => x.name === ratioName)!;
      expect(s).toBeTruthy();
      expect(Number(String(s.text ?? s.real).replace(/:.*$/, ''))).toBe(2);
    }
    // Le compresseur de NOVA de la piste est mis en pause (pas de doublon).
    expect(plan.tracks[0].pauseBuiltin).toContain('COMPRESSOR-1');
  });

  it('un seul compresseur installé : VST sur la piste, compresseur de NOVA (autre réglage) sur le bus', () => {
    const only = INSTALLED.filter(p => p.category !== 'compressor' || /Pro-C/.test(p.name));
    const plan = planVoiceMix({ installed: only, dims: { compression: 0.6 }, loudDb: -16, voice: { id: 'v', name: 'V', plugins: [] }, bus: { id: 'bus-vox', name: 'BUS VOX', plugins: [] } });
    expect(plan.tracks[0].vst.find(v => v.slot === 'comp1')!.plugin.name).toMatch(/Pro-C/);
    const bus = plan.tracks.find(t => t.trackId === 'bus-vox')!;
    expect(bus.vst).toHaveLength(0);
    expect(bus.builtin[0]).toMatchObject({ type: 'COMPRESSOR', params: { ratio: 2, mode: 'OPTO' } });
    expect(plan.summary.join(' ')).toMatch(/compresseur de NOVA/);
  });

  it('jamais un plugin non disponible ; repli sur NOVA annoncé', () => {
    const noDe = INSTALLED.map(p => (p.category === 'deesser' ? { ...p, unavailable: 'licence' } : p));
    const plan = planVoiceMix({ installed: noDe, dims: { deess: 0.8 }, loudDb: -16, voice: { id: 'v', name: 'V', plugins: [] } });
    expect(plan.tracks[0].vst.some(v => v.slot === 'deess')).toBe(false);
    expect(plan.tracks[0].builtin.find(b => b.slot === 'deess')).toBeTruthy();
    expect(candidatesFor('deess', noDe)).toHaveLength(0);
  });

  it('spatial + saturé + beaucoup de délai : chaîne ordonnée, reverb et délai en ENVOI', () => {
    const plan = ctx(parseMixIntent('mix spatial et saturé avec beaucoup de delay').dims);
    const slots = plan.tracks[0].vst.map(v => v.slot);
    const order = slots.map(s => SLOT_ORDER[s]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(slots).toContain('sat');
    // Pas de reverb / délai en insert sur la voix : sur les retours.
    expect(slots).not.toContain('verb');
    expect(plan.tracks.find(t => t.trackId === 'send-delay')!.vst[0].slot).toBe('delay');
    expect(plan.tracks.some(t => t.trackId.startsWith('send-verb') && t.vst[0]?.slot === 'verb')).toBe(true);
    expect(plan.sends.find(s => s.sendId === 'send-delay')!.level).toBeGreaterThan(0.3);
    // Les effets de NOVA des retours sont mis en pause (le VST les remplace).
    expect(plan.tracks.find(t => t.trackId === 'send-delay')!.pauseBuiltin).toContain('dl');
  });

  it('mix neutre : envois de délai remis à zéro, pas de saturation', () => {
    const plan = ctx(parseMixIntent('un mix neutre').dims);
    expect(plan.tracks[0].vst.some(v => v.slot === 'sat')).toBe(false);
    expect(plan.sends.find(s => s.sendId === 'send-delay')!.level).toBe(0);
  });

  it('application : une étape, pas de doublon au 2e passage, effets de NOVA en pause', () => {
    const st = {
      bpm: 140, projectKey: 6, projectScale: 'MINOR',
      tracks: [
        { id: 'track-rec-main', name: 'REC', type: TrackType.AUDIO, plugins: [plug('COMPRESSOR'), plug('DEESSER'), plug('AUTOTUNE')], sends: [], clips: [] },
        { id: 'bus-vox', name: 'BUS VOX', type: TrackType.BUS, plugins: [], sends: [], clips: [] },
        { id: 'send-delay', name: 'DELAY', type: TrackType.SEND, plugins: [plug('DELAY', { id: 'dl' })], sends: [], clips: [] },
      ],
    } as unknown as DAWState;
    const plan = ctx(parseMixIntent('rends ma voix plus pro').dims, { tweakOnly: true });
    const r1 = applyMixPlan(st, plan, { voiceTrackIds: ['track-rec-main'] });
    expect(r1.inserted).toBeGreaterThan(1);
    const rec = st.tracks[0];
    expect(rec.plugins.find(p => p.type === 'COMPRESSOR')!.isEnabled).toBe(false);
    const order = rec.plugins.map(slotOfPlugin);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const n = rec.plugins.length;
    const r2 = applyMixPlan(st, plan, { voiceTrackIds: ['track-rec-main'] });
    expect(st.tracks[0].plugins.length).toBe(n);
    expect(r2.updated).toBeGreaterThan(0);
    // Réglages déclaratifs (appliqués et relus au chargement par le pont).
    const vst = rec.plugins.find(p => p.type === 'VST3')!;
    expect(vst.params.novaSettings.length).toBeGreaterThan(0);
    expect(vst.params.novaQuiet).toBe(true);
  });

  it('niveau des passages forts', () => {
    const sr = 48000;
    const x = new Float32Array(sr * 4);
    for (let i = 0; i < x.length; i++) x[i] = (i < sr * 2 ? 0.5 : 0.05) * Math.sin(2 * Math.PI * 220 * i / sr);
    expect(estimateLoudDb(x, sr)!).toBeCloseTo(-9, 0);
  });
});

describe('commandes du chat (pont connecté)', () => {
  const st = { tracks: [{ id: 'track-rec-main', name: 'REC', type: TrackType.AUDIO, plugins: [{ id: 'x', name: 'Decapitator', type: 'VST3', params: {} }], sends: [], clips: [] }], selectedTrackId: null } as unknown as DAWState;
  it('reconnaît les demandes', () => {
    expect(parseVstCommand('quels plugins j’ai ?', st, true)!.actions[0].action).toBe('VST_LIST');
    expect(parseVstCommand('je veux un mix spatial et saturé avec beaucoup de delay', st, true)!.actions[0]).toMatchObject({ action: 'VST_MIX' });
    expect(parseVstCommand('rends ma voix plus pro', st, true)!.actions[0].action).toBe('VST_MIX');
    expect(parseVstCommand('mets un compresseur sur ma voix', st, true)!.actions[0].action).toBe('VST_MIX');
    expect(parseVstCommand('mets le ratio du compresseur à 3', st, true)!.actions[0]).toMatchObject({ action: 'VST_SET_PARAM', payload: { param: 'ratio', value: '3' } });
    expect(parseVstCommand('enlève le decapitator', st, true)!.actions[0].action).toBe('VST_REMOVE');
    expect(parseVstCommand('montre les réglages du Pro-C', st, true)!.actions[0].action).toBe('VST_SHOW_PARAMS');
    // « plus de reverb » reste le dosage des envois ; « annule » reste Annuler.
    expect(parseVstCommand('plus de reverb', st, true)).toBeNull();
    expect(parseVstCommand('annule', st, true)).toBeNull();
    // Pont absent : rien (les effets de NOVA et les commandes classiques).
    expect(parseVstCommand('mix spatial', st, false)).toBeNull();
  });
});

describe('toSetting : unités incompatibles (mesuré en réel le 04/10)', () => {
  it('secondes vers un decay en % (VerbSuite) : pas de réglage inventé', () => {
    expect(toSetting({ name: 'reverb_decay', text: '25%', range: [0, 100, 0] } as any, { value: 2.9, unit: 's' }, 'durée')).toBeNull();
  });
  it('Hz vers un bouton 0–10 (EchoBoy) : pas de réglage inventé', () => {
    expect(toSetting({ name: 'highcut', text: '1.00', range: [0, 10, 0] } as any, { value: 6000, unit: 'hz' }, 'filtre')).toBeNull();
  });
  it('% vers un bouton 0–10 : position sur la course', () => {
    expect(toSetting({ name: 'feedback', text: '1.25', range: [0, 10, 0] } as any, { value: 47, unit: 'pct' }, 'répétitions')?.real).toBeCloseTo(4.7, 3);
  });
  it('% vers un paramètre 0–1 : divisé par 100', () => {
    expect(toSetting({ name: 'mix', text: '0.5', range: [0, 1, 0] } as any, { value: 60, unit: 'pct' }, 'mélange')?.real).toBeCloseTo(0.6, 3);
  });
  it('ms vers s : converti', () => {
    expect(toSetting({ name: 'release_s', text: '0.10 s', range: [0, 5, 0] } as any, { value: 90, unit: 'ms' }, 'relâchement')?.real).toBeCloseTo(0.09, 3);
  });
});
