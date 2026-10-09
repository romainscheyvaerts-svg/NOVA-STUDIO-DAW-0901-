/**
 * Chaîne d'export de NOVA (R1), indépendante de la fenêtre : la fenêtre
 * « Exporter » et la file d'exports l'appellent avec des réglages figés.
 *
 * Rendu → queue (auto / réglée / coupée / bouclée) → rééchantillonnage
 * (filtre sinus cardinal, utils/resample) → mono-somme ou double mono →
 * volume final (crête ou cibles du Master Nova) → plafond MP3 → dither TPDF
 * (16 bits) → encodage WAV / AIFF / FLAC / MP3 avec métadonnées.
 *
 * Le mix est rendu à la fréquence des sources (celle du moteur) : les prises ne
 * passent plus par l'interpolation du navigateur, et la conversion vers 44,1,
 * 48 ou 96 kHz se fait une seule fois, proprement.
 */
import JSZip from 'jszip';
import { Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { AudioEncoder } from './AudioEncoder';
import { encodeWav, encodeAiff, applyLayout, applyTpdfDither, buildId3v2, makeRng, type AudioMeta, type ChannelLayout } from '../utils/audioFormats';
import { encodeFlac } from '../utils/flac';
import { resampleChannels } from '../utils/resample';
import { exportSpan, finalLength, applyTail, type TailSettings } from '../utils/exportTail';
import { withoutSoloSafe } from '../utils/soloMute';
import { planStems, withoutGuides, type StemGrouping, type ReturnsMode, MASTER } from '../utils/stemPlan';
import { extensionOf, stemFileNames } from '../utils/exportNaming';
import { integratedLufs, truePeakDb, MP3_TRUE_PEAK_CEILING } from '../utils/loudness';
import { loudnessRangeOf } from '../utils/audioMeasure';
import { PLATFORM_TARGETS } from '../utils/masterAssistant';

export type ExportFormat = 'WAV' | 'AIFF' | 'FLAC' | 'MP3';
export type ExportSource = 'MASTER' | 'STEMS' | 'VOCALS';
/** off ; peak = crête vraie à −1 dBTP ; sinon l'id d'une cible du Master Nova (spotify, apple…). */
export type NormalizeMode = 'off' | 'peak' | string;

export interface ExportSettings {
  source: ExportSource;
  /** Voix seules : prises brutes (sans effets). */
  vocalsDry?: boolean;
  stems?: { grouping: StemGrouping; returns: ReturnsMode; withMasterFx: boolean };
  /** Plage « musicale » dans le morceau (s), sans la queue. */
  start: number;
  end: number;
  tail: TailSettings;
  format: ExportFormat;
  /** 16, 24 ou 32 (flottant) ; FLAC : 16 ou 24. */
  bits: 16 | 24 | 32;
  mp3Kbps: number;
  sampleRate: number;
  layout: ChannelLayout;
  dither: boolean;
  normalize: NormalizeMode;
  meta: AudioMeta;
  /** Titre, BPM, ton (pour les noms Titre_BPM_Ton_Piste). */
  naming: { title: string; bpm?: number; key?: string };
  /** Nom du fichier principal (mix) ou du zip, sans extension. */
  baseName: string;
}

export interface ExportedFile { name: string; blob: Blob; frames: number; channels: number }

export interface ExportReport {
  lufs: number;
  truePeak: number;
  lra: number;
  /** Gain appliqué par la normalisation (dB). */
  gainDb: number;
  /** Cible visée (LUFS) et plafond ; « limitedByPeak » si la crête a bloqué. */
  target?: { label: string; lufs: number; ceiling: number; limitedByPeak: boolean };
  sampleRate: number;
  seconds: number;
}

export interface ExportResult {
  /** Fichier à enregistrer (le fichier seul, ou le zip). */
  download: { name: string; blob: Blob };
  files: ExportedFile[];
  report: ExportReport;
}

type Progress = (pct: number, text: string) => void;

const chans = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
const asBuf = (ch: Float32Array[], sr: number) => ({ sampleRate: sr, numberOfChannels: ch.length, length: ch[0]?.length || 0, getChannelData: (c: number) => ch[c] }) as unknown as AudioBuffer;

/** Fréquence de rendu : celle du moteur (= des prises décodées). */
export const renderRate = (): number => audioEngine.ctx?.sampleRate || 48000;

/** Fréquence de sortie réelle (le MP3 ne dépasse pas 48 kHz). */
export const outputRate = (s: Pick<ExportSettings, 'format' | 'sampleRate'>) => (s.format === 'MP3' ? Math.min(48000, s.sampleRate) : s.sampleRate);

/** Résolution réelle (FLAC : 24 bits au plus ; MP3 : 16). */
export const outputBits = (s: Pick<ExportSettings, 'format' | 'bits'>): 16 | 24 | 32 =>
  s.format === 'MP3' ? 16 : s.format === 'FLAC' ? (s.bits === 16 ? 16 : 24) : s.bits;

async function render(tracks: Track[], s: ExportSettings, seconds: number, onP?: (p: number) => void): Promise<Float32Array[]> {
  const b = await audioEngine.renderProject(tracks, seconds, s.start, renderRate(), onP);
  return chans(b).map(c => new Float32Array(c));
}

/** Rééchantillonnage + canaux : renvoie un ou deux jeux de canaux (double mono = deux fichiers). */
function shape(ch: Float32Array[], s: ExportSettings): Float32Array[][] {
  const resampled = resampleChannels(ch, renderRate(), outputRate(s));
  return applyLayout(resampled, s.layout);
}

/** Volume final du mix (jamais sur des stems : l'équilibre entre eux doit rester). */
function normalizeMix(ch: Float32Array[], sr: number, mode: NormalizeMode): { gainDb: number; target?: ExportReport['target'] } {
  if (mode === 'off') return { gainDb: 0 };
  const buf = asBuf(ch, sr);
  const scale = (g: number) => { const k = Math.pow(10, g / 20); for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= k; };
  if (mode === 'peak') {
    const tp = truePeakDb(buf);
    if (!Number.isFinite(tp) || tp < -120) return { gainDb: 0 };
    const g = -1 - tp;
    scale(g);
    return { gainDb: g, target: { label: 'Crête −1 dBTP', lufs: NaN, ceiling: -1, limitedByPeak: false } };
  }
  const t = PLATFORM_TARGETS.find(x => x.id === mode);
  if (!t) return { gainDb: 0 };
  const before = integratedLufs(buf);
  if (!Number.isFinite(before)) return { gainDb: 0 };
  let g = t.lufs - before;
  const tp = truePeakDb(buf);
  let limited = false;
  if (tp + g > t.ceiling) { g = t.ceiling - tp; limited = true; }
  scale(g);
  return { gainDb: g, target: { label: t.label, lufs: t.lufs, ceiling: t.ceiling, limitedByPeak: limited } };
}

async function encode(ch: Float32Array[], sr: number, s: ExportSettings, meta: AudioMeta | undefined, isStem: boolean): Promise<Blob> {
  const bits = outputBits(s);
  if (s.format === 'MP3') {
    // Plafond de crête vraie pour que le MP3 décodé ne sature pas.
    const buf = new AudioBuffer({ numberOfChannels: ch.length, length: Math.max(1, ch[0].length), sampleRate: sr });
    ch.forEach((c, i) => buf.copyToChannel(c, i));
    const mp3 = isStem ? await AudioEncoder.encodeMP3(buf, s.mp3Kbps) : await AudioEncoder.encodeMP3Plafonne(buf, s.mp3Kbps);
    const tag = meta ? buildId3v2(meta) : new Uint8Array(0);
    return new Blob([tag, mp3], { type: 'audio/mpeg' });
  }
  if (s.dither && bits < 32) applyTpdfDither(ch, bits, makeRng(0x5eed + ch[0].length));
  if (s.format === 'FLAC') return new Blob([encodeFlac(ch, sr, bits === 16 ? 16 : 24, meta)], { type: 'audio/flac' });
  if (s.format === 'AIFF') return new Blob([encodeAiff(ch, { sampleRate: sr, bits, float: bits === 32 }, meta)], { type: 'audio/aiff' });
  return new Blob([encodeWav(ch, { sampleRate: sr, bits, float: bits === 32 }, meta)], { type: 'audio/wav' });
}

function metaFor(s: ExportSettings, part: string | undefined, report: Partial<ExportReport>, markers: AudioMeta['markers']): AudioMeta {
  return {
    ...s.meta,
    title: part ? `${s.meta.title || s.naming.title} (${part})` : (s.meta.title || s.naming.title),
    timeReference: s.start,
    markers,
    loudness: { lufs: report.lufs, truePeak: report.truePeak, lra: report.lra },
    // Pochette : MP3 et FLAC seulement (un WAV de stem n'en a pas besoin).
    cover: s.format === 'MP3' || s.format === 'FLAC' ? s.meta.cover : undefined,
  };
}

/** Repères du projet à l'intérieur de la plage, recalés sur le début du fichier. */
export function markersInRange(markers: { name: string; time: number }[] | undefined, start: number, end: number) {
  return (markers || []).filter(m => m.time >= start && m.time <= end).map(m => ({ name: m.name, time: m.time - start }));
}

/**
 * Lance un export complet. `tracks` : pistes déjà préparées (VST rendus).
 * Les guides sont retirés ici, quelle que soit la source.
 */
export async function runExport(allTracks: Track[], s: ExportSettings, projectMarkers: { name: string; time: number }[] = [], onProgress: Progress = () => {}): Promise<ExportResult> {
  const tracks = withoutGuides(allTracks);
  const span = exportSpan(s.start, s.end, s.tail);
  const nominal = span.end - span.start;
  const sr = outputRate(s);
  const ext = extensionOf(s.format);
  const markers = markersInRange(projectMarkers, span.start, span.end);

  // 1. Le mix (référence de longueur pour la queue auto, et fichier du mode Mix).
  const mixTracks = s.source === 'STEMS' && s.stems && !s.stems.withMasterFx
    ? tracks.map(t => (t.id === MASTER ? { ...t, plugins: [] } : t))
    : tracks;
  let length: number | null = null;
  const files: ExportedFile[] = [];
  let report: ExportReport = { lufs: -Infinity, truePeak: -Infinity, lra: 0, gainDb: 0, sampleRate: sr, seconds: 0 };

  const finish = (raw: Float32Array[]): Float32Array[] => {
    const rr = renderRate();
    if (length === null) length = finalLength(raw, rr, nominal, s.tail);
    return applyTail(raw, length, s.tail.mode);
  };

  if (s.source === 'MASTER') {
    onProgress(2, 'Mixage du morceau…');
    const raw = await render(mixTracks, s, span.renderDuration, p => onProgress(2 + p * 0.6, 'Mixage du morceau…'));
    const sets = shape(finish(raw), s);
    const norm = normalizeMix(sets.flat(), sr, s.normalize);
    onProgress(70, 'Mesure du volume…');
    const all = sets.flat();
    const buf = asBuf(all, sr);
    report = { lufs: integratedLufs(buf), truePeak: truePeakDb(buf), lra: loudnessRangeOf(all, sr), gainDb: norm.gainDb, target: norm.target, sampleRate: sr, seconds: (all[0]?.length || 0) / sr };
    onProgress(80, `Création du fichier ${s.format}…`);
    const suffix = s.layout === 'dual-mono' ? ['.L', '.R'] : [''];
    for (let i = 0; i < sets.length; i++) {
      const blob = await encode(sets[i], sr, s, metaFor(s, undefined, report, markers), false);
      files.push({ name: `${s.baseName}${suffix[i]}.${ext}`, blob, frames: sets[i][0].length, channels: sets[i].length });
    }
    if (files.length === 1) {
      onProgress(100, 'Terminé');
      return { download: { name: files[0].name, blob: files[0].blob }, files, report };
    }
  } else {
    // Stems ou voix seules : même plage, même longueur pour tous.
    let parts: { label: string; tracks: Track[] }[];
    let refTracks: Track[] = mixTracks;
    if (s.source === 'STEMS') {
      const plan = planStems(tracks, s.stems || { grouping: 'tracks', returns: 'in-stems', withMasterFx: true });
      if (!plan.length) throw new Error('Aucune piste à exporter (pistes vides ou muettes).');
      parts = plan.map(p => ({ label: p.label, tracks: p.tracks }));
    } else {
      const estBeat = (t: Track) => t.id === 'instrumental' || (t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '');
      const sansBeat = tracks.filter(t => !estBeat(t));
      const voix = sansBeat.filter(t => (t.type === 'AUDIO' || t.type === 'DRUM_RACK' || !!t.bass808) && !t.isMuted && t.clips.some(c => !c.isMuted));
      if (!voix.length) throw new Error('Aucune de tes pistes (voix, batterie) à exporter.');
      const voixIds = new Set(voix.map(t => t.id));
      refTracks = sansBeat.map(withoutSoloSafe).map(t => ({ ...t, isSolo: voixIds.has(t.id), ...(voixIds.has(t.id) ? { isMuted: false } : {}) }));
      parts = voix.map(track => ({
        label: `${track.name}${s.vocalsDry ? ' (brut)' : ''}`,
        tracks: s.vocalsDry
          ? [{ ...track, isSolo: false, isFrozen: false, frozenClip: undefined, plugins: [], sends: [], outputTrackId: 'master', automationLanes: [] }, ...sansBeat.filter(t => t.id === MASTER).map(t => ({ ...t, plugins: [] }))]
          : sansBeat.map(withoutSoloSafe).map(t => (t.id === track.id ? { ...t, isMuted: false, isSolo: true } : { ...t, isSolo: false })),
      }));
    }
    // Longueur commune : d'après le mix de ces pistes (queue auto), rendu une fois.
    if (s.tail.mode === 'auto') {
      onProgress(1, 'Calcul de la queue (réverbe)…');
      const ref = await render(refTracks, s, span.renderDuration);
      length = finalLength(ref, renderRate(), nominal, s.tail);
    }
    const names = stemFileNames(s.format, s.naming, parts.map(p => p.label));
    const peaks: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const base = 3 + (i / parts.length) * 92;
      const label = `${s.source === 'STEMS' ? 'Stem' : 'Piste'} ${i + 1}/${parts.length} : ${parts[i].label}`;
      onProgress(base, label);
      const raw = await render(parts[i].tracks, s, span.renderDuration, p => onProgress(base + (p / 100) * (92 / parts.length) * 0.8, label));
      const sets = shape(finish(raw), s);
      const all = sets.flat();
      peaks.push(truePeakDb(asBuf(all, sr)));
      const suffix = s.layout === 'dual-mono' ? ['.L', '.R'] : [''];
      for (let k = 0; k < sets.length; k++) {
        const blob = await encode(sets[k], sr, s, metaFor(s, parts[i].label, {}, markers), true);
        const nm = suffix[k] ? names[i].replace(/(\.[a-z0-9]+)$/i, `${suffix[k]}$1`) : names[i];
        files.push({ name: nm, blob, frames: sets[k][0].length, channels: sets[k].length });
      }
    }
    report = { lufs: NaN, truePeak: Math.max(...peaks), lra: 0, gainDb: 0, sampleRate: sr, seconds: (length ?? 0) / renderRate() };
  }

  onProgress(96, 'Création du fichier .zip…');
  const zip = new JSZip();
  files.forEach(f => zip.file(f.name, f.blob));
  // Fiche de livraison lisible par l'ingé (Pro Tools : Session Info as Text).
  zip.file('LISEZMOI_NOVA.txt', deliveryNote(s, files, report));
  const blob = await zip.generateAsync({ type: 'blob' });
  onProgress(100, 'Terminé');
  const zipName = s.source === 'VOCALS' ? `${s.baseName}_Mes_pistes${s.vocalsDry ? '_brutes' : ''}.zip` : s.source === 'STEMS' ? `${s.baseName}_Stems.zip` : `${s.baseName}.zip`;
  return { download: { name: zipName, blob }, files, report };
}

