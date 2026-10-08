/**
 * Melodyne et VocAlign dans NOVA (plugins ARA2) : la logique côté DAW.
 *
 * Comme dans Pro Tools ou Studio One, le plugin reçoit le clip ENTIER (hôte
 * ARA natif du pont, voir bridge-python/ara_service.py) : Melodyne affiche
 * tout de suite les notes, sans lecture préalable. « Valider » rend le résultat
 * en un nouveau son, joué par le même clip.
 *
 * Non destructif (comme utils/pitchEdit) : la prise d'origine reste en mémoire
 * et dans la sauvegarde ; l'état ARA du plugin (archive : les retouches de
 * Melodyne) voyage avec le clip pour rouvrir et retoucher ; « Revenir à
 * l'original » remet la prise d'origine.
 *
 * Collaboration : chez l'autre, le clip joue son rendu (le son corrigé). Seul
 * un PC avec le plugin peut retoucher ; sinon un message clair l'explique.
 * Sur le site (sans le pont), les commandes restent visibles mais grisées.
 */
import { TrackType } from '../types';
import type { AraEditInfo, AraPluginKey, Clip, Track } from '../types';
import { clipRegion } from './pitchEdit';

export type { AraEditInfo, AraPluginKey } from '../types';

export const ARA_LABEL: Record<AraPluginKey, string> = { melodyne: 'Melodyne', vocalign: 'VocAlign' };

/** Infobulle du badge « ARA » (menu +, liste des plugins). */
export const ARA_BADGE_TOOLTIP =
  "ARA : en insert sur une piste, comme dans Pro Tools, le plugin lit tous les clips de la piste (sans « transfert ») ; son éditeur s'ancre en bas de la fenêtre Édition et ses retouches s'entendent en lecture. Clic droit sur un clip : « Ouvrir dans Melodyne » rend le clip (Commit).";

/** Plugins ARA connus, reconnus à leur nom ou leur chemin. */
export function araPluginKey(nameOrPath: string | undefined | null): AraPluginKey | null {
  const s = (nameOrPath || '').toLowerCase();
  if (s.includes('melodyne')) return 'melodyne';
  if (s.includes('vocalign')) return 'vocalign';
  return null;
}

export interface AraContext {
  /** Le pont VST de Nova Studio (PC) répond. */
  bridgeConnected: boolean;
  /** Le pont sait faire de l'ARA (v9 et hôte NovaARAHost présent). */
  bridgeAra: boolean;
  /** Plugins ARA trouvés sur le PC. */
  plugins: Partial<Record<AraPluginKey, { path: string; name?: string }>>;
}

export interface AraAvailability {
  enabled: boolean;
  /** Pourquoi c'est grisé (infobulle), ou ce que fait la commande. */
  tooltip: string;
  /** Repli proposé quand c'est grisé. */
  fallback?: 'pitch-editor' | 'nova-align';
}

/** Commande « Ouvrir dans Melodyne » / « Aligner avec VocAlign » : active ou grisée, et pourquoi. */
export function araAvailability(key: AraPluginKey, ctx: AraContext): AraAvailability {
  const label = ARA_LABEL[key];
  const fallback = key === 'melodyne' ? 'pitch-editor' : 'nova-align';
  const alt = key === 'melodyne' ? ' En attendant, la justesse note par note de NOVA fait le travail.' : " En attendant, l'alignement NOVA cale tes doubles.";
  if (!ctx.bridgeConnected) {
    return { enabled: false, fallback, tooltip: `Disponible dans Nova Studio sur PC avec ${label}.${alt}` };
  }
  if (!ctx.bridgeAra) {
    return { enabled: false, fallback, tooltip: `Mets à jour Nova Studio pour Windows pour ouvrir ${label} (ARA).${alt}` };
  }
  if (!ctx.plugins[key]) {
    return { enabled: false, fallback, tooltip: `${label} n'est pas installé sur ce PC.${alt}` };
  }
  return {
    enabled: true,
    tooltip: key === 'melodyne'
      ? 'Ouvre le clip dans Melodyne (ARA) : notes visibles tout de suite, « Valider » remplace le son, l’original est gardé'
      : 'Cale les doubles, backs et harmonies sur la lead avec VocAlign, sans détruire les prises d’origine',
  };
}

/** Le clip tel qu'on le confie au plugin : depuis la prise d'origine si on l'a encore. */
export function araSource(clip: Clip, hasBuffer: (id: string) => boolean): { bufferId?: string; offset: number; fromOriginal: boolean } {
  const ae = clip.araEdit;
  if (ae?.sourceBufferId && hasBuffer(ae.sourceBufferId)) {
    return { bufferId: ae.sourceBufferId, offset: (clip.offset || 0) + ae.regionStart, fromOriginal: true };
  }
  return { bufferId: clip.bufferId, offset: clip.offset || 0, fromOriginal: false };
}

