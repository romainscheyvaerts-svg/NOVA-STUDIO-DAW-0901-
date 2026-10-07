import { Track } from '../types';

/**
 * Une seule table de libellés pour les envois (audit G2) : en-tête de piste,
 * console, pistes mobile, automation et menus de sortie disent la même chose.
 * Avant : « Delay 1/4 / Verb Pro / Hall Space » ici, « dela / verb / verb » là.
 */
export interface SendInfo { label: string; short: string; color: string; help: string }

export const SEND_LABELS: Record<string, SendInfo> = {
  'send-delay': { label: 'Écho 1/4', short: 'Écho', color: '#00f2ff', help: 'Écho calé sur le tempo (une noire) : la fin des mots se répète.' },
  'send-verb-short': { label: 'Reverb courte', short: 'Rév. courte', color: '#10b981', help: 'Reverb courte : une petite pièce, la voix gagne de la profondeur sans s’éloigner.' },
  'send-verb-long': { label: 'Reverb longue', short: 'Rév. longue', color: '#a855f7', help: 'Reverb longue : une grande salle, pour les refrains et les fins de phrase.' },
};

/** Ordre d'affichage des envois standard. */
export const STANDARD_SENDS = ['send-delay', 'send-verb-short', 'send-verb-long'] as const;

/** Anciens noms par défaut (projets existants) : remplacés par le libellé de la table. */
const LEGACY_DEFAULTS = new Set(['DELAY 1/4', 'VERB PRO', 'HALL SPACE', 'ÉCHO 1/4', 'REVERB COURTE', 'REVERB LONGUE']);

/**
 * Nom affiché d'une piste d'envoi / d'un envoi. Un envoi standard porte le
 * libellé de la table, sauf si l'utilisateur a renommé sa piste d'envoi.
 */
export function sendLabel(sendId: string, tracks?: Track[] | null, short = false): string {
  const known = SEND_LABELS[sendId];
  const t = tracks?.find(x => x.id === sendId);
  const custom = t && t.name && !LEGACY_DEFAULTS.has(t.name.trim().toUpperCase()) ? t.name : null;
  if (custom) return short ? custom.slice(0, 12) : custom;
  if (known) return short ? known.short : known.label;
  return t?.name || sendId.replace(/^send-/, '');
}

/** Nom affiché d'une piste (les pistes d'envoi standard passent par la table). */
export const trackDisplayName = (t: Pick<Track, 'id' | 'name'>, tracks?: Track[] | null): string =>
  SEND_LABELS[t.id] ? sendLabel(t.id, tracks ?? [t as Track]) : t.name;

export const sendColor = (sendId: string) => SEND_LABELS[sendId]?.color || '#a855f7';
export const sendHelp = (sendId: string) => SEND_LABELS[sendId]?.help || '';