export function deliveryNote(s: ExportSettings, files: ExportedFile[], r: ExportReport): string {
  const fmt = s.format === 'MP3' ? `MP3 ${s.mp3Kbps} kbps` : `${s.format} ${outputBits(s) === 32 ? '32 bits flottant' : `${outputBits(s)} bits`}`;
  const lines = [
    `${s.meta.title || s.naming.title}${s.meta.artist ? ` — ${s.meta.artist}` : ''}`,
    `Tempo : ${s.naming.bpm ?? '?'} BPM · Tonalité : ${s.meta.key || '?'}${s.meta.isrc ? ` · ISRC : ${s.meta.isrc}` : ''}`,
    `Format : ${fmt}, ${outputRate(s)} Hz, ${s.layout === 'stereo' ? 'stéréo' : s.layout === 'mono-sum' ? 'mono (somme)' : s.layout === 'mono' ? 'mono (canal gauche)' : 'double mono (G / D)'}`,
    `Plage : ${s.start.toFixed(3)} s → ${s.end.toFixed(3)} s du morceau, queue ${s.tail.mode === 'auto' ? 'automatique' : s.tail.mode === 'manual' ? `${s.tail.seconds} s` : s.tail.mode === 'wrap' ? 'bouclée' : 'coupée'}.`,
    `Tous les fichiers démarrent à 0 et durent ${r.seconds.toFixed(3)} s : glisse-les au début de ta session.`,
    s.source === 'STEMS' && s.stems ? `Stems : ${({ tracks: 'par piste', buses: 'par bus', folders: 'par dossier', 'instru-voix': 'instru et voix séparés' } as Record<string, string>)[s.stems.grouping]}, retours ${s.stems.returns === 'in-stems' ? 'dans chaque stem' : s.stems.returns === 'separate' ? 'en fichiers séparés' : 'absents'}, ${s.stems.withMasterFx ? 'avec' : 'sans'} les effets du master.` : '',
    Number.isFinite(r.lufs) ? `Loudness : ${r.lufs.toFixed(1)} LUFS intégrés, crête vraie ${r.truePeak.toFixed(1)} dBTP, LRA ${r.lra.toFixed(1)} LU.` : '',
    '',
    'Fichiers :',
    ...files.map(f => `  ${f.name}  (${f.channels === 1 ? 'mono' : 'stéréo'}, ${f.frames} échantillons)`),
    '',
    'Exporté avec NOVA Studio.',
  ];
  return lines.filter((l, i) => l !== '' || i > 0).join('\r\n');
}
