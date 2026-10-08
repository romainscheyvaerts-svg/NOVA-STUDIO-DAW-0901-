import { describe, expect, it } from 'vitest';
import { matchParam, nameTokens, parseNumber, pickListValue, settingFor, unexposedReason } from '../utils/vstParamAlias';
import { buildTemplateFromSpec, TemplateSpec } from '../utils/templateSpec';
import { instantiateTemplate } from '../utils/sessionTemplate';

/** Paramètres réels relus par le pont (relevé LENNON, 08/10/2026), réduits. */
const C6 = [
  { name: 'release', display_name: 'Release', text: 'Manual ', values: ['ARC ', 'Manual '] },
  { name: 'low_crossover', display_name: 'Low Crossover', text: '92 Hz', range: [16, 21357, null] },
  { name: 'output_gain', display_name: 'Output Gain', text: '0.0 dB', range: [-18, 18, 0.1] },
  { name: 'band_1_threshold', display_name: 'Band 1 Threshold', text: '0.0 dB', range: [-80, 0, 0.1] },
  { name: 'band_2_threshold', display_name: 'Band 2 Threshold', text: '0.0 dB', range: [-80, 0, 0.1] },
];
const VOXBOX = [
  { name: 'low_cut', display_name: 'Low Cut', text: 'Off', values: ['Off', '80 Hz', '120 Hz'] },
  { name: 'comp_byp', display_name: 'Comp Byp', text: 'In', values: ['Byp', 'In'] },
  { name: 'mid_dip_freq', display_name: 'Mid Dip Freq', text: '300 Hz', range: [200, 7000, null], values: ['200.0', '300.0', '1500.0', '7000.0'] },
  { name: 'de_ess_byp', display_name: 'De Ess Byp', text: 'Byp', values: ['Byp', 'In'] },
  { name: 'de_ess_sel', display_name: 'De Ess Sel', text: 'Limit', values: ['3K', '6K', 'Limit'] },
];
const AUTOTUNE = [
  { name: 'input_type', display_name: 'Input Type', text: 'Alto-Tenor', values: ['Soprano', 'Alto-Tenor', 'Low Male'] },
  { name: 'detune', display_name: 'Detune', text: '0', range: [-100, 100, 1] },
  { name: 'correction_mode', display_name: 'Correction Mode', text: 'Auto mode', values: ['Auto mode', 'Graph mode'] },
  { name: 'hp_bypass_harmony_player', display_name: 'HP Bypass Harmony Player', text: 'On', values: ['False', 'True'], is_boolean: true },
];

