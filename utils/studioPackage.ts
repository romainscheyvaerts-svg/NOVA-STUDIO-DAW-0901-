import type { DAWState } from '../types';
import { fmtTime, sortComments, visibleReplies } from './timelineComments';
import {
  STUDIO_SERVICES, STUDIO_SLOTS, checkBooking, checkFiles, safeFileName, serviceLabel, slotLabel,
  type BookingInput, type FileDecl, type FileKind,
} from '../supabase/functions/studio-inbox/rules.ts';

/**
 * « Envoyer au studio » (chantier 17 · B6) : ce que NOVA regroupe pour le
 * studio Make Music. Les règles d'acceptation (fichiers, réservation) sont
 * celles du serveur, partagées (supabase/functions/studio-inbox/rules.ts).
 * Module pur : testable tel quel (tests/studioPackage.test.ts).
 */

export { STUDIO_SERVICES, STUDIO_SLOTS, checkBooking, checkFiles, safeFileName, serviceLabel, slotLabel };
export type { BookingInput, FileDecl, FileKind };

export interface StudioNote {
  /** Instant dans le morceau (s), null : note générale. */
  t: number | null;
  end?: number | null;
  kind: 'commentaire' | 'repere' | 'piste' | 'seance' | 'paroles';
  who?: string;
  text: string;
  status?: 'ouvert' | 'resolu';
  track?: string;
  replies?: { who: string; text: string }[];
}

export interface StudioNotes {
  title: string;
  bpm: number;
  key: string | null;
  notes: StudioNote[];
  /** Notes horodatées (commentaires + repères). */
  timed: number;
}

/**
 * Notes horodatées du projet, pour l'ingé du studio : commentaires de la
 * timeline (ouverts et résolus, sans les archivés), repères, consignes par
 * piste et notes de séance (mix, références, idées), paroles.
 */
export function buildStudioNotes(s: Pick<DAWState, 'name' | 'bpm' | 'tracks' | 'markers' | 'lyrics' | 'projectNotes' | 'timelineComments'> & { projectKey?: string | null }): StudioNotes {
  const trackName = new Map(s.tracks.map(t => [t.id, t.name]));
  const out: StudioNote[] = [];
  for (const c of sortComments((s.timelineComments || []).filter(c => !c.archived?.v))) {
    const text = c.text.v.trim();
    if (!text) continue;
    out.push({
      t: c.pos.v.t, end: c.pos.v.end, kind: 'commentaire', who: c.authorName, text,
      status: c.status.v.s === 'resolved' ? 'resolu' : 'ouvert',
      ...(c.trackId && trackName.get(c.trackId) ? { track: trackName.get(c.trackId) } : {}),
      replies: visibleReplies(c).map(r => ({ who: r.authorName, text: r.text.v })).filter(r => r.text.trim()),
    });
  }
  for (const m of [...(s.markers || [])].sort((a, b) => a.time - b.time)) {
    if (!m.name?.trim()) continue;
    out.push({ t: m.time, end: m.type === 'REGION' ? m.endTime ?? null : null, kind: 'repere', text: m.name.trim() });
  }
  const timed = out.length;
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  for (const t of s.tracks) {
    const txt = (t as { comment?: string }).comment?.trim();
    if (txt) out.push({ t: null, kind: 'piste', track: t.name, text: txt });
  }
  const pn = s.projectNotes || {};
  const labels: [keyof typeof pn, string][] = [['mix', 'Consignes de mix'], ['references', 'Références'], ['general', 'Notes']];
  for (const [k, label] of labels) {
    const v = typeof pn[k] === 'string' ? (pn[k] as string).trim() : '';
    if (v) out.push({ t: null, kind: 'seance', text: `${label} : ${v}` });
  }
  if (s.lyrics?.trim()) out.push({ t: null, kind: 'paroles', text: s.lyrics.trim() });
  return { title: s.name || 'Projet', bpm: s.bpm, key: s.projectKey ?? null, notes: out, timed };
}

/** Les mêmes notes en texte lisible (fichier « Notes.txt » pour l'ingé). */
export function studioNotesText(n: StudioNotes, booking?: BookingInput | null): string {
  const L: string[] = [`${n.title} · ${n.bpm} BPM${n.key ? ` · ${n.key}` : ''}`, ''];
  if (booking) {
    L.push(`Demande : ${serviceLabel(booking.service)} · ${booking.date} (${slotLabel(booking.slot).toLowerCase()}) · ${booking.hours} h · ${booking.name}${booking.phone ? ` · ${booking.phone}` : ''}`);
    if (booking.message) L.push(`Message : ${booking.message}`);
    L.push('');
  }
  const timed = n.notes.filter(x => x.t !== null);
  if (timed.length) {
    L.push('NOTES HORODATÉES');
    for (const x of timed) {
      const at = x.end != null ? `${fmtTime(x.t!)} → ${fmtTime(x.end)}` : fmtTime(x.t!);
      if (x.kind === 'repere') L.push(`[${at}] Repère : ${x.text}`);
      else {
        L.push(`[${at}] ${x.who || '?'}${x.track ? ` (${x.track})` : ''} : ${x.text}${x.status === 'resolu' ? ' (réglé)' : ''}`);
        for (const r of x.replies || []) L.push(`      ↳ ${r.who} : ${r.text}`);
      }
    }
    L.push('');
  }
  for (const x of n.notes.filter(y => y.t === null)) {
    if (x.kind === 'piste') L.push(`Piste « ${x.track} » : ${x.text}`);
    else if (x.kind === 'seance') L.push(x.text);
    else if (x.kind === 'paroles') L.push('', 'PAROLES', x.text);
  }
  return L.join('\n') + '\n';
}

/** Aperçu court d'une note horodatée (« 1:12 · Nina : le s siffle »). */
export const noteLine = (x: StudioNote): string =>
  `${x.t !== null ? (x.end != null ? `${fmtTime(x.t)} → ${fmtTime(x.end)}` : fmtTime(x.t)) + ' · ' : ''}${x.kind === 'repere' ? 'Repère : ' : x.who ? `${x.who} : ` : ''}${x.text}`;

/** Taille lisible (Mo / Go), pour l'artiste. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0).replace('.', ',')} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
}

/** Estimation des stems (FLAC 24 bits stéréo ≈ 60 % du WAV) : une piste par stem, durée du morceau. */
export function estimateStemsBytes(stems: number, seconds: number, sampleRate: number): number {
  return Math.round(stems * Math.max(1, seconds) * sampleRate * 2 * 3 * 0.6);
}

/** Jour par défaut proposé : dans 3 jours (AAAA-MM-JJ, heure locale). */
export function defaultBookingDate(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Jour lisible (« jeudi 23 octobre »). */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
