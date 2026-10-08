import { RecordInput, Track, TrackType } from '../types';
export { linkedRecordMates } from './editGroups';

/**
 * R14 · Enregistrement multipiste (Pro Tools : plusieurs pistes armées, une entrée
 * physique par piste). Module pur : entrées, armement, compensation par canal.
 *
 * - Chaque piste armée lit SON entrée : « Entrée 3 » (mono) ou « Entrées 1-2 »
 *   (stéréo). Sans réglage : l'entrée choisie dans les Réglages audio (comme avant).
 * - Armer une piste n'en désarme plus d'autre ; Maj+clic arme la piste seule (Pro Tools).
 *   « Armement exclusif » (préférence) inverse : clic = seule, Maj+clic = en plus.
 * - Latence par entrée : retard propre à chaque canal de la carte (convertisseurs
 *   ADAT, préampli externe…), mesuré par le pont ou réglé à la main, ajouté au calage
 *   commun de la prise.
 */

/** Canaux enregistrés au plus en même temps (ChannelMerger : 32 entrées). */
export const MAX_RECORD_CHANNELS = 32;

/** Piste qu'on enregistre au micro / à une entrée de la carte (pas le beat, pas un bus, pas MIDI). */
export const isAudioRecordTrack = (t?: Pick<Track, 'type' | 'id' | 'instrumentId'> | null): boolean =>
  !!t && t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId;

export const inputWidth = (spec?: RecordInput | null): 1 | 2 => (spec?.stereo ? 2 : 1);

const valid = (spec?: RecordInput | null): spec is RecordInput =>
  !!spec && Number.isInteger(spec.ch) && spec.ch >= 0 && spec.ch < MAX_RECORD_CHANNELS;

/** Libellé de l'entrée (« Réglages » quand la piste suit l'entrée des Réglages audio). */
export function inputLabel(spec?: RecordInput | null, short = false): string {
  if (!valid(spec)) return short ? 'Auto' : 'Entrée des réglages';
  if (spec.stereo) return short ? `${spec.ch + 1}-${spec.ch + 2}` : `Entrées ${spec.ch + 1}-${spec.ch + 2} (stéréo)`;
  return short ? `In ${spec.ch + 1}` : `Entrée ${spec.ch + 1}`;
}

/** Valeur d'un <select> : '' (auto), 'm:2' (entrée 3 mono), 's:0' (entrées 1-2). */
export const encodeInput = (spec?: RecordInput | null): string => (valid(spec) ? `${spec.stereo ? 's' : 'm'}:${spec.ch}` : '');

export function decodeInput(v: string | null | undefined): RecordInput | null {
  const m = /^([ms]):(\d{1,2})$/.exec(v || '');
  if (!m) return null;
  const ch = parseInt(m[2], 10);
  if (ch < 0 || ch >= MAX_RECORD_CHANNELS) return null;
  return m[1] === 's' ? { ch, stereo: true } : { ch };
}

/**
 * Choix du sélecteur d'entrée : auto, puis entrées mono 1…n, puis paires stéréo
 * 1-2, 3-4… (comme Pro Tools). `count` : entrées connues (au moins 2 proposées).
 */
export function inputOptions(count: number): { value: string; label: string; group: 'auto' | 'mono' | 'stereo' }[] {
  const n = Math.max(2, Math.min(MAX_RECORD_CHANNELS, Math.floor(count || 0)));
  const out: { value: string; label: string; group: 'auto' | 'mono' | 'stereo' }[] = [{ value: '', label: 'Entrée des réglages (auto)', group: 'auto' }];
  for (let c = 0; c < n; c++) out.push({ value: `m:${c}`, label: `Entrée ${c + 1} (mono)`, group: 'mono' });
  for (let c = 0; c + 1 < n; c += 2) out.push({ value: `s:${c}`, label: `Entrées ${c + 1}-${c + 2} (stéréo)`, group: 'stereo' });
  return out;
}

/** Canaux de la source lus par la piste ; [] = auto (résolu par le moteur). */
export const channelsOf = (spec?: RecordInput | null): number[] => (valid(spec) ? (spec.stereo ? [spec.ch, spec.ch + 1] : [spec.ch]) : []);

/** Nombre d'entrées nécessaires pour toutes les pistes armées (auto = 2). */
export function neededInputChannels(specs: (RecordInput | null | undefined)[]): number {
  let n = 0;
  for (const s of specs) { const ch = channelsOf(s); n = Math.max(n, ch.length ? Math.max(...ch) + 1 : 1); }
  return n;
}

/** Pistes dont l'entrée n'existe pas sur la source (carte à 2 entrées, navigateur limité…). */
export function missingInputs(armed: { trackId: string; spec?: RecordInput | null }[], available: number): string[] {
  return armed.filter(a => channelsOf(a.spec).some(c => c >= available)).map(a => a.trackId);
}

/** Entrées partagées par plusieurs pistes armées (permis : deux prises du même micro). */
export function sharedInputs(armed: { trackId: string; spec?: RecordInput | null }[]): { ch: number; trackIds: string[] }[] {
  const by = new Map<number, string[]>();
  for (const a of armed) for (const c of channelsOf(a.spec)) by.set(c, [...(by.get(c) || []), a.trackId]);
  return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([ch, trackIds]) => ({ ch, trackIds }));
}

