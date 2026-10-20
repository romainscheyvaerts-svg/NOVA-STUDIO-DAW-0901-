/**
 * R24 · Voix par l'IA locale (appli Windows Nova Studio) :
 *  - « Retirer la réverbe de la pièce… » : DeepFilterNet 3 sur le PC, dosage 0–100 %,
 *    écoute avant / après, résultat non destructif (AudioSuite, R6) ;
 *  - « Transcrire les paroles… » : Whisper sur la carte graphique (repli processeur),
 *    mots horodatés rangés dans le clip et dans le prompteur de paroles.
 *
 * Le calcul tourne sur le PC (pont, module installé à la demande) ; sur le site sans
 * pont, les commandes restent visibles mais grisées.
 *
 * Ce fichier ne contient que la logique (tests/voiceAI.test.ts) ; l'interface est
 * dans components/VoiceAIDialog.tsx.
 */
import type { Clip, DAWState, Track } from '../types';
import { TrackType } from '../types';
import type { BridgeState, VoiceFeature, VoiceWord } from './NovaBridge';
import { audioSuiteBlock, audioSuitePatch, audioSuiteRegion, patchClip } from '../utils/clipProcess';
import { buildTranscript, lyricsFromWords, projectTimedWords, shiftTranscript, transcriptValid } from '../utils/voiceLyrics';
import { sectionsOf } from '../utils/timeOps';

export type VoiceAvailability = 'web' | 'connect' | 'update' | 'ok';
export type TranscribeLanguage = 'fr' | 'en' | 'mix' | 'auto';
export type LyricsMode = 'replace' | 'keep' | 'append';

export const VOICE_WEB_TOOLTIP = 'Disponible dans Nova Studio sur PC';

export const DEVERB_TOOLTIP =
  'Retire la réverbe de la pièce (chambre, salon) d’une voix, comme De-reverb d’iZotope RX ou Enhance Speech d’Adobe. Calcul gratuit sur ton PC (appli Windows) ; l’original est gardé.';
export const TRANSCRIBE_TOOLTIP =
  'Écrit les paroles du clip mot par mot, calées sur le temps, dans ton prompteur et l’onglet Paroles. Calcul gratuit sur ton PC (appli Windows), rien n’est envoyé sur Internet.';

/** Réglage conseillé : le français d'abord, les phrases en anglais restent en anglais (mesures R24). */
export const DEFAULT_LANGUAGE: TranscribeLanguage = 'mix';

export const LANGUAGE_OPTIONS: { id: TranscribeLanguage; label: string; hint: string }[] = [
  { id: 'mix', label: 'Français + anglais (rap)', hint: 'Conseillé : le français d’abord ; une phrase en anglais reste en anglais, les mots anglais (« game », « flow ») sont gardés.' },
  { id: 'fr', label: 'Français seulement', hint: 'Tout le texte est lu comme du français (un peu plus rapide).' },
  { id: 'en', label: 'Anglais', hint: 'Texte entièrement en anglais.' },
  { id: 'auto', label: 'Détecter la langue', hint: 'Whisper choisit la langue tout seul.' },
];

/** Où en est la voix par l'IA pour ce poste : site sans pont, appli à mettre à jour, ou prêt. */
export function voiceAvailability(bridge: Pick<BridgeState, 'status' | 'voice'>, isDesktop: boolean): VoiceAvailability {
  if (bridge.status === 'connected') return bridge.voice ? 'ok' : 'update';
  return isDesktop ? 'connect' : 'web';
}

/** Entrée du menu du clip : grisée sur le site (sans l'appli Windows), avec la raison. */
export function voiceMenuState(avail: VoiceAvailability, tooltip: string): { disabled: boolean; title: string } {
  if (avail === 'web') return { disabled: true, title: `${VOICE_WEB_TOOLTIP}. ${tooltip}` };
  if (avail === 'update') return { disabled: false, title: `Mets à jour Nova Studio pour Windows. ${tooltip}` };
  return { disabled: false, title: tooltip };
}