/** Partie du son envoyée au plugin, et sa place dans le morceau. */
export function araRegion(clip: Clip, sourceOffset: number, bufferDuration: number): { start: number; end: number; songStart: number } {
  const r = clipRegion({ offset: sourceOffset, duration: clip.duration }, bufferDuration);
  return { ...r, songStart: clip.start - (sourceOffset - r.start) };
}

/**
 * Identifiant stable du son confié au plugin. L'archive de Melodyne s'y
 * rattache : si le clip a changé de son (autre prise, autre découpe), on ne
 * réapplique pas des retouches qui ne correspondent plus.
 */
export function araPersistentId(sourceBufferId: string | undefined, clipId: string, region: { start: number; end: number }): string {
  const r = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
  return `nova:${sourceBufferId || clipId}:${r(region.start)}-${r(region.end)}`;
}

/** Archive à redonner au plugin : seulement si elle porte sur ce même son. */
export function archiveFor(clip: Clip, persistentId: string): string | undefined {
  const ae = clip.araEdit;
  return ae?.archive && ae.persistentId === persistentId ? ae.archive : undefined;
}

const SUFFIX: Record<AraPluginKey, string> = { melodyne: 'Melodyne', vocalign: 'calé' };
const SUFFIX_RE = /\s*\((Melodyne|calé|justesse)\)$/;

/** Changements du clip quand on valide (nouveau son déjà enregistré sous `newBufferId`). */
export function araClipPatch(clip: Clip, opts: {
  plugin: AraPluginKey; mode: AraEditInfo['mode']; newBufferId: string; sourceBufferId?: string; sourceOffset: number;
  regionStart: number; persistentId: string; archive?: string; pluginName?: string;
  guide?: AraEditInfo['guide']; at?: number;
}): Partial<Clip> {
  const prev = clip.araEdit;
  const baseName = prev?.sourceName ?? clip.pitchEdit?.sourceName ?? clip.name.replace(SUFFIX_RE, '');
  const info: AraEditInfo = {
    version: 1,
    plugin: opts.plugin,
    pluginName: opts.pluginName,
    mode: opts.mode,
    sourceBufferId: opts.sourceBufferId,
    regionStart: opts.regionStart,
    persistentId: opts.persistentId,
    ...(opts.archive ? { archive: opts.archive } : {}),
    ...(opts.guide ? { guide: opts.guide } : {}),
    sourceWarp: prev ? prev.sourceWarp : clip.warp,
    sourceName: baseName,
    at: opts.at,
  };
  return {
    bufferId: opts.newBufferId,
    offset: Math.max(0, opts.sourceOffset - opts.regionStart),
    warp: undefined,
    name: `${baseName} (${SUFFIX[opts.plugin]})`,
    araEdit: info,
  };
}

/** Retour à la prise d'origine (null si elle n'est plus là : projet reçu en collaboration). */
export function araRevertPatch(clip: Clip, hasBuffer: (id: string) => boolean): Partial<Clip> | null {
  const ae = clip.araEdit;
  if (!ae?.sourceBufferId || !hasBuffer(ae.sourceBufferId)) return null;
  return {
    bufferId: ae.sourceBufferId,
    offset: (clip.offset || 0) + ae.regionStart,
    warp: ae.sourceWarp,
    name: ae.sourceName ?? clip.name.replace(SUFFIX_RE, ''),
    araEdit: undefined,
  };
}

/**
 * Que peut-on faire de ce clip retouché sur CE poste ? (collaboration, autre PC, site)
 * Le son rendu joue toujours ; la retouche demande le plugin et, pour repartir
 * de l'original, la prise d'origine.
 */
export function araReopenInfo(clip: Clip, ctx: AraContext, hasBuffer: (id: string) => boolean): { canEdit: boolean; canRevert: boolean; message?: string } {
  const ae = clip.araEdit;
  if (!ae) return { canEdit: araAvailability('melodyne', ctx).enabled, canRevert: false };
  const label = ARA_LABEL[ae.plugin];
  const canRevert = !!ae.sourceBufferId && hasBuffer(ae.sourceBufferId);
  const avail = araAvailability(ae.plugin, ctx);
  if (!ctx.bridgeConnected) {
    return { canEdit: false, canRevert, message: `Retouché avec ${label} : le son corrigé est joué tel quel. Pour retoucher, ouvre le projet dans Nova Studio sur un PC avec ${label}.` };
  }
  if (!ctx.plugins[ae.plugin]) {
    return { canEdit: false, canRevert, message: `${label} n'est pas installé sur ce PC : le son corrigé est joué tel quel.` };
  }
  if (!canRevert) {
    return { canEdit: avail.enabled, canRevert, message: `La prise d'origine n'est pas sur ce poste : ${label} repartira du son corrigé.` };
  }
  return { canEdit: avail.enabled, canRevert };
}

