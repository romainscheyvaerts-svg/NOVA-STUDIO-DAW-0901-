/**
 * Échange DAWproject (écart 14) : NOVA → .dawproject → NOVA identique, lecture par le
 * format seul (fichier d'un autre logiciel, sans nova/nova.json) et ouverture d'un fichier
 * de référence fabriqué ici à la manière des logiciels du marché (noires, calage « Warps »,
 * dossier imbriqué, boucle MIDI, plugin VST3 absent, son manquant, rampe de tempo).
 */
import { describe, expect, it } from 'vitest';
import { DAWState, Track, TrackType } from '../types';
import { parseXml, writeXml, el } from '../utils/dawproject/xml';
import { BeatClock, novaClock } from '../utils/dawproject/dawTime';
import { buildDawProject, NOVA_SIDECAR } from '../utils/dawproject/novaToDawProject';
import { readDawProject } from '../utils/dawproject/dawProjectRead';
import { dawProjectToNova } from '../utils/dawproject/dawProjectToNova';
import { mergeDawImport } from '../utils/dawproject/dawProjectApp';
import { decodeAudioFile } from '../utils/aaf/aafMedia';
import { encodeBwf } from '../utils/bwf';

const SR = 48000;
const S = (n: number) => n / SR;
const tone = (n: number, f: number, sr = SR) => Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin((2 * Math.PI * f * i) / sr) + 0.01 * Math.sin(i * 0.731));

const track = (o: Partial<Track> & Pick<Track, 'id' | 'name' | 'type'>): Track => ({
  color: '#22d3ee', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master',
  sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...o,
});