/** « 1,6 Go », « 27 Mo ». */
export function formatBytes(n: number | null | undefined): string {
  if (!n || !isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} Go`;
  return `${Math.max(1, Math.round(n / 1e6))} Mo`;
}

export function installButtonLabel(feature: VoiceFeature, downloadBytes: number | null): string {
  const size = formatBytes(downloadBytes);
  const what = feature === 'transcribe' ? 'la transcription' : 'le retrait de réverbe';
  return `Installer ${what}${size ? ` (~${size}, une fois)` : ' (une fois)'}`;
}

/** Message clair pour une erreur. */
export function describeVoiceError(err: unknown): string {
  const e = err as { message?: string; code?: string } | null;
  const msg = (e?.message || '').trim();
  if (e?.code === 'cancelled') return 'Calcul annulé.';
  if (e?.code === 'not_installed') return 'Cette fonction n’est pas encore installée sur ce PC.';
  if (/non connecté|déconnecté|introuvable/i.test(msg) && /pont/i.test(msg)) return 'L’appli Windows ne répond plus : relance Nova Studio puis réessaie.';
  return msg || 'Le calcul a échoué.';
}

export function progressLabel(ev: { pct?: number; message?: string } | null | undefined, fallback = 'Préparation…'): string {
  if (!ev) return fallback;
  const pct = typeof ev.pct === 'number' ? `${Math.round(ev.pct)} %` : '';
  return [ev.message || 'En cours', pct].filter(Boolean).join(' · ');
}

// ─── Déréverbération ────────────────────────────────────────────────────────

/** Poignées envoyées avec le clip (s) : la queue de réverbe juste après le clip est traitée aussi. */
export const DEVERB_HANDLE = 0.5;

/** Ce clip peut-il être traité ? (sinon : la raison) */
export function deverbBlock(c: Clip | null | undefined): string | null {
  if (!c) return 'Clip introuvable.';
  const b = audioSuiteBlock(c);
  if (b) return b.replace('Ce traitement', 'Le retrait de réverbe');
  if (c.duration < 0.5) return 'Clip trop court (une demi-seconde minimum).';
  return null;
}

/** Les canaux d'une partie d'un son (1 ou 2), à envoyer au pont. */
export function sliceChannels(buffer: { numberOfChannels: number; sampleRate: number; length: number; getChannelData(c: number): Float32Array }, from: number, to: number): Float32Array[] {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.min(buffer.length, Math.round(from * sr)));
  const b = Math.max(a, Math.min(buffer.length, Math.round(to * sr)));
  const n = Math.max(1, Math.min(2, buffer.numberOfChannels));
  return Array.from({ length: n }, (_, c) => buffer.getChannelData(c).slice(a, b));
}

/** Mélange voix d'origine / voix sans réverbe : 0 = original, 1 = traitement complet. */
export function blendDeverb(orig: Float32Array[], wet: Float32Array[], amount: number): Float32Array[] {
  const a = Math.max(0, Math.min(1, amount));
  return orig.map((o, c) => {
    const w = wet[Math.min(c, wet.length - 1)] || o;
    const out = new Float32Array(o.length);
    for (let i = 0; i < o.length; i++) out[i] = (1 - a) * o[i] + a * (w[i] ?? 0);
    return out;
  });
}

/** Nom de l'étape (liste AudioSuite, nom du clip). */
export const deverbStepName = (amount: number) => `Réverbe retirée ${Math.round(Math.max(0, Math.min(1, amount)) * 100)} %`;

/**
 * Changements du clip une fois la voix traitée enregistrée sous `newBufferId`
 * (elle commence à `from` dans le son actuel du clip). Comme AudioSuite : la
 * prise d'origine est gardée ; la transcription éventuelle suit le nouveau son.
 */
export function deverbPatch(c: Clip, o: { newBufferId: string; from: number; amount: number; now?: number }): Partial<Clip> {
  const patch = audioSuitePatch(c, { newBufferId: o.newBufferId, from: o.from, step: { type: 'AI_DEVERB', name: deverbStepName(o.amount), at: o.now ?? Date.now() } });
  if (c.transcript && transcriptValid(c)) patch.transcript = shiftTranscript(c.transcript, o.from, o.newBufferId);
  return patch;
}

/** Partie du son à traiter (clip + poignées). */
export const deverbRegion = (c: Pick<Clip, 'offset' | 'duration'>, bufferDuration: number) => audioSuiteRegion(c, bufferDuration, DEVERB_HANDLE);

// ─── Transcription ─────────────────────────────────────────────────────────

/** Marge envoyée avant / après la partie montrée (s) : pas de mot coupé au bord. */
export const TRANSCRIBE_MARGIN = 0.25;

export function transcribeBlock(c: Clip | null | undefined, hasBuffer: boolean): string | null {
  if (!c) return 'Clip introuvable.';
  if (c.type === TrackType.MIDI || c.notes) return 'Un clip MIDI n’a pas de voix à transcrire.';
  if (!hasBuffer) return 'Le son de ce clip n’est pas encore chargé.';
  if (c.isReversed) return 'Clip inversé : remets-le à l’endroit pour le transcrire.';
  if (c.warp && c.warp.mode && c.warp.mode !== 'OFF') return 'Clip calé sur le tempo (warp) : consolide-le d’abord (Alt+Maj+3), puis transcris-le.';
  if (c.duration < 0.3) return 'Clip trop court pour être transcrit.';
  return null;
}

export function transcribeRegion(c: Pick<Clip, 'offset' | 'duration'>, bufferDuration: number): { from: number; to: number } {
  const off = c.offset || 0;
  return { from: Math.max(0, off - TRANSCRIBE_MARGIN), to: Math.min(bufferDuration, off + c.duration + TRANSCRIBE_MARGIN) };
}

export interface TranscribedClip {
  trackId: string;
  clipId: string;
  /** Mots renvoyés par le pont (temps du son envoyé). */
  words: VoiceWord[];
  /** Début du son envoyé dans le son du clip (s). */
  from: number;
  bufferId?: string;
  language: string;
  model: string;
}

/**
 * Pose les transcriptions sur les clips et remplit les paroles (prompteur, onglet
 * Paroles), en UN changement d'état (une seule annulation) :
 *  - « replace » : les paroles deviennent le texte transcrit (toutes les prises
 *    transcrites, calées sur les sections du morceau) ;
 *  - « keep » : le texte de l'artiste est gardé, seulement calé sur la voix ;
 *  - « append » : le texte des nouveaux clips s'ajoute à la fin.
 */
export function applyTranscriptions<S extends Pick<DAWState, 'tracks' | 'markers' | 'lyrics'>>(state: S, results: TranscribedClip[], o: { mode: LyricsMode; show: boolean; now?: number }): S {
  const byClip = new Map(results.map(r => [r.clipId, r]));
  const tracks: Track[] = state.tracks.map(t => (t.clips.some(c => byClip.has(c.id)) ? {
    ...t,
    clips: t.clips.map(c => {
      const r = byClip.get(c.id);
      if (!r) return c;
      return patchClip(c, { transcript: buildTranscript(r.words, { from: r.from, bufferId: r.bufferId ?? c.bufferId, language: r.language, model: r.model, show: o.show, now: o.now }) });
    }),
  } : t));
  const sections = sectionsOf({ tracks, markers: state.markers || [] }).map(s => ({ name: s.name, start: s.start, end: s.end }));
  let lyrics = state.lyrics || '';
  if (o.mode === 'replace' || (o.mode !== 'keep' && !lyrics.trim())) {
    lyrics = lyricsFromWords(projectTimedWords(tracks), sections);
  } else if (o.mode === 'append') {
    const fresh = projectTimedWords(tracks).filter(w => byClip.has(w.clipId));
    const add = lyricsFromWords(fresh, sections);
    if (add) lyrics = `${lyrics.replace(/\s+$/, '')}\n\n${add}`;
  }
  return { ...state, tracks, lyrics };
}

/** Texte au-dessus du clip : allumé / éteint. */
export function setTranscriptShown(c: Clip, show: boolean): Partial<Clip> | null {
  if (!c.transcript) return null;
  const { show: _old, ...rest } = c.transcript;
  return { transcript: show ? { ...rest, show: true } : rest };
}

/** Résumé après la transcription (notification). */
export function transcriptionSummary(results: TranscribedClip[], seconds: number, device: string): string {
  const n = results.reduce((a, r) => a + r.words.length, 0);
  const where = device === 'cuda' ? 'carte graphique' : 'processeur, carte graphique indisponible';
  return `📝 ${n} mot${n > 1 ? 's' : ''} transcrit${n > 1 ? 's' : ''} sur ${results.length} clip${results.length > 1 ? 's' : ''} (${Math.max(1, Math.round(seconds))} s, ${where}). Corrige le texte dans le prompteur : les temps suivent. Ctrl+K « trouver … » retrouve un mot dans tes prises.`;
}

/** B7 : la transcription tourne sur le processeur (carte graphique absente, désactivée ou pleine). */
export const CPU_FALLBACK_NOTE = 'Carte graphique indisponible : calcul sur le processeur, beaucoup plus lent (environ 1 min 30 par minute de voix, contre 3 s sur la carte). Vérifie que la carte NVIDIA est activée (mode graphique), puis relance.';

/** B7 : dosage proposé (mesuré : la queue de la pièce baisse de 13 dB en médiane à 100 %). */
export const DEFAULT_DEVERB_AMOUNT = 1;
