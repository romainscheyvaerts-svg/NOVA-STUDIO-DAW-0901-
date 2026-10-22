/**
 * Séance DAWproject lue (dawProjectRead) → pistes NOVA, prêtes pour
 * utils/sessionImport.applyImport, avec tempo, mesure, repères et réglages du master.
 *
 * Un fichier écrit par NOVA porte `nova/nova.json` : courbes de fondu, gain de clip,
 * réglages complets des effets, instrument… y sont relus pour un aller-retour identique.
 * Un fichier d'un autre logiciel est repris par le format seul : compresseur, limiteur,
 * gate et EQ génériques deviennent ceux de NOVA ; les plugins (VST, CLAP, AU) et
 * instruments absents sont listés clairement dans le rapport.
 *
 * Module pur : tests/dawProject.test.ts.
 */
import { FADER_MAX_GAIN } from '../faderLaw';
import { AutomationLane, Clip, DAWState, Marker, MidiNote, PluginInstance, TimeSignature, Track, TrackType } from '../../types';
import { buildTempoMap, timeToPosition, TempoEvent } from '../tempoMap';
import type { DawDevice, DawSession, DawTrack } from './dawProjectRead';
import { panFromNormalized } from './dawProjectRead';
import { CLIP_EXTRAS, TRACK_EXTRAS } from './novaToDawProject';

export interface MediaAudio { channels: Float32Array[]; sampleRate: number }
export interface DawImportBuffer { id: string; channels: Float32Array[]; sampleRate: number }

export interface DawImportReport {
  summary: string;
  lines: string[];
  /** Fichiers son absents ou illisibles (clips gardés à leur place, muets). */
  missing: string[];
  /** Plugins et instruments que NOVA n'a pas (à remplacer à la main). */
  absentPlugins: string[];
  tracks: number;
  clips: number;
  notes: number;
  fromNova: boolean;
}

export interface DawImportResult {
  tracks: Track[];
  buffers: DawImportBuffer[];
  /** Samples des samplers NOVA (registre : leur id d'origine). */
  samples: DawImportBuffer[];
  bpm: number;
  timeSignature: TimeSignature;
  tempoEvents: TempoEvent[];
  markers: Marker[];
  master: Pick<Track, 'volume' | 'pan' | 'plugins' | 'automationLanes'> | null;
  /** Loi de pan du projet NOVA d'origine (absente : fichier d'un autre logiciel). */
  panLaw?: DAWState['panLaw'];
  report: DawImportReport;
}

const COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#facc15', '#34d399', '#fb923c', '#60a5fa', '#f87171'];
const dbToLin = (db: number) => Math.pow(10, db / 20);
const copy = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const EQ_FROM: Record<string, string> = { highPass: 'highpass', lowPass: 'lowpass', bell: 'peaking', lowShelf: 'lowshelf', highShelf: 'highshelf', notch: 'notch', bandPass: 'bandpass' };
const EQ_FREQS = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
const pv = (d: DawDevice, k: string, def: number) => (d.params[k] ? d.params[k].value : def);
const secOf = (d: DawDevice, k: string, def: number) => { const p = d.params[k]; if (!p) return def; return p.unit === 'seconds' || !p.unit ? p.value : p.unit === 'percent' ? p.value / 100 : p.value; };

