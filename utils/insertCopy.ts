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
  return all.filter(t => t.id !== track.id && acceptsInserts(t) && !t.isHidden).slice(0, 10).map(t => ({
    label: `Copier vers « ${t.name} »`, icon: 'fa-copy',
    title: 'Alt+glisser l’insert sur une autre tranche (réglages compris)',
    onClick: () => apply(ts => transferInsert(ts, track.id, p.id, t.id).tracks, `${p.name || p.type} copié sur « ${t.name} » (réglages compris)`),
  }));
}
