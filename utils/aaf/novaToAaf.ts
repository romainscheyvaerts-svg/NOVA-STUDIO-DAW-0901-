/**
 * Projet NOVA → séance à écrire en AAF (« Séance pour Pro Tools »).
 *
 *  - une piste AAF par piste audio (stéréo : double mono .L / .R, fait par l'écrivain) ;
 *  - clips en échantillons ENTIERS de la fréquence du projet ;
 *  - gain de clip, ligne de gain (segments droits), fondus et leur forme ;
 *  - fondus enchaînés NOVA (deux clips qui se chevauchent avec fondus égaux) → une
 *    Transition, comme un crossfade Pro Tools ;
 *  - clips qui se chevauchent autrement : répartis sur des pistes « Nom (2) »… ;
 *  - clip à l'envers : son rendu à l'envers ;
 *  - pistes MIDI et instruments : rendu gelé exporté en audio s'il existe, sinon listées
 *    comme non exportées (avec la marche à suivre).
 *
 * Module pur : le son est fourni par `getAudio` (registre des sons de l'appli).
 * Tests : tests/aafWrite.test.ts.
 */
import { Clip, CrossfadeCurve, DAWState, Track, TrackType } from '../../types';
import type { AafExportClip, AafExportInput, AafExportMedia, AafExportTrack } from './aafWrite';

export interface AudioData { channels: Float32Array[]; sampleRate: number }

export interface NovaExportOptions {
  embed: boolean;
  trackVolumePan: boolean;
  /** Clips coupés (muets) : exportés quand même (true) ou laissés de côté. */
  includeMuted?: boolean;
}

export interface NovaExportPlan {
  input: AafExportInput;
  /** Pistes ou clips non exportés, avec la raison (affichés dans le rapport). */
  skipped: string[];
  /** Remarques (approximations, couches). */
  notes: string[];
}

const DEFAULT_CURVE: CrossfadeCurve = 'LINEAR';
const dbToLin = (db: number) => Math.pow(10, db / 20);
const isAudioClip = (c: Clip) => !c.notes && !!c.bufferId && !c.isFreezeSlice;
const label = (t: Track) => `« ${t.name} »`;