/**
 * Message clair quand des pistes demandent des entrées que la source ne donne pas.
 * `mode` : 'asio' (carte via Nova Studio) ou 'navigateur' (micro du navigateur).
 */
export function inputsMessage(o: { names: string[]; available: number; mode: 'asio' | 'navigateur' }): string | null {
  if (!o.names.length) return null;
  const who = o.names.length === 1 ? `« ${o.names[0]} »` : o.names.map(n => `« ${n} »`).join(', ');
  const avail = `${o.available} entrée${o.available > 1 ? 's' : ''}`;
  if (o.mode === 'navigateur') {
    return `${who} : le navigateur ne donne que ${avail} de ta carte son. Pour enregistrer plus d'entrées en même temps, ouvre Nova Studio (pont ASIO) : chaque piste lira son entrée. En attendant, choisis une entrée entre 1 et ${o.available}.`;
  }
  return `${who} : la carte ne donne que ${avail}. Choisis une entrée existante dans le sélecteur d'entrée de la piste.`;
}

// ─── Armement ─────────────────────────────────────────────────────────────────

export const ARM_EXCLUSIVE_KEY = 'nova_arm_exclusive';

/** Préférence « Armement exclusif » (une seule piste armée à la fois, comme avant R14). */
export function armExclusivePref(): boolean {
  try { return localStorage.getItem(ARM_EXCLUSIVE_KEY) === '1'; } catch { return false; }
}

export function setArmExclusivePref(on: boolean) {
  try { localStorage.setItem(ARM_EXCLUSIVE_KEY, on ? '1' : '0'); } catch { /* stockage indisponible */ }
}

/** La piste est-elle armée SEULE ? Maj+clic inverse la préférence (Pro Tools : Maj+clic = seule). */
export const armAlone = (shift: boolean, pref: boolean = armExclusivePref()): boolean => shift !== pref;

let lastArmClick: { shift: boolean; at: number } | null = null;

/** Clic sur un bouton R : on note Maj, lu juste après par App (le bouton ne passe que la piste). */
export function noteArmClick(e: { shiftKey?: boolean } | null | undefined) {
  lastArmClick = { shift: !!e?.shiftKey, at: Date.now() };
}

/** Maj était-elle tenue au dernier clic R (moins d'1,5 s) ? Lu une seule fois. */
export function takeArmShift(now = Date.now()): boolean {
  const c = lastArmClick;
  lastArmClick = null;
  return !!c && now - c.at < 1500 && c.shift;
}

/** Pistes armées après un clic : la piste seule, ou en plus des autres. */
export function armedAfter(tracks: Pick<Track, 'id' | 'isTrackArmed'>[], trackId: string, on: boolean, alone: boolean): string[] {
  const set = new Set(tracks.filter(t => t.isTrackArmed).map(t => t.id));
  if (!on) { set.delete(trackId); return tracks.filter(t => set.has(t.id)).map(t => t.id); }
  if (alone) return [trackId];
  set.add(trackId);
  return tracks.filter(t => set.has(t.id)).map(t => t.id);
}

/** Pistes audio armées, dans l'ordre affiché : ce que REC enregistre. */
export const recordTargets = <T extends Pick<Track, 'id' | 'type' | 'instrumentId' | 'isTrackArmed'>>(tracks: T[]): T[] =>
  tracks.filter(t => t.isTrackArmed && isAudioRecordTrack(t));

// ─── Latence par entrée ───────────────────────────────────────────────────────

export const CHANNEL_LATENCY_KEY = 'nova_input_latency_ms';

/** Retard propre de chaque entrée (ms, + = l'entrée arrive plus tard), ajouté au calage commun. */
export function channelOffsets(): Record<number, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(CHANNEL_LATENCY_KEY) || '{}');
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      const c = parseInt(k, 10), ms = Number(v);
      if (Number.isInteger(c) && c >= 0 && c < MAX_RECORD_CHANNELS && Number.isFinite(ms) && Math.abs(ms) <= 200) out[c] = ms;
    }
    return out;
  } catch { return {}; }
}

export function setChannelOffsets(map: Record<number, number>) {
  try { localStorage.setItem(CHANNEL_LATENCY_KEY, JSON.stringify(map)); } catch { /* */ }
}

/** Retard propre (s) des canaux lus par une piste (moyenne en stéréo). */
export function channelOffsetSec(channels: number[], offsets: Record<number, number>): number {
  if (!channels.length) return 0;
  return channels.reduce((s, c) => s + (offsets[c] || 0), 0) / channels.length / 1000;
}

/**
 * Mesure du pont (impulsion en boucle) → retard propre de chaque entrée (ms) :
 * aller-retour mesuré moins la latence annoncée par le pilote (déjà comptée dans le
 * calage commun). Entrée sans retour : pas de valeur.
 */
export function offsetsFromProbe(delays: (number | null)[], sampleRate: number, reportedSec: number): Record<number, number> {
  const out: Record<number, number> = {};
  delays.forEach((d, c) => {
    if (typeof d !== 'number' || !Number.isFinite(d) || sampleRate <= 0) return;
    out[c] = Math.round((d / sampleRate - reportedSec) * 1000 * 1000) / 1000;
  });
  return out;
}

/** Ordre des pistes d'un passage multipiste : regroupe les prises d'une même plage. */
export interface PassTrack { trackId: string; channels: number[]; width: 1 | 2 }
