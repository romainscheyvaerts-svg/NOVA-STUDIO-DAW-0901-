/**
 * Séparation de stems (comme Stem Splitter dans Logic ou Stem Separation dans FL Studio).
 *
 * Un clip audio (beat importé, morceau de référence, sample…) est envoyé au pont de
 * l'appli Windows, qui le sépare sur le PC avec Demucs (module optionnel installé à la
 * demande, gratuit, en local). Les stems reviennent en nouvelles pistes calées au même
 * endroit que le clip, nommées « Voix (stem) », « Batterie (stem) »…, et le clip
 * d'origine est coupé (M pour le réentendre) pour ne pas doubler le son.
 *
 * Ce fichier ne contient que la logique (testée par vitest) ; l'interface est dans
 * components/StemSeparationDialog.tsx.
 */
import type { Clip, Track } from '../types';
import { TrackType } from '../types';
import type { BridgeState } from './NovaBridge';

export type StemCount = 2 | 4;
export type StemKey = 'vocals' | 'instrumental' | 'drums' | 'bass' | 'other';

export const STEM_TRACK_NAMES: Record<StemKey, string> = {
  vocals: 'Voix (stem)',
  instrumental: 'Instru (stem)',
  drums: 'Batterie (stem)',
  bass: 'Basse (stem)',
  other: 'Autres (stem)',
};

export const STEM_COLORS: Record<StemKey, string> = {
  vocals: '#f472b6',
  instrumental: '#38bdf8',
  drums: '#f59e0b',
  bass: '#a78bfa',
  other: '#34d399',
};

export const STEM_SETS: Record<StemCount, StemKey[]> = {
  2: ['vocals', 'instrumental'],
  4: ['vocals', 'drums', 'bass', 'other'],
};

/** Infobulle commune (équivalents dans les autres logiciels). */
export const STEMS_TOOLTIP =
  'Sépare la voix, la batterie, la basse et le reste du clip, comme Stem Splitter dans Logic ou Stem Separation dans FL Studio. Calcul gratuit sur ton PC (appli Windows).';

export const STEMS_INSTALL_LABEL = 'Installer la séparation de stems (~2 Go, une fois)';

export function stemTrackName(key: string): string {
  return STEM_TRACK_NAMES[key as StemKey] || `${key} (stem)`;
}

/** Pourquoi un clip ne peut pas être séparé (null = il peut l'être). */
export function clipSeparationBlocker(clip: Pick<Clip, 'type' | 'bufferId' | 'buffer' | 'duration'> | null | undefined, hasBuffer: boolean): string | null {
  if (!clip) return 'Clip introuvable';
  if (clip.type === TrackType.MIDI) return 'Un clip MIDI n’a pas de son à séparer : gèle ou exporte-le en audio d’abord.';
  if (!hasBuffer) return 'Le son de ce clip n’est pas encore chargé.';
  if ((clip.duration || 0) < 0.5) return 'Clip trop court pour être séparé (une demi-seconde minimum).';
  return null;
}

/** Où en est la séparation pour ce poste : web sans pont, appli à mettre à jour, ou prêt. */
export type StemsAvailability = 'web' | 'connect' | 'update' | 'ok';

export function stemsAvailability(bridge: Pick<BridgeState, 'status' | 'stems'>, isDesktop: boolean): StemsAvailability {
  if (bridge.status === 'connected') return bridge.stems ? 'ok' : 'update';
  return isDesktop ? 'connect' : 'web';
}

/** Les 1 ou 2 canaux d'un buffer, à envoyer au pont. */
export function bufferChannels(buffer: { numberOfChannels: number; getChannelData(c: number): Float32Array }): Float32Array[] {
  const n = Math.max(1, Math.min(2, buffer.numberOfChannels));
  return Array.from({ length: n }, (_, c) => buffer.getChannelData(c));
}

export interface StemForTracks {
  key: string;
  /** Identifiant du buffer déjà enregistré dans audioBufferRegistry. */
  bufferId: string;
}

/**
 * Pistes des stems : chaque stem a la longueur du buffer source, donc le clip garde
 * exactement le même début, la même découpe (offset, durée), les fondus, le gain et
 * le sens de lecture que le clip d'origine : tout reste aligné.
 */
export function buildStemTracks(source: { track: Pick<Track, 'id' | 'outputTrackId'>; clip: Clip }, stems: StemForTracks[], uid: string): Track[] {
  const c = source.clip;
  return stems.map((s, i) => {
    const key = s.key as StemKey;
    const color = STEM_COLORS[key] || '#94a3b8';
    const clip: Clip = {
      id: `clip-stem-${uid}-${s.key}`,
      name: `${c.name} – ${stemTrackName(s.key).replace(' (stem)', '')}`,
      type: TrackType.AUDIO,
      start: c.start,
      duration: c.duration,
      offset: c.offset || 0,
      bufferId: s.bufferId,
      color,
      fadeIn: c.fadeIn || 0,
      fadeOut: c.fadeOut || 0,
      ...(c.fadeInCurve ? { fadeInCurve: c.fadeInCurve } : {}),
      ...(c.fadeOutCurve ? { fadeOutCurve: c.fadeOutCurve } : {}),
      gain: c.gain ?? 1,
      isMuted: false,
      ...(c.isReversed ? { isReversed: true } : {}),
    };
    return {
      id: `track-stem-${uid}-${i}-${s.key}`,
      name: stemTrackName(s.key),
      type: TrackType.AUDIO,
      color,
      isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 1.0, pan: 0, outputTrackId: source.track.outputTrackId || 'master',
      sends: [], clips: [clip], plugins: [], automationLanes: [], totalLatency: 0,
    } as Track;
  });
}

/**
 * Pose les pistes de stems juste sous la piste du clip et coupe le clip d'origine
 * (à appliquer dans un produce d'Immer, ou sur une copie).
 * Renvoie false si la piste ou le clip n'existent plus (supprimés pendant le calcul).
 */
export function insertStemTracks(draft: { tracks: Track[]; selectedTrackId?: string | null }, trackId: string, clipId: string, stemTracks: Track[], muteOriginal = true): boolean {
  const idx = draft.tracks.findIndex(t => t.id === trackId);
  if (idx < 0) return false;
  const clip = draft.tracks[idx].clips.find(c => c.id === clipId);
  if (!clip) return false;
  if (muteOriginal) clip.isMuted = true;
  draft.tracks.splice(idx + 1, 0, ...stemTracks);
  if (stemTracks[0]) draft.selectedTrackId = stemTracks[0].id;
  return true;
}

/** Message clair pour une erreur de séparation. */
export function describeStemsError(err: unknown): string {
  const e = err as { message?: string; code?: string } | null;
  const msg = (e?.message || '').trim();
  if (e?.code === 'cancelled') return 'Séparation annulée.';
  if (e?.code === 'not_installed') return 'La séparation de stems n’est pas encore installée sur ce PC.';
  if (/non connecté|déconnecté|introuvable/i.test(msg) && /pont/i.test(msg)) return 'L’appli Windows ne répond plus : relance Nova Studio puis réessaie.';
  return msg || 'La séparation a échoué.';
}

/** Libellé de la progression de l'installation (étape + pourcentage). */
export function installProgressLabel(ev: { pct?: number; message?: string } | null | undefined): string {
  if (!ev) return 'Préparation…';
  const pct = typeof ev.pct === 'number' ? `${Math.round(ev.pct)} %` : '';
  return [ev.message || 'Installation', pct].filter(Boolean).join(' · ');
}

export function formatSeconds(s: number): string {
  if (!isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
}
