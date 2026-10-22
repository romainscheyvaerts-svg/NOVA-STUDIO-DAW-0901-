import type { ContextMenuItem, PluginInstance, Track, TrackSend } from '../types';

/**
 * Inserts et envois copiés / déplacés d'une tranche à l'autre (Pro Tools :
 * glisser un insert ou un envoi sur une autre tranche = le DÉPLACER ;
 * Alt+glisser = le COPIER, réglages compris). Module pur :
 * tests/insertCopy.test.ts ; branché dans components/MixerView.
 *
 * Préréglage NOVA : glisser vers une autre tranche copiait déjà ; on le garde
 * (Alt copie aussi). Préréglage Pro Tools : glisser déplace, Alt copie.
 */

export const INSERT_MIME = 'application/nova-insert';
export const SEND_MIME = 'application/nova-send';

export type DropMode = 'copy' | 'move';

/** Copier ou déplacer, selon Alt et le préréglage de raccourcis. */
export const dropModeOf = (altKey: boolean, presetId: string): DropMode =>
  (altKey || presetId !== 'protools' ? 'copy' : 'move');

/** Une tranche qui accepte des inserts (pas un VCA ni un dossier simple). */
export const acceptsInserts = (t: Track | undefined): boolean =>
  !!t && !t.isVca && t.folder?.kind !== 'basic';

/** Une tranche qui peut envoyer vers `busId` (pas le bus lui-même, pas le master, pas un VCA). */
export const acceptsSend = (t: Track | undefined, busId: string): boolean =>
  !!t && t.id !== 'master' && t.id !== busId && !t.isVca && !t.folder && t.type !== 'SEND';

