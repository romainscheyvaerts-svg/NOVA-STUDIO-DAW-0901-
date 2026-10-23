/**
 * Projet NOVA → fichier DAWproject (format ouvert d'échange entre logiciels de musique,
 * ZIP + XML, licence MIT) : `project.xml`, `metadata.xml`, les sons en WAV dans `audio/`,
 * et `nova/nova.json` (ce que le format ne décrit pas : courbes de fondu, gain de clip,
 * réglages complets des effets NOVA, instrument…) pour qu'un aller-retour NOVA → NOVA
 * soit identique. Les autres logiciels ignorent `nova/`.
 *
 * Ce qui est écrit dans le format lui-même :
 *  - tempo, mesure, changements de tempo et de mesure, repères ;
 *  - pistes (nom, couleur, type audio / notes / dossier), volume (linéaire), panoramique
 *    (normalisé 0…1), mute, solo, sortie, envois ;
 *  - clips audio (position et longueur en noires, décalage dans le son, fondus en secondes,
 *    clip coupé = « enable=false »), avec leur son ; clips MIDI et leurs notes ;
 *  - automation de volume, de panoramique et des réglages d'effets écrits ;
 *  - effets : compresseur, limiteur, gate et EQ en appareils génériques du format ; les autres
 *    effets NOVA en « BuiltinDevice » avec leurs réglages ; VST3 avec leur identifiant.
 *
 * Mêmes verrous que l'export AAF : le beat du catalogue sans licence et les sons des kits
 * NOVA ne sont jamais écrits en fichier. Module pur : tests/dawProject.test.ts.
 */
import { FADER_MAX_GAIN } from '../faderLaw';
import { PAN_L, PAN_R } from '../panLaw';
import { AutomationLane, Clip, DAWState, PluginInstance, Track, TrackType } from '../../types';
import { encodeBwf, BwfFormat } from '../bwf';
import { usesKitSounds } from '../drumKitLibrary';
import { buildTempoMap, quartersAt } from '../tempoMap';
import { BeatClock, novaClock } from './dawTime';
import { el, writeXml, XmlNode } from './xml';

export interface AudioData { channels: Float32Array[]; sampleRate: number }

export interface DawExportOptions {
  /** Beats du catalogue achetés (ids) ; `'all'` : admin. Absent : aucun achat connu. */
  owned?: (string | number)[] | 'all';
  /** Format des WAV : 32 bits flottants (au bit près, défaut) ou 24 bits. */
  format?: BwfFormat;
  /** Aperçu : tout est calculé sauf les WAV (fenêtre d'export, rapide). */
  dryRun?: boolean;
  /** Version de NOVA écrite dans le fichier. */
  appVersion?: string;
}

export interface DawExportFile { path: string; bytes: Uint8Array }

export interface DawExportResult {
  projectXml: string;
  metadataXml: string;
  /** Sons (audio/*.wav), samples des samplers et nova/nova.json. */
  files: DawExportFile[];
  stats: { tracks: number; clips: number; audioClips: number; notes: number; audioFiles: number; devices: number; automation: number };
  /** Pistes ou clips non écrits, avec la raison. */
  skipped: string[];
  /** Remarques (ce que les autres logiciels ne reprendront pas). */
  notes: string[];
}

/** Ce que le format ne porte pas : relu par NOVA seulement. */
export interface NovaSidecar {
  format: 'nova-dawproject';
  version: 1;
  tracks: Record<string, { id: string; type: TrackType; extras: Record<string, unknown>; sends?: Record<string, { isEnabled: boolean; isMuted?: boolean; slot?: number; pan?: number; preFader?: boolean }> }>;
  clips: Record<string, Record<string, unknown>>;
  devices: Record<string, PluginInstance>;
  lanes: Record<string, { parameterName: string; color: string; isExpanded: boolean; min: number; max: number; curves: (string | null)[] }>;
  markers: Record<string, { type: string; endTime?: number; number?: number }>;
  samples: string[];
  tempoEvents?: DAWState['tempoEvents'];
  /** Loi de pan du projet (absente : −3 dB). */
  panLaw?: DAWState['panLaw'];
}

