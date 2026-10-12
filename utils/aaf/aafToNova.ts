/**
 * Séance AAF lue (aafRead) → pistes NOVA, prêtes pour utils/sessionImport.applyImport.
 *
 * Positions et durées en secondes calculées depuis des échantillons ENTIERS
 * (position / fréquence) : relues ×fréquence elles redonnent l'échantillon exact.
 * Le son de chaque clip est un tampon du registre : un par média (mono ou stéréo
 * entrelacé) ou un par paire double mono (L + R réunis).
 *
 * Module pur : tests/aafRead.test.ts.
 */
import { Clip, ClipGainPoint, Track, TrackType } from '../../types';
import type { AafClip, AafMedia, AafSession } from './aafRead';
import { aafSummary } from './aafRead';

export interface MediaAudio { channels: Float32Array[]; sampleRate: number }

/** Son d'un clip à enregistrer dans le registre (identifiant = bufferId des clips). */
export interface ImportBuffer { id: string; channels: Float32Array[]; sampleRate: number }

export interface AafImportReport {
  /** « 47 clips importés, 6 pistes, 2 fondus approchés ». */
  summary: string;
  clips: number;
  tracks: number;
  sampleRate: number;
  projectRate: number;
  fadesExact: number;
  fadesApprox: number;
  renderedFades: number;
  crossfades: number;
  stereoPairs: number;
  sampleAccurateMerged: number;
  roundedPositions: number;
  /** Fichiers liés introuvables (clips gardés à leur place, muets). */
  missing: string[];
  offlineClips: number;
  /** Phrases du rapport, dans l'ordre d'affichage. */
  lines: string[];
}

const COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#facc15', '#34d399', '#fb923c', '#60a5fa', '#f87171'];
const linToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -144);

