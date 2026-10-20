/**
 * Lecture d'une séance AAF (Pro Tools : « Export > Selected Tracks as New AAF/OMF »,
 * Media Composer, Premiere, Resolve, pyaaf2…) : pistes, clips à l'échantillon près,
 * gain de clip, fondus (et leur forme), fréquence, volume et panoramique de piste.
 *
 * Chaîne des sources : CompositionMob (pistes) → SourceClip → MasterMob → SourceMob
 * de fichier (descripteur PCM / WAVE / AIFC) → essence intégrée (EssenceData) ou
 * fichier lié (NetworkLocator).
 *
 * Particularités de Pro Tools reprises :
 *  - fondus en Transition (Filler + Transition + clip, clip + Transition + Filler),
 *    forme donnée par l'interpolation du paramètre Level (Linear, Power, Log, BSpline) ;
 *  - fondus « rendus » (petits clips « Fade … » collés au clip, son fabriqué par Pro
 *    Tools) remplacés par un vrai fondu sur le clip, forme approchée ;
 *  - bouts « Sample accurate edit » (séance au débit d'édition vidéo) fusionnés au clip ;
 *  - pistes stéréo exportées en double mono (« Nom.L » / « Nom.R ») regroupées.
 *
 * Module pur (aucune dépendance au navigateur) : tests/aafRead.test.ts.
 */
import type { CrossfadeCurve } from '../../types';
import { CfbReader } from './cfb';
import { AafFile, AafObject, indirectNumber, ratValue, Rational, readRational } from './aafObjects';
import { AUDIO_FILE_DESCRIPTORS, CLS, INTERPDEF, isSoundDef, OPDEF, PARAMDEF, PID, USAGE_TOPLEVEL } from './aafIds';
import { fileNameOfUrl, parseAiffFormat, parseWaveFormat } from './aafMedia';

export interface AafFade {
  /** Longueur en échantillons (fréquence de la séance). */
  length: number;
  shape: CrossfadeCurve;
  /** Forme inconnue (approchée) ou fondu rendu par Pro Tools. */
  approx: boolean;
  source: 'transition' | 'rendu' | 'clip';
}

export interface AafMedia {
  /** Identifiant du SourceMob de fichier. */
  key: string;
  name: string;
  /** Nom du fichier lié (ou proposé pour un son intégré). */
  fileName: string;
  channels: number;
  sampleRate: number;
  /** Longueur en échantillons du média. */
  length: number;
  storage: 'integre' | 'lie';
  format: 'pcm' | 'wave' | 'aiff' | 'inconnu';
  bits: number;
  url?: string;
  /** Octets de l'essence intégrée (lus à la demande). */
  data?: () => Uint8Array | null;
}

export interface AafClipSource { media: AafMedia; channel: number; /** Décalage dans le média, en échantillons du média. */ offset: number }

export interface AafClip {
  name: string;
  /** Position, longueur : échantillons de la séance. */
  position: number;
  length: number;
  sources: AafClipSource[];
  /** Gain de clip (linéaire). */
  gain: number;
  /** Ligne de gain du clip : t en échantillons depuis le début du clip, gain linéaire. */
  gainPoints?: { t: number; gain: number }[];
  fadeIn?: AafFade;
  fadeOut?: AafFade;
}

export interface AafTrack {
  name: string;
  channels: number;
  clips: AafClip[];
  /** Volume de piste (linéaire) et panoramique (−1 … 1) quand l'AAF les donne. */
  volume: number | null;
  pan: number | null;
  volumeAutomated: boolean;
  panAutomated: boolean;
}

export interface AafSession {
  name: string;
  sampleRate: number;
  editRate: Rational;
  tracks: AafTrack[];
  media: AafMedia[];
  warnings: string[];
  stats: {
    clips: number;
    fadesExact: number;
    fadesApprox: number;
    renderedFades: number;
    sampleAccurateMerged: number;
    crossfades: number;
    roundedPositions: number;
    stereoPairs: number;
    skippedSlots: number;
  };
}

export class AafReadError extends Error {}

const SHAPE_OF_INTERP: Record<string, CrossfadeCurve> = {
  [INTERPDEF.Linear]: 'LINEAR',
  [INTERPDEF.Power]: 'EQUAL_POWER',
  [INTERPDEF.Log]: 'EXPONENTIAL',
  [INTERPDEF.BSpline]: 'S_CURVE',
};