export const NOVA_SIDECAR = 'nova/nova.json';
export const AUDIO_DIR = 'audio';

/** Champs de piste propres à NOVA gardés pour l'aller-retour. */
export const TRACK_EXTRAS = ['inputTrimDb', 'phaseInvert', 'monoSum', 'stereoWidth', 'comment', 'isGuide', 'guideLevel', 'guideMuted', 'midiChannel',
  'novaSynth', 'bass808', 'melodicSampler', 'breathKind', 'isHidden', 'soloSafe', 'folder', 'automationMode',
  // Double pan des pistes stéréo (G / D, lien, format) : le format n'a qu'un pan par piste.
  'stereoPan', 'panLink', 'panFormat'] as const;
/** Champs de clip propres à NOVA gardés pour l'aller-retour. */
export const CLIP_EXTRAS = ['gain', 'gainPoints', 'fadeInCurve', 'fadeOutCurve', 'takeNumber', 'cc', 'syncPoint', 'originStart', 'lock', 'transcript', 'breaths'] as const;

const linToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -144);
const label = (t: Track) => `« ${t.name} »`;
const copy = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const isMaster = (t: Track) => t.id === 'master';
const safe = (s: string) => (s || 'son').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || 'son';
const color = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : c && /^#[0-9a-f]{3}$/i.test(c) ? `#${c.slice(1).split('').map(x => x + x).join('')}`.toLowerCase() : undefined);

/** Nom lisible d'un effet NOVA (sans dépendre de l'interface). */
const DEVICE_NAMES: Record<string, string> = {
  REVERB: 'Réverbe', DELAY: 'Délai', CHORUS: 'Chorus', FLANGER: 'Flanger', DOUBLER: 'Doubleur', STEREOSPREADER: 'Largeur stéréo', COMPRESSOR: 'Compresseur',
  AUTOTUNE: 'Autotune', DEESSER: 'De-esser', DENOISER: 'Débruiteur', PROEQ12: 'EQ 12 bandes', VOCALSATURATOR: 'Saturation voix', MASTERSYNC: 'Master',
  LIMITER: 'Limiteur', HARMONIZER: 'Harmoniseur', VOICESHIFT: 'Voix grave/aiguë', TIMEFX: 'Tape stop', DJFILTER: 'Filtre DJ', LOFI: 'Lo-fi',
  GATEFX: 'Gate rythmique', GATE: 'Gate', OPTO_VINTAGE: 'Opto Vintage', FET76: 'FET 76', LEVELER2A: 'Leveler', VOXSTRIP: 'Tranche voix',
  MASTERTRANSIENT: 'Transitoires', MBCOMP: 'Compresseur multibande', DYNEQ: 'EQ dynamique',
};

const EQ_TYPES: Record<string, string> = { highpass: 'highPass', lowpass: 'lowPass', peaking: 'bell', lowshelf: 'lowShelf', highshelf: 'highShelf', notch: 'notch', bandpass: 'bandPass' };

