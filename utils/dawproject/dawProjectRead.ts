/**
 * Lecture d'un fichier DAWproject (project.xml + fichiers du ZIP) → séance en SECONDES,
 * prête à convertir en pistes NOVA (dawProjectToNova).
 *
 * Gère ce que les logiciels écrivent : temps en noires ou en secondes à n'importe quel
 * niveau, changements de tempo (paliers et rampes) et de mesure, pistes imbriquées
 * (dossiers), clips imbriqués, calage (« Warps »), boucles de clip MIDI, notes,
 * automation de volume / pan / réglages, envois, repères, appareils (effets, instruments,
 * plugins). Ce qui n'est pas repris est listé dans `warnings`.
 *
 * Module pur : tests/dawProject.test.ts.
 */
import { BeatClock, TempoPoint } from './dawTime';
import { bool, kid, kids, local, num, parseXml, XmlNode } from './xml';
import type { NovaSidecar } from './novaToDawProject';

export type TimeUnit = 'beats' | 'seconds';

export interface DawParam { xmlId: string; name: string; /** Attribut name (NOVA : clé du réglage). */ label: string; value: number; unit: string; isBool: boolean }
export interface DawDevice {
  xmlId: string;
  /** Balise : Compressor, Limiter, NoiseGate, Equalizer, BuiltinDevice, Vst3Plugin, Vst2Plugin, ClapPlugin, AuPlugin, Device. */
  kind: string;
  role: string;
  name: string;
  vendor: string;
  deviceId: string;
  enabled: boolean;
  loaded: boolean;
  /** Réglages par nom de balise (Threshold, Ratio…) ou par nom (Parameters). */
  params: Record<string, DawParam>;
  bands: { type: string; freq: number; gain: number; q: number; enabled: boolean; ids: { freq?: string; gain?: string; q?: string } }[];
}
export interface DawNote { start: number; duration: number; key: number; vel: number; channel: number }
export interface DawClip {
  xmlId: string;
  name: string;
  color?: string;
  /** Début et longueur sur la timeline (s). */
  start: number;
  duration: number;
  enabled: boolean;
  fadeIn: number;
  fadeOut: number;
  audio?: { path: string; offset: number; channels: number; sampleRate: number; stretched: boolean };
  /** Notes : début relatif au clip (s). */
  notes?: DawNote[];
}
export interface DawPoints { xmlId: string; target: string; unit: string; points: { time: number; value: number; hold: boolean }[] }
export interface DawSend { xmlId: string; destination: string; volume: number; pan: number | null; enabled: boolean; pre: boolean }
export interface DawTrack {
  xmlId: string;
  channelId: string;
  name: string;
  color?: string;
  contentType: string;
  role: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  destination?: string;
  sends: DawSend[];
  devices: DawDevice[];
  clips: DawClip[];
  automation: DawPoints[];
  parentXmlId?: string;
  isFolder: boolean;
  ids: { volume?: string; pan?: string; mute?: string };
}
export interface DawMarker { xmlId: string; time: number; name: string; color?: string }

export interface DawSession {
  app: string;
  title: string;
  bpm: number;
  numerator: number;
  denominator: number;
  /** Changements de tempo (noires) et de mesure, tels que lus. */
  tempoPoints: TempoPoint[];
  meterPoints: { beat: number; numerator: number; denominator: number }[];
  clock: BeatClock;
  tracks: DawTrack[];
  master: DawTrack | null;
  markers: DawMarker[];
  sidecar: NovaSidecar | null;
  warnings: string[];
  stats: { tracks: number; clips: number; audioClips: number; notes: number; automation: number };
}

const unitOf = (n: XmlNode | null | undefined, inherited: TimeUnit): TimeUnit => {
  const u = n?.attrs.timeUnit;
  return u === 'seconds' || u === 'beats' ? u : inherited;
};
/** Panoramique normalisé (0…1) → NOVA (−1…1), arrondi au milliardième (−0,3 relu −0,3, pas −0,30000000000000004). */
export const panFromNormalized = (v: number) => Math.round((v * 2 - 1) * 1e9) / 1e9;
const hex = (c: string | undefined) => (c && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) ? c.slice(0, 7).toLowerCase() : undefined);

