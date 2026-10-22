import type { Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { runExport, renderRate, ExportSettings } from './ExportPipeline';
import { prepareTracksForOffline } from './VstFreeze';
import { safeFileName } from '../utils/exportNaming';

/**
 * Chantier 11 · Bounce du mix pour « Envoyer la version N » : le MÊME chemin que
 * l'export du mix (Exporter › Mix : effets VST rendus par le pont, guides retirés,
 * queue automatique), en WAV 16 bits à la fréquence du projet, sans normalisation
 * (l'artiste entend le mix tel qu'il est). Rien n'est téléchargé : le son est
 * décodé puis envoyé par le canal audio de la collaboration (services/Collab).
 */
export async function renderMixBounce(tracks: Track[], title: string, onStep: (text: string) => void = () => {}, opts: { tag?: boolean } = {}): Promise<{ buffer: AudioBuffer; missingVst: string[]; tagged: boolean }> {
  const end = Math.max(0.05, ...tracks.filter(t => !t.isGuide).flatMap(t => t.clips.map(c => c.start + c.duration)));
  const settings: ExportSettings = {
    source: 'MASTER', start: 0, end, tail: { mode: 'auto', seconds: 2 },
    format: 'WAV', bits: 16, mp3Kbps: 320, sampleRate: renderRate(), layout: 'stereo', dither: false, normalize: 'off',
    meta: { title }, naming: { title }, baseName: safeFileName(title, 'Mix'),
  };
  onStep('préparation des pistes…');
  const prep = await prepareTracksForOffline(tracks, msg => onStep(msg));
  try {
    const r = await runExport(prep.tracks, settings, [], (pct, text) => onStep(`${text} ${Math.round(pct)} %`));
    const file = r.files[0] || { blob: r.download.blob };
    await audioEngine.init();
    const ctx = audioEngine.ctx;
    if (!ctx) throw new Error('moteur audio indisponible');
    const buffer = await ctx.decodeAudioData(await file.blob.arrayBuffer());
    // Beat sans licence ou sons des kits NOVA dans un projet non payé : tag sonore, comme la démo
    // gratuite (sinon cette version serait un export propre gratuit, lisible sur la page d'écoute).
    if (opts.tag) { const { applyTag } = await import('../utils/demoExport'); await applyTag(buffer); }
    return { buffer, missingVst: prep.missingVst, tagged: !!opts.tag };
  } finally { prep.cleanup(); }
}