export function planNovaExport(state: DAWState, getAudio: (bufferId: string) => AudioData | null, opts: NovaExportOptions): NovaExportPlan {
  const sr = state.sampleRate || 44100;
  const skipped: string[] = [];
  const notes: string[] = [];
  const media = new Map<string, AafExportMedia>();
  const tracks: AafExportTrack[] = [];
  const S = (sec: number) => Math.round(sec * sr);
  let curvesApprox = 0, breaths = 0, stretched = 0;
  const firstUse = new Map<string, number>();

  const mediaFor = (key: string, name: string, make: () => AudioData | null): AafExportMedia | null => {
    const got = media.get(key);
    if (got) return got;
    const a = make();
    if (!a || !a.channels.length || !a.channels[0].length) return null;
    const m: AafExportMedia = { id: key, name, channels: a.channels.slice(0, 2), sampleRate: a.sampleRate, timeReference: Number.POSITIVE_INFINITY };
    media.set(key, m);
    return m;
  };

  for (const t of state.tracks) {
    if (t.id === 'master') continue;
    const isInstrument = t.type !== TrackType.AUDIO || t.clips.some(c => c.notes);
    let sources: Clip[] = t.clips.filter(isAudioClip);
    if (isInstrument) {
      const frozen = t.frozenClip;
      if (frozen?.bufferId && getAudio(frozen.bufferId)) {
        sources = [{ ...frozen, name: `${t.name} (rendu)` }];
        notes.push(`${label(t)} (${kindLabel(t)}) : exportée en audio depuis son rendu gelé.`);
      } else {
        if (t.type === TrackType.BUS || t.type === TrackType.SEND) continue;
        if (t.clips.length || t.drumMachine) skipped.push(`${label(t)} (${kindLabel(t)}) : non exportée. Gèle la piste (❄) pour l'exporter en audio.`);
        continue;
      }
    }
    if (!sources.length) continue;

    const out: AafExportClip[] = [];
    const sorted = [...sources].sort((a, b) => a.start - b.start);
    for (const c of sorted) {
      if (c.isMuted && !opts.includeMuted) { skipped.push(`${label(t)} : clip coupé « ${c.name} » non exporté.`); continue; }
      if (c.isOffline) { skipped.push(`${label(t)} : son introuvable pour « ${c.name} », clip non exporté.`); continue; }
      const raw = c.bufferId ? getAudio(c.bufferId) : null;
      if (!raw) { skipped.push(`${label(t)} : son introuvable pour « ${c.name} », clip non exporté.`); continue; }
      if (c.warp?.enabled && c.warp.mode !== 'OFF' && c.warp.sourceBufferId) stretched++;
      if (c.breaths?.length) breaths++;
      let offset = Math.round((c.offset || 0) * raw.sampleRate);
      let m: AafExportMedia | null;
      if (c.isReversed) {
        // Son joué à l'envers : rendu dans son propre fichier.
        const a = Math.max(0, Math.round((c.offset || 0) * raw.sampleRate));
        const n = Math.min(raw.channels[0].length - a, Math.round(c.duration * raw.sampleRate));
        m = mediaFor(`${c.bufferId}#rev${a}-${n}`, `${c.name} (envers)`, () => ({ sampleRate: raw.sampleRate, channels: raw.channels.map(ch => ch.slice(a, a + n).reverse()) }));
        offset = 0;
        notes.push(`${label(t)} : clip à l'envers « ${c.name} » rendu dans son propre fichier.`);
      } else {
        m = mediaFor(c.bufferId!, c.name || t.name, () => raw);
      }
      if (!m) continue;
      const position = S(c.start);
      const length = Math.max(1, S(c.duration));
      const off = Math.round(offset);
      // Horodatage du fichier (Pro Tools : Original Time Stamp) : celui du 1er clip qui l'utilise sur la timeline.
      const first = firstUse.get(m.id);
      if (first === undefined || position < first) { firstUse.set(m.id, position); m.timeReference = Math.max(0, position - Math.round(off * sr / m.sampleRate)); }
      const clip: AafExportClip = {
        name: c.name || t.name, position, length, mediaId: m.id, offset: off, gain: c.gain ?? 1,
        fadeIn: c.fadeIn > 0 ? { length: S(c.fadeIn), shape: c.fadeInCurve || DEFAULT_CURVE } : undefined,
        fadeOut: c.fadeOut > 0 ? { length: S(c.fadeOut), shape: c.fadeOutCurve || DEFAULT_CURVE } : undefined,
      };
      if (c.gainPoints?.length && !c.gainRender) {
        if (c.gainPoints.some(p => p.curve)) curvesApprox++;
        clip.gainPoints = gainLine(c, sr);
      }
      out.push(clip);
    }
    if (!out.length) continue;

    // Fondus enchaînés et couches : une piste AAF ne superpose pas deux clips.
    const lanes: AafExportClip[][] = [];
    for (const c of out) {
      let placed = false;
      for (const lane of lanes) {
        const prev = lane[lane.length - 1];
        const end = prev.position + prev.length;
        const ov = end - c.position;
        if (ov <= 0) { lane.push(c); placed = true; break; }
        // Fondu enchaîné NOVA : chevauchement = fondu de sortie = fondu d'entrée.
        if (prev.fadeOut && c.fadeIn && Math.abs(prev.fadeOut.length - ov) <= 1 && Math.abs(c.fadeIn.length - ov) <= 1 && ov < prev.length && ov < c.length) {
          c.crossfadeIn = { length: ov, shape: c.fadeIn.shape };
          c.fadeIn = undefined; prev.fadeOut = undefined;
          lane.push(c); placed = true; break;
        }
      }
      if (!placed) lanes.push([c]);
    }
    const channels = Math.max(...out.map(c => media.get(c.mediaId)!.channels.length)) >= 2 ? 2 : 1;
    lanes.forEach((clips, i) => tracks.push({
      name: i === 0 ? t.name : `${t.name} (${i + 1})`, channels, clips,
      volume: t.volume, pan: t.pan,
    }));
    if (lanes.length > 1) notes.push(`${label(t)} : clips superposés répartis sur ${lanes.length} pistes (« ${t.name} (2) »…).`);
  }
  for (const m of media.values()) if (!Number.isFinite(m.timeReference)) m.timeReference = 0;
  if (curvesApprox) notes.push(`Ligne de gain : ${curvesApprox} clip${curvesApprox > 1 ? 's' : ''} aux segments courbes, exportés en segments droits.`);
  if (breaths) notes.push(`Respirations baissées sur ${breaths} clip${breaths > 1 ? 's' : ''} : non reprises dans l'AAF (son d'origine).`);
  if (stretched) notes.push(`${stretched} clip${stretched > 1 ? 's' : ''} calé${stretched > 1 ? 's' : ''} au tempo : exporté${stretched > 1 ? 's' : ''} tel${stretched > 1 ? 's' : ''} qu'ils sonnent dans NOVA.`);
  return {
    input: { name: state.name || 'Séance NOVA', sampleRate: sr, tracks, media: [...media.values()], embed: opts.embed, trackVolumePan: opts.trackVolumePan, project: state.name },
    skipped, notes,
  };
}

function kindLabel(t: Track): string {
  switch (t.type) {
    case TrackType.MIDI: return 'MIDI';
    case TrackType.DRUM_RACK: case TrackType.DRUM_SAMPLER: return 'batterie';
    case TrackType.SAMPLER: case TrackType.MELODIC_SAMPLER: return 'sampler';
    default: return 'instrument';
  }
}

/** Ligne de gain NOVA (dB, temps de la source) → points du clip (échantillons depuis le début, gain linéaire). */
function gainLine(c: Clip, sr: number): { t: number; gain: number }[] {
  const pts = [...(c.gainPoints || [])].sort((a, b) => a.t - b.t);
  const off = c.offset || 0;
  const at = (x: number): number => {
    if (x <= pts[0].t) return pts[0].db;
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i].t) { const a = pts[i - 1], b = pts[i]; const k = b.t > a.t ? (x - a.t) / (b.t - a.t) : 0; return a.db + k * (b.db - a.db); }
    }
    return pts[pts.length - 1].db;
  };
  const len = Math.max(1, Math.round(c.duration * sr));
  const out = [{ t: 0, gain: dbToLin(at(off)) }];
  for (const p of pts) {
    const t = Math.round((p.t - off) * sr);
    if (t > 0 && t < len) out.push({ t, gain: dbToLin(p.db) });
  }
  out.push({ t: len, gain: dbToLin(at(off + c.duration)) });
  return out;
}