export function aafToNova(
  s: AafSession,
  audioOf: (m: AafMedia) => MediaAudio | null,
  opts: { projectRate: number; idPrefix: string },
): { tracks: Track[]; buffers: ImportBuffer[]; report: AafImportReport } {
  const buffers = new Map<string, ImportBuffer>();
  const missing = new Set<string>();
  const decoded = new Map<string, MediaAudio | null>();
  const audio = (m: AafMedia) => { if (!decoded.has(m.key)) decoded.set(m.key, audioOf(m)); return decoded.get(m.key)!; };
  let offline = 0;
  let n = 0;

  const bufferFor = (c: AafClip): { id: string; offsetSec: number } | null => {
    const srcs = c.sources;
    const parts = srcs.map(x => ({ src: x, a: audio(x.media) }));
    const lost = parts.filter(p => !p.a);
    if (lost.length) { lost.forEach(p => missing.add(p.src.media.fileName)); return null; }
    const key = srcs.map(x => `${x.media.key}:${x.channel}`).join('+');
    const off0 = srcs[0].offset / srcs[0].media.sampleRate;
    if (!buffers.has(key)) {
      const chans = parts.map(p => p.a!.channels[Math.min(p.src.channel, p.a!.channels.length - 1)]);
      // Double mono décalé (rare) : chaque canal recalé sur le premier.
      const shift = parts.map(p => Math.round((p.src.offset / p.src.media.sampleRate - off0) * p.a!.sampleRate));
      const len = Math.max(...chans.map((ch, i) => ch.length - shift[i]));
      const out = chans.map((ch, i) => (shift[i] === 0 ? ch : ch.subarray(Math.max(0, shift[i]))));
      const channels = out.map(ch => (ch.length === len ? ch : (() => { const x = new Float32Array(len); x.set(ch.subarray(0, len)); return x; })()));
      buffers.set(key, { id: `${opts.idPrefix}-son${buffers.size + 1}`, channels: channels.length > 2 ? channels.slice(0, 2) : channels, sampleRate: parts[0].a!.sampleRate });
    }
    return { id: buffers.get(key)!.id, offsetSec: off0 };
  };

  const tracks: Track[] = s.tracks.map((t, ti) => {
    const color = COLORS[ti % COLORS.length];
    const trackId = `${opts.idPrefix}-p${ti + 1}`;
    const clips: Clip[] = t.clips.map(c => {
      const sr = s.sampleRate;
      const b = bufferFor(c);
      const clip: Clip = {
        id: `${opts.idPrefix}-c${++n}`, name: c.name, color, type: TrackType.AUDIO,
        start: c.position / sr, duration: c.length / sr,
        offset: b ? b.offsetSec : c.sources[0] ? c.sources[0].offset / (c.sources[0].media.sampleRate || sr) : 0,
        fadeIn: c.fadeIn ? c.fadeIn.length / sr : 0, fadeOut: c.fadeOut ? c.fadeOut.length / sr : 0,
      };
      if (c.fadeIn) clip.fadeInCurve = c.fadeIn.shape;
      if (c.fadeOut) clip.fadeOutCurve = c.fadeOut.shape;
      if (Math.abs(c.gain - 1) > 1e-9) clip.gain = c.gain;
      if (c.gainPoints && c.gainPoints.length > 1) {
        clip.gainPoints = c.gainPoints.map((p): ClipGainPoint => ({ t: clip.offset + p.t / sr, db: Math.round(linToDb(p.gain) * 1000) / 1000 }));
      }
      if (b) clip.bufferId = b.id;
      else { clip.isOffline = true; offline++; }
      return clip;
    });
    return {
      id: trackId, name: t.name, type: TrackType.AUDIO, color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: t.volume ?? 1, pan: t.pan ?? 0, outputTrackId: 'master', sends: [], clips, plugins: [], automationLanes: [], totalLatency: 0,
    };
  });

  const st = s.stats;
  const report: AafImportReport = {
    summary: aafSummary(s, { missingMedia: missing.size }), clips: st.clips, tracks: s.tracks.length, sampleRate: s.sampleRate, projectRate: opts.projectRate,
    fadesExact: st.fadesExact, fadesApprox: st.fadesApprox, renderedFades: st.renderedFades, crossfades: st.crossfades, stereoPairs: st.stereoPairs,
    sampleAccurateMerged: st.sampleAccurateMerged, roundedPositions: st.roundedPositions, missing: [...missing], offlineClips: offline, lines: [],
  };
  report.lines = reportLines(s, report);
  return { tracks, buffers: [...buffers.values()], report };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const khz = (r: number) => `${(r / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kHz`;

/** Rapport d'import lisible, du plus important au détail. */
export function reportLines(s: AafSession, r: AafImportReport): string[] {
  const out: string[] = [];
  out.push(`${plural(r.clips, 'clip importé', 'clips importés')} sur ${plural(r.tracks, 'piste')}, à l'échantillon près.`);
  if (r.roundedPositions) out.push(`⚠️ ${plural(r.roundedPositions, 'position arrondie', 'positions arrondies')} à l'échantillon (débit d'édition non entier).`);
  out.push(`Fréquence de la séance : ${khz(r.sampleRate)}${r.sampleRate !== r.projectRate ? ` — le projet est à ${khz(r.projectRate)} : les sons sont convertis, les positions gardent leur temps.` : '.'}`);
  const fades = r.fadesExact + r.fadesApprox;
  if (fades) out.push(`${plural(fades, 'fondu')} : ${r.fadesExact} à la forme exacte${r.fadesApprox ? `, ${plural(r.fadesApprox, 'approché', 'approchés')} (forme inconnue ou fondu rendu par Pro Tools)` : ''}.`);
  if (r.renderedFades) out.push(`${plural(r.renderedFades, 'fondu rendu', 'fondus rendus')} par Pro Tools remplacé${r.renderedFades > 1 ? 's' : ''} par un vrai fondu sur le clip.`);
  if (r.crossfades) out.push(`${plural(r.crossfades, 'fondu enchaîné', 'fondus enchaînés')} entre deux clips.`);
  if (r.stereoPairs) out.push(`${plural(r.stereoPairs, 'piste stéréo', 'pistes stéréo')} en double mono (.L / .R) regroupée${r.stereoPairs > 1 ? 's' : ''}.`);
  if (r.sampleAccurateMerged) out.push(`${plural(r.sampleAccurateMerged, 'bout « Sample accurate edit » recollé', 'bouts « Sample accurate edit » recollés')} à son clip.`);
  const vol = s.tracks.filter(t => t.volume !== null).length, pan = s.tracks.filter(t => t.pan !== null).length;
  if (vol || pan) out.push(`Volume repris sur ${plural(vol, 'piste')}, panoramique sur ${plural(pan, 'piste')}.`);
  const auto = s.tracks.filter(t => t.volumeAutomated || t.panAutomated).map(t => t.name);
  if (auto.length) out.push(`Automation de volume ou de pan non reprise (valeur de départ gardée) : ${auto.join(', ')}.`);
  if (r.missing.length) out.push(`⚠️ ${plural(r.missing.length, 'fichier introuvable', 'fichiers introuvables')} : ${r.missing.join(', ')} — ${plural(r.offlineClips, 'clip gardé', 'clips gardés')} à sa place, muet${r.offlineClips > 1 ? 's' : ''}.`);
  for (const w of s.warnings) out.push(w);
  return out;
}
