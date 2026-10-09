/**
 * Plan des stems (R1) : quelles pistes sonnent dans chaque fichier.
 *
 * Regroupements (comme Pro Tools « Track Bounce », Logic « Bounce stems »,
 * Ableton « Export individual tracks », FL « Split mixer tracks ») :
 *   - tracks       : une piste source = un fichier ;
 *   - buses        : un fichier par sortie qui arrive au master (bus voix, bus
 *                    batterie…) ; une piste branchée directement au master
 *                    reste seule ;
 *   - folders      : un fichier par dossier du haut (pistes hors dossier : seules) ;
 *   - instru-voix  : deux fichiers, les voix et tout le reste (pour l'ingé).
 * Retours d'effets (réverbe, delay) :
 *   - in-stems     : chaque stem porte sa propre réverbe (la somme = le mix) ;
 *   - separate     : stems secs + un fichier par retour (la somme = le mix) ;
 *   - none         : stems secs, sans retours (la somme ≠ le mix, dit à l'écran).
 * Effets du master : gardés sur chaque stem, ou retirés (le fader du master reste).
 *
 * Le rendu reçoit pour chaque stem la liste COMPLÈTE des pistes, modifiée :
 * solo des pistes du stem (le moteur garde leurs bus, envois et le master),
 * envois retirés ou sorties coupées selon le choix. Tous les stems sont rendus
 * sur la même plage : ils démarrent à 0 et ont la même longueur.
 */
import { Track, TrackType } from '../types';
import { withoutSoloSafe } from './soloMute';
import { engineView, VOID_OUTPUT } from './trackStructure';
import { isVoiceTrack } from './vocalRoles';

export type StemGrouping = 'tracks' | 'buses' | 'folders' | 'instru-voix';
export type ReturnsMode = 'in-stems' | 'separate' | 'none';

export interface StemPlanOptions {
  grouping: StemGrouping;
  returns: ReturnsMode;
  withMasterFx: boolean;
}

export interface StemSpec {
  id: string;
  label: string;
  kind: 'track' | 'bus' | 'folder' | 'voix' | 'instru' | 'return';
  /** Pistes sources (ou retour) qui composent le stem. */
  memberIds: string[];
  /** Pistes à passer au rendu. */
  tracks: Track[];
}

export const MASTER = 'master';

const SOURCE_TYPES = new Set<string>([TrackType.AUDIO, TrackType.MIDI, TrackType.SAMPLER, TrackType.DRUM_RACK, TrackType.DRUM_SAMPLER, TrackType.MELODIC_SAMPLER]);

/** Piste qui produit du son par elle-même (et qui sonne dans le mix). */
export function isStemSource(t: Track): boolean {
  if (t.id === MASTER || t.isGuide || t.isMuted || t.isVca || t.folder) return false;
  if (!SOURCE_TYPES.has(t.type)) return false;
  return (t.clips || []).some(c => !c.isMuted && (c.type !== TrackType.MIDI || (c.notes?.length ?? 0) > 0 || !!c.bufferId || !!c.buffer))
    || (isFrozenWithAudio(t));
}
const isFrozenWithAudio = (t: Track) => !!t.isFrozen && !!t.frozenClip;

export const isReturnTrack = (t: Track) => t.type === TrackType.SEND && t.id !== MASTER;

/** Pistes jouées (hors guides) : les guides ne sont jamais exportés. */
export const withoutGuides = (tracks: Track[]) => tracks.filter(t => !t.isGuide);

/** Dernière étape avant le master pour une piste (elle-même si elle y va directement). */
export function lastHopBeforeMaster(trackId: string, tracks: Track[]): string {
  const view = engineView(tracks);
  const byId = view.byId;
  let cur = byId.get(trackId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const out = cur.outputTrackId;
    if (!out || out === MASTER || out === VOID_OUTPUT || !byId.has(out)) return cur.id;
    cur = byId.get(out);
  }
  return trackId;
}

/** Dossier du haut d'une piste (ou null). */
export function topFolderOf(t: Track, byId: Map<string, Track>): string | null {
  let top: string | null = null;
  const seen = new Set<string>([t.id]);
  let cur = t.parentFolderId ? byId.get(t.parentFolderId) : undefined;
  while (cur && cur.folder && !seen.has(cur.id)) {
    top = cur.id;
    seen.add(cur.id);
    cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined;
  }
  return top;
}

/** Instruments reconnus au nom d'une piste audio (un sample de caisse claire n'est pas une voix). */
const INSTRUMENT_NAME = /kick|snare|clap|hat|hh|perc|drum|batterie|caisse|charley|cymb|tom|808|bass|basse|beat|instru|prod|m[eé]lod|piano|guitar|guitare|synth|pad|keys|string|cordes|sample|loop|boucle|fx/i;

/** Piste de voix (pour « instru / voix séparés ») : une prise enregistrée, ou une piste audio au nom de voix. */
export function isVocalSource(t: Track): boolean {
  if (!isVoiceTrack(t) || t.instrumentId) return false;
  if ((t.clips || []).some(c => typeof c.takeNumber === 'number')) return true;
  return !INSTRUMENT_NAME.test(t.name || '');
}

