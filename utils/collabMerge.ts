import type { PluginInstance, Track, TrackSend } from '../types';

/**
 * Collaboration « En direct » : règle de fusion quand deux personnes touchent
 * la même piste en même temps (deux ingés, ou l'ingé et l'artiste).
 *
 * Règle : la DERNIÈRE ÉCRITURE GAGNE, PAR PARAMÈTRE. Chaque réglage de mix
 * d'une piste est un champ à part : volume, pan, muet, sortie, envois, ordre
 * des effets, et chaque effet (« plugin:<id> »). Une opération ne porte que
 * les champs modifiés. L'ordre est celui du journal du serveur (numéro seq) :
 *  - un champ reçu plus ancien que celui déjà appliqué est ignoré (opération
 *    arrivée en retard, dans le désordre) ;
 *  - ce que l'autre a changé ailleurs (un autre champ) n'est jamais écrasé ;
 *  - un champ modifié ici et pas encore parti (file d'envoi) n'est pas
 *    remplacé par celui de l'autre : le nôtre partira après et gagnera chez
 *    tout le monde (même résultat partout).
 * Avant : l'ingé envoyait TOUT le mix de la piste ; le volume d'un ingé
 * écrasait le pan que l'autre venait de régler.
 *
 * Module pur : testable tel quel.
 */

export type MixFields = Record<string, unknown>;

export const PLUGIN_FIELD = 'plugin:';
const BASE_FIELDS = ['volume', 'pan', 'isMuted', 'outputTrackId', 'sends', 'pluginOrder'] as const;

/** Réglages de mix d'une piste, champ par champ (volume absent s'il est verrouillé par l'artiste). */
export function mixFieldsOf(t: Track): MixFields {
  const out: MixFields = {
    pan: t.pan, isMuted: t.isMuted, outputTrackId: t.outputTrackId,
    sends: t.sends || [], pluginOrder: (t.plugins || []).map(p => p.id),
  };
  if (!t.volumeLock) out.volume = t.volume;
  for (const p of t.plugins || []) out[PLUGIN_FIELD + p.id] = p;
  return out;
}