export function dawProjectToNova(s: DawSession, audioOf: (path: string) => MediaAudio | null, opts: { idPrefix: string }): DawImportResult {
  const side = s.sidecar;
  const P = opts.idPrefix;
  let n = 0;
  const buffers = new Map<string, DawImportBuffer | null>();
  const missing = new Set<string>();
  const absent: string[] = [];
  const lines: string[] = [];
  const bufferFor = (path: string): string | null => {
    if (!buffers.has(path)) {
      const a = audioOf(path);
      buffers.set(path, a && a.channels.length ? { id: `${P}-son${buffers.size + 1}`, channels: a.channels.slice(0, 2), sampleRate: a.sampleRate } : null);
    }
    const b = buffers.get(path);
    if (!b) { missing.add(path.split('/').pop() || path); return null; }
    return b.id;
  };

  // Pistes NOVA : id par piste lue ; tranche → piste (sorties, envois).
  const all = [...s.tracks];
  const tid = new Map<string, string>(all.map((t, i) => [t.xmlId, `${P}-p${i + 1}`]));
  const byChannel = new Map<string, string>();
  all.forEach(t => { if (t.channelId) byChannel.set(t.channelId, tid.get(t.xmlId)!); });
  if (s.master?.channelId) byChannel.set(s.master.channelId, 'master');
  const oldIds = new Map<string, string>();
  all.forEach(t => { const o = side?.tracks[t.xmlId]?.id; if (o) oldIds.set(o, tid.get(t.xmlId)!); });
  const routeOf = (ch?: string) => (ch && byChannel.has(ch) ? byChannel.get(ch)! : 'master');

  // Effets d'une tranche (param lu → voie d'automation NOVA).
  const paramLane = new Map<string, string>();
  const pluginsOf = (t: DawTrack, owner: string): { plugins: PluginInstance[]; instrument: DawDevice | null } => {
    const out: PluginInstance[] = [];
    let instrument: DawDevice | null = null;
    for (const d of t.devices) {
      const fromNova = side?.devices[d.xmlId];
      if (d.role === 'instrument') { instrument = d; continue; }
      if (fromNova) {
        const p = copy(fromNova);
        p.id = `${P}-fx${++n}`;
        if (p.sidechainSourceId) {
          const sc = p.sidechainSourceId.startsWith('bus:') ? undefined : oldIds.get(p.sidechainSourceId);
          if (sc) p.sidechainSourceId = sc; else { delete p.sidechainSourceId; delete p.sidechainSourceName; }
        }
        out.push(p);
        // Réglages automatisables : attribut name = clé NOVA.
        Object.values(d.params).forEach(x => x.xmlId && paramLane.set(x.xmlId, `plugin::${p.id}::${x.label}`));
        d.bands.forEach((b, i) => { if (b.ids.freq) paramLane.set(b.ids.freq, `plugin::${p.id}::b${i + 1}Freq`); if (b.ids.gain) paramLane.set(b.ids.gain, `plugin::${p.id}::b${i + 1}Gain`); if (b.ids.q) paramLane.set(b.ids.q, `plugin::${p.id}::b${i + 1}Q`); });
        continue;
      }
      const id = `${P}-fx${++n}`;
      const base = { id, isEnabled: d.enabled, latency: 0, ...(d.loaded ? {} : { isInactive: true }) };
      const map = (tag: string, key: string) => { const x = d.params[tag]; if (x?.xmlId) paramLane.set(x.xmlId, `plugin::${id}::${key}`); };
      switch (d.kind) {
        case 'Compressor':
          out.push({ ...base, name: 'Compresseur', type: 'COMPRESSOR', params: { isEnabled: d.enabled, threshold: pv(d, 'Threshold', -18), ratio: Math.max(1, pv(d, 'Ratio', 4)), attack: secOf(d, 'Attack', 0.003), release: secOf(d, 'Release', 0.25), makeupGain: dbToLin(pv(d, 'OutputGain', 0) + pv(d, 'InputGain', 0)) } });
          map('Threshold', 'threshold'); map('Ratio', 'ratio');
          continue;
        case 'Limiter':
          out.push({ ...base, name: 'Limiteur', type: 'LIMITER', params: { isEnabled: d.enabled, ceiling: Math.min(0, pv(d, 'Threshold', -1) + pv(d, 'OutputGain', 0)), inputGain: pv(d, 'InputGain', 0), release: Math.round(secOf(d, 'Release', 0.1) * 1000), lookahead: 3, oversample: 4 } });
          map('Threshold', 'ceiling'); map('InputGain', 'inputGain');
          continue;
        case 'NoiseGate':
          out.push({ ...base, name: 'Gate', type: 'GATE', params: { isEnabled: d.enabled, threshold: pv(d, 'Threshold', -40), range: Math.abs(pv(d, 'Range', -80)), attack: secOf(d, 'Attack', 0.0005) * 1000, hold: 20, release: secOf(d, 'Release', 0.08) * 1000 } });
          map('Threshold', 'threshold');
          continue;
        case 'Equalizer': {
          const bands = Array.from({ length: 12 }, (_, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking', frequency: EQ_FREQS[i], gain: 0, q: i === 0 || i === 11 ? Math.SQRT1_2 : 1, isEnabled: i !== 0 && i !== 11 ? true : false, isSolo: false }));
          d.bands.slice(0, 12).forEach((b, i) => {
            bands[i] = { id: i, type: EQ_FROM[b.type] || 'peaking', frequency: b.freq, gain: b.gain, q: b.q, isEnabled: b.enabled, isSolo: false };
            if (b.ids.freq) paramLane.set(b.ids.freq, `plugin::${id}::b${i + 1}Freq`); if (b.ids.gain) paramLane.set(b.ids.gain, `plugin::${id}::b${i + 1}Gain`); if (b.ids.q) paramLane.set(b.ids.q, `plugin::${id}::b${i + 1}Q`);
          });
          if (d.bands.length > 12) lines.push(`⚠️ EQ de « ${t.name} » : ${d.bands.length} bandes, les 12 premières sont reprises.`);
          // Q du format = Q linéaire, comme la convention v2 de l'égaliseur (engine/eqQ.ts) : repris tel quel.
          out.push({ ...base, name: 'EQ 12 bandes', type: 'PROEQ12', params: { isEnabled: d.enabled, masterGain: dbToLin(pv(d, 'OutputGain', 0) + pv(d, 'InputGain', 0)), qVersion: 2, bands } });
          continue;
        }
        default: {
          // Effet NOVA écrit par une version sans fichier nova.json : réglages par nom.
          const m = /^nova\.([A-Z0-9_]+)$/.exec(d.deviceId);
          if (m && m[1] !== 'instrument') {
            const params: Record<string, any> = { isEnabled: d.enabled };
            Object.values(d.params).forEach(x => { params[x.label] = x.isBool ? x.value !== 0 : x.value; if (x.xmlId) paramLane.set(x.xmlId, `plugin::${id}::${x.label}`); });
            out.push({ ...base, name: d.name, type: m[1] as any, params });
            continue;
          }
          const fmt = d.kind === 'Vst3Plugin' ? 'VST3' : d.kind === 'Vst2Plugin' ? 'VST2' : d.kind === 'ClapPlugin' ? 'CLAP' : d.kind === 'AuPlugin' ? 'AU' : 'effet intégré';
          absent.push(`« ${d.name} » (${fmt}) sur « ${t.name} »`);
        }
      }
    }
    return { plugins: out, instrument };
  };

  const automationOf = (t: DawTrack, owner: string): AutomationLane[] => {
    const lanes: AutomationLane[] = [];
    for (const a of t.automation) {
      const ls = side?.lanes[a.xmlId];
      let name: string | undefined, conv = (v: number) => v, min = 0, max = 1;
      if (a.target && a.target === t.ids.volume) { name = 'volume'; max = FADER_MAX_GAIN; if (a.unit === 'decibel') conv = v => dbToLin(v); }
      else if (a.target && a.target === t.ids.pan) { name = 'pan'; min = -1; max = 1; conv = v => (a.unit === 'normalized' || !a.unit ? panFromNormalized(v) : v); }
      else if (a.target && paramLane.has(a.target)) name = paramLane.get(a.target);
      if (!name) continue;
      lanes.push({
        id: `${P}-a${++n}`, parameterName: name,
        color: ls?.color || '#22d3ee', isExpanded: ls?.isExpanded ?? false, min: ls?.min ?? min, max: ls?.max ?? Math.max(max, ...a.points.map(p => conv(p.value))),
        points: a.points.map((p, i) => ({ id: `${P}-ap${++n}`, time: p.time, value: conv(p.value), ...(ls?.curves?.[i] ? { curveType: ls.curves[i] as any } : p.hold ? { curveType: 'HOLD' as const } : {}) })),
      });
    }
    return lanes;
  };

  let clipCount = 0, noteCount = 0, droppedNotes = 0;
  const tracks: Track[] = all.map((t, ti) => {
    const st = side?.tracks[t.xmlId];
    const id = tid.get(t.xmlId)!;
    const hasNotes = t.clips.some(c => c.notes && !c.audio), hasAudio = t.clips.some(c => c.audio);
    const childOut = all.some(c => c.parentXmlId === t.xmlId && c.destination && c.destination === t.channelId);
    const type: TrackType = st?.type ?? (t.isFolder ? TrackType.BUS
      : (t.role === 'effect' || t.role === 'submix') && !hasAudio && !hasNotes ? TrackType.BUS
        : hasNotes && !hasAudio ? TrackType.MIDI : /\bnotes\b/.test(t.contentType) && !/\baudio\b/.test(t.contentType) ? TrackType.MIDI : TrackType.AUDIO);
    const color = t.color || COLORS[ti % COLORS.length];
    const { plugins, instrument } = pluginsOf(t, id);
    const clips: Clip[] = [];
    for (const c of t.clips) {
      const extras = side?.clips[c.xmlId] || {};
      const cid = `${P}-c${++clipCount}`;
      if (c.audio) {
        if (type !== TrackType.AUDIO) { droppedNotes++; continue; }
        const bid = bufferFor(c.audio.path);
        const offExact = typeof extras.offsetExact === 'number' && Math.abs((extras.offsetExact as number) - c.audio.offset) < 0.002 ? extras.offsetExact as number : c.audio.offset;
        const clip: Clip = { id: cid, name: c.name || t.name, color: c.color || color, type: TrackType.AUDIO, start: c.start, duration: c.duration, offset: offExact, fadeIn: c.fadeIn, fadeOut: c.fadeOut };
        for (const k of CLIP_EXTRAS) if (extras[k] !== undefined) (clip as any)[k] = copy(extras[k]);
        if (!c.enabled) clip.isMuted = true;
        if (bid) clip.bufferId = bid; else clip.isOffline = true;
        clips.push(clip);
        continue;
      }
      if (c.notes) {
        if (type === TrackType.AUDIO) { droppedNotes++; continue; }
        const xmlNotes: MidiNote[] = c.notes.map((x, i) => ({ id: `${cid}-n${i + 1}`, pitch: Math.max(0, Math.min(127, x.key)), start: x.start, duration: x.duration, velocity: Math.max(1, Math.min(127, Math.round(x.vel * 127 * 1000) / 1000)) }));
        const novaNotes = Array.isArray(extras.notes) ? (extras.notes as MidiNote[]) : null;
        // Notes de NOVA (glissés, notes muettes, réglages par note) si le fichier n'a pas été retouché ailleurs.
        const same = novaNotes && novaNotes.filter(x => !x.muted).length === xmlNotes.length
          && novaNotes.filter(x => !x.muted).every((x, i) => x.pitch === xmlNotes[i].pitch);
        const notes = same ? copy(novaNotes!) : xmlNotes;
        noteCount += notes.length;
        const clip: Clip = { id: cid, name: c.name || t.name, color: c.color || color, type: TrackType.MIDI, start: c.start, duration: c.duration, offset: 0, fadeIn: 0, fadeOut: 0, notes };
        for (const k of CLIP_EXTRAS) if (extras[k] !== undefined) (clip as any)[k] = copy(extras[k]);
        if (!c.enabled) clip.isMuted = true;
        clips.push(clip);
      }
    }
    const track: Track = {
      id, name: t.name, type, color, isMuted: t.mute, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: t.volume, pan: t.pan, outputTrackId: routeOf(t.destination), sends: [], clips, plugins, automationLanes: [], totalLatency: 0,
    };
    for (const k of TRACK_EXTRAS) if (st?.extras[k] !== undefined) (track as any)[k] = copy(st.extras[k]);
    if (st?.extras.vstInstrument) track.vstInstrument = copy(st.extras.vstInstrument as any);
    if (t.isFolder && !track.folder) track.folder = { kind: childOut ? 'routing' : 'basic', isOpen: true };
    track.sends = t.sends.filter(x => byChannel.has(x.destination)).map(x => {
      const ss = st?.sends?.[x.xmlId];
      return {
        id: byChannel.get(x.destination)!, level: x.volume, isEnabled: ss ? ss.isEnabled : x.enabled,
        ...(ss?.isMuted !== undefined ? { isMuted: ss.isMuted } : {}), ...(ss?.slot !== undefined ? { slot: ss.slot } : {}),
        ...((ss?.pan ?? (x.pan !== null ? x.pan : undefined)) !== undefined ? { pan: ss?.pan ?? x.pan! } : {}),
        ...(ss ? (ss.preFader !== undefined ? { preFader: ss.preFader } : {}) : x.pre ? { preFader: true } : {}),
      };
    });
    if (instrument && !st && (instrument.kind !== 'BuiltinDevice' || instrument.vendor !== 'NOVA')) absent.push(`instrument « ${instrument.name} » sur « ${t.name} » (remplacé par le synthé NOVA)`);
    return track;
  });
  // Automation après les effets (ids des réglages connus) ; dossiers parents.
  all.forEach((t, i) => {
    tracks[i].automationLanes = automationOf(t, tracks[i].id);
    // Voies « Pan G » / « Pan D » d'une piste stéréo NOVA (gardées dans nova.json).
    const pl = side?.tracks[t.xmlId]?.extras.panLanes;
    if (Array.isArray(pl)) tracks[i].automationLanes.push(...(copy(pl) as AutomationLane[]).map(l => ({ ...l, id: `${P}-a${++n}`, points: (l.points || []).map(p => ({ ...p, id: `${P}-ap${++n}` })) })));
    if (t.parentXmlId && tid.has(t.parentXmlId)) tracks[i].parentFolderId = tid.get(t.parentXmlId);
  });

  // Master.
  let master: DawImportResult['master'] = null;
  if (s.master) {
    const { plugins } = pluginsOf(s.master, 'master');
    master = { volume: s.master.volume, pan: s.master.pan, plugins, automationLanes: automationOf(s.master, 'master') };
  }

  // Tempo, mesure.
  const timeSignature: TimeSignature = { numerator: s.numerator, denominator: s.denominator };
  let tempoEvents: TempoEvent[] = [];
  let approxTempo = 0;
  if (side?.tempoEvents) tempoEvents = copy(side.tempoEvents) as TempoEvent[];
  else {
    const changes = [
      ...s.clock.points.slice(1).map(p => ({ beat: p.beat, bpm: p.bpm as number | undefined, num: undefined as number | undefined, den: undefined as number | undefined })),
      ...s.meterPoints.filter(m => m.beat > 1e-9).map(m => ({ beat: m.beat, bpm: undefined, num: m.numerator, den: m.denominator })),
    ].sort((a, b) => a.beat - b.beat);
    const m0 = s.meterPoints.find(m => m.beat <= 1e-9);
    if (m0) { timeSignature.numerator = m0.numerator; timeSignature.denominator = m0.denominator; }
    let cur = { num: timeSignature.numerator, den: timeSignature.denominator };
    let curBpm = s.bpm;
    for (const c of changes) {
      if (c.bpm !== undefined) { if (Math.abs(c.bpm - curBpm) < 1e-9) c.bpm = undefined; else curBpm = c.bpm; }
      if (c.bpm === undefined && c.num === undefined) continue;
      if (c.num !== undefined) {
        if (c.num === cur.num && c.den === cur.den) { c.num = undefined; c.den = undefined; if (c.bpm === undefined) continue; }
        else cur = { num: c.num, den: c.den! };
      }
      const map = buildTempoMap(s.bpm, timeSignature, tempoEvents);
      const pos = timeToPosition(map, s.clock.secAt(c.beat));
      const onBar = pos.beat === 0 && pos.frac < 1e-6;
      const bar = onBar ? pos.bar : pos.bar + 1;
      if (!onBar) approxTempo++;
      const prev = tempoEvents.find(e => e.bar === bar);
      if (prev) { if (c.bpm !== undefined) prev.bpm = c.bpm; if (c.num !== undefined) { prev.numerator = c.num; prev.denominator = c.den; } }
      else tempoEvents.push({ id: `${P}-tempo${++n}`, bar, ...(c.bpm !== undefined ? { bpm: c.bpm } : {}), ...(c.num !== undefined ? { numerator: c.num, denominator: c.den } : {}) });
    }
  }

  const markers: Marker[] = s.markers.map((m, i) => {
    const ms = side?.markers[m.xmlId];
    return { id: `${P}-m${i + 1}`, name: m.name, time: m.time, type: (ms?.type as any) || 'MARKER', color: m.color || '#facc15', ...(ms?.endTime !== undefined ? { endTime: ms.endTime } : {}), ...(ms?.number !== undefined ? { number: ms.number } : {}) };
  });

  const samples: DawImportBuffer[] = [];
  for (const sid of side?.samples || []) {
    const a = audioOf(`nova/samples/${sid}.wav`);
    if (a) samples.push({ id: sid, channels: a.channels.slice(0, 2), sampleRate: a.sampleRate });
  }

  // Rapport.
  const fromNova = !!side;
  const audioClips = tracks.reduce((k, t) => k + t.clips.filter(c => !c.notes).length, 0);
  const summary = `${plural(tracks.length, 'piste')}, ${plural(audioClips, 'clip audio', 'clips audio')}, ${plural(noteCount, 'note')}`;
  const out: string[] = [];
  out.push(`${summary}${s.app ? ` (fichier de ${s.app})` : ''}.`);
  out.push(`Tempo : ${Math.round(s.bpm * 1000) / 1000} BPM, ${timeSignature.numerator}/${timeSignature.denominator}${tempoEvents.length ? ` et ${plural(tempoEvents.length, 'changement')} de tempo ou de mesure` : ''}.`);
  if (approxTempo) out.push(`⚠️ ${plural(approxTempo, 'changement')} de tempo hors début de mesure, posé${approxTempo > 1 ? 's' : ''} à la mesure suivante (positions des clips gardées).`);
  const fx = tracks.reduce((k, t) => k + t.plugins.length, 0) + (master?.plugins.length || 0);
  if (fx) out.push(`${plural(fx, 'effet repris', 'effets repris')}${fromNova ? ' avec tous leurs réglages' : ' (compresseur, limiteur, gate et EQ du format → ceux de NOVA)'}.`);
  if (markers.length) out.push(`${plural(markers.length, 'repère')}.`);
  if (absent.length) out.push(`⚠️ ${plural(absent.length, 'plugin absent', 'plugins absents')} de NOVA, à remplacer à la main : ${absent.join(', ')}.`);
  if (missing.size) out.push(`⚠️ ${plural(missing.size, 'fichier son introuvable', 'fichiers son introuvables')} : ${[...missing].join(', ')} — clips gardés à leur place, muets.`);
  if (droppedNotes) out.push(`⚠️ ${plural(droppedNotes, 'clip')} audio et MIDI mélangés sur une même piste : non repris.`);
  out.push(...s.warnings.map(w => `⚠️ ${w}`));
  out.push(...lines);
  return {
    tracks, buffers: [...buffers.values()].filter((b): b is DawImportBuffer => !!b), samples, bpm: s.bpm, timeSignature, tempoEvents, markers, master,
    ...(side?.panLaw !== undefined ? { panLaw: side.panLaw } : {}),
    report: { summary, lines: out, missing: [...missing], absentPlugins: absent, tracks: tracks.length, clips: clipCount, notes: noteCount, fromNova },
  };
}