const sendsTo = (t: Track, ids: Set<string>) => (t.sends || []).filter(s => !ids.has(s.id));

/** Liste de rendu d'un stem : solo des membres, retours / master selon les options. */
function renderTracksFor(tracks: Track[], memberIds: Set<string>, opts: StemPlanOptions, returnIds: Set<string>): Track[] {
  return tracks.map(t => {
    // Solo safe retiré (utils/soloMute) : un stem ne contient que ses pistes.
    let x: Track = { ...withoutSoloSafe(t), isSolo: memberIds.has(t.id) };
    if (memberIds.has(t.id)) x.isMuted = false;
    if (opts.returns !== 'in-stems' && returnIds.size) x = { ...x, sends: sendsTo(x, returnIds) };
    if (t.id === MASTER && !opts.withMasterFx) x = { ...x, plugins: [] };
    return x;
  });
}

/** Rendu d'un retour seul : tout joue, les chemins secs vers le master sont coupés, seuls les envois vers ce retour restent. */
function renderTracksForReturn(tracks: Track[], ret: Track, opts: StemPlanOptions, returnIds: Set<string>): Track[] {
  const others = new Set([...returnIds].filter(id => id !== ret.id));
  // Chemin du retour jusqu'au master (retour → bus FX → master) : gardé intact.
  const byId = new Map(tracks.map(t => [t.id, t] as const));
  const keep = new Set<string>([ret.id]);
  for (let cur = byId.get(ret.outputTrackId || ''); cur && cur.id !== MASTER && !keep.has(cur.id); cur = byId.get(cur.outputTrackId || '')) keep.add(cur.id);
  return tracks.map(t => {
    let x: Track = { ...t, isSolo: false };
    if (others.size) x = { ...x, sends: sendsTo(x, others) };
    const out = x.outputTrackId;
    const goesToMaster = !out || out === MASTER;
    if (t.id !== MASTER && !keep.has(t.id) && goesToMaster) x = { ...x, outputTrackId: VOID_OUTPUT, outputBusId: undefined };
    if (t.id === MASTER && !opts.withMasterFx) x = { ...x, plugins: [] };
    return x;
  });
}

export function planStems(allTracks: Track[], opts: StemPlanOptions): StemSpec[] {
  const tracks = withoutGuides(allTracks);
  const view = engineView(tracks);
  const played = new Set(view.tracks.map(t => t.id));
  const byId = new Map(tracks.map(t => [t.id, t] as const));
  const sources = tracks.filter(t => played.has(t.id) && isStemSource(t));
  const returns = tracks.filter(t => played.has(t.id) && isReturnTrack(t));
  const returnIds = new Set(returns.map(r => r.id));

  const groups: { id: string; label: string; kind: StemSpec['kind']; members: string[] }[] = [];
  const add = (id: string, label: string, kind: StemSpec['kind'], member: string) => {
    let g = groups.find(x => x.id === id);
    if (!g) { g = { id, label, kind, members: [] }; groups.push(g); }
    g.members.push(member);
  };
  for (const s of sources) {
    if (opts.grouping === 'tracks') add(s.id, s.name || 'Piste', 'track', s.id);
    else if (opts.grouping === 'buses') {
      const hop = lastHopBeforeMaster(s.id, tracks);
      const h = byId.get(hop);
      add(hop, h?.name || s.name, hop === s.id ? 'track' : 'bus', s.id);
    } else if (opts.grouping === 'folders') {
      const f = topFolderOf(s, byId);
      add(f || s.id, (f ? byId.get(f)?.name : s.name) || 'Piste', f ? 'folder' : 'track', s.id);
    } else {
      const voix = isVocalSource(s);
      add(voix ? 'voix' : 'instru', voix ? 'Voix' : 'Instru', voix ? 'voix' : 'instru', s.id);
    }
  }
  if (opts.grouping === 'instru-voix') groups.sort((a, b) => (a.id === 'instru' ? -1 : b.id === 'instru' ? 1 : 0));

  const out: StemSpec[] = groups.map(g => ({
    id: g.id, label: g.label, kind: g.kind, memberIds: g.members,
    tracks: renderTracksFor(tracks, new Set(g.members), opts, returnIds),
  }));
  if (opts.returns === 'separate') {
    for (const r of returns) {
      // Un retour qui ne reçoit rien (aucun envoi actif) ne fait pas de fichier vide.
      const fed = tracks.some(t => t.id !== r.id && (t.sends || []).some(s => s.id === r.id && s.isEnabled && !s.isMuted && s.level > 0));
      if (!fed) continue;
      out.push({ id: `ret-${r.id}`, label: r.name || 'Retour', kind: 'return', memberIds: [r.id], tracks: renderTracksForReturn(tracks, r, opts, returnIds) });
    }
  }
  return out;
}

/** Vrai si la somme des stems redonne le mix (rien de non linéaire ni de retiré). */
export function stemsSumToMix(opts: StemPlanOptions, tracks: Track[]): boolean {
  if (opts.returns === 'none' && tracks.some(isReturnTrack)) return false;
  const master = tracks.find(t => t.id === MASTER);
  const masterFx = (master?.plugins || []).some(p => p.isEnabled && !p.isInactive);
  return !(opts.withMasterFx && masterFx);
}