/** Empreinte stable d'une valeur (FNV-1a du JSON). */
export const fieldSig = (v: unknown): string => {
  const s = JSON.stringify(v) ?? 'u';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length}:${h.toString(16)}`;
};

export const fieldSigsOf = (fields: MixFields): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fieldSig(v)]));

/** Champs qui ont changé depuis les empreintes connues (envoyées ou reçues). */
export function changedFields(known: Record<string, string> | undefined, fields: MixFields): MixFields {
  const out: MixFields = {};
  for (const [k, v] of Object.entries(fields)) if (!known || known[k] !== fieldSig(v)) out[k] = v;
  return out;
}

/** Ancien format (« mix » complet) → champs. */
export function legacyMixToFields(m: Record<string, any> | undefined | null): MixFields {
  const out: MixFields = {};
  if (!m) return out;
  if (typeof m.volume === 'number') out.volume = m.volume;
  if (typeof m.pan === 'number') out.pan = m.pan;
  if (typeof m.isMuted === 'boolean') out.isMuted = m.isMuted;
  if (typeof m.outputTrackId === 'string') out.outputTrackId = m.outputTrackId;
  if (Array.isArray(m.sends)) out.sends = m.sends;
  if (Array.isArray(m.plugins)) {
    out.pluginOrder = m.plugins.map((p: PluginInstance) => p.id);
    for (const p of m.plugins as PluginInstance[]) if (p && typeof p.id === 'string') out[PLUGIN_FIELD + p.id] = p;
  }
  return out;
}

/** Fusion de deux opérations de mix en file (la plus récente l'emporte champ par champ). */
export const mergeMixOps = (older: Record<string, any>, newer: Record<string, any>): Record<string, any> =>
  ({ ...older, ...newer, fields: { ...(older.fields || {}), ...(newer.fields || {}) } });

/**
 * Repères en file (hors ligne) : deux lots se cumulent, repère par repère (le
 * plus récent l'emporte) ; un repère supprimé puis recréé reste, et inversement.
 */
export const mergeMarkerOps = (older: Record<string, any>, newer: Record<string, any>): Record<string, any> => {
  const up = new Map<string, any>();
  const rm = new Set<string>();
  for (const batch of [older, newer]) {
    for (const m of Array.isArray(batch?.upsert) ? batch.upsert : []) if (m && typeof m.id === 'string') { up.set(m.id, m); rm.delete(m.id); }
    for (const id of Array.isArray(batch?.remove) ? batch.remove : []) if (typeof id === 'string') { rm.add(id); up.delete(id); }
  }
  return { ...older, ...newer, upsert: [...up.values()], remove: [...rm] };
};

/** Fusion par défaut de la file d'envoi : le mix champ par champ, les repères repère par repère, le reste remplacé par le plus récent. */
export const mergeQueuedOps = (kind: string, older: Record<string, any>, newer: Record<string, any>): Record<string, any> =>
  (kind === 'mix' && older?.fields && newer?.fields ? mergeMixOps(older, newer)
    : kind === 'markers' ? mergeMarkerOps(older, newer) : newer);

/**
 * Horloge « dernière écriture gagne » : le numéro (seq) du journal le plus
 * récent appliqué par clé (« voix:pan », « content:voix »…).
 */
export class LwwClock {
  private m = new Map<string, number>();
  /** Vrai si l'écriture n° seq est au moins aussi récente que la dernière appliquée (elle est retenue). */
  accept(key: string, seq: number): boolean {
    const cur = this.m.get(key);
    if (cur !== undefined && seq < cur) return false;
    this.m.set(key, seq);
    return true;
  }
  /** Notre propre écriture (numéro rendu par le serveur) : une plus ancienne de l'autre ne passera plus. */
  note(key: string, seq: number) {
    const cur = this.m.get(key);
    if (cur === undefined || seq > cur) this.m.set(key, seq);
  }
  get(key: string): number | undefined { return this.m.get(key); }
  clear() { this.m.clear(); }
}

/**
 * Applique des champs de mix reçus (brouillon Immer). `accept(champ)` décide
 * pour chacun (horloge + modification locale en attente). Renvoie les champs
 * appliqués.
 */
export function applyMixFields(t: Track, fields: MixFields, accept: (field: string) => boolean): string[] {
  const applied: string[] = [];
  const take = (f: string) => { const ok = accept(f); if (ok) applied.push(f); return ok; };
  if (typeof fields.volume === 'number' && !t.volumeLock && take('volume')) t.volume = fields.volume;
  if (typeof fields.pan === 'number' && take('pan')) t.pan = fields.pan;
  if (typeof fields.isMuted === 'boolean' && take('isMuted')) t.isMuted = fields.isMuted;
  if (typeof fields.outputTrackId === 'string' && take('outputTrackId')) t.outputTrackId = fields.outputTrackId;
  if (Array.isArray(fields.sends) && take('sends')) t.sends = (fields.sends as TrackSend[]).map(s => ({ ...s }));
  // Effets : chacun à part ; l'ordre (et les ajouts / retraits) par « pluginOrder ».
  const incoming = new Map<string, PluginInstance>();
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith(PLUGIN_FIELD) || !v || typeof v !== 'object') continue;
    incoming.set(k.slice(PLUGIN_FIELD.length), v as PluginInstance);
  }
  const plugins = [...(t.plugins || [])];
  incoming.forEach((p, id) => {
    const i = plugins.findIndex(x => x.id === id);
    if (i >= 0 && take(PLUGIN_FIELD + id)) plugins[i] = { ...p, params: { ...(p.params || {}) } };
  });
  if (Array.isArray(fields.pluginOrder) && take('pluginOrder')) {
    const order = (fields.pluginOrder as unknown[]).filter((x): x is string => typeof x === 'string');
    const next: PluginInstance[] = [];
    for (const id of order) {
      const have = plugins.find(x => x.id === id);
      if (have) { next.push(have); continue; }
      const p = incoming.get(id);
      if (p) { next.push({ ...p, params: { ...(p.params || {}) } }); if (!applied.includes(PLUGIN_FIELD + id)) { accept(PLUGIN_FIELD + id); applied.push(PLUGIN_FIELD + id); } }
    }
    t.plugins = next;
  } else {
    t.plugins = plugins;
  }
  return applied;
}

/** Champs de mix touchés par une opération (pour savoir si les effets ont bougé). */
export const touchesPlugins = (fields: MixFields): boolean =>
  Object.keys(fields).some(k => k === 'pluginOrder' || k.startsWith(PLUGIN_FIELD));

export const isBaseField = (f: string): boolean => (BASE_FIELDS as readonly string[]).includes(f);
