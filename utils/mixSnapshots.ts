/**
 * Scènes de mix (écart 20 du comparatif du 21/10/2026) : instantanés des réglages de la console,
 * rappelés en une étape d'annulation, comparés en A/B. Module pur : tests/mixSnapshots.test.ts.
 *
 * Une scène garde, pour chaque piste (master compris) : volume, panoramique, muet, envois (niveau,
 * pan, muet, actif) et effets (actif, réglages). Le rappel peut être partiel (seulement les
 * volumes, ou seulement les envois…) : le reste de la console ne bouge pas. Ce qui n'existe plus
 * (piste, effet ou envoi supprimé) est ignoré ; ce qui est apparu depuis garde ses réglages.
 *
 * Elles sont dans le projet (DAWState.mixScenes : sauvegarde, .zip) et voyagent en collaboration
 * (opération « scenes ») : une scène par emplacement (A, B, C, D), « le plus récent gagne »
 * (horodatage + auteur), un effacement est une pierre tombale qui gagne aussi par sa date.
 */
import type { PluginInstance, Track } from '../types';

export type SceneSlot = 'A' | 'B' | 'C' | 'D';
export const SCENE_SLOTS: SceneSlot[] = ['A', 'B', 'C', 'D'];
export const SCENES_KIND = 'scenes';

export type ScenePart = 'volumes' | 'pans' | 'mutes' | 'sends' | 'plugins';
export const SCENE_PARTS: { id: ScenePart; label: string; hint: string }[] = [
  { id: 'volumes', label: 'Volumes', hint: 'Faders des pistes, des bus et du master.' },
  { id: 'pans', label: 'Panoramiques', hint: 'Position gauche / droite de chaque piste.' },
  { id: 'mutes', label: 'Muets', hint: 'Pistes coupées.' },
  { id: 'sends', label: 'Envois', hint: 'Niveau, pan et coupure des envois vers les bus d’effets.' },
  { id: 'plugins', label: 'Effets', hint: 'Réglages des effets et leur marche / arrêt (bypass).' },
];
export const ALL_PARTS: ScenePart[] = SCENE_PARTS.map(p => p.id);

export interface SceneSend { id: string; level: number; isEnabled: boolean; pan?: number; isMuted?: boolean }
export interface ScenePlugin { id: string; type: string; isEnabled: boolean; params: Record<string, any> }
export interface TrackScene { volume: number; pan: number; isMuted: boolean; sends: SceneSend[]; plugins: ScenePlugin[] }

export interface SceneStamp { t: number; by: string }

export interface MixScene {
  slot: SceneSlot;
  name: string;
  savedAt: number;
  savedBy?: string;
  tracks: Record<string, TrackScene>;
  stamp: SceneStamp;
  /** Effacée (pierre tombale : l'effacement voyage et gagne s'il est plus récent). */
  deleted?: boolean;
}

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Réglages d'effet gardés dans une scène (le réglage `isEnabled` interne suit le bypass). */
const pluginOf = (p: PluginInstance): ScenePlugin => ({ id: p.id, type: p.type, isEnabled: !!p.isEnabled, params: clone(p.params || {}) });

export function trackSceneOf(t: Track): TrackScene {
  return {
    volume: num(t.volume, 1),
    pan: num(t.pan, 0),
    isMuted: !!t.isMuted,
    sends: (t.sends || []).map(s => ({ id: s.id, level: num(s.level, 0), isEnabled: !!s.isEnabled, ...(typeof s.pan === 'number' ? { pan: s.pan } : {}), ...(s.isMuted ? { isMuted: true } : {}) })),
    plugins: (t.plugins || []).map(pluginOf),
  };
}

/** Instantané de toute la console. */
export function captureScene(tracks: Track[], slot: SceneSlot, opts: { name?: string; by?: string; now?: number } = {}): MixScene {
  const now = opts.now ?? Date.now();
  const out: Record<string, TrackScene> = {};
  for (const t of tracks) out[t.id] = trackSceneOf(t);
  return {
    slot,
    name: (opts.name || '').trim().slice(0, 40) || `Scène ${slot}`,
    savedAt: now,
    ...(opts.by ? { savedBy: opts.by } : {}),
    tracks: out,
    stamp: { t: now, by: opts.by || 'local' },
  };
}

/**
 * Rappel (pur) : nouvelles pistes avec les parties choisies de la scène. Les objets non touchés
 * restent les mêmes (référence) : React et le moteur ne recâblent que ce qui change.
 */
