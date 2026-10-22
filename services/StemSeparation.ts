/**
 * Séparation de stems (comme Stem Splitter dans Logic ou Stem Separation dans FL Studio).
 *
 * Un clip audio (beat importé, morceau de référence, sample…) est envoyé au pont de
 * l'appli Windows, qui le sépare sur le PC avec Demucs (module optionnel installé à la
 * demande, gratuit, en local). Les stems reviennent en nouvelles pistes calées au même
 * endroit que le clip, nommées « Voix (stem) », « Batterie (stem) »…, et le clip
 * d'origine est coupé (M pour le réentendre) pour ne pas doubler le son.
 *
 * Lot 6 (BandLab Splitter) : 6 stems (voix, batterie, basse, guitare, piano, autres ;
 * Demucs htdemucs_6s) et voix lead / chœurs (UVR-MDX-NET Karaoke 2), modèles téléchargés
 * à la première séparation qui les demande ; un stem (basse, piano, guitare, voix) peut
 * ensuite devenir une piste MIDI par « Audio → MIDI ».
 *
 * Licence des beats : un stem garde les règles du clip d'où il vient (stemsRightsFor). Beat
 * du catalogue non acheté : pas de séparation (comme l'export) ; beat sous licence ou beat
 * de la piste BEAT : les stems restent « beat » (jamais gelés, rendus, samplés ni envoyés à
 * l'ingé, comme canBakeTrack le veut pour le beat) et aucun WAV n'est gardé sur le PC.
 *
 * Ce fichier ne contient que la logique (testée par vitest) ; l'interface est dans
 * components/StemSeparationDialog.tsx.
 */
import type { Clip, Track } from '../types';
import { TrackType } from '../types';
import type { BridgeState, StemsModuleStatus } from './NovaBridge';
import type { ExportAccess } from './Billing';

/** Jeu de stems : 2, 4 ou 6 pistes, ou « leadback » (voix lead / chœurs / instru). */
export type StemSet = 2 | 4 | 6 | 'leadback';
/** Ancien nom (2 ou 4 seulement avant le lot 6). */
export type StemCount = StemSet;
export type StemKey = 'vocals' | 'instrumental' | 'drums' | 'bass' | 'other' | 'guitar' | 'piano' | 'lead_vocals' | 'backing_vocals';

export const STEM_TRACK_NAMES: Record<StemKey, string> = {
  vocals: 'Voix (stem)',
  instrumental: 'Instru (stem)',
  drums: 'Batterie (stem)',
  bass: 'Basse (stem)',
  guitar: 'Guitare (stem)',
  piano: 'Piano (stem)',
  other: 'Autres (stem)',
  lead_vocals: 'Voix lead (stem)',
  backing_vocals: 'Chœurs (stem)',
};

export const STEM_COLORS: Record<StemKey, string> = {
  vocals: '#f472b6',
  instrumental: '#38bdf8',
  drums: '#f59e0b',
  bass: '#a78bfa',
  guitar: '#fb923c',
  piano: '#60a5fa',
  other: '#34d399',
  lead_vocals: '#f472b6',
  backing_vocals: '#e879f9',
};

export const STEM_SETS: Record<string, StemKey[]> = {
  2: ['vocals', 'instrumental'],
  4: ['vocals', 'drums', 'bass', 'other'],
  6: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
  leadback: ['lead_vocals', 'backing_vocals', 'instrumental'],
};

export const STEM_SET_ORDER: StemSet[] = [2, 4, 6, 'leadback'];

/** Les choix de la fenêtre, dans l'ordre (titre, pistes obtenues, à quoi ça sert). */
export const STEM_SET_CHOICES: Record<string, { title: string; detail: string; uses: string; note?: string }> = {
  2: { title: 'Voix + instru (2 stems)', detail: 'Voix (stem) et Instru (stem).', uses: 'Enlever la voix d’une instru (karaoké, beat), isoler la voix d’un morceau de référence.' },
  4: { title: 'Voix, batterie, basse, autres (4 stems)', detail: 'Une piste par famille d’instruments.', uses: 'Refaire un sample, récupérer une batterie ou une ligne de basse.' },
  6: {
    title: '6 stems : + guitare et piano', detail: 'Voix, batterie, basse, guitare, piano, autres.',
    uses: 'Sample de soul, de jazz ou de variété : isoler la guitare ou le piano.',
    note: 'Le piano est le stem le moins propre (le modèle le reconnaît moins bien).',
  },
  leadback: {
    title: 'Voix lead / chœurs', detail: 'Voix lead (stem), Chœurs (stem) et Instru (stem).',
    uses: 'Garder les chœurs et refaire la lead, ou l’inverse ; isoler les doubles et les backs d’une référence.',
  },
};

/** Crédit demandé par Ultimate Vocal Remover (licence MIT) pour son modèle voix lead / chœurs. */
export const LEADBACK_CREDIT = 'Voix lead / chœurs : modèle UVR-MDX-NET Karaoke 2 d’Ultimate Vocal Remover (Anjok07, aufr33), licence MIT.';

/** Infobulle commune (équivalents dans les autres logiciels). */
export const STEMS_TOOLTIP =
  'Sépare la voix, la batterie, la basse, la guitare, le piano et le reste du clip (ou la voix lead des chœurs). Calcul gratuit sur ton appareil : dans le navigateur (2 ou 4 stems), ou dans l’appli Windows (plus rapide, 6 stems et voix lead / chœurs en plus).';