/** Noms des fondus rendus par Pro Tools (anglais, français, allemand, espagnol, japonais). */
const RENDERED_FADE_RX = /^(fade\b|fade[\s_-]|fondu\b|blende\b|fundido\b|フェード)/i;
const SAMPLE_ACCURATE_RX = /^(sample[\s_-]*accurate[\s_-]*edit|modification.*(échantillon|echantillon)|samplegenaue)/i;

interface RawClip extends AafClip { masterName: string; rendered?: boolean; sae?: boolean }
type Piece = { kind: 'gap'; length: number } | { kind: 'clip'; clip: RawClip } | { kind: 'trans'; length: number; fade: Omit<AafFade, 'length'> };

export function readAaf(bytes: Uint8Array): AafSession {
  const cfb = new CfbReader(bytes);
  const file = new AafFile(cfb);
  const root = file.root();
  const header = root.strongRef(PID.Root_Header);
  if (!header) throw new AafReadError('Fichier AAF incomplet : en-tête introuvable.');
  const content = header.strongRef(PID.Header_Content);
  if (!content) throw new AafReadError('Fichier AAF incomplet : contenu introuvable.');
  const warnings: string[] = [];
  const stats: AafSession['stats'] = { clips: 0, fadesExact: 0, fadesApprox: 0, renderedFades: 0, sampleAccurateMerged: 0, crossfades: 0, roundedPositions: 0, stereoPairs: 0, skippedSlots: 0 };

  const mobs = content.strongRefs(PID.ContentStorage_Mobs);
  const mobById = new Map<string, AafObject>();
  for (const m of mobs) { const id = m.mobId(PID.Mob_MobID); if (id) mobById.set(id, m); }
  const essence = new Map<string, AafObject>();
  for (const e of content.strongRefs(PID.ContentStorage_EssenceData)) { const id = e.mobId(PID.EssenceData_MobID); if (id) essence.set(id, e); }

  // ── Médias (SourceMob de fichier) ────────────────────────────────────────────────────
  const media = new Map<string, AafMedia>();
  const mediaOf = (sm: AafObject, mobId: string): AafMedia | null => {
    const got = media.get(mobId);
    if (got) return got;
    let d = sm.strongRef(PID.SourceMob_EssenceDescription);
    if (!d || !AUDIO_FILE_DESCRIPTORS.has(d.classId)) return null;
    if (d.classId === CLS.MultipleDescriptor) {
      const sub = d.strongRefs(PID.MultipleDescriptor_FileDescriptors).find(x => AUDIO_FILE_DESCRIPTORS.has(x.classId) && x.classId !== CLS.MultipleDescriptor);
      if (!sub) return null;
      const locs = d.strongRefs(PID.EssenceDescriptor_Locator);
      d = sub;
      if (!d.strongRefs(PID.EssenceDescriptor_Locator).length && locs.length) (d as any).__locators = locs;
    }
    const rate = d.rational(PID.FileDescriptor_SampleRate) || d.rational(PID.Sound_AudioSamplingRate);
    let sampleRate = rate ? Math.round(ratValue(rate)) : 0;
    let channels = d.uint(PID.Sound_Channels, 0);
    let bits = d.uint(PID.Sound_QuantizationBits, 0);
    let format: AafMedia['format'] = 'inconnu';
    if (d.classId === CLS.PCMDescriptor) format = 'pcm';
    else if (d.classId === CLS.WAVEDescriptor) {
      format = 'wave';
      const s = d.data(PID.WAVE_Summary);
      const f = s ? parseWaveFormat(s) : null;
      if (f) { channels = channels || f.channels; bits = bits || f.bits; sampleRate = sampleRate || f.sampleRate; }
    } else if (d.classId === CLS.AIFCDescriptor) {
      format = 'aiff';
      const s = d.data(PID.AIFC_Summary);
      const f = s ? parseAiffFormat(s) : null;
      if (f) { channels = channels || f.channels; bits = bits || f.bits; sampleRate = sampleRate || f.sampleRate; }
    }
    const locs: AafObject[] = (d as any).__locators || d.strongRefs(PID.EssenceDescriptor_Locator);
    const url = locs.map(l => l.string(PID.NetworkLocator_URLString)).find(Boolean) || undefined;
    const ed = essence.get(mobId);
    const name = sm.string(PID.Mob_Name) || '';
    const m: AafMedia = {
      key: mobId, name, fileName: url ? fileNameOfUrl(url) : `${(name || 'son').replace(/\.PHYS$/i, '')}.wav`,
      channels: Math.max(1, channels || 1), sampleRate, length: d.int(PID.FileDescriptor_Length, 0),
      storage: ed ? 'integre' : 'lie', format, bits: bits || 16, url,
      data: ed ? () => ed.stream(PID.EssenceData_Data) : undefined,
    };
    media.set(mobId, m);
    return m;
  };

  // ── Chaîne des sources : clip de la séance → média ─────────────────────────────────────
  /** Décalage (en secondes exactes : num / den) et sources d'un SourceClip. */
  const resolve = (sc: AafObject, editRate: Rational, depth = 0): { sources: AafClipSource[]; masterName: string } | null => {
    if (depth > 10) return null;
    const id = sc.mobId(PID.SourceReference_SourceID);
    if (!id || /^0+$/.test(id)) return null;
    const mob = mobById.get(id);
    if (!mob) return null;
    const slotId = sc.uint(PID.SourceReference_SourceMobSlotID, 1);
    const start = sc.int(PID.SourceClip_StartTime, 0);
    // Début dans le mob visé, en secondes : StartTime est exprimé au débit du slot qui contient le clip.
    const startSec = (start * editRate.den) / editRate.num;
    if (mob.classId === CLS.SourceMob) {
      const m = mediaOf(mob, id);
      if (m) {
        const chans = channelIds(sc);
        const list = chans.length ? chans : range(m.channels);
        return { sources: list.map(c => ({ media: m, channel: Math.min(c, m.channels - 1), offset: Math.round(startSec * m.sampleRate) })), masterName: m.name };
      }
    }
    const slot = mob.strongRefs(PID.Mob_Slots).find(s => s.uint(PID.MobSlot_SlotID) === slotId);
    if (!slot) return null;
    const rate = slot.rational(PID.TimelineMobSlot_EditRate) || editRate;
    let seg = slot.strongRef(PID.MobSlot_Segment);
    // Le slot d'un mob maître contient un SourceClip (parfois dans une Sequence).
    while (seg && seg.classId === CLS.Sequence) seg = seg.strongRefs(PID.Sequence_Components).find(c => c.classId === CLS.SourceClip) || null;
    while (seg && seg.classId === CLS.EssenceGroup) seg = seg.strongRefs(PID.EssenceGroup_Choices)[0] || null;
    if (!seg || seg.classId !== CLS.SourceClip) return null;
    const inner = resolve(seg, rate, depth + 1);
    if (!inner) return null;
    const masterName = mob.classId === CLS.MasterMob ? mob.string(PID.Mob_Name) || inner.masterName : inner.masterName;
    return { sources: inner.sources.map(s => ({ ...s, offset: s.offset + Math.round(startSec * s.media.sampleRate) })), masterName };
  };

  // ── Composition ──────────────────────────────────────────────────────────────────────
  const comps = mobs.filter(m => m.classId === CLS.CompositionMob);
  if (!comps.length) throw new AafReadError('Aucune séance dans ce fichier AAF (pas de CompositionMob).');
  const soundSlots = (m: AafObject) => m.strongRefs(PID.Mob_Slots).filter(s => isSoundDef(s.strongRef(PID.MobSlot_Segment)?.weakRefKey(PID.Component_DataDefinition) ?? null));
  const comp = comps.find(m => m.auid(PID.Mob_UsageCode) === USAGE_TOPLEVEL)
    || [...comps].sort((a, b) => soundSlots(b).length - soundSlots(a).length)[0];
  if (comps.length > 1) warnings.push(`${comps.length} séquences dans l'AAF : « ${comp.string(PID.Mob_Name) || 'sans nom'} » est importée.`);

  const slots = soundSlots(comp);
  let editRate: Rational = { num: 48000, den: 1 };
  const rawTracks: (Omit<AafTrack, 'clips'> & { clips: RawClip[]; slotName: string })[] = [];

  // Fréquence de la séance : celle des médias (la plus fréquente), sinon le débit d'édition s'il est audio.
  const rateVotes = new Map<number, number>();

  for (const slot of slots) {
    const er = slot.rational(PID.TimelineMobSlot_EditRate) || { num: 48000, den: 1 };
    editRate = er;
    const name = slot.string(PID.MobSlot_SlotName) || `Piste ${slot.uint(PID.MobSlot_SlotID)}`;
    let seg = slot.strongRef(PID.MobSlot_Segment);
    let volume: number | null = null, pan: number | null = null, volumeAutomated = false, panAutomated = false;
    // OperationGroup au niveau de la piste : volume (Mono Audio Gain) et panoramique (Mono Audio Pan).
    for (let guard = 0; seg && seg.classId === CLS.OperationGroup && guard < 8; guard++) {
      const op = seg.weakRefKey(PID.OperationGroup_Operation);
      const p = paramOf(seg, op === OPDEF.MonoAudioPan ? PARAMDEF.Pan : PARAMDEF.Amplitude);
      if (op === OPDEF.MonoAudioGain || op === OPDEF.StereoAudioGain) { volume = p.value; volumeAutomated = p.varying; }
      else if (op === OPDEF.MonoAudioPan) { pan = p.value === null ? null : Math.max(-1, Math.min(1, p.value * 2 - 1)); panAutomated = p.varying; }
      seg = seg.strongRefs(PID.OperationGroup_InputSegments)[0] || null;
    }
    const pieces: Piece[] = [];
    const walk = (s: AafObject | null, wrapGain = 1, wrapPoints?: AafClip['gainPoints']) => {
      if (!s) return;
      const len = s.int(PID.Component_Length, 0);
      switch (s.classId) {
        case CLS.Sequence:
          for (const c of s.strongRefs(PID.Sequence_Components)) walk(c, wrapGain, wrapPoints);
          return;
        case CLS.Filler:
          pieces.push({ kind: 'gap', length: len });
          return;
        case CLS.Transition: {
          const og = s.strongRef(PID.Transition_OperationGroup);
          const interp = og ? levelInterp(og) : null;
          const shape = interp ? SHAPE_OF_INTERP[interp] : undefined;
          pieces.push({ kind: 'trans', length: len, fade: { shape: shape || 'LINEAR', approx: !shape, source: 'transition' } });
          return;
        }
        case CLS.OperationGroup: {
          const op = s.weakRefKey(PID.OperationGroup_Operation);
          const inputs = s.strongRefs(PID.OperationGroup_InputSegments);
          if (op === OPDEF.MonoAudioGain || op === OPDEF.StereoAudioGain) {
            const p = paramOf(s, PARAMDEF.Amplitude);
            const points = p.points?.map(x => ({ t: Math.round(x.t * len), gain: x.v }));
            walk(inputs[0] || null, wrapGain * (p.varying ? 1 : (p.value ?? 1)), p.varying ? points : wrapPoints);
          } else {
            if (inputs.length !== 1) warnings.push(`Effet AAF non repris sur « ${name} » (${inputs.length} entrées) : le premier son est gardé.`);
            if (inputs[0]) walk(inputs[0], wrapGain, wrapPoints);
            else pieces.push({ kind: 'gap', length: len });
          }
          return;
        }
        case CLS.Selector: walk(s.strongRef(PID.Selector_Selected), wrapGain, wrapPoints); return;
        case CLS.EssenceGroup: walk(s.strongRefs(PID.EssenceGroup_Choices)[0] || null, wrapGain, wrapPoints); return;
        case CLS.SourceClip: {
          const r = resolve(s, er);
          if (!r) { pieces.push({ kind: 'gap', length: len }); if (s.mobId(PID.SourceReference_SourceID) && !/^0+$/.test(s.mobId(PID.SourceReference_SourceID)!)) warnings.push(`Un clip de « ${name} » renvoie à un son absent de l'AAF : il est ignoré.`); return; }
          const masterName = r.masterName || 'Clip';
          const clip: RawClip = { name: masterName, masterName, position: 0, length: len, sources: r.sources, gain: wrapGain, gainPoints: wrapPoints };
          const fiL = s.int(PID.SourceClip_FadeInLength, 0), foL = s.int(PID.SourceClip_FadeOutLength, 0);
          if (fiL > 0) clip.fadeIn = { length: fiL, shape: s.uint(PID.SourceClip_FadeInType, 1) === 2 ? 'EQUAL_POWER' : 'LINEAR', approx: false, source: 'clip' };
          if (foL > 0) clip.fadeOut = { length: foL, shape: s.uint(PID.SourceClip_FadeOutType, 1) === 2 ? 'EQUAL_POWER' : 'LINEAR', approx: false, source: 'clip' };
          if (RENDERED_FADE_RX.test(masterName)) clip.rendered = true;
          if (SAMPLE_ACCURATE_RX.test(masterName)) clip.sae = true;
          for (const src of r.sources) rateVotes.set(src.media.sampleRate, (rateVotes.get(src.media.sampleRate) || 0) + 1);
          pieces.push({ kind: 'clip', clip });
          return;
        }
        default:
          pieces.push({ kind: 'gap', length: len });
      }
    };
    walk(seg);

    // Positions (unités d'édition) ; les Transitions chevauchent le composant précédent.
    const clips: RawClip[] = [];
    let pos = 0;
    pieces.forEach((p, i) => {
      if (p.kind === 'gap') { pos += p.length; return; }
      if (p.kind === 'clip') { p.clip.position = pos; pos += p.clip.length; clips.push(p.clip); return; }
      pos -= p.length;
      const prev = pieces[i - 1], next = pieces[i + 1];
      const fade = (length: number): AafFade => ({ ...p.fade, length });
      if (prev?.kind === 'clip' && next?.kind === 'clip') {
        prev.clip.fadeOut = fade(p.length); next.clip.fadeIn = fade(p.length);
        stats.crossfades++;
      } else if (next?.kind === 'clip') next.clip.fadeIn = fade(p.length);
      else if (prev?.kind === 'clip') prev.clip.fadeOut = fade(p.length);
    });
    rawTracks.push({ name, slotName: name, channels: 1, clips, volume, pan, volumeAutomated, panAutomated });
  }

  // Fréquence de la séance
  const voted = [...rateVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const erValue = editRate.num / editRate.den;
  const sampleRate = voted || (erValue >= 8000 ? Math.round(erValue) : 48000);
  if (rateVotes.size > 1) warnings.push(`Sons à plusieurs fréquences (${[...rateVotes.keys()].map(r => `${r / 1000} kHz`).join(', ')}) : la séance est lue à ${sampleRate / 1000} kHz.`);
  const videoRate = erValue < 1000;
  if (videoRate) warnings.push(`Séance au débit d'édition vidéo (${fmtRate(erValue)} images/s) : les positions sont sur les images, les bouts « Sample accurate edit » sont recollés.`);

  // ── Conversion en échantillons, fondus rendus, bouts « Sample accurate edit » ─────────
  const tracks: AafTrack[] = rawTracks.map(t => {
    // Les unités d'édition de la piste → échantillons de la séance (exact si entier).
    const k = sampleRate / erValue;
    const toS = (x: number) => {
      const v = x * k;
      const r = Math.round(v);
      if (Math.abs(v - r) > 1e-6) stats.roundedPositions++;
      return r;
    };
    const conv = (f?: AafFade) => (f ? { ...f, length: toS(f.length) } : undefined);
    let clips: RawClip[] = t.clips.map(c => ({
      ...c, position: toS(c.position), length: toS(c.length), fadeIn: conv(c.fadeIn), fadeOut: conv(c.fadeOut),
      gainPoints: c.gainPoints?.map(p => ({ ...p, t: toS(p.t) })),
      sources: c.sources.map(s => ({ ...s })),
    }));
    clips = mergeSampleAccurate(clips, stats, sampleRate);
    clips = replaceRenderedFades(clips, stats, sampleRate);
    return { ...t, clips: clips.map(({ masterName, rendered: _r, sae: _s, ...c }) => ({ ...c, name: clipName(masterName || c.name) })), channels: Math.max(1, ...clips.map(c => c.sources.length)) };
  });

  const paired = pairStereo(tracks, stats, warnings);
  stats.clips = paired.reduce((s, t) => s + t.clips.length, 0);
  for (const t of paired) for (const c of t.clips) for (const f of [c.fadeIn, c.fadeOut]) if (f) { if (f.approx) stats.fadesApprox++; else stats.fadesExact++; }
  stats.skippedSlots = comp.strongRefs(PID.Mob_Slots).length - slots.length;
  const missingRate = [...media.values()].filter(m => !m.sampleRate);
  missingRate.forEach(m => { m.sampleRate = sampleRate; });
  return {
    name: comp.string(PID.Mob_Name) || 'Séance AAF', sampleRate, editRate, tracks: paired,
    media: [...media.values()], warnings, stats,
  };
}

// ── Aides ────────────────────────────────────────────────────────────────────────────────
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const fmtRate = (r: number) => (Number.isInteger(r) ? String(r) : r.toFixed(3).replace('.', ','));

function channelIds(sc: AafObject): number[] {
  const d = sc.data(0x1103);
  if (!d || d.length < 8) return [];
  // Tableau d'entiers : nombre (u32) puis valeurs u32 (ou valeurs seules selon l'écrivain).
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const vals: number[] = [];
  for (let i = 0; i + 4 <= d.length; i += 4) vals.push(dv.getUint32(i, true));
  const list = vals.length > 1 && vals[0] === vals.length - 1 ? vals.slice(1) : vals;
  return list.filter(v => v >= 1).map(v => v - 1);
}

/** Valeur d'un paramètre (constante ou courbe) d'un OperationGroup. */
function paramOf(og: AafObject, paramDef: string): { value: number | null; varying: boolean; points?: { t: number; v: number }[] } {
  const params = og.strongRefs(PID.OperationGroup_Parameters);
  const p = params.find(x => x.auid(PID.Parameter_Definition) === paramDef) || params[0];
  if (!p) return { value: null, varying: false };
  if (p.classId === CLS.ConstantValue) return { value: indirectNumber(p.indirect(PID.ConstantValue_Value)), varying: false };
  if (p.classId === CLS.VaryingValue) {
    const points = p.strongRefs(PID.VaryingValue_PointList).map(cp => {
      const t = cp.data(PID.ControlPoint_Time);
      return { t: t && t.length >= 8 ? ratValue(readRational(t)) : 0, v: indirectNumber(cp.indirect(PID.ControlPoint_Value)) ?? 1 };
    }).sort((a, b) => a.t - b.t);
    return { value: points.length ? points[0].v : null, varying: points.length > 1 && points.some(x => Math.abs(x.v - points[0].v) > 1e-9), points };
  }
  return { value: null, varying: false };
}

/** Interpolation de la courbe Level d'une Transition (forme du fondu). */
function levelInterp(og: AafObject): string | null {
  for (const p of og.strongRefs(PID.OperationGroup_Parameters)) {
    if (p.classId === CLS.VaryingValue) return p.weakRefKey(PID.VaryingValue_Interpolation);
  }
  return null;
}

const clipName = (n: string) => (n || 'Clip').replace(/\.(wav|aif|aiff|bwf)$/i, '');

/** Bouts « Sample accurate edit » : recollés au clip voisin (même son, à l'échantillon près). */
function mergeSampleAccurate(clips: RawClip[], stats: AafSession['stats'], sr: number): RawClip[] {
  const inMedia = (s: AafClipSource, n: number) => Math.round((n * s.media.sampleRate) / sr);
  const out: RawClip[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c.sae) { out.push(c); continue; }
    const next = clips[i + 1], prev = out[out.length - 1];
    if (next && !next.sae && !next.rendered && next.position === c.position + c.length && next.sources.every(s => s.offset >= inMedia(s, c.length))) {
      next.position -= c.length; next.length += c.length;
      next.sources.forEach(s => { s.offset -= inMedia(s, c.length); });
      stats.sampleAccurateMerged++;
    } else if (prev && !prev.rendered && prev.position + prev.length === c.position) {
      prev.length += c.length;
      stats.sampleAccurateMerged++;
    } else out.push(c);
  }
  return out;
}