export function readDawProject(files: Map<string, Uint8Array>): DawSession {
  const text = (p: string) => { const b = files.get(p); return b ? new TextDecoder('utf-8').decode(b) : null; };
  const xml = text('project.xml');
  if (!xml) throw new Error("Ce n'est pas un fichier DAWproject : project.xml absent.");
  const root = parseXml(xml);
  if (local(root.name) !== 'Project') throw new Error("Ce n'est pas un fichier DAWproject : la racine n'est pas <Project>.");
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  let sidecar: NovaSidecar | null = null;
  try { const s = text('nova/nova.json'); if (s) { const j = JSON.parse(s); if (j?.format === 'nova-dawproject') sidecar = j; } } catch { /* fichier abîmé : ignoré */ }
  let title = '';
  try { const m = text('metadata.xml'); if (m) title = (kid(parseXml(m), 'Title')?.text || '').trim(); } catch { /* facultatif */ }

  // ── Transport ──
  const transport = kid(root, 'Transport');
  const bpm = num(kid(transport, 'Tempo'), 'value', 120);
  const ts = kid(transport, 'TimeSignature');
  const numerator = Math.round(num(ts, 'numerator', 4)), denominator = Math.round(num(ts, 'denominator', 4));
  const arr = kid(root, 'Arrangement');
  const arrUnit = unitOf(kid(arr, 'Lanes'), 'beats');

  // Tempo : points en noires (ou en secondes, convertis au fil de l'eau).
  const tempoPoints: TempoPoint[] = [];
  const tAuto = kid(arr, 'TempoAutomation');
  if (tAuto) {
    const u = unitOf(tAuto, arrUnit);
    const pts = kids(tAuto, 'RealPoint').map(p => ({ time: num(p, 'time', 0), value: num(p, 'value', bpm), ramp: p.attrs.interpolation === 'linear' }))
      .filter(p => p.value > 0).sort((a, b) => a.time - b.time);
    for (const p of pts) {
      const beat = u === 'beats' ? p.time : new BeatClock(bpm, tempoPoints).beatAt(p.time);
      tempoPoints.push({ beat, bpm: p.value, ramp: p.ramp });
    }
  }
  const clock = new BeatClock(bpm, tempoPoints);
  const toSec = (u: TimeUnit, t: number) => (u === 'beats' ? clock.secAt(t) : t);
  const toBeat = (u: TimeUnit, t: number) => (u === 'beats' ? t : clock.beatAt(t));
  const meterPoints: DawSession['meterPoints'] = [];
  const mAuto = kid(arr, 'TimeSignatureAutomation');
  if (mAuto) {
    const u = unitOf(mAuto, arrUnit);
    for (const p of kids(mAuto, 'TimeSignaturePoint')) meterPoints.push({ beat: toBeat(u, num(p, 'time', 0)), numerator: Math.round(num(p, 'numerator', numerator)), denominator: Math.round(num(p, 'denominator', denominator)) });
    meterPoints.sort((a, b) => a.beat - b.beat);
  }

  // ── Structure : pistes (imbriquées) et tranches ──
  const tracks: DawTrack[] = [];
  let master: DawTrack | null = null;
  const byTrack = new Map<string, DawTrack>();
  const paramOwner = new Map<string, DawTrack>();
  const readDevice = (d: XmlNode): DawDevice => {
    const params: Record<string, DawParam> = {};
    const p = (n: XmlNode, name: string) => { params[name] = { xmlId: n.attrs.id || '', name, label: n.attrs.name || name, isBool: local(n.name) === 'BoolParameter' || n.attrs.value === 'true' || n.attrs.value === 'false', value: n.attrs.value === 'true' ? 1 : n.attrs.value === 'false' ? 0 : num(n, 'value', 0), unit: n.attrs.unit || '' }; };
    for (const c of d.children) {
      const nm = local(c.name);
      if (nm === 'Parameters') { for (const x of c.children) p(x, x.attrs.name || x.attrs.parameterID || local(x.name)); continue; }
      if (nm === 'Band' || nm === 'State' || nm === 'Enabled') continue;
      if (c.attrs.value !== undefined) p(c, nm);
    }
    const bands = kids(d, 'Band').map(b => {
      const f = kid(b, 'Freq'), g = kid(b, 'Gain'), q = kid(b, 'Q'), e = kid(b, 'Enabled');
      return { type: b.attrs.type || 'bell', freq: num(f, 'value', 1000), gain: num(g, 'value', 0), q: num(q, 'value', 1), enabled: e ? bool(e, 'value', true) : bool(b, 'enabled', true), ids: { freq: f?.attrs.id, gain: g?.attrs.id, q: q?.attrs.id } };
    });
    const en = kid(d, 'Enabled');
    return {
      xmlId: d.attrs.id || '', kind: local(d.name), role: d.attrs.deviceRole || 'audioFX', name: d.attrs.deviceName || d.attrs.name || local(d.name),
      vendor: d.attrs.deviceVendor || '', deviceId: d.attrs.deviceID || '', enabled: en ? bool(en, 'value', true) : true, loaded: bool(d, 'loaded', true), params, bands,
    };
  };
  const walk = (t: XmlNode, parent: string | undefined, depth: number) => {
    const ch = kid(t, 'Channel');
    const role = ch?.attrs.role || 'regular';
    const content = t.attrs.contentType || '';
    const isFolder = /\btracks\b/.test(content) || kids(t, 'Track').length > 0;
    const vol = kid(ch, 'Volume'), pan = kid(ch, 'Pan'), mute = kid(ch, 'Mute');
    const volUnit = vol?.attrs.unit || 'linear';
    const volume = vol ? (volUnit === 'decibel' ? Math.pow(10, num(vol, 'value', 0) / 20) : num(vol, 'value', 1)) : 1;
    const panV = pan ? ((pan.attrs.unit || 'normalized') === 'normalized' ? panFromNormalized(num(pan, 'value', 0.5)) : num(pan, 'value', 0)) : 0;
    const dt: DawTrack = {
      xmlId: t.attrs.id || `t${tracks.length}`, channelId: ch?.attrs.id || '', name: t.attrs.name || ch?.attrs.name || 'Piste', color: hex(t.attrs.color),
      contentType: content, role, volume, pan: Math.max(-1, Math.min(1, panV)), mute: mute ? bool(mute, 'value', false) : false, solo: bool(ch, 'solo', false),
      destination: ch?.attrs.destination, devices: kids(kid(ch, 'Devices')).map(readDevice), clips: [], automation: [], parentXmlId: parent, isFolder,
      sends: kids(kid(ch, 'Sends'), 'Send').map(s => {
        const v = kid(s, 'Volume'), p = kid(s, 'Pan'), e = kid(s, 'Enable');
        return { xmlId: s.attrs.id || '', destination: s.attrs.destination || '', volume: v ? ((v.attrs.unit || 'linear') === 'decibel' ? Math.pow(10, num(v, 'value', 0) / 20) : num(v, 'value', 1)) : 1,
          pan: p ? panFromNormalized(num(p, 'value', 0.5)) : null, enabled: e ? bool(e, 'value', true) : true, pre: s.attrs.type === 'pre' };
      }),
      ids: { volume: vol?.attrs.id, pan: pan?.attrs.id, mute: mute?.attrs.id },
    };
    if (role === 'master' && !master) master = dt;
    else tracks.push(dt);
    byTrack.set(dt.xmlId, dt);
    for (const id of [dt.ids.volume, dt.ids.pan, dt.ids.mute]) if (id) paramOwner.set(id, dt);
    dt.devices.forEach(d => { Object.values(d.params).forEach(p => p.xmlId && paramOwner.set(p.xmlId, dt)); d.bands.forEach(b => Object.values(b.ids).forEach(i => i && paramOwner.set(i, dt))); });
    if (depth < 32) kids(t, 'Track').forEach(c => walk(c, dt.xmlId, depth + 1));
  };
  const structure = kid(root, 'Structure');
  for (const n of kids(structure)) {
    if (local(n.name) === 'Track') walk(n, undefined, 0);
    else if (local(n.name) === 'Channel' && n.attrs.role === 'master' && !master) {
      // Master écrit directement comme <Channel> (sans <Track>).
      walk({ name: 'Track', attrs: { id: n.attrs.id || 'master', name: n.attrs.name || 'Master', contentType: 'audio' }, children: [n] }, undefined, 0);
    }
  }

  // ── Arrangement : clips et automation, en secondes ──
  let stretched = 0, loopedAudio = 0, unsupported = 0;
  /** Longueur relative d'une unité à l'autre, au tempo local (instant `near`, s). */
  const conv = (v: number, from: TimeUnit, to: TimeUnit, near: number) => {
    if (from === to) return v;
    const k = clock.bpmAt(clock.beatAt(Number.isFinite(near) ? near : 0)) / 60;
    return from === 'seconds' ? v * k : v / k;
  };
  const stats = { tracks: tracks.length, clips: 0, audioClips: 0, notes: 0, automation: 0 };
  /**
   * Contenu d'un clip. `at(p)` : instant (s) où joue la position p (unité `cu`) du contenu ;
   * [w0, w1] : fenêtre audible (s) ; base : clip qui reçoit notes / son.
   */
  const readContent = (node: XmlNode, cu: TimeUnit, at: (p: number) => number, w0: number, w1: number, out: DawClip, owner: DawTrack, depth: number) => {
    const name = local(node.name);
    if (name === 'Notes') {
      const nu = unitOf(node, cu);
      const atN = nu === cu ? at : (p: number) => at(conv(p, nu, cu, w0));
      for (const n of kids(node, 'Note')) {
        const a = atN(num(n, 'time', 0)), b = atN(num(n, 'time', 0) + num(n, 'duration', 0));
        if (b <= w0 + 1e-9 || a >= w1 - 1e-9) continue;
        const s = Math.max(a, w0), e = Math.min(b, w1);
        out.notes = out.notes || [];
        out.notes.push({ start: s - out.start, duration: Math.max(0, e - s), key: Math.round(num(n, 'key', 60)), vel: num(n, 'vel', 0.8), channel: Math.round(num(n, 'channel', 0)) });
      }
      return;
    }
    if (name === 'Audio' || name === 'Video') {
      const f = kid(node, 'File');
      if (!f || name === 'Video') { unsupported++; return; }
      // Position 0 du son : instant at(0) ; décalage = début audible − at(0).
      if (!out.audio) out.audio = { path: f.attrs.path || '', offset: Math.max(0, w0 - at(0)), channels: Math.round(num(node, 'channels', 2)), sampleRate: num(node, 'sampleRate', 48000), stretched: false };
      return;
    }
    if (name === 'Warps') {
      const wu = unitOf(node, cu);
      const cwu: TimeUnit = node.attrs.contentTimeUnit === 'beats' ? 'beats' : 'seconds';
      const warps = kids(node, 'Warp').map(w => ({ t: num(w, 'time', 0), c: num(w, 'contentTime', 0) })).sort((a, b) => a.t - b.t);
      const media = node.children.find(c => ['Audio', 'Video', 'Notes', 'Clips', 'Lanes'].includes(local(c.name)));
      if (!media) return;
      // Contenu (cwu) → temps du clip (wu) par les points de calage (linéaire par morceaux, prolongé aux bouts).
      const inv = (c: number): number => {
        if (warps.length < 2) return warps.length ? warps[0].t + (c - warps[0].c) : c;
        let i = 0;
        while (i < warps.length - 2 && c > warps[i + 1].c) i++;
        const a = warps[i], b = warps[i + 1];
        return b.c !== a.c ? a.t + ((c - a.c) * (b.t - a.t)) / (b.c - a.c) : a.t;
      };
      const atW = (c: number) => at(conv(inv(c), wu, cu, w0));
      // Étiré ? Comparer la durée réelle d'une seconde de son à 1 s.
      if (warps.length >= 2 && cwu === 'seconds') {
        const a = warps[0], b = warps[warps.length - 1];
        const real = atW(b.c) - atW(a.c);
        if (b.c > a.c && Math.abs(real / (b.c - a.c) - 1) > 0.001) { stretched++; if (out.audio) out.audio.stretched = true; }
      }
      readContent(media, cwu, atW, w0, w1, out, owner, depth + 1);
      if (out.audio && warps.length >= 2) {
        const a = warps[0], b = warps[warps.length - 1];
        if (b.c > a.c && Math.abs((atW(b.c) - atW(a.c)) / (b.c - a.c) - 1) > 0.001) out.audio.stretched = true;
      }
      return;
    }
    if (name === 'Clips') { for (const c of kids(node, 'Clip')) readClip(c, unitOf(node, cu), at, w0, w1, owner, out, depth + 1); return; }
    if (name === 'Lanes') { for (const c of node.children) readContent(c, unitOf(node, cu), at, w0, w1, out, owner, depth + 1); return; }
    if (name === 'Points') return; // expression dans le clip : non reprise
  };
  /**
   * Un <Clip> placé sur une timeline (unité `u`, instant de la position p : `at(p)`),
   * limité à la fenêtre [w0, w1]. `into` : clip parent (clips imbriqués : contenu fusionné).
   */
  const readClip = (c: XmlNode, u: TimeUnit, at: (p: number) => number, w0: number, w1: number, owner: DawTrack, into: DawClip | null, depth: number) => {
    if (depth > 24) return;
    const t = num(c, 'time', 0), d = num(c, 'duration', 0);
    const s = Math.max(at(t), w0), e = Math.min(at(t + d), w1);
    if (e <= s + 1e-9) return;
    const cu: TimeUnit = c.attrs.contentTimeUnit === 'seconds' || c.attrs.contentTimeUnit === 'beats' ? c.attrs.contentTimeUnit as TimeUnit : u;
    const playStart = num(c, 'playStart', 0);
    const fu: TimeUnit = c.attrs.fadeTimeUnit === 'seconds' || c.attrs.fadeTimeUnit === 'beats' ? c.attrs.fadeTimeUnit as TimeUnit : u;
    const fadeLen = (v: number, out: boolean) => (fu === 'seconds' ? v : Math.max(0, out ? at(t + d) - at(t + d - v) : at(t + v) - at(t)));
    const startAbs = at(t);
    // Instant d'une position du contenu : le début du clip joue la position playStart.
    const atC = (p: number) => (cu === 'seconds' && u === 'seconds' ? startAbs + (p - playStart)
      : cu === 'beats' ? clock.secAt(clock.beatAt(startAbs) + (p - playStart))
        : startAbs + (p - playStart));
    const loopS = c.attrs.loopStart !== undefined ? num(c, 'loopStart', 0) : null, loopE = c.attrs.loopEnd !== undefined ? num(c, 'loopEnd', 0) : null;
    const clip: DawClip = into || {
      xmlId: c.attrs.id || `c${stats.clips}`, name: c.attrs.name || '', color: hex(c.attrs.color), start: s, duration: e - s,
      enabled: c.attrs.enable !== 'false', fadeIn: fadeLen(num(c, 'fadeInTime', 0), false), fadeOut: fadeLen(num(c, 'fadeOutTime', 0), true),
    };
    if (into && !clip.name && c.attrs.name) clip.name = c.attrs.name;
    const content = c.children.filter(x => ['Notes', 'Audio', 'Video', 'Warps', 'Clips', 'Lanes', 'Points'].includes(local(x.name)));
    const loopLen = loopS !== null && loopE !== null ? loopE - loopS : 0;
    if (loopLen > 0) {
      // Boucle : 1er passage de playStart à loopEnd, puis [loopStart, loopEnd) répété.
      const span = (a: number, b: number) => (cu === 'beats' ? clock.secAt(clock.beatAt(startAbs) + b) - clock.secAt(clock.beatAt(startAbs) + a) : b - a);
      let rel = 0, first = true, guard = 0;
      while (guard++ < 4096) {
        const from = first ? playStart : loopS!;
        const segLen = loopE! - from;
        if (segLen <= 0) { if (first) { first = false; continue; } break; }
        const segStart = startAbs + span(0, rel);
        const a0 = segStart, a1 = startAbs + span(0, rel + segLen);
        if (a0 >= e - 1e-9) break;
        const atSeg = (p: number) => (cu === 'beats' ? clock.secAt(clock.beatAt(startAbs) + rel + (p - from)) : startAbs + rel + (p - from));
        for (const x of content) {
          if (local(x.name) === 'Audio' || local(x.name) === 'Warps') { if (!first) { loopedAudio++; continue; } }
          readContent(x, cu, atSeg, Math.max(s, a0), Math.min(e, a1), clip, owner, depth + 1);
        }
        rel += segLen; first = false;
      }
    } else {
      for (const x of content) readContent(x, cu, atC, s, e, clip, owner, depth + 1);
    }
    if (!into) {
      if (!clip.audio && !clip.notes && content.some(x => ['Notes'].includes(local(x.name)))) clip.notes = [];
      owner.clips.push(clip);
      stats.clips++;
      if (clip.audio) stats.audioClips++;
      if (clip.notes) stats.notes += clip.notes.length;
    }
  };
  const readPoints = (p: XmlNode, u: TimeUnit, owner: DawTrack | undefined) => {
    const target = kid(p, 'Target')?.attrs.parameter || '';
    const tr = paramOwner.get(target) || owner;
    if (!tr) return;
    const pu = unitOf(p, u);
    tr.automation.push({
      xmlId: p.attrs.id || '', target, unit: p.attrs.unit || '',
      points: kids(p).filter(x => /Point$/.test(local(x.name)) && local(x.name) !== 'TimeSignaturePoint')
        .map(x => ({ time: toSec(pu, num(x, 'time', 0)), value: x.attrs.value === 'true' ? 1 : x.attrs.value === 'false' ? 0 : num(x, 'value', 0), hold: x.attrs.interpolation === 'hold' })),
    });
    stats.automation++;
  };
  const walkLanes = (n: XmlNode, u: TimeUnit, owner: DawTrack | undefined, depth: number) => {
    if (depth > 24) return;
    const nu = unitOf(n, u);
    const tr = (n.attrs.track && byTrack.get(n.attrs.track)) || owner;
    for (const c of n.children) {
      const nm = local(c.name);
      const cTr = (c.attrs.track && byTrack.get(c.attrs.track)) || tr;
      if (nm === 'Lanes') walkLanes(c, nu, cTr, depth + 1);
      else if (nm === 'Clips') {
        if (!cTr) { unsupported++; continue; }
        const cu = unitOf(c, nu);
        for (const clip of kids(c, 'Clip')) readClip(clip, cu, p => toSec(cu, p), -Infinity, Infinity, cTr, null, depth + 1);
      } else if (nm === 'Points') readPoints(c, nu, cTr);
    }
  };
  if (arr) for (const l of kids(arr, 'Lanes')) walkLanes(l, unitOf(l, 'beats'), undefined, 0);

  const markers: DawMarker[] = [];
  const mk = kid(arr, 'Markers');
  if (mk) { const u = unitOf(mk, arrUnit); for (const m of kids(mk, 'Marker')) markers.push({ xmlId: m.attrs.id || '', time: toSec(u, num(m, 'time', 0)), name: m.attrs.name || 'Repère', color: hex(m.attrs.color) }); }

  if (stretched) warn(`${stretched} clip${stretched > 1 ? 's' : ''} audio étiré${stretched > 1 ? 's' : ''} par l'autre logiciel : joué${stretched > 1 ? 's' : ''} à sa vitesse d'origine (place et début gardés).`);
  if (loopedAudio) warn(`Boucles de clips audio : seul le premier passage est repris.`);
  if (unsupported) warn(`${unsupported} élément${unsupported > 1 ? 's' : ''} non repris (vidéo ou contenu sans piste).`);
  if (clock.hasRamps) warn('Rampes de tempo : remplacées par des paliers à chaque mesure (positions des clips gardées en secondes).');
  if (kids(kid(root, 'Scenes'), 'Scene').length) warn('Scènes (lanceur de clips) non reprises : seul l\'arrangement est importé.');
  return {
    app: kid(root, 'Application')?.attrs.name || '', title, bpm, numerator, denominator, tempoPoints, meterPoints, clock,
    tracks, master, markers, sidecar, warnings, stats,
  };
}
