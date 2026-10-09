import type { Track } from '../types';

/**
 * Solo et muet comme Pro Tools (module pur, branché par hooks/useProToolsUtiles) :
 *
 * - Alt+clic sur un Solo (ou un Mute) : TOUTES les pistes prennent le nouvel état
 *   du bouton cliqué. En pratique : Alt+clic sur un Solo allumé = « effacer tous
 *   les solos » ; Alt+clic sur un Mute allumé = rendre le son à toutes les pistes.
 * - Ctrl+clic sur un Solo : Solo safe (la piste reste audible quand d'autres
 *   sont en solo : retour de réverbe, clic, piste guide, beat de référence).
 * - Maj+S / Maj+M : solo / muet des pistes sélectionnées.
 * - Indicateurs « S » et « M » de l'arrangement et de la console : nombre de
 *   pistes en solo / muettes, un clic efface (Pro Tools 2023.6 : indicateurs
 *   globaux de solo et de mute).
 *
 * Le moteur (engine/AudioEngine.computeSoloSilencedIds) ne coupe jamais une
 * piste solo safe ; les exports de stems et de voix seules retirent le solo
 * safe des pistes (utils/stemPlan, services/ExportPipeline) : un stem ne
 * contient que ses pistes.
 */

/** Le master n'a ni solo ni muet de piste (comme le Master Fader de Pro Tools). */
const isMaster = (t: Track) => t.id === 'master';

/** Pistes concernées par « tous les solos / tous les mutes ». */
const soloable = (t: Track) => !isMaster(t);

export interface SoloMuteStatus {
  /** Pistes en solo (hors master). */
  soloed: Track[];
  /** Pistes muettes (hors master). */
  muted: Track[];
  /** Pistes solo safe. */
  safe: Track[];
}

export function soloMuteStatus(tracks: Track[]): SoloMuteStatus {
  const list = tracks.filter(soloable);
  return { soloed: list.filter(t => t.isSolo), muted: list.filter(t => t.isMuted), safe: list.filter(t => !!t.soloSafe) };
}

/** Remplace seulement les pistes qui changent (Immer-friendly : références gardées sinon). */
function mapChanged(tracks: Track[], f: (t: Track) => Track | null): Track[] {
  let changed = false;
  const out = tracks.map(t => { const n = f(t); if (!n || n === t) return t; changed = true; return n; });
  return changed ? out : tracks;
}

/**
 * Alt+clic sur un Solo : toutes les pistes passent à `on`. Allumer tous les
 * solos laisse de côté les pistes solo safe (elles restent audibles de toute
 * façon), comme Pro Tools.
 */
export function setAllSolo(tracks: Track[], on: boolean): Track[] {
  return mapChanged(tracks, t => {
    if (!soloable(t)) return null;
    const want = on && !t.soloSafe;
    return !!t.isSolo === want ? null : { ...t, isSolo: want };
  });
}

/** Alt+clic sur un Mute : toutes les pistes (sauf le master) passent à `on`. */
export function setAllMute(tracks: Track[], on: boolean): Track[] {
  return mapChanged(tracks, t => (!soloable(t) || !!t.isMuted === on ? null : { ...t, isMuted: on }));
}

/**
 * Solo safe des pistes données : si l'une ne l'est pas, toutes le deviennent ;
 * sinon toutes le perdent (même règle que Pro Tools sur une sélection).
 */
export function toggleSoloSafe(tracks: Track[], ids: string[]): { tracks: Track[]; on: boolean } {
  const set = new Set(ids);
  const targets = tracks.filter(t => set.has(t.id) && soloable(t));
  if (!targets.length) return { tracks, on: false };
  const on = targets.some(t => !t.soloSafe);
  return {
    on,
    tracks: mapChanged(tracks, t => {
      if (!set.has(t.id) || !soloable(t) || !!t.soloSafe === on) return null;
      const n: Track = { ...t };
      if (on) n.soloSafe = true; else delete n.soloSafe;
      return n;
    }),
  };
}

/**
 * Maj+S / Maj+M (Pro Tools : solo / mute des pistes sélectionnées) : si l'une
 * des pistes n'est pas en solo (muette), toutes le deviennent ; sinon toutes
 * repassent à l'écoute.
 */