// ---------------------------------------------------------------------------
// VocAlign : guide et clips à aligner
// ---------------------------------------------------------------------------

const DUB_RE = /(back|bck|double|dbl|dub|harmo|harm|chœur|choeur|chorus|ad.?lib|adlib|tierce|octave|unisson|stack|bv\b)/i;
const LEAD_RE = /(lead|voix|vocal|vox|chant|main)/i;

export interface AlignCandidate { trackId: string; clipId: string; name: string; trackName: string; suggested: boolean }

/** Recouvrement (s) entre deux clips dans le morceau. */
const overlap = (a: Clip, b: Clip) => Math.min(a.start + a.duration, b.start + b.duration) - Math.max(a.start, b.start);

/**
 * Clips qu'on peut caler sur le guide : clips audio des AUTRES pistes qui
 * recouvrent le guide dans le temps (même section). Ceux des pistes BACK,
 * DOUBLE, HARMO… sont proposés cochés.
 */
export function alignCandidates(tracks: Track[], guideTrackId: string, guideClipId: string): AlignCandidate[] {
  const gt = tracks.find(t => t.id === guideTrackId);
  const guide = gt?.clips.find(c => c.id === guideClipId);
  if (!guide) return [];
  const out: AlignCandidate[] = [];
  for (const t of tracks) {
    if (t.id === guideTrackId) continue;
    for (const c of t.clips || []) {
      if (!c.bufferId || c.type === TrackType.MIDI || c.notes?.length) continue;
      const ov = overlap(guide, c);
      if (ov < Math.min(0.5, 0.3 * c.duration)) continue;
      out.push({ trackId: t.id, clipId: c.id, name: c.name, trackName: t.name, suggested: DUB_RE.test(t.name) || DUB_RE.test(c.name) });
    }
  }
  return out.sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.trackName.localeCompare(b.trackName));
}

/** Piste qui ressemble à la lead (pour proposer le guide quand on part d'un double). */
export function guessLeadTrack(tracks: Track[], fromTrackId: string): Track | undefined {
  return tracks.find(t => t.id !== fromTrackId && LEAD_RE.test(t.name) && !DUB_RE.test(t.name) && (t.clips || []).some(c => c.bufferId));
}

// ---------------------------------------------------------------------------
// Fenêtre commune guide / doubles (temps du morceau)
// ---------------------------------------------------------------------------

/** Plage du morceau couverte par le guide et les doubles (+ marge), commune à tous. */
export function alignWindow(clips: Pick<Clip, 'start' | 'duration'>[], pad = 0.25): { start: number; end: number } {
  const s = Math.max(0, Math.min(...clips.map(c => c.start)) - pad);
  const e = Math.max(...clips.map(c => c.start + c.duration)) + pad;
  return { start: s, end: e };
}

/**
 * Ce qu'on entend d'un clip, posé dans la fenêtre [w.start, w.end[ du morceau
 * (silence ailleurs). `sourceOffset` = instant du son qui joue à `clip.start`.
 */
export function clipInWindow(channels: Float32Array[], sr: number, clip: Pick<Clip, 'start' | 'duration' | 'gain'>, sourceOffset: number,
  w: { start: number; end: number }): Float32Array[] {
  const n = Math.max(1, Math.round((w.end - w.start) * sr));
  const a = Math.max(0, Math.round((clip.start - w.start) * sr));
  const b = Math.min(n, Math.round((clip.start + clip.duration - w.start) * sr));
  const src0 = Math.round(sourceOffset * sr) - Math.round((clip.start - w.start) * sr);
  return channels.map(ch => {
    const out = new Float32Array(n);
    for (let i = a; i < b; i++) {
      const j = src0 + i;
      if (j >= 0 && j < ch.length) out[i] = ch[j];
    }
    return out;
  });
}

/** Instant du son d'origine qui correspond au début du rendu d'un clip calé dans la fenêtre. */
export const windowRegionStart = (clipStart: number, sourceOffset: number, w: { start: number }) => sourceOffset - (clipStart - w.start);