describe('noms des réglages Pro Tools → VST3', () => {
  it('mots normalisés : abréviations et numéros de bande', () => {
    expect(nameTokens('Band 1 Freq')).toEqual(['1', 'frequency']);
    expect(nameTokens('band_1_frequency')).toEqual(['1', 'frequency']);
    expect(nameTokens('Thresh')).toEqual(['threshold']);
    expect(nameTokens('Rel. Time')).toEqual(['release', 'time']);
  });

  it('RUBY2 (hôte natif) : « High Cut Gain » = Flat → high_cut_gain à 0', () => {
    const RUBY2 = [{ name: 'high_cut_gain', display_name: 'High Cut Gain', text: '0', range: [0, 0, null] }];
    const m = matchParam('High Cut Gain', RUBY2, 'RUBY2')!;
    expect(m).toMatchObject({ key: 'high_cut_gain', how: 'alias' });
    expect(settingFor(RUBY2[0], m.key, 'Flat', m.convert)).toEqual({ name: 'high_cut_gain', real: 0 });
  });

  it('correspondance approchée : Crossover Low = low_crossover, Threshold 2 = band_2_threshold', () => {
    expect(matchParam('Crossover Low', C6, 'Some EQ')).toMatchObject({ key: 'low_crossover', how: 'approx' });
    expect(matchParam('Band 2 Thresh', C6, 'Some EQ')).toMatchObject({ key: 'band_2_threshold', how: 'approx' });
    expect(matchParam('Band 3 Thresh', C6, 'Some EQ')).toBeNull();                // pas de bande 3 : rien plutôt qu'une erreur
  });

  it('alias vérifiés par plugin, prioritaires sur le nom identique', () => {
    expect(matchParam('High Pass', VOXBOX, 'uaudio_manley_voxbox')).toMatchObject({ key: 'low_cut', how: 'alias' });
    expect(matchParam('De-Ess', VOXBOX, 'uaudio_manley_voxbox')).toMatchObject({ key: 'de_ess_byp' });
    expect(matchParam('Release Mode', C6, 'C6 Stereo')).toMatchObject({ key: 'release', how: 'alias' });
    // Auto-Tune : « Detune 440 Hz » est la référence du La → 0 cent.
    const m = matchParam('Detune', AUTOTUNE, 'Auto-Tune Pro')!;
    expect(settingFor(AUTOTUNE[1], m.key, '440.0 Hz', m.convert)).toEqual({ name: 'detune', real: 0 });
    // « Harmony Player Off » = bypass du Harmony Player activé.
    const h = matchParam('Harmony Player', AUTOTUNE, 'Auto-Tune Pro')!;
    expect(settingFor(AUTOTUNE[3], h.key, 'Off', h.convert)).toEqual({ name: 'hp_bypass_harmony_player', text: 'On' });
  });

  it('réglage non exposé en VST3 : signalé, jamais deviné', () => {
    expect(matchParam('Relative', [{ name: 'key_scale', display_name: 'Key/Scale' }], 'Auto-Key')).toBeNull();
    expect(unexposedReason('Relative', 'Auto-Key')).toMatch(/affich/);
    expect(unexposedReason('Threshold', 'C6 Stereo')).toBeNull();
  });

  it('un vu-mètre n’est jamais pris pour un réglage', () => {
    const p = [{ name: 'gain_reduction_meter', display_name: 'GAIN REDUCTION METER', range: [0, 1, 0.01] }, { name: 'output', display_name: 'OUTPUT', range: [-10, 15, 0.1] }];
    expect(matchParam('Gain', p, 'Unknown Comp')).toBeNull();
    expect(matchParam('Gain', p, 'Bettermaker Bus Compressor DSP')).toMatchObject({ key: 'output' });
  });
});

describe('valeurs', () => {
  it('liste : texte exact du plugin', () => {
    expect(pickListValue(['Soprano', 'Alto-Tenor'], 'Alto / Tenor')).toBe('Alto-Tenor');
    expect(pickListValue(['Norm', 'HP', 'Dist 2'], 'normal')).toBe('Norm');
    expect(pickListValue(['Single', 'Dual', 'Ping-Pong'], 'Single Echo')).toBe('Single');
    expect(pickListValue(['SmHall B', 'SmHall A', 'Room A'], '6 Sm Hall A')).toBe('SmHall A');
    expect(pickListValue(['L+R', 'L/R', 'M/S'], 'L/R')).toBe('L/R');            // pas « L+R »
    expect(pickListValue(['1:1', '2:1', '4:1'], '4')).toBe('4:1');
    expect(pickListValue(['Out ', 'In '], 'On')).toBe('In ');
    expect(pickListValue(['Off ', 'Bypass '], 'Off')).toBe('Off ');
  });

  it('nombres de console : 1K5, 12K, 100 cps, -Inf, x 1.50', () => {
    expect(parseNumber('1K5')).toEqual({ n: 1500, unit: 'hz' });
    expect(parseNumber('12K')).toEqual({ n: 12000, unit: 'hz' });
    expect(parseNumber('100 cps')).toEqual({ n: 100, unit: 'hz' });
    expect(parseNumber('-Inf')!.n).toBe(-Infinity);
    expect(parseNumber('x 1.50')).toEqual({ n: 1.5, unit: '' });
    expect(settingFor(VOXBOX[2], 'mid_dip_freq', '1K5')).toEqual({ name: 'mid_dip_freq', text: '1500.0' });
  });

  it('interrupteur lu sur un potard continu : extrémité de la plage', () => {
    expect(settingFor({ name: 'power', text: '1.00', range: [0, 1, 0.01] }, 'power', 'On')).toEqual({ name: 'power', real: 1 });
    expect(settingFor({ name: 'air', text: '50', range: [0, 100, 1] }, 'air', 'Off')).toEqual({ name: 'air', real: 0 });
  });

  it('valeur composée (Auto-Key : « C » + « Minor » → « C Minor »)', () => {
    const p = { name: 'key_scale', display_name: 'Key/Scale', values: ['Chromatic', 'C Major', 'C Minor'] };
    const m = matchParam('Key', [p], 'Auto-Key')!;
    expect(settingFor(p, m.key, 'C', m.convert, { Key: 'C', Scale: 'Minor' })).toEqual({ name: 'key_scale', text: 'C Minor' });
  });
});