/** Fondus rendus par Pro Tools (« Fade … ») → vrai fondu sur le clip collé, forme approchée. */
function replaceRenderedFades(clips: RawClip[], stats: AafSession['stats'], sr: number): RawClip[] {
  const out: RawClip[] = [];
  const inMedia = (s: AafClipSource, n: number) => Math.round((n * s.media.sampleRate) / sr);
  const isReal = (c?: RawClip) => !!c && !c.rendered;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c.rendered) { out.push(c); continue; }
    const next = clips[i + 1], prev = out[out.length - 1];
    if (isReal(next) && next.position === c.position + c.length && !next.fadeIn && next.sources.every(s => s.offset >= inMedia(s, c.length))) {
      next.position -= c.length; next.length += c.length;
      next.sources.forEach(s => { s.offset -= inMedia(s, c.length); });
      next.fadeIn = { length: c.length, shape: 'EQUAL_POWER', approx: true, source: 'rendu' };
      stats.renderedFades++;
    } else if (isReal(prev) && prev.position + prev.length === c.position && !prev.fadeOut
      && prev.sources.every(s => !s.media.length || s.offset + inMedia(s, prev.length + c.length) <= s.media.length)) {
      prev.length += c.length;
      prev.fadeOut = { length: c.length, shape: 'EQUAL_POWER', approx: true, source: 'rendu' };
      stats.renderedFades++;
    } else out.push(c); // fondu isolé : gardé comme clip (son rendu par Pro Tools)
  }
  return out;
}

