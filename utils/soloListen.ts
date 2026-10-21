import type { Track } from '../types';
import { soloSilencedIds } from './soloMute';
import type { SoloListen } from './monitorSection';

/**
 * Solo d'écoute AFL / PFL (module pur, branché par engine/AudioEngine).
 *
 * - « sip » (solo dans le mix, comportement historique) : les pistes non soloées
 *   se taisent (utils/soloMute.soloSilencedIds), en lecture ET à l'export.
 * - « afl » / « pfl » : le mix n'est JAMAIS touché. Les pistes en solo sont
 *   prélevées (après fader et panoramique pour AFL, avant fader pour PFL) vers
 *   un bus d'écoute, que la section d'écoute fait entendre à la place du mix.
 *   Rien n'est coupé, donc rien ne change à l'export : les solos d'écoute sont
 *   retirés des pistes avant tout rendu (tracksForRender).
 *
 * Les pistes reçues sont celles du moteur (utils/trackStructure.engineView) :
 * le solo d'un VCA ou d'un dossier est déjà posé sur ses membres.
 *
 * Bus : soloer un bus fait entendre sa sortie (avec tout ce qui y passe).
 * Une piste en solo dont la sortie mène (directement ou par une chaîne de bus)
 * à un bus lui aussi en solo n'est pas prélevée en double : elle s'entend déjà
 * dans ce bus. Les envois ne comptent pas : soloer une voix en AFL fait entendre
 * la voix sèche ; soloer aussi le retour de réverbe pour l'entendre.
 * Solo safe : sans objet en AFL / PFL (rien n'est coupé) ; une piste solo safe
 * n'est jamais ajoutée à l'écoute sans être elle-même en solo.
 * Muet : en AFL la piste muette reste muette (le prélèvement est après le fader
 * et le muet) ; en PFL on l'entend (prélevée avant), pour la vérifier avant de
 * la remonter, comme sur une console.
 */

export interface ListenTap { id: string; point: 'pre' | 'post' }

const MASTER = 'master';

/** Prélèvements du bus d'écoute (vide en « sip » ou sans solo). */
export function listenTaps(tracks: Track[], mode: SoloListen): ListenTap[] {
  if (mode === 'sip') return [];
  const soloed = new Set(tracks.filter(t => t.isSolo && t.id !== MASTER).map(t => t.id));
  if (!soloed.size) return [];
  const byId = new Map(tracks.map(t => [t.id, t]));
  const reachesSoloed = (t: Track): boolean => {
    const seen = new Set<string>([t.id]);
    let out = t.outputTrackId;
    while (out && out !== MASTER && !seen.has(out)) {
      if (soloed.has(out)) return true;
      seen.add(out);
      out = byId.get(out)?.outputTrackId;
    }
    return false;
  };
  const point = mode === 'pfl' ? 'pre' : 'post';
  return tracks.filter(t => soloed.has(t.id) && !reachesSoloed(t)).map(t => ({ id: t.id, point }));
}

/** Pistes coupées par le solo EN LECTURE : seulement en « solo dans le mix ». */
export function liveSoloSilenced(tracks: Track[], isSource: (t: Track) => boolean, mode: SoloListen): Set<string> {
  return mode === 'sip' ? soloSilencedIds(tracks, isSource) : new Set();
}

/**
 * Pistes à rendre (export, gel, mastering, rendu d'un bus…) : en AFL / PFL, les
 * solos posés sont des solos d'ÉCOUTE, retirés (pistes, dossiers et VCA) ; le
 * fichier est le mix entier, comme si aucun solo n'était posé. Même tableau si
 * rien ne change.
 */
export function tracksForRender<T extends Track>(tracks: T[], mode: SoloListen): T[] {
  if (mode === 'sip' || !tracks.some(t => t.isSolo)) return tracks;
  return tracks.map(t => (t.isSolo ? { ...t, isSolo: false } : t));
}
