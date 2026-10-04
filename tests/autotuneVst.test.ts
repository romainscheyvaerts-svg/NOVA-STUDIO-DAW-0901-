import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  detectAutotunes, isExcluded, keyLabel, noteOfToggle, parseKeyText, parseNote, pitchClassesOf, readbackMatches,
  recommendedAutotune, resolveAutotuneSettings, ScannedPlugin, toVstParams, VstParam,
} from '../utils/autotuneVst';

/**
 * Autotune du PC : détection, exclusions, lecture des tonalités et réglage de la
 * gamme à partir des VRAIS paramètres lus par le pont le 04/10/2026 sur le PC du
 * studio (tests/fixtures : Auto-Tune Pro 120 paramètres, MetaTune 21).
 */
const fixture = (f: string): VstParam[] =>
  toVstParams(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')));
const ATP = fixture('autotune-pro.params.json');
const MT = fixture('metatune.params.json');

const plug = (name: string, vendor: string, extra: Partial<ScannedPlugin> = {}): ScannedPlugin => ({
  id: `id-${name}`, name, vendor, path: `C:\\Program Files\\Common Files\\VST3\\${name}.vst3`, pluginName: null, category: 'Effect', ...extra,
});

describe('détection des autotunes', () => {
  const scanned: ScannedPlugin[] = [
    plug('Pro-Q 4', 'FabFilter'),
    plug('MetaTune', 'Slate Digital', { path: 'C:\\Program Files\\Common Files\\VST3\\Slate Digital\\MetaTune.vst3', license: 'activation' }),
    plug('Auto-Key', 'Antares'),
    plug('Auto-Tune Pro', 'Antares'),
    plug('Auto-Tune Access', 'Antares'),
    plug('Melodyne', 'Celemony'),
    plug('LittleAlterBoy', 'Soundtoys'),
    plug('Waves Tune Real-Time Mono', 'Waves', { path: 'C:\\Program Files\\Common Files\\VST3\\WaveShell1-VST3 17.4_x64.vst3', pluginName: 'Waves Tune Real-Time Mono' }),
    plug('Waves Tune Real-Time Mono', 'Waves', { path: 'C:\\Program Files\\Common Files\\VST3\\WaveShell1-VST3 16.7_x64.vst3', pluginName: 'Waves Tune Real-Time Mono' }),
    plug('Graillon 3', 'Auburn Sounds'),
    plug('MetaPitch', 'Slate Digital', { path: 'C:\\Program Files\\Common Files\\VST3\\Slate Digital\\MetaPitch.vst3' }),
    plug('Auto-Tune Slice', 'Antares', { isInstrument: true, category: 'Instrument' }),
    plug('bx_tuner', 'Plugin Alliance'),
  ];

  it('reconnaît les familles par nom et éditeur, dans l’ordre de préférence de Romain', () => {
    const c = detectAutotunes(scanned);
    expect(c.map(x => x.name)).toEqual([
      'Auto-Tune Pro', 'Auto-Tune Access', 'MetaTune', 'Waves Tune Real-Time Mono', 'Graillon 3', 'LittleAlterBoy',
    ]);
    expect(c[0].vendor).toBe('Antares');
    // Melodyne (pas temps réel), Auto-Key (détecteur de tonalité), Slice (instrument),
    // MetaPitch, accordeur : jamais proposés.
    expect(c.find(x => /melodyne|key|slice|pitch|tuner/i.test(x.name))).toBeUndefined();
    // Deux WaveShell : un seul Waves Tune.
    expect(c.filter(x => x.family === 'waves-tune')).toHaveLength(1);
    // Little AlterBoy ne suit pas une gamme.
    expect(c.find(x => x.family === 'little-alterboy')!.followsKey).toBe(false);
  });

  it('Auto-Tune Pro est recommandé ; s’il est indisponible, MetaTune prend la suite', () => {
    expect(recommendedAutotune(detectAutotunes(scanned))!.name).toBe('Auto-Tune Pro');
    const key = `${scanned[3].path}#Auto-Tune Pro`;
    const c = detectAutotunes(scanned, { unavailable: { [key]: 'Demande une licence' } });
    expect(c.find(x => x.name === 'Auto-Tune Pro')!.unavailable).toBe('Demande une licence');
    expect(recommendedAutotune(c)!.name).toBe('Auto-Tune Access');
    const c2 = detectAutotunes(scanned.filter(p => !/Auto-Tune/.test(p.name)));
    expect(recommendedAutotune(c2)!.name).toBe('MetaTune');
  });

  it('une ancienne fenêtre de licence vue par le pont n’empêche pas l’essai discret', () => {
    const mt = detectAutotunes(scanned).find(x => x.name === 'MetaTune')!;
    expect(mt.unavailable).toBeNull();
    expect(mt.licenseHint).toBe('Licence à vérifier');
  });
});

describe('liste d’exclusion (licences)', () => {
  it('Slate Digital exclu sauf MetaTune et VerbSuite Classics ; SSL / Solid State Logic exclus', () => {
    const slate = (n: string) => plug(n, '', { path: `C:\\Program Files\\Common Files\\VST3\\Slate Digital\\${n}.vst3` });
    expect(isExcluded(slate('Virtual Mix Rack'))).toBe(true);
    expect(isExcluded(slate('FG-X 2'))).toBe(true);
    expect(isExcluded(slate('Fresh Air'))).toBe(true);
    expect(isExcluded(slate('MetaTune'))).toBe(false);
    expect(isExcluded(slate('VerbSuite Classics'))).toBe(false);
    expect(isExcluded(plug('SSL Native Channel Strip 2', ''))).toBe(true);
    expect(isExcluded(plug('Fusion Vintage Drive', 'Solid State Logic'))).toBe(true);
    expect(isExcluded(plug('Bus Compressor 2', 'SSL'))).toBe(true);
    // Le « SSL E Channel Strip » d'Universal Audio n'est pas un plugin Slate / SSL.
    expect(isExcluded(plug('UADx SSL E Channel Strip', 'Universal Audio'))).toBe(false);
    expect(isExcluded(plug('Pro-Q 4', 'FabFilter'))).toBe(false);
  });
  it('liste modifiable : éditeur ajouté, exception retirée', () => {
    const ex = { vendors: ['Slate Digital', 'Waves'], plugins: ['Pro-Q'], allow: [] };
    expect(isExcluded(plug('MetaTune', 'Slate Digital'), ex)).toBe(true);
    expect(isExcluded(plug('CLA-2A', 'Waves'), ex)).toBe(true);
    expect(isExcluded(plug('Pro-Q 4', 'FabFilter'), ex)).toBe(true);
  });
});

describe('tonalités', () => {
  it('notes : dièses, bémols, solfège, doubles écritures', () => {
    expect(parseNote('F#')).toBe(6);
    expect(parseNote('Gb')).toBe(6);
    expect(parseNote('G♭')).toBe(6);
    expect(parseNote('C#/Db')).toBe(1);
    expect(parseNote('Bb')).toBe(10);
    expect(parseNote('B')).toBe(11);
    expect(parseNote('A# ')).toBe(10);
    expect(parseNote('Fa#')).toBe(6);
    expect(parseNote('Sib')).toBe(10);
    expect(parseNote('Ré')).toBe(2);
    expect(parseNote('Mi bémol')).toBe(3);
    expect(parseNote('H')).toBeNull();
  });
  it('tonalités du catalogue et de l’artiste', () => {
    expect(parseKeyText('F# minor')).toEqual({ root: 6, scale: 'MINOR' });
    expect(parseKeyText('B harmonic minor')).toEqual({ root: 11, scale: 'MINOR_HARMONIC' });
    expect(parseKeyText('B HAMONIC minor')).toEqual({ root: 11, scale: 'MINOR_HARMONIC' });
    expect(parseKeyText('C major')).toEqual({ root: 0, scale: 'MAJOR' });
    expect(parseKeyText('Bb min')).toEqual({ root: 10, scale: 'MINOR' });
    expect(parseKeyText('Bbm')).toEqual({ root: 10, scale: 'MINOR' });
    expect(parseKeyText('C # minor')).toEqual({ root: 1, scale: 'MINOR' });
    expect(parseKeyText('B MIN')).toEqual({ root: 11, scale: 'MINOR' });
    expect(parseKeyText('Fa# mineur')).toEqual({ root: 6, scale: 'MINOR' });
    expect(parseKeyText('Do majeur')).toEqual({ root: 0, scale: 'MAJOR' });
    expect(parseKeyText('Eb')).toEqual({ root: 3, scale: 'MINOR' });
    expect(parseKeyText('A minor pentatonic')).toEqual({ root: 9, scale: 'PENTATONIC' });
    expect(parseKeyText('')).toBeNull();
  });
  it('gammes et libellés', () => {
    expect(pitchClassesOf(6, 'MINOR')).toEqual([1, 2, 4, 6, 8, 9, 11]);
    expect(pitchClassesOf(11, 'MINOR_HARMONIC')).toEqual([1, 2, 4, 6, 7, 10, 11]);
    expect(keyLabel(6, 'MINOR')).toBe('F# mineur');
    expect(keyLabel(11, 'MINOR_HARMONIC')).toBe('B mineur harmonique');
  });
});

describe('réglage de la gamme par introspection (paramètres réels)', () => {
  const style = { speed: 0, humanize: 0, mix: 1, lowLatency: true };
  const get = (r: ReturnType<typeof resolveAutotuneSettings>, n: string) => r.settings.find(s => s.name === n);

  it('Auto-Tune Pro : key + modern_scale (pas l’ancienne « scale »), basse latence, mode auto', () => {
    const r = resolveAutotuneSettings('Auto-Tune Pro', ATP, { root: 6, scale: 'MINOR', ...style });
    expect(r.keyMethod).toBe('scale-list');
    expect(get(r, 'key')!.text).toBe('F#');
    expect(get(r, 'modern_scale')!.text).toBe('Minor');
    expect(get(r, 'scale')).toBeUndefined();
    expect(get(r, 'latency_removal')!.text).toBe('On');
    expect(get(r, 'correction_mode')!.text).toBe('Auto mode');
    expect(get(r, 'retune_speed_ms')!.real).toBe(0);
    expect(get(r, 'wet_dry_mix')!.real).toBe(100);
    const h = resolveAutotuneSettings('Auto-Tune Pro', ATP, { root: 11, scale: 'MINOR_HARMONIC', ...style });
    expect(get(h, 'key')!.text).toBe('B');
    expect(get(h, 'modern_scale')!.text).toBe('Harmonic Minor');
    expect(h.approximated).toBeNull();
    const flat = resolveAutotuneSettings('Auto-Tune Pro', ATP, { root: 10, scale: 'MAJOR', ...style });
    expect(get(flat, 'key')!.text).toBe('A#'); // Si♭ : le plugin n'écrit que des dièses
  });

  it('Auto-Tune Pro : styles (retune, humanize, Flex-Tune, dosage) et qualité maximale', () => {
    const drill = resolveAutotuneSettings('Auto-Tune Pro', ATP, { root: 0, scale: 'MINOR', speed: 0.25, humanize: 0.3, mix: 0.5, lowLatency: false });
    expect(get(drill, 'retune_speed_ms')!.real).toBe(25);
    expect(get(drill, 'humanize')!.real).toBe(30);
    expect(get(drill, 'flex_tune')!.real).toBe(25);
    expect(get(drill, 'wet_dry_mix')!.real).toBe(50);
    expect(get(drill, 'latency_removal')!.text).toBe('Off');
    // Jamais les paramètres de l'harmoniseur (hp_*) ni du mode graphique (object_*).
    expect(drill.settings.some(s => /^(hp_|object_)/.test(s.name) && s.name !== 'hp_bypass_harmony_player')).toBe(false);
  });

  it('MetaTune : 12 interrupteurs de notes (c, c_sharp_db…), vitesse et dosage', () => {
    const r = resolveAutotuneSettings('MetaTune', MT, { root: 11, scale: 'MINOR_HARMONIC', ...style });
    expect(r.keyMethod).toBe('note-toggles');
    const on = r.settings.filter(s => s.text === 'On' && s.name !== 'bypass').map(s => s.name).sort();
    // B C# D E F# G A#
    expect(on).toEqual(['a_sharp_bb', 'b', 'c_sharp_db', 'd', 'e', 'f_sharp_gb', 'g'].sort());
    expect(get(r, 'speed')!.real).toBe(0);
    expect(get(r, 'amount')!.real).toBe(100);
    expect(get(r, 'bypass')!.text).toBe('Off');
    expect(r.verify).toHaveLength(12);
  });

  it('noms d’interrupteurs de notes', () => {
    const p = (name: string, displayName?: string) => ({ name, displayName, value: 0, text: 'On', isBoolean: true });
    expect(noteOfToggle(p('c_sharp_db'))).toBe(1);
    expect(noteOfToggle(p('a_sharp_bb'))).toBe(10);
    expect(noteOfToggle(p('b'))).toBe(11);
    expect(noteOfToggle(p('note_7', 'G#/Ab'))).toBe(8);
    expect(noteOfToggle(p('bypass'))).toBeNull();
  });

  it('plugin inconnu : recherche générique (Key / Scale), gamme voisine si absente', () => {
    const generic: VstParam[] = [
      { name: 'root_note', displayName: 'Root Note', value: 0, text: 'C', values: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] },
      { name: 'scale_type', displayName: 'Scale', value: 0, text: 'Major', values: ['Major', 'Minor', 'Chromatic'] },
      { name: 'correction_speed', displayName: 'Correction Speed', value: 0, text: '50', range: [0, 100, 1] },
      { name: 'mix', displayName: 'Mix', value: 1, text: '100%', range: [0, 100, 1] },
    ];
    const r = resolveAutotuneSettings('Some Tuner', generic, { root: 6, scale: 'MINOR_HARMONIC', ...style });
    expect(get(r, 'root_note')!.text).toBe('Gb');
    expect(get(r, 'scale_type')!.text).toBe('Minor');
    expect(r.approximated).toMatch(/harmonique/);
    expect(get(r, 'correction_speed')!.real).toBe(0);
    expect(get(r, 'mix')!.real).toBe(100);
    // Aucun moyen de régler la gamme : signalé.
    const none = resolveAutotuneSettings('Pitch Thing', [{ name: 'pitch', value: 0.5, text: '0' }], { root: 0, scale: 'MINOR', ...style });
    expect(none.keyMethod).toBe('none');
  });

  it('relecture : texte exact ou interrupteur', () => {
    expect(readbackMatches('Harmonic Minor', 'Harmonic Minor')).toBe(true);
    expect(readbackMatches('F#', 'F#')).toBe(true);
    expect(readbackMatches('F#', 'G')).toBe(false);
    expect(readbackMatches(true, 'On')).toBe(true);
    expect(readbackMatches(false, 'Off')).toBe(true);
    expect(readbackMatches(true, 'Off')).toBe(false);
  });
});