/** Pistes stéréo en double mono (« Nom.L » / « Nom.R ») : une seule piste stéréo. */
function pairStereo(tracks: AafTrack[], stats: AafSession['stats'], warnings: string[]): AafTrack[] {
  const out: AafTrack[] = [];
  const sideRx = /^(.*?)[\s._-]*(?:\(?\s*([LR])\s*\)?)$/;
  for (let i = 0; i < tracks.length; i++) {
    const a = tracks[i], b = tracks[i + 1];
    const ma = a.name.match(sideRx), mb = b?.name.match(sideRx);
    const sameBase = ma && mb && ma[2].toUpperCase() === 'L' && mb[2].toUpperCase() === 'R' && ma[1].trim().toLowerCase() === mb[1].trim().toLowerCase() && /[._\s-]|\(/.test(a.name.slice(ma[1].length));
    if (b && sameBase && a.channels === 1 && b.channels === 1) {
      const same = a.clips.length === b.clips.length && a.clips.every((c, k) => c.position === b.clips[k].position && c.length === b.clips[k].length);
      if (same) {
        // Pan d'une paire : L à gauche et R à droite = centre ; décalés ensemble = pan de la piste stéréo.
        const pan = a.pan !== null && b.pan !== null ? (a.pan + b.pan) / 2 : a.pan ?? b.pan;
        out.push({
          ...a, name: ma![1].trim(), channels: 2, pan: pan === null ? null : Math.abs(pan) < 1e-9 ? 0 : pan,
          volume: a.volume ?? b.volume, volumeAutomated: a.volumeAutomated || b.volumeAutomated, panAutomated: a.panAutomated || b.panAutomated,
          clips: a.clips.map((c, k) => ({ ...c, name: c.name.replace(/[._\s-]*[LR]$/i, ''), sources: [...c.sources, ...b.clips[k].sources] })),
        });
        stats.stereoPairs++;
        i++;
        continue;
      }
      warnings.push(`« ${a.name} » et « ${b.name} » n'ont pas les mêmes clips : gardées en deux pistes mono.`);
    }
    out.push(a);
  }
  return out;
}

/** Résumé lisible (« 47 clips importés, 2 fondus approchés »). */
export function aafSummary(s: Pick<AafSession, 'stats' | 'tracks'>, opts: { missingMedia?: number } = {}): string {
  const n = s.stats.clips;
  const parts = [`${n} clip${n > 1 ? 's' : ''} importé${n > 1 ? 's' : ''}`];
  parts.push(`${s.tracks.length} piste${s.tracks.length > 1 ? 's' : ''}`);
  if (s.stats.fadesApprox) parts.push(`${s.stats.fadesApprox} fondu${s.stats.fadesApprox > 1 ? 's' : ''} approché${s.stats.fadesApprox > 1 ? 's' : ''}`);
  if (opts.missingMedia) parts.push(`${opts.missingMedia} son${opts.missingMedia > 1 ? 's' : ''} introuvable${opts.missingMedia > 1 ? 's' : ''}`);
  return parts.join(', ');
}