function project(): { state: DAWState; audio: Map<string, { channels: Float32Array[]; sampleRate: number }> } {
  const audio = new Map([
    ['voix', { channels: [tone(SR * 6, 220)], sampleRate: SR }],
    ['beat', { channels: [tone(SR * 8, 110), tone(SR * 8, 111)], sampleRate: SR }],
    ['msample-s1', { channels: [tone(SR / 2, 440)], sampleRate: SR }],
  ]);
  const tracks: Track[] = [
    track({ id: 'dossier', name: 'Voix', type: TrackType.BUS, color: '#f59e0b', folder: { kind: 'routing', isOpen: true } }),
    track({
      id: 'lead', name: 'Lead « été » & <co>', type: TrackType.AUDIO, color: '#a78bfa', volume: 0.71, pan: -0.3, parentFolderId: 'dossier', outputTrackId: 'dossier',
      inputTrimDb: -3, comment: 'SM7B', isGuide: false,
      sends: [{ id: 'reverb', level: 0.42, isEnabled: true, preFader: true, slot: 2 }],
      clips: [
        { id: 'c1', name: 'Prise 1', color: '#a78bfa', type: TrackType.AUDIO, bufferId: 'voix', start: S(48_001), duration: S(40_000), offset: S(1_234),
          fadeIn: S(480), fadeOut: S(2_400), fadeInCurve: 'EQUAL_POWER', fadeOutCurve: 'S_CURVE', gain: 0.8, takeNumber: 1 },
        { id: 'c2', name: 'Prise 2', color: '#a78bfa', type: TrackType.AUDIO, bufferId: 'voix', start: S(150_017), duration: S(22_222), offset: S(7), fadeIn: 0, fadeOut: 0,
          gainPoints: [{ t: S(7), db: 0 }, { t: S(11_007), db: -6 }, { t: S(22_229), db: 0 }], isMuted: true },
        // Après le changement de tempo (mesure 4) : la conversion en noires reste exacte.
        { id: 'c3', name: 'Prise 3', color: '#a78bfa', type: TrackType.AUDIO, bufferId: 'voix', start: S(600_013), duration: S(9_001), offset: S(100_003), fadeIn: S(97), fadeOut: 0 },
      ],
      plugins: [
        { id: 'fx-comp', name: 'Compresseur', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { threshold: -21, ratio: 3, attack: 0.004, release: 0.12, makeupGain: 1.5, knee: 8, mode: 'OPTO' } },
        { id: 'fx-eq', name: 'EQ', type: 'PROEQ12', isEnabled: false, latency: 0, params: { isEnabled: true, masterGain: 1, bands: Array.from({ length: 12 }, (_, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking', frequency: [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000][i], gain: i === 4 ? -3.5 : 0, q: 1.2, isEnabled: true, isSolo: false })) } },
        { id: 'fx-deess', name: 'De-esser', type: 'DEESSER', isEnabled: true, latency: 0, params: { threshold: -30, frequency: 6500, listen: false } },
      ],
      automationLanes: [
        { id: 'l1', parameterName: 'volume', color: '#a78bfa', isExpanded: true, min: 0, max: 1.5, points: [{ id: 'p1', time: 0.5, value: 0.7 }, { id: 'p2', time: 2.25, value: 1.1, curveType: 'S_CURVE' }, { id: 'p3', time: 13.1, value: 0.3, curveType: 'HOLD' }] },
        { id: 'l2', parameterName: 'pan', color: '#a78bfa', isExpanded: false, min: -1, max: 1, points: [{ id: 'p4', time: 1, value: -0.5 }, { id: 'p5', time: 3, value: 0.5 }] },
        { id: 'l3', parameterName: 'plugin::fx-comp::threshold', color: '#f472b6', isExpanded: true, min: -60, max: 0, points: [{ id: 'p6', time: 1, value: -30 }, { id: 'p7', time: 2, value: -12 }] },
      ],
    }),
    track({ id: 'beat', name: 'Beat', type: TrackType.AUDIO, color: '#34d399', clips: [
      { id: 'b1', name: 'Beat', color: '#34d399', type: TrackType.AUDIO, bufferId: 'beat', start: 0, duration: 8, offset: 0, fadeIn: 0, fadeOut: S(4_800), fadeOutCurve: 'LINEAR' },
    ] }),
    track({ id: 'synth', name: 'Synth', type: TrackType.MIDI, color: '#facc15', isMuted: true, novaSynth: { preset: 'pad', cutoff: 1800 } as any, clips: [
      { id: 'm1', name: 'Accords', color: '#facc15', type: TrackType.MIDI, start: 2, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0, notes: [
        { id: 'n1', pitch: 60, start: 0, duration: 0.5, velocity: 100 },
        { id: 'n2', pitch: 64, start: 0.5, duration: 0.25, velocity: 87, slide: true },
        { id: 'n3', pitch: 67, start: 1.75, duration: 1.5, velocity: 127, pan: 0.3 },
        { id: 'n4', pitch: 70, start: 3, duration: 0.5, velocity: 64, muted: true },
      ] },
    ] }),
    track({ id: 'sampler', name: 'Sampler', type: TrackType.MELODIC_SAMPLER, melodicSampler: { sampleId: 's1', sampleName: 'Pluck' } as any, clips: [
      { id: 'm2', name: 'Pluck', color: '#22d3ee', type: TrackType.MIDI, start: 0, duration: 2, offset: 0, fadeIn: 0, fadeOut: 0, notes: [{ id: 'n5', pitch: 72, start: 0.125, duration: 0.25, velocity: 90 }] },
    ] }),
    track({ id: 'reverb', name: 'Réverbe', type: TrackType.BUS, color: '#60a5fa', volume: 0.9, plugins: [
      { id: 'fx-rev', name: 'Réverbe', type: 'REVERB', isEnabled: true, latency: 0, params: { mix: 1, decay: 2.4, preDelay: 0.03 } },
    ] }),
    track({ id: 'master', name: 'Master', type: TrackType.BUS, outputTrackId: '', volume: 0.95, plugins: [
      { id: 'fx-lim', name: 'Limiteur', type: 'LIMITER', isEnabled: true, latency: 0, params: { ceiling: -1, inputGain: 4, release: 120, lookahead: 3, oversample: 4, isEnabled: true } },
    ] }),
  ];
  const state = {
    id: 'p', name: 'Projet test', sampleRate: SR, bpm: 90, timeSignature: { numerator: 4, denominator: 4 },
    tempoEvents: [{ id: 't1', bar: 4, bpm: 120 }, { id: 't2', bar: 8, numerator: 3, denominator: 4 }],
    tracks, trackGroups: [], markers: [
      { id: 'mk1', name: 'Couplet', time: 2.5, type: 'MARKER', color: '#facc15', number: 1 },
      { id: 'mk2', name: 'Refrain', time: 10.75, type: 'REGION', endTime: 18, color: '#f87171', number: 2 },
    ],
  } as unknown as DAWState;
  return { state, audio };
}

const filesOf = (r: ReturnType<typeof buildDawProject>, drop: string[] = []) => {
  const m = new Map<string, Uint8Array>();
  m.set('project.xml', new TextEncoder().encode(r.projectXml));
  m.set('metadata.xml', new TextEncoder().encode(r.metadataXml));
  r.files.forEach(f => { if (!drop.includes(f.path)) m.set(f.path, f.bytes); });
  return m;
};
const audioOf = (files: Map<string, Uint8Array>) => (p: string) => { const b = files.get(p); const a = b ? decodeAudioFile(b) : null; return a ? { channels: a.channels, sampleRate: a.sampleRate } : null; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('XML du format', () => {
  it('écrit et relit sans perte (entités, accents, nombres)', () => {
    const x = writeXml(el('Project', { version: '1.0' }, [el('Track', { name: 'A & B « é » <x> "q"', value: 0.1 + 0.2, tiny: 1e-7 })]));
    const r = parseXml(x);
    expect(r.name).toBe('Project');
    expect(r.children[0].attrs.name).toBe('A & B « é » <x> "q"');
    expect(Number(r.children[0].attrs.value)).toBe(0.1 + 0.2);
    expect(r.children[0].attrs.tiny).toBe('0.0000001');
  });
  it('lit commentaires, CDATA, DOCTYPE et refuse un fichier abîmé', () => {
    const r = parseXml('<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x "y">]><!-- c --><P a=\'1\'><Q><![CDATA[a<b]]></Q><R/></P>');
    expect(r.children.map(c => c.name)).toEqual(['Q', 'R']);
    expect(r.children[0].text).toBe('a<b');
    expect(() => parseXml('<P><Q></P>')).toThrow(/XML illisible/);
  });
});

describe('horloge noires ↔ secondes', () => {
  it('paliers et rampes : aller-retour exact', () => {
    const c = new BeatClock(90, [{ beat: 16, bpm: 120 }, { beat: 32, bpm: 150, ramp: true }, { beat: 48, bpm: 100 }]);
    expect(c.secAt(16)).toBeCloseTo(16 * 60 / 90, 12);
    for (const b of [0, 3.3, 16, 20.5, 31.9, 40, 48, 77.7]) expect(c.beatAt(c.secAt(b))).toBeCloseTo(b, 9);
    // Rampe 120 → 150 sur 16 noires : 60·16/30·ln(150/120).
    expect(c.secAt(32) - c.secAt(16)).toBeCloseTo((60 * 16 / 30) * Math.log(150 / 120), 12);
  });
  it('horloge d\'un projet NOVA (changements à la mesure)', () => {
    const { state } = project();
    const c = novaClock(state);
    expect(c.secAt(16)).toBeCloseTo(16 * 60 / 90, 12); // mesure 4 en 4/4
    expect(c.bpmAt(17)).toBe(120);
  });
});

describe('NOVA → DAWproject → NOVA', () => {
  const { state, audio } = project();
  const r = buildDawProject(state, id => audio.get(id) || null, { format: '32f' });
  const files = filesOf(r);
  const s = readDawProject(files);
  const conv = dawProjectToNova(s, audioOf(files), { idPrefix: 'x' });

  it('écrit un fichier conforme au format (structure, noires, sons, nova.json)', () => {
    const x = parseXml(r.projectXml);
    expect(x.name).toBe('Project');
    expect(x.children.map(c => c.name)).toEqual(['Application', 'Transport', 'Structure', 'Arrangement', 'Scenes']);
    expect(r.projectXml).toContain('timeUnit="beats"');
    expect(r.projectXml).toContain('<Compressor');
    expect(r.projectXml).toContain('<Equalizer');
    expect(r.projectXml).toContain('<Limiter');
    expect(r.projectXml).toContain('role="master"');
    expect(r.files.map(f => f.path).sort()).toEqual(['audio/Beat.wav', 'audio/Prise 1.wav', NOVA_SIDECAR, 'nova/samples/msample-s1.wav'].sort());
    expect(r.stats).toMatchObject({ tracks: 6, clips: 6, audioClips: 4, notes: 4, audioFiles: 3 });
    expect(s.app).toBe('NOVA');
    expect(s.title).toBe('Projet test');
  });

  it('pistes, routage, volume, pan, mute, dossiers et réglages NOVA identiques', () => {
    const src = state.tracks.filter(t => t.id !== 'master');
    expect(conv.tracks.map(t => [t.name, t.type, t.color, t.volume, t.pan, t.isMuted])).toEqual(src.map(t => [t.name, t.type, t.color, t.volume, t.pan, t.isMuted]));
    const byName = (n: string) => conv.tracks.find(t => t.name === n)!;
    const lead = byName('Lead « été » & <co>');
    expect(lead.outputTrackId).toBe(byName('Voix').id);
    expect(lead.parentFolderId).toBe(byName('Voix').id);
    expect(byName('Voix').folder).toEqual({ kind: 'routing', isOpen: true });
    expect(lead.sends).toEqual([{ id: byName('Réverbe').id, level: 0.42, isEnabled: true, preFader: true, slot: 2 }]);
    expect([lead.inputTrimDb, lead.comment]).toEqual([-3, 'SM7B']);
    expect(byName('Synth').novaSynth).toEqual({ preset: 'pad', cutoff: 1800 });
    expect(byName('Sampler').melodicSampler).toEqual({ sampleId: 's1', sampleName: 'Pluck' });
    expect(conv.samples.map(x => x.id)).toEqual(['msample-s1']);
  });

  it("clips à l'échantillon près, fondus, gain, coupé, notes (glissé, note muette) identiques", () => {
    const src = state.tracks.filter(t => t.id !== 'master');
    src.forEach((t, i) => {
      const got = conv.tracks[i].clips;
      expect(got.length).toBe(t.clips.length);
      t.clips.forEach((c, k) => {
        const g = got[k];
        for (const f of ['start', 'duration', 'offset', 'fadeIn', 'fadeOut'] as const) expect(near(g[f], c[f]), `${c.name}.${f}`).toBe(true);
        expect(Math.round(g.start * SR)).toBe(Math.round(c.start * SR));
        const { id: _a, bufferId: _b, start: _s, duration: _d, offset: _o, fadeIn: _fi, fadeOut: _fo, notes: n1, ...restSrc } = c;
        const { id: _c, bufferId: _e, start: _s2, duration: _d2, offset: _o2, fadeIn: _fi2, fadeOut: _fo2, notes: n2, ...restGot } = g;
        expect(restGot).toEqual(restSrc);
        if (n1) expect(n2!.map(({ id: _i, ...x }) => x)).toEqual(n1.map(({ id: _i, ...x }) => x));
      });
    });
  });

  it('son identique au bit près (WAV 32 bits flottants)', () => {
    const lead = conv.tracks[1];
    const b = conv.buffers.find(x => x.id === lead.clips[0].bufferId)!;
    expect(b.sampleRate).toBe(SR);
    expect(Array.from(b.channels[0])).toEqual(Array.from(audio.get('voix')!.channels[0]));
  });

  it('effets, automation, tempo, mesure, repères et master identiques', () => {
    const lead = conv.tracks[1];
    expect(lead.plugins.map(p => [p.type, p.name, p.isEnabled, p.params])).toEqual(state.tracks[1].plugins.map(p => [p.type, p.name, p.isEnabled, p.params]));
    const comp = lead.plugins[0];
    expect(lead.automationLanes.map(l => l.parameterName)).toEqual(['volume', 'pan', `plugin::${comp.id}::threshold`]);
    lead.automationLanes.forEach((l, i) => {
      const o = state.tracks[1].automationLanes[i];
      expect([l.color, l.isExpanded, l.min, l.max]).toEqual([o.color, o.isExpanded, o.min, o.max]);
      expect(l.points.map(p => [p.curveType])).toEqual(o.points.map(p => [p.curveType]));
      l.points.forEach((p, k) => { expect(near(p.time, o.points[k].time)).toBe(true); expect(near(p.value, o.points[k].value)).toBe(true); });
    });
    expect([conv.bpm, conv.timeSignature, conv.tempoEvents]).toEqual([state.bpm, state.timeSignature, state.tempoEvents]);
    expect(conv.markers.map(({ id: _i, ...m }) => ({ ...m, time: +m.time.toFixed(9) }))).toEqual(state.markers.map(({ id: _i, ...m }) => ({ ...m, time: +m.time.toFixed(9) })));
    expect(conv.master!.volume).toBe(0.95);
    expect(conv.master!.plugins.map(p => [p.type, p.params])).toEqual([['LIMITER', state.tracks[6].plugins[0].params]]);
    expect(conv.report.absentPlugins).toEqual([]);
    expect(conv.report.fromNova).toBe(true);
  });

  it('import dans un projet vide : une seule opération, tout est repris', () => {
    const empty = { ...project().state, tracks: [project().state.tracks[6]], tempoEvents: undefined, markers: [], bpm: 140 } as DAWState;
    const m = mergeDawImport(empty, conv, { takeProjectSettings: true }, 'z');
    expect(m.state.tracks.map(t => t.name)).toEqual([...state.tracks.filter(t => t.id !== 'master').map(t => t.name), 'Master']);
    expect(m.state.bpm).toBe(90);
    expect(m.state.tempoEvents).toEqual(state.tempoEvents);
    expect(m.state.markers.length).toBe(2);
    expect(m.state.tracks.find(t => t.name === 'Synth')!.isMuted).toBe(true);
    const lead = m.state.tracks.find(t => t.name.startsWith('Lead'))!;
    expect(lead.parentFolderId).toBe(m.state.tracks.find(t => t.name === 'Voix')!.id);
    expect(m.state.tracks.find(t => t.id === 'master')!.plugins[0].type).toBe('LIMITER');
    // Sans reprendre les réglages : le tempo du projet reste.
    const keep = mergeDawImport(empty, conv, { takeProjectSettings: false }, 'z');
    expect(keep.state.bpm).toBe(140);
  });

  it("verrous : beat du catalogue sans licence jamais écrit", () => {
    const { state: st, audio: au } = project();
    st.tracks[2] = { ...st.tracks[2], instrumentId: 'beat-42' };
    const locked = buildDawProject(st, id => au.get(id) || null, { owned: [] });
    expect(locked.files.some(f => f.path === 'audio/Beat.wav')).toBe(false);
    expect(locked.skipped.join(' ')).toMatch(/sans licence/);
    const ok = buildDawProject(st, id => au.get(id) || null, { owned: ['beat-42'] });
    expect(ok.files.some(f => f.path === 'audio/Beat.wav')).toBe(true);
  });
});

describe('lecture par le format seul (sans nova/nova.json)', () => {
  const { state, audio } = project();
  const r = buildDawProject(state, id => audio.get(id) || null, { format: '24' });
  const files = filesOf(r, [NOVA_SIDECAR]);
  const s = readDawProject(files);
  const conv = dawProjectToNova(s, audioOf(files), { idPrefix: 'y' });

  it('positions, fondus, notes, volume, pan, routage, tempo repris', () => {
    expect(s.sidecar).toBeNull();
    const src = state.tracks.filter(t => t.id !== 'master');
    expect(conv.tracks.map(t => [t.name, t.volume, t.pan, t.isMuted])).toEqual(src.map(t => [t.name, t.volume, t.pan, t.isMuted]));
    src.forEach((t, i) => t.clips.forEach((c, k) => {
      const g = conv.tracks[i].clips[k];
      expect(Math.round(g.start * SR)).toBe(Math.round(c.start * SR));
      expect(Math.round(g.duration * SR)).toBe(Math.round(c.duration * SR));
      if (!c.notes) expect(Math.round(g.offset * SR)).toBe(Math.round(c.offset * SR));
      expect(near(g.fadeIn, c.fadeIn, 1e-9) && near(g.fadeOut, c.fadeOut, 1e-9)).toBe(true);
      expect(!!g.isMuted).toBe(!!c.isMuted);
      if (c.notes) {
        const playable = c.notes.filter(n => !n.muted);
        expect(g.notes!.map(n => [n.pitch, n.velocity, +n.start.toFixed(9), +n.duration.toFixed(9)])).toEqual(playable.map(n => [n.pitch, n.velocity, +n.start.toFixed(9), +n.duration.toFixed(9)]));
      }
    }));
    expect(conv.tracks[1].outputTrackId).toBe(conv.tracks[0].id);
    expect(conv.tracks[1].sends[0]).toMatchObject({ id: conv.tracks[5].id, level: 0.42, preFader: true });
    expect([conv.bpm, conv.timeSignature]).toEqual([90, { numerator: 4, denominator: 4 }]);
    expect(conv.tempoEvents.map(({ id: _i, ...e }) => e)).toEqual([{ bar: 4, bpm: 120 }, { bar: 8, numerator: 3, denominator: 4 }]);
    // Son en 24 bits : à un pas de quantification près.
    const b = conv.buffers.find(x => x.id === conv.tracks[1].clips[0].bufferId)!;
    const o = audio.get('voix')!.channels[0];
    expect(Math.max(...Array.from(b.channels[0].subarray(0, 5000), (v, i) => Math.abs(v - o[i])))).toBeLessThan(1 / 8388608 + 1e-9);
  });

  it('effets génériques → effets NOVA, effet NOVA par ses réglages, automation reciblée', () => {
    const lead = conv.tracks[1];
    expect(lead.plugins.map(p => p.type)).toEqual(['COMPRESSOR', 'PROEQ12', 'DEESSER']);
    const c = lead.plugins[0].params;
    expect([c.threshold, c.ratio, c.attack, c.release]).toEqual([-21, 3, 0.004, 0.12]);
    expect(c.makeupGain).toBeCloseTo(1.5, 9);
    expect(lead.plugins[1].isEnabled).toBe(false);
    expect(lead.plugins[1].params.bands[4]).toMatchObject({ type: 'peaking', frequency: 1000, gain: -3.5, q: 1.2 });
    expect(lead.plugins[2].params).toMatchObject({ threshold: -30, frequency: 6500, listen: false });
    expect(lead.automationLanes.map(l => l.parameterName)).toEqual(['volume', 'pan', `plugin::${lead.plugins[0].id}::threshold`]);
    expect(lead.automationLanes[2].points.map(p => p.value)).toEqual([-30, -12]);
    expect(conv.master!.plugins[0]).toMatchObject({ type: 'LIMITER', params: { ceiling: -1, inputGain: 4, release: 120 } });
  });
});

// ── Fichier de référence : écrit comme le font les logiciels du marché ──────────────────────
function referenceFile(): Map<string, Uint8Array> {
  const sr = 44100;
  const wav = encodeBwf({ channels: [tone(sr * 4, 330, sr), tone(sr * 4, 331, sr)], sampleRate: sr, format: '24', timeReference: 0, info: { track: 'Guitare', take: 1 } });
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project version="1.0">
  <Application name="Logiciel de référence" version="5.1"/>
  <Transport>
    <Tempo unit="bpm" value="120.0" id="id0" name="Tempo"/>
    <TimeSignature numerator="4" denominator="4" id="id1"/>
  </Transport>
  <Structure>
    <Track contentType="tracks" loaded="true" id="id2" name="Groupe" color="#FF8800">
      <Channel audioChannels="2" role="submix" destination="id20" id="id3"><Volume unit="linear" value="1.0" id="id4"/><Pan unit="normalized" value="0.5" id="id5"/></Channel>
      <Track contentType="audio" loaded="true" id="id6" name="Guitare" color="#3366CC">
        <Channel audioChannels="2" destination="id3" role="regular" solo="false" id="id7">
          <Devices>
            <Vst3Plugin deviceID="ABCDEF0123456789" deviceName="SuperReverb" deviceRole="audioFX" loaded="true" id="id8" name="SuperReverb">
              <Enabled value="true" id="id9" name="On/Off"/><State path="plugins/superreverb.vstpreset"/>
            </Vst3Plugin>
            <Compressor deviceName="Compressor" deviceRole="audioFX" id="id10">
              <Enabled value="true" id="id11"/>
              <Threshold unit="decibel" value="-12.0" id="id12"/><Ratio unit="linear" value="2.5" id="id13"/>
              <Attack unit="seconds" value="0.01" id="id14"/><Release unit="seconds" value="0.2" id="id15"/>
              <InputGain unit="decibel" value="0" id="id16"/><OutputGain unit="decibel" value="6.0" id="id17"/>
            </Compressor>
          </Devices>
          <Mute value="false" id="id18" name="Mute"/>
          <Pan max="1.0" min="0.0" unit="normalized" value="0.75" id="id19" name="Pan"/>
          <Volume max="2.0" min="0.0" unit="linear" value="0.5" id="id21" name="Volume"/>
          <Sends><Send destination="id31" type="post" id="id22"><Volume unit="linear" value="0.3" id="id23"/><Enable value="true" id="id24"/></Send></Sends>
        </Channel>
      </Track>
    </Track>
    <Track contentType="notes" loaded="true" id="id25" name="Piano" color="#00AA55">
      <Channel audioChannels="2" destination="id20" role="regular" id="id26">
        <Devices><ClapPlugin deviceID="com.vendor.piano" deviceName="GrandPiano" deviceRole="instrument" id="id27" name="GrandPiano"/></Devices>
        <Mute value="true" id="id28"/><Volume unit="linear" value="0.8" id="id29"/><Pan unit="normalized" value="0.5" id="id29b"/>
      </Channel>
    </Track>
    <Track contentType="audio" loaded="true" id="id30" name="FX">
      <Channel audioChannels="2" destination="id20" role="effect" id="id31"><Volume unit="linear" value="1" id="id32"/><Pan unit="normalized" value="0.5" id="id33"/></Channel>
    </Track>
    <Track contentType="audio notes" loaded="true" id="id34" name="Master">
      <Channel audioChannels="2" role="master" id="id20"><Volume unit="linear" value="0.9" id="id35"/><Pan unit="normalized" value="0.5" id="id36"/></Channel>
    </Track>
  </Structure>
  <Arrangement id="id40">
    <Lanes timeUnit="beats" id="id41">
      <Lanes track="id6" id="id42">
        <Clips id="id43">
          <Clip time="4.0" duration="4.0" playStart="1.0" fadeTimeUnit="beats" fadeInTime="0.5" fadeOutTime="0.25" name="Riff">
            <Warps contentTimeUnit="seconds" timeUnit="beats" id="id44">
              <Audio algorithm="stretch" channels="2" duration="4.0" sampleRate="44100" id="id45"><File path="audio/guitare.wav"/></Audio>
              <Warp time="0.0" contentTime="0.0"/>
              <Warp time="8.0" contentTime="4.0"/>
            </Warps>
          </Clip>
          <Clip time="12.0" duration="2.0" playStart="0.0" name="Perdu" enable="false">
            <Clips><Clip time="0" duration="2"><Audio channels="1" sampleRate="44100" duration="1" id="id46"><File path="audio/absent.wav"/></Audio></Clip></Clips>
          </Clip>
        </Clips>
        <Points id="id47" unit="linear"><Target parameter="id21"/>
          <RealPoint time="0.0" value="0.5" interpolation="linear"/><RealPoint time="8.0" value="1.0" interpolation="hold"/>
        </Points>
        <Points id="id48" unit="decibel"><Target parameter="id12"/><RealPoint time="4.0" value="-20"/></Points>
      </Lanes>
      <Lanes track="id25" id="id50">
        <Clips id="id51">
          <Clip time="16.0" duration="8.0" playStart="0.0" loopStart="0.0" loopEnd="2.0" name="Boucle">
            <Notes id="id52">
              <Note time="0.0" duration="0.5" channel="0" key="60" vel="0.7874" rel="0.5"/>
              <Note time="1.0" duration="0.5" channel="0" key="64" vel="1.0" rel="0.5"/>
            </Notes>
          </Clip>
        </Clips>
      </Lanes>
    </Lanes>
    <Markers id="id60"><Marker time="16.0" name="Refrain" color="#FF0000" id="id61"/></Markers>
    <TempoAutomation unit="bpm" id="id62">
      <RealPoint time="0.0" value="120.0" interpolation="hold"/>
      <RealPoint time="16.0" value="140.0" interpolation="hold"/>
    </TempoAutomation>
  </Arrangement>
  <Scenes/>
</Project>`;
  return new Map([
    ['project.xml', new TextEncoder().encode(xml)],
    ['metadata.xml', new TextEncoder().encode('<?xml version="1.0"?><MetaData><Title>Référence</Title></MetaData>')],
    ['audio/guitare.wav', wav],
  ]);
}

describe('fichier de référence (autre logiciel)', () => {
  const files = referenceFile();
  const s = readDawProject(files);
  const conv = dawProjectToNova(s, audioOf(files), { idPrefix: 'r' });
  const by = (n: string) => conv.tracks.find(t => t.name === n)!;

  it('pistes, dossier, routage, volume, pan, mute', () => {
    expect(conv.tracks.map(t => [t.name, t.type])).toEqual([['Groupe', TrackType.BUS], ['Guitare', TrackType.AUDIO], ['Piano', TrackType.MIDI], ['FX', TrackType.BUS]]);
    expect(by('Groupe').folder).toEqual({ kind: 'routing', isOpen: true });
    expect(by('Guitare').parentFolderId).toBe(by('Groupe').id);
    expect(by('Guitare').outputTrackId).toBe(by('Groupe').id);
    expect([by('Guitare').volume, by('Guitare').pan, by('Guitare').color]).toEqual([0.5, 0.5, '#3366cc']);
    expect(by('Guitare').sends).toEqual([{ id: by('FX').id, level: 0.3, isEnabled: true }]);
    expect(by('Piano').isMuted).toBe(true);
    expect(conv.master!.volume).toBe(0.9);
    expect(s.title).toBe('Référence');
  });

  it("clip audio calé : position, décalage et fondus à l'échantillon près (44,1 kHz)", () => {
    const c = by('Guitare').clips[0];
    const sr = 44100;
    // 120 BPM : noire = 0,5 s. Début 4 noires = 2 s ; playStart 1 noire → 0,5 s dans le son.
    expect(Math.round(c.start * sr)).toBe(2 * sr);
    expect(Math.round(c.duration * sr)).toBe(2 * sr);
    expect(Math.round(c.offset * sr)).toBe(sr / 2);
    expect(c.fadeIn).toBeCloseTo(0.25, 12);
    expect(c.fadeOut).toBeCloseTo(0.125, 12);
    expect(c.bufferId).toBeTruthy();
    expect(conv.buffers[0].sampleRate).toBe(sr);
  });

  it('son absent : clip gardé à sa place, muet, signalé', () => {
    const c = by('Guitare').clips[1];
    expect([c.isOffline, c.isMuted, c.name]).toEqual([true, true, 'Perdu']);
    expect(c.start).toBeCloseTo(6, 12);
    expect(conv.report.missing).toEqual(['absent.wav']);
  });

  it('boucle MIDI dépliée après le changement de tempo (140 BPM)', () => {
    const c = by('Piano').clips[0];
    expect(c.start).toBeCloseTo(8, 12); // 16 noires à 120
    expect(c.duration).toBeCloseTo(8 * 60 / 140, 12);
    expect(c.notes!.map(n => [n.pitch, n.velocity, +n.start.toFixed(9)])).toEqual([
      [60, 100, 0], [64, 127, +(60 / 140).toFixed(9)], [60, 100, +(120 / 140).toFixed(9)], [64, 127, +(180 / 140).toFixed(9)],
      [60, 100, +(240 / 140).toFixed(9)], [64, 127, +(300 / 140).toFixed(9)], [60, 100, +(360 / 140).toFixed(9)], [64, 127, +(420 / 140).toFixed(9)]]);
  });

  it('tempo, repères, effets génériques, automation, plugins absents signalés', () => {
    expect([conv.bpm, conv.tempoEvents.map(({ id: _i, ...e }) => e)]).toEqual([120, [{ bar: 4, bpm: 140 }]]);
    expect(conv.markers.map(m => [m.name, m.time, m.color])).toEqual([['Refrain', 8, '#ff0000']]);
    const g = by('Guitare');
    expect(g.plugins.map(p => p.type)).toEqual(['COMPRESSOR']);
    expect(g.plugins[0].params).toMatchObject({ threshold: -12, ratio: 2.5, attack: 0.01, release: 0.2 });
    expect(g.plugins[0].params.makeupGain).toBeCloseTo(Math.pow(10, 6 / 20), 9);
    expect(g.automationLanes.map(l => [l.parameterName, l.points.map(p => [p.time, p.value])])).toEqual([
      ['volume', [[0, 0.5], [4, 1]]], [`plugin::${g.plugins[0].id}::threshold`, [[2, -20]]]]);
    expect(conv.report.absentPlugins).toEqual(['« SuperReverb » (VST3) sur « Guitare »', 'instrument « GrandPiano » sur « Piano » (remplacé par le synthé NOVA)']);
    expect(conv.report.lines.join('\n')).toMatch(/plugins absents/);
    expect(conv.report.fromNova).toBe(false);
  });

  it('fichier qui n\'est pas un DAWproject : message clair', () => {
    expect(() => readDawProject(new Map())).toThrow(/project\.xml absent/);
    expect(() => readDawProject(new Map([['project.xml', new TextEncoder().encode('<Autre/>')]]))).toThrow(/racine/);
  });
});