export function buildDawProject(state: DAWState, getAudio: (bufferId: string) => AudioData | null, opts: DawExportOptions = {}): DawExportResult {
  const clock: BeatClock = novaClock(state);
  const B = (sec: number) => clock.beatAt(sec);
  const skipped: string[] = [];
  const notes: string[] = [];
  const files: DawExportFile[] = [];
  const stats = { tracks: 0, clips: 0, audioClips: 0, notes: 0, audioFiles: 0, devices: 0, automation: 0 };
  const side: NovaSidecar = { format: 'nova-dawproject', version: 1, tracks: {}, clips: {}, devices: {}, lanes: {}, markers: {}, samples: [] };
  const format: BwfFormat = opts.format || '32f';
  let nId = 0;
  const id = (p = 'id') => `${p}${++nId}`;

  // ── Sons : un WAV par son utilisé (clip à l'envers : son rendu à part). ──────────────────────
  const audioFiles = new Map<string, { path: string; channels: number; sampleRate: number; duration: number }>();
  const usedNames = new Set<string>();
  const audioFor = (key: string, name: string, make: () => AudioData | null, dir = AUDIO_DIR) => {
    const got = audioFiles.get(key);
    if (got) return got;
    const a = make();
    if (!a || !a.channels.length || !a.channels[0].length) return null;
    let base = safe(name), n = 1;
    while (usedNames.has(`${dir}/${base}${n > 1 ? ` ${n}` : ''}.wav`.toLowerCase())) n++;
    const path = `${dir}/${base}${n > 1 ? ` ${n}` : ''}.wav`;
    usedNames.add(path.toLowerCase());
    const chans = a.channels.slice(0, 2);
    if (!opts.dryRun) files.push({ path, bytes: encodeBwf({ channels: chans, sampleRate: a.sampleRate, format, timeReference: 0, info: { project: state.name, track: name, take: 1 } }) });
    const f = { path, channels: chans.length, sampleRate: a.sampleRate, duration: chans[0].length / a.sampleRate };
    audioFiles.set(key, f);
    stats.audioFiles++;
    return f;
  };

  // ── Identifiants des pistes et des tranches (sorties et envois les référencent). ────────────
  const tracks = state.tracks;
  const owned = opts.owned === 'all' ? null : (opts.owned || []).map(String);
  const blocked = new Set<string>();
  for (const t of tracks) {
    if (isMaster(t)) continue;
    if (owned && t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '' && !owned.includes(String(t.instrumentId))) {
      skipped.push(`${label(t)} : beat du catalogue sans licence, non exporté. Achète sa licence sur le site pour l'exporter.`);
      blocked.add(t.id);
    }
  }
  const ids = new Map<string, { track: string; channel: string; volume: string; pan: string; mute: string }>();
  for (const t of tracks) if (!blocked.has(t.id)) ids.set(t.id, { track: id('track'), channel: id('ch'), volume: id('vol'), pan: id('pan'), mute: id('mute') });
  const sendTargets = new Set(tracks.flatMap(t => (t.sends || []).map(s => s.id)));
  const outTargets = new Set(tracks.map(t => t.outputTrackId));
  const paramIds = new Map<string, string>(); // `${pluginId}::${clé}` → id du paramètre écrit

  // ── Effets ─────────────────────────────────────────────────────────────────────────
  const real = (name: string, value: number, unit: string, extra: Record<string, number> = {}, key?: string, pluginId?: string) => {
    const pid = id('p');
    if (key && pluginId) paramIds.set(`${pluginId}::${key}`, pid);
    return el(name, { id: pid, name: key || name, unit, value, ...extra });
  };
  const boolP = (name: string, value: boolean, n = name) => el(name, { id: id('p'), name: n, value: value ? 'true' : 'false' });
  const deviceOf = (p: PluginInstance, role: 'audioFX' | 'instrument'): XmlNode => {
    const did = id('dev');
    side.devices[did] = copy({ ...p });
    stats.devices++;
    const q = p.params || {};
    const base = { id: did, deviceRole: role, deviceName: p.type === 'VST3' ? p.name : (DEVICE_NAMES[p.type] || p.name), deviceVendor: 'NOVA', loaded: p.isInactive ? 'false' : 'true', name: p.name };
    const enabled = boolP('Enabled', p.isEnabled !== false, 'Actif');
    const n = (k: string, d: number) => (typeof q[k] === 'number' && Number.isFinite(q[k]) ? q[k] as number : d);
    switch (p.type) {
      case 'COMPRESSOR':
        return el('Compressor', base, [enabled,
          real('Threshold', n('threshold', -18), 'decibel', {}, 'threshold', p.id), real('Ratio', n('ratio', 4), 'linear', {}, 'ratio', p.id),
          real('Attack', n('attack', 0.003), 'seconds'), real('Release', n('release', 0.25), 'seconds'),
          real('InputGain', 0, 'decibel'), real('OutputGain', linToDb(n('makeupGain', 1)), 'decibel'), boolP('AutoMakeup', false)]);
      case 'LIMITER':
        return el('Limiter', base, [enabled,
          real('Threshold', n('ceiling', -1), 'decibel', {}, 'ceiling', p.id), real('InputGain', n('inputGain', 0), 'decibel', {}, 'inputGain', p.id),
          real('OutputGain', 0, 'decibel'), real('Attack', n('lookahead', 3) / 1000, 'seconds'), real('Release', n('release', 100) / 1000, 'seconds')]);
      case 'GATE':
        return el('NoiseGate', base, [enabled,
          real('Threshold', n('threshold', -40), 'decibel', {}, 'threshold', p.id), real('Ratio', 100, 'linear'),
          real('Attack', n('attack', 0.5) / 1000, 'seconds'), real('Release', n('release', 80) / 1000, 'seconds'), real('Range', -Math.abs(n('range', 80)), 'decibel')]);
      case 'PROEQ12': {
        const bands: any[] = Array.isArray(q.bands) ? q.bands : [];
        return el('Equalizer', base, [enabled,
          ...bands.map((b, i) => el('Band', { type: EQ_TYPES[b.type] || 'bell' }, [
            real('Freq', Number(b.frequency) || 1000, 'hertz', {}, `b${i + 1}Freq`, p.id), real('Gain', Number(b.gain) || 0, 'decibel', {}, `b${i + 1}Gain`, p.id),
            real('Q', Number(b.q) || 1, 'linear', {}, `b${i + 1}Q`, p.id), boolP('Enabled', b.isEnabled !== false)])),
          real('InputGain', 0, 'decibel'), real('OutputGain', linToDb(n('masterGain', 1)), 'decibel')]);
      }
      case 'VST3':
        return el('Vst3Plugin', { ...base, deviceID: String(q.uid || q.cid || q.localPath || ''), deviceVendor: String(q.vendor || ''), pluginVersion: q.version ? String(q.version) : undefined }, [enabled]);
      default: {
        // Effet NOVA : appareil générique, réglages numériques et interrupteurs (automation possible).
        const params: XmlNode[] = [];
        for (const [k, v] of Object.entries(q)) {
          if (k === 'isEnabled') continue;
          if (typeof v === 'number' && Number.isFinite(v)) params.push(real('RealParameter', v, 'linear', {}, k, p.id));
          else if (typeof v === 'boolean') params.push(boolP('BoolParameter', v, k));
        }
        return el('BuiltinDevice', { ...base, deviceID: `nova.${p.type}` }, [el('Parameters', {}, params), enabled]);
      }
    }
  };
  const instrumentOf = (t: Track): XmlNode | null => {
    if (t.vstInstrument) {
      const did = id('dev');
      stats.devices++;
      return el('Vst3Plugin', { id: did, deviceRole: 'instrument', deviceName: t.vstInstrument.pluginName || t.vstInstrument.name || 'Instrument', deviceID: t.vstInstrument.uid || '', loaded: 'true', name: t.vstInstrument.pluginName || 'Instrument' }, [boolP('Enabled', true, 'Actif')]);
    }
    const isNotes = t.type !== TrackType.AUDIO && t.type !== TrackType.BUS && t.type !== TrackType.SEND;
    if (!isNotes) return null;
    const name = t.bass808 ? 'Basse 808' : t.melodicSampler ? (t.melodicSampler.instrument ? `Instrument (${t.melodicSampler.instrument})` : 'Sampler') : t.drumMachine ? 'Boîte à rythmes' : 'Synthé';
    stats.devices++;
    return el('BuiltinDevice', { id: id('dev'), deviceRole: 'instrument', deviceName: `NOVA ${name}`, deviceVendor: 'NOVA', deviceID: `nova.instrument`, loaded: 'true', name }, [boolP('Enabled', true, 'Actif')]);
  };

  // ── Pistes ─────────────────────────────────────────────────────────────────────────
  const lanesXml: XmlNode[] = [];
  const contentOf = (t: Track) => (t.folder ? 'tracks' : t.type === TrackType.AUDIO ? 'audio' : t.type === TrackType.BUS || t.type === TrackType.SEND ? 'audio' : 'notes');
  const roleOf = (t: Track) => (isMaster(t) ? 'master' : t.type === TrackType.BUS || t.type === TrackType.SEND || t.folder ? (sendTargets.has(t.id) && !outTargets.has(t.id) ? 'effect' : 'submix') : 'regular');

  const trackXml = (t: Track, children: XmlNode[]): XmlNode => {
    const ref = ids.get(t.id)!;
    const extras: Record<string, unknown> = {};
    for (const k of TRACK_EXTRAS) if ((t as any)[k] !== undefined) extras[k] = copy((t as any)[k]);
    if (t.vstInstrument) { const { renderSig: _r, ...vi } = t.vstInstrument; extras.vstInstrument = copy(vi); }
    // Voies « Pan G » / « Pan D » (pistes stéréo) : sans équivalent dans le format, gardées pour NOVA.
    const panLanes = (t.automationLanes || []).filter(l => (l.parameterName === PAN_L || l.parameterName === PAN_R) && l.points?.length);
    if (panLanes.length) extras.panLanes = copy(panLanes);
    // Sampler perso : son du sample joint (nova/samples/).
    if (t.melodicSampler?.sampleId && !t.melodicSampler.kitRef) {
      const sid = `msample-${t.melodicSampler.sampleId}`;
      if (!side.samples.includes(sid)) {
        const f = audioFor(sid, sid, () => getAudio(sid), 'nova/samples');
        if (f) side.samples.push(sid);
        else notes.push(`${label(t)} : son du sampler introuvable, non joint.`);
      }
    }
    if (t.drumMachine) notes.push(`${label(t)} : motif de la boîte à rythmes non repris par le format (ses sons restent dans NOVA). Gèle la piste ou exporte les stems pour l'avoir en audio.`);
    if (usesKitSounds(t)) notes.push(`${label(t)} : sons des kits NOVA, jamais écrits en fichier (seules les notes partent).`);
    const sendsSide: NonNullable<NovaSidecar['tracks'][string]['sends']> = {};
    const sends = (t.sends || []).filter(s => ids.has(s.id)).map(s => {
      const sid = id('send');
      sendsSide[sid] = { isEnabled: s.isEnabled, ...(s.isMuted !== undefined ? { isMuted: s.isMuted } : {}), ...(s.slot !== undefined ? { slot: s.slot } : {}), ...(s.pan !== undefined ? { pan: s.pan } : {}), ...(s.preFader !== undefined ? { preFader: s.preFader } : {}) };
      return el('Send', { id: sid, destination: ids.get(s.id)!.channel, type: s.preFader ? 'pre' : 'post' }, [
        el('Volume', { id: id('p'), name: 'Envoi', unit: 'linear', min: 0, max: FADER_MAX_GAIN, value: s.level }),
        s.pan !== undefined ? el('Pan', { id: id('p'), name: 'Pan', unit: 'normalized', min: 0, max: 1, value: (s.pan + 1) / 2 }) : null,
        boolP('Enable', s.isEnabled !== false && !s.isMuted, 'Actif'),
      ]);
    });
    side.tracks[ref.track] = { id: t.id, type: t.type, extras, ...(Object.keys(sendsSide).length ? { sends: sendsSide } : {}) };
    const dest = isMaster(t) ? undefined : t.outputTrackId && ids.has(t.outputTrackId) ? ids.get(t.outputTrackId)!.channel : ids.get('master')?.channel;
    const inst = instrumentOf(t);
    const devices = [...(inst ? [inst] : []), ...(t.plugins || []).map(p => deviceOf(p, 'audioFX'))];
    const channel = el('Channel', { id: ref.channel, role: roleOf(t), audioChannels: 2, destination: dest, solo: t.isSolo ? 'true' : 'false' }, [
      devices.length ? el('Devices', {}, devices) : null,
      el('Mute', { id: ref.mute, name: 'Mute', value: t.isMuted ? 'true' : 'false' }),
      el('Pan', { id: ref.pan, name: 'Pan', unit: 'normalized', min: 0, max: 1, value: ((t.pan ?? 0) + 1) / 2 }),
      el('Volume', { id: ref.volume, name: 'Volume', unit: 'linear', min: 0, max: FADER_MAX_GAIN, value: t.volume ?? 1 }),
      sends.length ? el('Sends', {}, sends) : null,
    ]);
    stats.tracks += isMaster(t) ? 0 : 1;
    if (!isMaster(t)) lanesXml.push(trackLanes(t, ref.track));
    else { const l = automationXml(t); if (l.length) lanesXml.push(el('Lanes', { id: id('lanes'), track: ref.track }, l)); }
    return el('Track', { id: ref.track, name: isMaster(t) ? (t.name || 'Master') : t.name, color: color(t.color), contentType: isMaster(t) ? 'audio notes' : contentOf(t), loaded: 'true' }, [channel, ...children]);
  };

  // Automation : volume, pan et réglages d'effets écrits dans le fichier.
  const automationXml = (t: Track): XmlNode[] => {
    const ref = ids.get(t.id)!;
    const out: XmlNode[] = [];
    let dropped = 0;
    for (const l of (t.automationLanes || []) as AutomationLane[]) {
      if (!l.points?.length) continue;
      let target: string | undefined, unit = 'linear', conv = (v: number) => v;
      if (l.parameterName === PAN_L || l.parameterName === PAN_R) continue; // gardées dans nova.json (extras.panLanes)
      if (l.parameterName === 'volume') target = ref.volume;
      else if (l.parameterName === 'pan') { target = ref.pan; unit = 'normalized'; conv = v => (v + 1) / 2; }
      else { const m = /^plugin::(.+?)::(.+)$/.exec(l.parameterName); if (m) target = paramIds.get(`${m[1]}::${m[2]}`); }
      if (!target) { dropped++; continue; }
      const pid = id('auto');
      const pts = [...l.points].sort((a, b) => a.time - b.time);
      side.lanes[pid] = { parameterName: l.parameterName, color: l.color, isExpanded: l.isExpanded, min: l.min, max: l.max, curves: pts.map(p => p.curveType || null) };
      out.push(el('Points', { id: pid, unit }, [el('Target', { parameter: target }),
        ...pts.map((p, i) => el('RealPoint', { time: B(p.time), value: conv(p.value), interpolation: (pts[i].curveType === 'HOLD') ? 'hold' : 'linear' }))]));
      stats.automation++;
    }
    if (dropped) notes.push(`${label(t)} : ${dropped} courbe${dropped > 1 ? 's' : ''} d'automation sans équivalent dans le format (gardée${dropped > 1 ? 's' : ''} pour NOVA seulement).`);
    return out;
  };

  const trackLanes = (t: Track, trackId: string): XmlNode => {
    const clips: XmlNode[] = [];
    const isAudioTrack = t.type === TrackType.AUDIO;
    let curvesNote = 0, gainNote = 0;
    for (const c of [...(t.clips || [])].filter(x => !x.isFreezeSlice).sort((a, b) => a.start - b.start)) {
      const cid = id('clip');
      const extras: Record<string, unknown> = {};
      for (const k of CLIP_EXTRAS) if ((c as any)[k] !== undefined) extras[k] = copy((c as any)[k]);
      const t0 = B(c.start), t1 = B(c.start + c.duration);
      const base = { id: cid, time: t0, duration: t1 - t0, name: c.name, color: color(c.color), enable: c.isMuted ? 'false' : undefined };
      if (c.notes) {
        const playable = c.notes.filter(n => !n.muted);
        if (playable.length !== c.notes.length) notes.push(`${label(t)} : notes muettes de « ${c.name} » gardées pour NOVA seulement.`);
        extras.notes = copy(c.notes.map(n => { const { isSelected: _s, ...r } = n; return r; }));
        const notesXml = playable.map(n => {
          const a = B(c.start + n.start), b = B(c.start + n.start + n.duration);
          return el('Note', { time: a - t0, duration: b - a, channel: 0, key: n.pitch, vel: Math.max(0, Math.min(1, n.velocity / 127)), rel: Math.max(0, Math.min(1, n.velocity / 127)) });
        });
        stats.notes += playable.length;
        clips.push(el('Clip', { ...base, playStart: 0 }, [el('Notes', { id: id('notes') }, notesXml)]));
        side.clips[cid] = extras;
        stats.clips++;
        continue;
      }
      if (!isAudioTrack && !c.bufferId) continue;
      if (!c.bufferId || c.isOffline) { skipped.push(`${label(t)} : son introuvable pour « ${c.name} », clip non exporté.`); continue; }
      const raw = getAudio(c.bufferId);
      if (!raw) { skipped.push(`${label(t)} : son introuvable pour « ${c.name} », clip non exporté.`); continue; }
      let offset = c.offset || 0;
      let f;
      if (c.isReversed) {
        const a = Math.max(0, Math.round(offset * raw.sampleRate));
        const n = Math.min(raw.channels[0].length - a, Math.round(c.duration * raw.sampleRate));
        f = audioFor(`${c.bufferId}#rev${a}-${n}`, `${c.name} (envers)`, () => ({ sampleRate: raw.sampleRate, channels: raw.channels.map(ch => ch.slice(a, a + n).reverse()) }));
        offset = 0;
        extras.reversedRender = true;
        notes.push(`${label(t)} : clip à l'envers « ${c.name} » rendu dans son propre fichier.`);
      } else { f = audioFor(c.bufferId, c.name || t.name, () => raw); extras.offsetExact = offset; }
      if (!f) { skipped.push(`${label(t)} : son vide pour « ${c.name} », clip non exporté.`); continue; }
      if ((c.fadeInCurve && c.fadeInCurve !== 'LINEAR') || (c.fadeOutCurve && c.fadeOutCurve !== 'LINEAR')) curvesNote++;
      if ((c.gain !== undefined && Math.abs(c.gain - 1) > 1e-9) || c.gainPoints?.length) gainNote++;
      // Le son ne suit pas le tempo dans NOVA : points de calage du début à la fin du fichier, un de
      // plus à chaque changement de tempo traversé (le son garde sa vitesse, au bit près).
      const a0 = c.start - offset, b0 = B(a0), bEnd = B(a0 + f.duration);
      const warps = [el('Warp', { time: 0, contentTime: 0 }),
        ...clock.points.filter(p => p.beat > b0 + 1e-9 && p.beat < bEnd - 1e-9).map(p => el('Warp', { time: p.beat - b0, contentTime: clock.secAt(p.beat) - a0 })),
        el('Warp', { time: bEnd - b0, contentTime: f.duration })];
      clips.push(el('Clip', { ...base, playStart: t0 - b0, fadeTimeUnit: 'seconds', fadeInTime: c.fadeIn || 0, fadeOutTime: c.fadeOut || 0 }, [
        el('Warps', { id: id('warps'), timeUnit: 'beats', contentTimeUnit: 'seconds' }, [
          el('Audio', { id: id('audio'), channels: f.channels, sampleRate: f.sampleRate, duration: f.duration, algorithm: 'raw' }, [el('File', { path: f.path })]),
          ...warps,
        ]),
      ]));
      side.clips[cid] = extras;
      stats.clips++; stats.audioClips++;
    }
    if (curvesNote) notes.push(`${label(t)} : formes de fondu de ${curvesNote} clip${curvesNote > 1 ? 's' : ''} lues comme linéaires par les autres logiciels.`);
    if (gainNote) notes.push(`${label(t)} : gain de clip de ${gainNote} clip${gainNote > 1 ? 's' : ''} gardé pour NOVA (le format n'a pas de gain de clip).`);
    const lanes: XmlNode[] = [];
    if (clips.length) lanes.push(el('Clips', { id: id('clips') }, clips));
    lanes.push(...automationXml(t));
    return el('Lanes', { id: id('lanes'), track: trackId }, lanes);
  };

  // Arbre des dossiers : les pistes d'un dossier sont écrites dans sa balise <Track>.
  const visible = tracks.filter(t => !isMaster(t) && ids.has(t.id));
  const childrenOf = (fid: string) => visible.filter(t => t.parentFolderId === fid);
  const isRoot = (t: Track) => !t.parentFolderId || !visible.some(x => x.id === t.parentFolderId && x.folder);
  const build = (t: Track, depth: number): XmlNode => trackXml(t, t.folder && depth < 16 ? childrenOf(t.id).map(c => build(c, depth + 1)) : []);
  const structure: XmlNode[] = visible.filter(isRoot).map(t => build(t, 0));
  const master = tracks.find(isMaster);
  if (master && ids.has('master')) structure.push(trackXml(master, []));

  // ── Transport, tempo, mesure, repères ──────────────────────────────────────────────
  if (state.panLaw !== undefined && state.panLaw !== null) side.panLaw = state.panLaw;
  const map = buildTempoMap(state.bpm, state.timeSignature, state.tempoEvents);
  const seg0 = map.segments[0];
  const arrangement: XmlNode[] = [];
  if (map.segments.length > 1) {
    side.tempoEvents = copy(state.tempoEvents);
    arrangement.push(el('TempoAutomation', { id: id('tempo'), unit: 'bpm' }, map.segments.map(s => el('RealPoint', { time: quartersAt(map, s.time), value: s.bpm, interpolation: 'hold' }))));
    if (map.segments.some(s => s.num !== seg0.num || s.den !== seg0.den)) {
      arrangement.push(el('TimeSignatureAutomation', { id: id('meter') }, map.segments.map(s => el('TimeSignaturePoint', { time: quartersAt(map, s.time), numerator: s.num, denominator: s.den }))));
    }
  }
  const markers = (state.markers || []).map(m => {
    const mid = id('marker');
    side.markers[mid] = { type: m.type, ...(m.endTime !== undefined ? { endTime: m.endTime } : {}), ...(m.number !== undefined ? { number: m.number } : {}) };
    return el('Marker', { id: mid, time: B(m.time), name: m.name, color: color(m.color) });
  });
  if (markers.length) arrangement.push(el('Markers', { id: id('markers') }, markers));
  arrangement.push(el('Lanes', { id: id('lanes'), timeUnit: 'beats' }, lanesXml));

  const project = el('Project', { version: '1.0' }, [
    el('Application', { name: 'NOVA', version: opts.appVersion || '1.5' }),
    el('Transport', {}, [
      el('Tempo', { id: id('p'), name: 'Tempo', unit: 'bpm', min: 20, max: 999, value: seg0.bpm }),
      el('TimeSignature', { id: id('p'), name: 'Mesure', numerator: seg0.num, denominator: seg0.den }),
    ]),
    el('Structure', {}, structure),
    el('Arrangement', { id: id('arr') }, arrangement),
    el('Scenes', {}),
  ]);
  const meta = el('MetaData', {}, [{ name: 'Title', attrs: {}, children: [], text: state.name || 'Projet NOVA' }, { name: 'Comment', attrs: {}, children: [], text: 'Exporté par NOVA' }]);
  files.push({ path: NOVA_SIDECAR, bytes: new TextEncoder().encode(JSON.stringify(side)) });
  return { projectXml: writeXml(project), metadataXml: writeXml(meta), files, stats, skipped, notes: [...new Set(notes)] };
}
