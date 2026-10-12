/**
 * Branchement de l'échange AAF dans l'appli (navigateur) :
 *  - ouvrir un .aaf, retrouver ses fichiers liés parmi ceux choisis, décoder les sons,
 *    les enregistrer dans le registre et ajouter les pistes au projet (Ctrl+Z annule) ;
 *  - fabriquer le .zip « Séance pour Pro Tools » (AAF + Audio Files/*.wav + LISEZ-MOI).
 * La logique AAF est dans les modules purs (aafRead, aafWrite, aafToNova, novaToAaf).
 */
import JSZip from 'jszip';
import type { DAWState } from '../../types';
import { audioBufferRegistry } from '../audioBufferRegistry';
import { resampleBuffer } from '../hqAudio';
import { projectRateOf } from '../projectRate';
import { applyImport, ImportReport } from '../sessionImport';
import { AafMedia, AafSession, readAaf } from './aafRead';
import { aafToNova, AafImportReport } from './aafToNova';
import { decodeAudioFile, decodePcm, matchLinkedFile, PcmAudio } from './aafMedia';
import { planNovaExport, NovaExportOptions, NovaExportPlan } from './novaToAaf';
import { AafExportResult, MEDIA_FOLDER, writeAaf } from './aafWrite';

export const isAafFile = (f: { name: string }) => /\.aaf$/i.test(f.name);
export const isAudioFile = (f: { name: string }) => /\.(wav|wave|bwf|aif|aiff|aifc)$/i.test(f.name);

export async function openAaf(file: File): Promise<AafSession> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readAaf(bytes);
}

/** Fichiers liés de la séance absents de la sélection de l'utilisateur. */
export function missingMedia(s: AafSession, files: File[]): AafMedia[] {
  const used = new Set(s.tracks.flatMap(t => t.clips.flatMap(c => c.sources.map(x => x.media.key))));
  return s.media.filter(m => used.has(m.key) && m.storage === 'lie' && !matchLinkedFile(m.fileName, files));
}

/** Son d'un média : essence intégrée (PCM brut, WAVE, AIFF) ou fichier lié choisi. */
async function mediaAudio(m: AafMedia, files: File[]): Promise<PcmAudio | null> {
  if (m.storage === 'integre') {
    const d = m.data?.();
    if (!d) return null;
    if (m.format === 'pcm') return { channels: decodePcm(d, m.channels, m.bits || 16), sampleRate: m.sampleRate, bits: m.bits };
    return decodeAudioFile(d);
  }
  const f = matchLinkedFile(m.fileName, files);
  if (!f) return null;
  return decodeAudioFile(new Uint8Array(await f.arrayBuffer()));
}

export interface AafImportOutcome { state: DAWState; report: AafImportReport; importReport: ImportReport; trackIds: string[] }

/**
 * Pistes de la séance ajoutées au projet `target` : sons décodés, convertis à la
 * fréquence du projet si besoin, enregistrés dans le registre.
 */
export async function importAafIntoProject(s: AafSession, files: File[], target: DAWState, onProgress?: (text: string) => void): Promise<AafImportOutcome> {
  const projectRate = projectRateOf(target);
  const stamp = Date.now().toString(36);
  const used = new Set(s.tracks.flatMap(t => t.clips.flatMap(c => c.sources.map(x => x.media.key))));
  const decoded = new Map<string, PcmAudio | null>();
  let k = 0;
  for (const m of s.media) {
    if (!used.has(m.key)) continue;
    onProgress?.(`Lecture des sons… ${++k} / ${used.size}`);
    decoded.set(m.key, await mediaAudio(m, files));
  }
  const conv = aafToNova(s, m => decoded.get(m.key) || null, { projectRate, idPrefix: `aaf${stamp}` });
  let i = 0;
  for (const b of conv.buffers) {
    onProgress?.(`Préparation des sons… ${++i} / ${conv.buffers.length}`);
    let buf = new AudioBuffer({ length: Math.max(1, b.channels[0].length), numberOfChannels: b.channels.length, sampleRate: b.sampleRate });
    b.channels.forEach((ch, c) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, c));
    if (b.sampleRate !== projectRate) buf = await resampleBuffer(buf, projectRate);
    audioBufferRegistry.register(buf, b.id);
  }
  let n = 0;
  const r = applyImport(target, { tracks: conv.tracks, bpm: target.bpm }, conv.tracks.map(t => ({ sourceId: t.id, parts: ['clips', 'plugins', 'color'] })),
    { sameName: 'add', matchTempo: false }, base => `${base}-${stamp}${(n++).toString(36)}`);
  return { state: r.state, report: conv.report, importReport: r.report, trackIds: r.trackIds };
}