export function toggleField(tracks: Track[], ids: string[], field: 'isSolo' | 'isMuted'): { tracks: Track[]; on: boolean; count: number } {
  const set = new Set(ids);
  const targets = tracks.filter(t => set.has(t.id) && soloable(t));
  if (!targets.length) return { tracks, on: false, count: 0 };
  const on = targets.some(t => !t[field]);
  return {
    on, count: targets.length,
    tracks: mapChanged(tracks, t => (!set.has(t.id) || !soloable(t) || !!t[field] === on ? null : { ...t, [field]: on })),
  };
}

export type SoloClick = 'toggle' | 'all' | 'safe';

/** Ce que fait un clic sur un bouton Solo selon les touches tenues (Pro Tools, Windows et Mac). */
export function soloClickKind(e: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): SoloClick {
  if (e.altKey) return 'all';
  // Maj+Ctrl = inverser les groupes (R12) : pas un solo safe.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) return 'safe';
  return 'toggle';
}

/** Un clic sur un bouton Mute : Alt = toutes les pistes. */
export const muteClickKind = (e: { altKey?: boolean }): 'toggle' | 'all' => (e.altKey ? 'all' : 'toggle');

/**
 * Pistes sources à couper quand au moins une piste est en solo (lecture ET
 * export : engine/AudioEngine l'appelle des deux côtés). Restent audibles : les
 * pistes en solo et tout ce qui les alimente (sortie ou envoi actif) ; les bus
 * et retours ne sont jamais coupés (`isSource` faux), sinon soloer une voix
 * couperait le bus par lequel elle passe. Les pistes solo safe sont ajoutées
 * APRÈS la propagation : ce qui alimente une piste solo safe ne devient pas
 * audible pour autant.
 */
export function soloSilencedIds(tracks: Track[], isSource: (t: Track) => boolean): Set<string> {
  const audible = new Set(tracks.filter(t => t.isSolo).map(t => t.id));
  if (audible.size === 0) return new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tracks) {
      if (audible.has(t.id)) continue;
      const feedsAudible =
        (!!t.outputTrackId && audible.has(t.outputTrackId)) ||
        (t.sends || []).some(sd => sd.isEnabled && !sd.isMuted && sd.level > 0 && audible.has(sd.id));
      if (feedsAudible) { audible.add(t.id); changed = true; }
    }
  }
  return new Set(tracks.filter(t => isSource(t) && !audible.has(t.id) && !t.soloSafe).map(t => t.id));
}

/** Retire le solo safe (exports de stems / voix seules : chaque fichier ne contient que ses pistes). */
export function withoutSoloSafe<T extends Track>(t: T): T {
  if (!t.soloSafe) return t;
  const { soloSafe: _s, ...rest } = t;
  return rest as T;
}

/** Libellé court d'un indicateur (« 2 pistes en solo »). */
export const countLabel = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Appui long sur un S ou un M au doigt (téléphone, tablette) : l'équivalent
 * d'Alt+clic et de Ctrl+clic, avec des libellés au lieu d'une touche cachée.
 * Renvoie les entrées du menu, dans l'ordre, avec la commande à lancer (le titre du
 * menu nomme la piste : les libellés restent courts, lisibles sur un téléphone).
 */
export type SoloMuteMenuAction =
  | { kind: 'soloAll'; on: boolean; label: string }
  | { kind: 'muteAll'; on: boolean; label: string }
  | { kind: 'soloSafe'; on: boolean; label: string };

export function soloMuteMenu(tracks: Track[], trackId: string, button: 'solo' | 'mute'): SoloMuteMenuAction[] {
  const st = soloMuteStatus(tracks);
  const list = tracks.filter(soloable);
  const t = list.find(x => x.id === trackId);
  if (!t) return [];
  const out: SoloMuteMenuAction[] = [];
  if (button === 'solo') {
    const candidates = list.filter(x => !x.soloSafe);
    if (candidates.some(x => !x.isSolo)) out.push({ kind: 'soloAll', on: true, label: 'Toutes les pistes en solo' });
    if (st.soloed.length) out.push({ kind: 'soloAll', on: false, label: `Effacer tous les solos (${countLabel(st.soloed.length, 'piste', 'pistes')})` });
    out.push(t.soloSafe
      ? { kind: 'soloSafe', on: false, label: 'Retirer le solo safe' }
      : { kind: 'soloSafe', on: true, label: 'Solo safe : toujours audible' });
  } else {
    if (list.some(x => !x.isMuted)) out.push({ kind: 'muteAll', on: true, label: 'Couper toutes les pistes' });
    if (st.muted.length) out.push({ kind: 'muteAll', on: false, label: `Rendre le son à toutes les pistes (${countLabel(st.muted.length, 'muette', 'muettes')})` });
  }
  return out;
}
