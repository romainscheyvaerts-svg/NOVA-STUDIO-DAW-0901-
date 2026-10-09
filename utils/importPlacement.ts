import { TrackType, type Track } from '../types';

/**
 * Pistes créées par un dépôt de plusieurs fichiers (ex. 2 backs lâchés sur la
 * piste « Backs ») : comme dans Pro Tools, une piste par fichier en trop, posée
 * JUSTE SOUS la piste visée (avant : tout en haut, sous le beat), nommée sans
 * l'extension (avant : « back_2.wav », stems « back_2.wav.wav »), et dans le même
 * circuit que la piste visée : même sortie (bus voix), mêmes effets (copiés,
 * réglages compris), mêmes envois. Le fader et le pan restent neutres.
 * Module pur : tests/importPlacement.test.ts.
 */

/** Nom de piste d'après le fichier : sans extension, sans blancs en trop, 24 caractères. */
export function trackNameFromFile(fileName: string): string {
  const base = (fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/\s+/g, ' ').trim();
  return (base || 'Audio').slice(0, 24);
}

let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * Réglages de circuit repris de `model` (la piste visée par le dépôt) pour la
 * nouvelle piste. Rien de repris si la piste visée n'est pas une piste audio de
 * voix (beat, instrument) : la nouvelle piste part alors au master, vierge.
 */
export function circuitFrom(model: Track | undefined): Pick<Track, 'outputTrackId' | 'plugins' | 'sends'> {
  if (!model || model.id === 'instrumental' || model.instrumentId || model.type !== TrackType.AUDIO) {
    return { outputTrackId: 'master', plugins: [], sends: [] };
  }
  return {
    outputTrackId: model.outputTrackId || 'master',
    plugins: (model.plugins || []).map(p => ({ ...p, id: uid('plugin'), params: p.params ? JSON.parse(JSON.stringify(p.params)) : p.params })),
    sends: (model.sends || []).map(s => ({ ...s })),
  };
}

/** Index où insérer la nouvelle piste : juste sous la piste `afterId` (et ses pistes déjà créées par le même dépôt). */
export function insertIndexAfter(tracks: Pick<Track, 'id'>[], afterId: string | undefined, fallback = 1): number {
  const i = afterId ? tracks.findIndex(t => t.id === afterId) : -1;
  return i >= 0 ? i + 1 : Math.min(fallback, tracks.length);
}

/** Sélecteur de fichiers du PC pour un son (Ctrl+Maj+I, palette, menu). */
export function pickAudioFile(onFile: (f: File) => void) {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a';
  input.onchange = () => { const f = input.files?.[0]; if (f) onFile(f); };
  input.click();
}
