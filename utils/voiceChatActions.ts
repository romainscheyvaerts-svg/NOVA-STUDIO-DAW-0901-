/**
 * Lot 8 — actions du chat (Nova ingé son) sur la chaîne voix d'une piste :
 *  - DESCRIBE_SOUND { trackId, text } : « Décris ton son » (utils/describeSound), sans IA ;
 *  - APPLY_VOICE_PRESET { trackId, preset } : poser un preset de la bibliothèque ;
 *  - ONE_KNOB { trackId, macro, amount } : tourner une macro du One Knob (0-100 %).
 * Pur : renvoie la piste modifiée et la phrase de compte rendu ; App.tsx branche (une
 * modification de piste, donc un Ctrl+Z avec le reste du message).
 */
import type { OneKnobMacro, Track } from '../types';
import { decrireTonSon } from './describeSound';
import { applyOneKnob, MACRO_ORDER, macroDef } from './oneKnob';
import { applyVoicePreset, findVoicePreset, SEND_IDS, type ApplyVoicePresetOptions } from './voicePresets';
import { lufsOf } from './audioMeasure';

export const VOICE_CHAT_ACTIONS = ['DESCRIBE_SOUND', 'APPLY_VOICE_PRESET', 'ONE_KNOB'] as const;

/** LUFS (mono) de l'audio d'une piste tel que le moteur le donne (getTrackSourceAudio). */
export function lufsOfSource(src: { channels: Float32Array[]; sampleRate: number } | null | undefined): number | null {
  if (!src || !src.channels.length) return null;
  const [L, R] = src.channels;
  const m = new Float32Array(L.length);
  for (let i = 0; i < m.length; i++) m[i] = (L[i] + (R ? R[i] : L[i])) / 2;
  const v = lufsOf([m], src.sampleRate);
  return Number.isFinite(v) ? v : null;
}

const MACRO_ALIASES: Record<string, OneKnobMacro> = {
  presence: 'presence', présence: 'presence', chaleur: 'chaleur', brillance: 'brillance', compression: 'compression',
  espace: 'espace', autotune: 'autotune', 'auto-tune': 'autotune', largeur: 'largeur', saturation: 'saturation',
};

export function runVoiceChatAction(name: string, payload: Record<string, any>, track: Track, opts: ApplyVoicePresetOptions): { track: Track | null; message: string } {
  const returns = opts.allTracks.filter(t => (Object.values(SEND_IDS) as string[]).includes(t.id)).map(t => t.id);
  if (name === 'DESCRIBE_SOUND') {
    const r = decrireTonSon(String(payload.text || payload.description || ''), track, { ...opts, returns });
    return { track: r.track || null, message: `✨ ${r.compteRendu}` };
  }
  if (name === 'APPLY_VOICE_PRESET') {
    const p = findVoicePreset(String(payload.preset || payload.presetId || payload.name || ''));
    if (!p) return { track: null, message: `Preset voix « ${payload.preset} » inconnu.` };
    const r = applyVoicePreset(track, p, opts);
    return { track: r.track, message: `✅ « ${p.name} » posé sur ${track.name}${r.notes.length ? ` · ${r.notes.join(' · ')}` : ''}` };
  }
  if (name === 'ONE_KNOB') {
    const m = MACRO_ALIASES[String(payload.macro || '').toLowerCase()];
    if (!m || !MACRO_ORDER.includes(m)) return { track: null, message: `Macro « ${payload.macro} » inconnue.` };
    const raw = Number(payload.amount ?? payload.value);
    const a = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
    if (!Number.isFinite(a)) return { track: null, message: 'Position du bouton illisible.' };
    const r = applyOneKnob(track, m, a, { returns, projectKey: opts.projectKey, projectScale: opts.projectScale });
    return { track: r.track, message: `🎛️ One Knob de ${track.name} : ${macroDef(m).name} ${Math.round(a * 100)} %` };
  }
  return { track: null, message: `Action ${name} inconnue.` };
}