// ── Export ───────────────────────────────────────────────────────────────────────────────
/** Son d'un tampon du registre, canaux par canal (sans copie). */
export function registryAudio(id: string) {
  const b = audioBufferRegistry.get(id);
  if (!b) return null;
  return { channels: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)), sampleRate: b.sampleRate };
}

export function planProjectExport(state: DAWState, opts: NovaExportOptions): NovaExportPlan {
  return planNovaExport({ ...state, sampleRate: projectRateOf(state) }, registryAudio, opts);
}

const safeName = (s: string) => (s || 'Séance').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Séance';

export interface AafZip { blob: Blob; fileName: string; result: AafExportResult; plan: NovaExportPlan }

/** .zip « Séance pour Pro Tools » : <nom>.aaf, Audio Files/*.wav (BWF horodatés), LISEZ-MOI.txt. */
export async function buildProToolsZip(state: DAWState, opts: NovaExportOptions): Promise<AafZip> {
  const plan = planProjectExport(state, opts);
  const result = await writeAaf(plan.input);
  const name = safeName(state.name);
  const zip = new JSZip();
  const folder = `${name} (Pro Tools)`;
  zip.file(`${folder}/${name}.aaf`, result.aaf);
  for (const f of result.files) zip.file(`${folder}/${f.path}`, f.bytes);
  zip.file(`${folder}/LISEZ-MOI.txt`, readme(name, plan, result, opts));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blob, fileName: `${name} (Pro Tools).zip`, result, plan };
}

function readme(name: string, plan: NovaExportPlan, r: AafExportResult, opts: NovaExportOptions): string {
  const lines = [
    `Séance « ${name} » exportée par NOVA pour Pro Tools`,
    '',
    `Contenu : ${r.stats.tracks} piste(s), ${r.stats.clips} clip(s), ${r.stats.mediaFiles} fichier(s) BWF 24 bits à ${plan.input.sampleRate / 1000} kHz.`,
    opts.embed ? 'Les sons sont intégrés dans le fichier AAF (le dossier Audio Files est une copie de secours).'
      : `Les sons sont dans le dossier « ${MEDIA_FOLDER} », à côté du fichier AAF : gardez-les ensemble.`,
    '',
    'Dans Pro Tools :',
    `  1. Décompressez ce dossier sur le disque de vos séances.`,
    `  2. Fichier › Ouvrir… et choisissez « ${name}.aaf » (nouvelle séance),`,
    '     ou Fichier › Importer › Données de session… dans une séance ouverte.',
    `  3. Si Pro Tools demande les fichiers audio : « Relier manuellement » puis le dossier « ${MEDIA_FOLDER} ».`,
    '',
    'Secours : chaque fichier BWF est horodaté (bext TimeReference). Glissez-les dans Pro Tools en mode Spot',
    '(« Horodatage d\'origine ») : ils se posent à l\'échantillon près.',
  ];
  if (plan.skipped.length) lines.push('', 'Non exporté :', ...plan.skipped.map(s => `  - ${s}`));
  if (plan.notes.length || r.messages.length) lines.push('', 'Remarques :', ...[...plan.notes, ...r.messages].map(s => `  - ${s}`));
  return lines.join('\r\n') + '\r\n';
}