describe('plugins absents remplacés', () => {
  const spec: TemplateSpec = {
    format: 'nova-template-spec', version: 1, name: 'Remplacements',
    tracks: [
      { name: 'LEAD', kind: 'audio', channels: 'mono', inserts: [
        { vendor: 'Kazrog', plugin: 'True Iron', state: 'active', params: { Crush: '0.1 dB', Strength: '5.00', Mix: '100.0 %', Out: '0.0' } },
        { vendor: 'Sonnox', plugin: 'Oxford SuprEsser DS', state: 'active', params: { Threshold: '-18.0 dB', Frequency: '4.91 kHz' } },
        { vendor: 'iZotope', plugin: 'Neutron 4', state: 'inactive' },
        { vendor: 'Waves', plugin: 'C6', state: 'active' },
      ] },
      { name: 'Master', kind: 'master' },
    ],
  };
  const plugins = [
    { name: 'DeEdger', vendor: 'Tokyo Dawn Labs', path: 'C:/VST3/DeEdger.vst3' },
    { name: 'Ozone 9', vendor: 'iZotope', path: 'C:/VST3/iZotope/Ozone 9.vst3' },
    { name: 'C6 Stereo', vendor: 'Waves', path: 'C:/VST3/WaveShell1-VST3 17.1_x64.vst3', pluginName: 'C6 Stereo' },
    { name: 'C6 Mono', vendor: 'Waves', path: 'C:/VST3/WaveShell1-VST3 17.1_x64.vst3', pluginName: 'C6 Mono' },
  ];

  it('True Iron → saturation NOVA, SuprEsser → DeEdger, Neutron 4 → Ozone 9 inactif ; C6 mono sur piste mono', () => {
    const { template, report } = buildTemplateFromSpec(spec, { plugins, activateAll: true });
    const lead = template.session.tracks.find(t => t.name === 'LEAD')!;
    expect(lead.plugins[0].type).toBe('VOCALSATURATOR');
    expect(lead.plugins[0].params.templateReplacement).toMatchObject({ from: 'True Iron', kind: 'builtin' });
    expect(lead.plugins[0].params.mix).toBe(1);
    expect(lead.plugins[1].params.name).toBe('DeEdger');
    expect(lead.plugins[2].params.name).toBe('Ozone 9');
    expect(lead.plugins[2].isInactive).toBe(true);                         // laissé inactif, même avec « tout activer »
    expect(lead.plugins[3].params.pluginName).toBe('C6 Mono');             // piste mono → variante mono
    expect(report.warnings.some(w => /True Iron manquant : remplacé par la saturation NOVA/.test(w))).toBe(true);
    // Rapport de chargement du modèle dans NOVA
    const { report: load } = instantiateTemplate(template, { plugins, enableAll: true });
    expect(load.messages.some(m => /Neutron 4 manquant sur LEAD : remplacé par Ozone 9 \(laissé inactif\)/.test(m))).toBe(true);
    expect(load.messages.some(m => /Oxford SuprEsser DS manquant sur LEAD : remplacé par DeEdger/.test(m))).toBe(true);
  });

  it('sans DeEdger : de-esser NOVA vers 8 kHz', () => {
    const { template } = buildTemplateFromSpec(spec, { plugins: plugins.filter(p => p.name !== 'DeEdger') });
    const ds = template.session.tracks.find(t => t.name === 'LEAD')!.plugins[1];
    expect(ds.type).toBe('DEESSER');
    expect(ds.params.frequency).toBe(8000);
    expect(ds.params.threshold).toBe(-18);
  });
});

describe('unités affichées', () => {
  it('Trackspacer affiche « 20.00k » : le nombre en Hz est envoyé (le pont lit « k » = ×1000)', () => {
    expect(settingFor({ name: 'high_cut_hz', text: '20.00k' }, 'high_cut_hz', '20 kHz')).toEqual({ name: 'high_cut_hz', real: 20000 });
  });
});