/** « 55 Mo », « 1,2 Go ». */
export function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0 Mo';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} Go`;
  return `${Math.max(1, Math.round(n / 1e6))} Mo`;
}

/**
 * Ce qu'il faut télécharger, la première fois, pour ce jeu de stems (null : rien).
 * Le pont donne la taille exacte ; sans elle, l'ordre de grandeur annoncé.
 */
export function stemSetDownload(set: StemSet, module: Pick<StemsModuleStatus, 'sets' | 'variant'> | null): string | null {
  if (set === 2 || set === 4) return null;
  const info = module?.sets?.[String(set) as '6' | 'leadback'];
  if (info) return info.ready ? null : `+${formatBytes(info.downloadBytes)} à télécharger la 1re fois`;
  const guess = set === 6 ? 55e6 : (module?.variant === 'cuda' ? 270e6 : 68e6);
  return `+${formatBytes(guess)} à télécharger la 1re fois`;
}

// --- Droits : un stem garde la licence du clip séparé ---------------------------------

/** D'où vient le son : fichier de l'utilisateur, piste BEAT, ou beat du catalogue. */
export type StemsRights = { kind: 'own' } | { kind: 'beat' } | { kind: 'catalogue'; catalogId: string };

export function stemsRightsFor(track: { id: string; instrumentId?: string | number | null; beatStem?: boolean } | null | undefined): StemsRights {
  if (!track) return { kind: 'own' };
  const id = track.instrumentId;
  if (id !== undefined && id !== null && id !== '') return { kind: 'catalogue', catalogId: String(id) };
  if (track.id === 'instrumental' || track.beatStem) return { kind: 'beat' };
  return { kind: 'own' };
}

/**
 * Le serveur (export_access, comme l'export du mix) autorise-t-il à séparer ce beat du
 * catalogue ? Oui seulement si la licence est achetée (ou compte admin). Un export payé ou
 * Nova Pro ne suffit pas : ils n'ouvrent jamais l'instru seule.
 */
export function catalogueStemsAllowed(access: Pick<ExportAccess, 'unlocked' | 'via' | 'reason' | 'missing' | 'items'> | null, catalogId: string, admin = false): boolean {
  if (admin) return true;
  if (!access) return false;
  if (access.items?.some(i => String(i.id) === catalogId && i.owned)) return true;
  if (access.missing.some(m => String(m.id) === catalogId)) return false;
  if (access.reason === 'catalogue_non_achete') return false;
  return access.unlocked && (access.via === 'licence' || access.via === 'admin');
}

/** Message (et suite possible) quand le beat du catalogue n'est pas encore acheté. */
export const CATALOGUE_STEMS_REFUSAL =
  'Ce beat du catalogue n’est pas encore à toi : comme pour l’export, achète sa licence pour le séparer en stems. Tes propres sons (voix, samples, beats importés) se séparent librement.';

/** Champs posés sur les pistes de stems d'un beat : mêmes règles que le beat lui-même. */
export function licensedStemFields(rights: StemsRights): { beatStem?: true; instrumentId?: string } {
  if (rights.kind === 'catalogue') return { beatStem: true, instrumentId: rights.catalogId };
  if (rights.kind === 'beat') return { beatStem: true };
  return {};
}

// --- Stem → MIDI (réutilise « Audio → MIDI ») -------------------------------------------

export interface StemMidiConversion { mode: 'melody' | 'drums' | 'harmony'; instrument?: '808' | 'piano' | 'lead' | 'pad'; label: string; tip: string; /** Source grave : hauteur cherchée dès 30 Hz. */ low?: boolean }

/** Conversion MIDI proposée pour un stem (null : rien d'utile). */
export function stemMidiConversion(key: string): StemMidiConversion | null {
  switch (key) {
    case 'bass': return { mode: 'melody', instrument: '808', low: true, label: 'Basse → MIDI', tip: 'La ligne de basse devient une piste MIDI (808 ou basse du synthé NOVA), avec aperçu avant de valider.' };
    case 'piano': return { mode: 'harmony', label: 'Piano → MIDI', tip: 'Les accords du piano deviennent des accords MIDI (et, au choix, la piste d’accords).' };
    case 'guitar': return { mode: 'harmony', label: 'Guitare → MIDI', tip: 'Les accords de la guitare deviennent des accords MIDI.' };
    case 'vocals':
    case 'lead_vocals': return { mode: 'melody', instrument: 'lead', label: 'Voix → MIDI', tip: 'La mélodie chantée devient une piste MIDI (lead, piano ou nappe du synthé NOVA).' };
    case 'drums': return { mode: 'drums', label: 'Batterie → MIDI', tip: 'Kick, snare et hi-hat deviennent un motif de la boîte à rythmes.' };
    default: return null;
  }
}

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
export function buildStemTracks(source: { track: Pick<Track, 'id' | 'outputTrackId'>; clip: Clip }, stems: StemForTracks[], uid: string, rights: StemsRights = { kind: 'own' }): Track[] {
  const c = source.clip;
  const licence = licensedStemFields(rights);
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
      ...licence,
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