export function applyScene(tracks: Track[], scene: MixScene, parts: ScenePart[] = ALL_PARTS): { tracks: Track[]; changed: number } {
  const want = new Set(parts);
  let changed = 0;
  const next = tracks.map(t => {
    const s = scene.tracks[t.id];
    if (!s) return t;
    let nt: Track = t;
    const set = <K extends keyof Track>(k: K, v: Track[K]) => { if (nt[k] !== v) { if (nt === t) nt = { ...t }; (nt as any)[k] = v; } };
    if (want.has('volumes')) set('volume', s.volume);
    if (want.has('pans')) set('pan', s.pan);
    if (want.has('mutes')) set('isMuted', s.isMuted);
    if (want.has('sends') && t.sends?.length) {
      const byId = new Map(s.sends.map(x => [x.id, x]));
      let touched = false;
      const sends = t.sends.map(x => {
        const y = byId.get(x.id);
        if (!y) return x;
        const z = { ...x, level: y.level, isEnabled: y.isEnabled };
        if (typeof y.pan === 'number') z.pan = y.pan; else delete z.pan;
        if (y.isMuted) z.isMuted = true; else delete z.isMuted;
        if (JSON.stringify(z) === JSON.stringify(x)) return x;
        touched = true;
        return z;
      });
      if (touched) set('sends', sends);
    }
    if (want.has('plugins') && t.plugins?.length) {
      const byId = new Map(s.plugins.map(x => [x.id, x]));
      let touched = false;
      const plugins = t.plugins.map(p => {
        const y = byId.get(p.id);
        if (!y || y.type !== p.type) return p;
        if (p.isEnabled === y.isEnabled && JSON.stringify(p.params || {}) === JSON.stringify(y.params)) return p;
        touched = true;
        return { ...p, isEnabled: y.isEnabled, params: clone(y.params) };
      });
      if (touched) set('plugins', plugins);
    }
    if (nt !== t) changed++;
    return nt;
  });
  return { tracks: changed ? next : tracks, changed };
}

/** La console correspond-elle déjà à la scène (pour les parties choisies) ? */
export function sceneMatches(tracks: Track[], scene: MixScene, parts: ScenePart[] = ALL_PARTS): boolean {
  return applyScene(tracks, scene, parts).changed === 0;
}

/** Résumé lisible d'une scène (infobulle). */
export function sceneSummary(scene: MixScene): string {
  const n = Object.keys(scene.tracks).length;
  const d = new Date(scene.savedAt);
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${scene.name} · ${n} piste${n > 1 ? 's' : ''} · enregistrée à ${hh}${scene.savedBy && scene.savedBy !== 'local' ? ` par ${scene.savedBy}` : ''}`;
}

export const newerStamp = (a: SceneStamp, b: SceneStamp) => a.t > b.t || (a.t === b.t && a.by > b.by);

/** Pose (ou remplace) une scène dans la liste ; renvoie une nouvelle liste. */
export function upsertScene(list: MixScene[] | undefined, scene: MixScene): MixScene[] {
  const rest = (list || []).filter(s => s.slot !== scene.slot);
  return [...rest, scene].sort((a, b) => SCENE_SLOTS.indexOf(a.slot) - SCENE_SLOTS.indexOf(b.slot));
}

/** Efface une scène (pierre tombale datée, pour la collaboration). */
export function deleteScene(list: MixScene[] | undefined, slot: SceneSlot, by = 'local', now = Date.now()): MixScene[] {
  return upsertScene(list, { slot, name: '', savedAt: now, tracks: {}, stamp: { t: now, by }, deleted: true });
}

/** Scènes visibles (sans les pierres tombales). */
export const liveScenes = (list: MixScene[] | undefined): MixScene[] => (list || []).filter(s => !s.deleted);

/** Lecture prudente d'une opération reçue. */
export function readScenesOp(op: unknown): MixScene[] {
  const arr = op && typeof op === 'object' && Array.isArray((op as any).upsert) ? (op as any).upsert : [];
  return arr.filter((s: any) => s && SCENE_SLOTS.includes(s.slot) && s.stamp && typeof s.stamp.t === 'number' && typeof s.stamp.by === 'string'
    && (s.deleted || (s.tracks && typeof s.tracks === 'object'))).map((s: any) => ({
    slot: s.slot, name: String(s.name || '').slice(0, 40), savedAt: num(s.savedAt, s.stamp.t), ...(s.savedBy ? { savedBy: String(s.savedBy).slice(0, 60) } : {}),
    tracks: s.deleted ? {} : s.tracks, stamp: { t: s.stamp.t, by: s.stamp.by }, ...(s.deleted ? { deleted: true } : {}),
  }));
}

/** Fusion « le plus récent gagne », emplacement par emplacement (converge quel que soit l'ordre). */
export function mergeScenes(local: MixScene[] | undefined, incoming: MixScene[]): { list: MixScene[]; changed: SceneSlot[] } {
  let list = [...(local || [])];
  const changed: SceneSlot[] = [];
  for (const s of incoming) {
    const cur = list.find(x => x.slot === s.slot);
    if (cur && !newerStamp(s.stamp, cur.stamp)) continue;
    list = upsertScene(list, s);
    changed.push(s.slot);
  }
  return { list, changed };
}

/** Parties à rappeler choisies par l'utilisateur (préférence de l'appareil). */
const PARTS_KEY = 'nova_scene_parts';
export function readSceneParts(): ScenePart[] {
  try {
    const v = JSON.parse(localStorage.getItem(PARTS_KEY) || 'null');
    if (Array.isArray(v)) { const ok = v.filter((x: any) => ALL_PARTS.includes(x)); if (ok.length) return ok; }
  } catch { /* stockage indisponible */ }
  return ALL_PARTS;
}
export function writeSceneParts(parts: ScenePart[]) {
  try { localStorage.setItem(PARTS_KEY, JSON.stringify(parts)); } catch { /* stockage indisponible */ }
}