let seq = 0;
const newPluginId = () => `pl-copy-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Effet copié : nouvel identifiant, réglages recopiés (état VST compris). */
export const clonePlugin = (p: PluginInstance): PluginInstance =>
  ({ ...JSON.parse(JSON.stringify(p)), id: newPluginId() });

/**
 * Pose l'effet `pluginId` de `srcId` sur `destId` (à la position `index`,
 * sinon à la fin). `move` : il quitte la tranche d'origine.
 */
export function transferInsert(tracks: Track[], srcId: string, pluginId: string, destId: string, opts: { index?: number; move?: boolean } = {}): { tracks: Track[]; ok: boolean; name?: string } {
  if (srcId === destId) return { tracks, ok: false };
  const src = tracks.find(t => t.id === srcId);
  const dest = tracks.find(t => t.id === destId);
  const p = src?.plugins.find(x => x.id === pluginId);
  if (!src || !p || !acceptsInserts(dest)) return { tracks, ok: false };
  const copy = opts.move ? { ...p, params: { ...p.params } } : clonePlugin(p);
  return {
    ok: true, name: p.name || String(p.type),
    tracks: tracks.map(t => {
      if (t.id === destId) {
        const plugins = [...t.plugins];
        const at = typeof opts.index === 'number' && opts.index >= 0 ? Math.min(opts.index, plugins.length) : plugins.length;
        plugins.splice(at, 0, copy);
        return { ...t, plugins };
      }
      if (opts.move && t.id === srcId) return { ...t, plugins: t.plugins.filter(x => x.id !== pluginId) };
      return t;
    }),
  };
}

const sameSend = (a: TrackSend, sendId: string, slot?: number) => a.id === sendId && (slot === undefined || (a.slot ?? null) === (slot ?? null));

/**
 * Pose l'envoi de `srcId` vers le bus `sendId` sur `destId` (niveau, pré / post,
 * pan, mute). La destination a déjà un envoi vers ce bus : il prend ces réglages.
 * `move` : l'envoi d'origine retombe à zéro (coupé, son routage reste).
 */
export function transferSend(tracks: Track[], srcId: string, sendId: string, destId: string, opts: { slot?: number; move?: boolean } = {}): { tracks: Track[]; ok: boolean } {
  if (srcId === destId) return { tracks, ok: false };
  const src = tracks.find(t => t.id === srcId);
  const dest = tracks.find(t => t.id === destId);
  const s = src?.sends.find(x => sameSend(x, sendId, opts.slot));
  if (!src || !s || !acceptsSend(dest, sendId)) return { tracks, ok: false };
  const { slot: _slot, ...settings } = s;
  return {
    ok: true,
    tracks: tracks.map(t => {
      if (t.id === destId) {
        const has = t.sends.some(x => x.id === sendId);
        const sends = has
          ? t.sends.map(x => (x.id === sendId ? { ...x, ...settings } : x))
          : [...t.sends, { ...settings }];
        return { ...t, sends };
      }
      if (opts.move && t.id === srcId) return { ...t, sends: t.sends.map(x => (sameSend(x, sendId, opts.slot) ? { ...x, level: 0 } : x)) };
      return t;
    }),
  };
}

/**
 * Menu d'un insert (clic droit, appui long — la tablette n'a ni glisser-déposer
 * ni Alt) : « Copier vers « Backs » »… pour chaque autre tranche.
 */
export function insertCopyMenuItems(track: Track, p: PluginInstance, all: Track[], apply: (fn: (ts: Track[]) => Track[], label: string) => void): ContextMenuItem[] {
  const name = p.name || String(p.type);
  const items: ContextMenuItem[] = [];
  // En une fois (audit mix 22/10) : les pistes qui sortent vers le même bus, toutes les pistes audio.
  for (const g of insertCopyGroups(track, all)) {
    items.push({
      label: `${g.label} (${g.ids.length})`, icon: 'fa-clone',
      title: 'Une copie de l’effet (réglages compris) en fin de chaîne de chacune de ces pistes ; Ctrl+Z annule tout',
      onClick: () => apply(ts => copyInsertToMany(ts, track.id, p.id, g.ids), `${name} copié sur ${g.ids.length} piste${g.ids.length > 1 ? 's' : ''} (réglages compris)`),
    });
  }
  // Une par une : les voisines de la tranche d'abord (avant : les 10 premières pistes de la séance,
  // la piste 30 d'une séance de 60 n'était jamais proposée).
  for (const t of nearestInsertTargets(track, all, 8)) {
    items.push({
      label: `Copier vers « ${t.name} »`, icon: 'fa-copy',
      title: 'Alt+glisser l’insert sur une autre tranche (réglages compris)',
      onClick: () => apply(ts => transferInsert(ts, track.id, p.id, t.id).tracks, `${name} copié sur « ${t.name} » (réglages compris)`),
    });
  }
  return items;
}

const isAudioLike = (t: Track) => t.type === 'AUDIO' || t.type === 'SAMPLER' || t.type === 'MIDI';

/** Groupes de destinations proposés pour copier un insert d'un coup. Pur. */
export function insertCopyGroups(track: Track, all: Track[]): { label: string; ids: string[] }[] {
  const others = all.filter(t => t.id !== track.id && t.id !== 'master' && acceptsInserts(t) && !t.isHidden);
  const out: { label: string; ids: string[] }[] = [];
  const bus = track.outputTrackId && track.outputTrackId !== 'master' ? all.find(t => t.id === track.outputTrackId) : undefined;
  if (bus) {
    const ids = others.filter(t => t.outputTrackId === bus.id).map(t => t.id);
    if (ids.length) out.push({ label: `Copier sur les pistes vers « ${bus.name} »`, ids });
  }
  const audio = others.filter(isAudioLike).map(t => t.id);
  if (audio.length > 1 && audio.length !== out[0]?.ids.length) out.push({ label: 'Copier sur toutes les pistes', ids: audio });
  return out;
}

/** Les `n` tranches les plus proches (dans l'ordre de la séance) qui acceptent un insert. Pur. */
export function nearestInsertTargets(track: Track, all: Track[], n: number): Track[] {
  const i = all.findIndex(t => t.id === track.id);
  return all
    .map((t, k) => ({ t, d: Math.abs(k - i) + (k < i ? 0.5 : 0) }))
    .filter(({ t }) => t.id !== track.id && acceptsInserts(t) && !t.isHidden)
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(({ t }) => t);
}

/** Copie (réglages compris) d'un insert en fin de chaîne de plusieurs pistes. Pur. */
export function copyInsertToMany(tracks: Track[], srcId: string, pluginId: string, destIds: string[]): Track[] {
  let ts = tracks;
  for (const id of destIds) ts = transferInsert(ts, srcId, pluginId, id).tracks;
  return ts;
}
