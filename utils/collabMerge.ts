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
/** Automation (R7/R8/R9) : chaque couloir à part (« auto:<id> »), leur liste et le mode de lecture. */
export const AUTO_FIELD = 'auto:';
const BASE_FIELDS = ['volume', 'pan', 'isMuted', 'outputTrackId', 'sends', 'pluginOrder', 'structure', 'strip', 'autoOrder', 'automationMode'] as const;

/**
 * Tranche de console (trim d'entrée, inversion de phase, somme mono, largeur
 * stéréo) : un seul champ. Avant : réglée chez l'ingé, jamais envoyée.
 */
export const STRIP_KEYS = ['inputTrimDb', 'phaseInvert', 'monoSum', 'stereoWidth'] as const;
export const stripOf = (t: Track): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of STRIP_KEYS) if (t[k] !== undefined && t[k] !== false && !(k === 'inputTrimDb' && t[k] === 0) && !(k === 'stereoWidth' && t[k] === 1)) out[k] = t[k];
  return out;
};

/** Couloir d'automation tel qu'il voyage (sans l'état d'affichage, local : déplié ou non). */
const laneForWire = (l: any) => { const { isExpanded: _e, ...r } = l || {}; return r; };

/**
 * Structure façon Pro Tools (utils/trackStructure) : masquée, inactive, dossier,
 * VCA, bus nommés. Un seul champ « structure » (dernière écriture gagne) :
 * une piste inactive ou masquée chez l'un l'est chez l'autre. Ignoré par les
 * anciennes versions. (Les effets inactifs voyagent avec chaque effet.)
 */
export const STRUCTURE_KEYS = ['isHidden', 'isInactive', 'folder', 'parentFolderId', 'isVca', 'vcaId', 'vcaGroupId', 'inputBusId', 'outputBusId', 'ioBuses'] as const;
export type StructureFields = Partial<Pick<Track, typeof STRUCTURE_KEYS[number]>>;

export function structureOf(t: Track): StructureFields {
  const out: Record<string, unknown> = {};
  for (const k of STRUCTURE_KEYS) if (t[k] !== undefined && t[k] !== false) out[k] = t[k];
  return out as StructureFields;
}

/** Applique une structure reçue (les clés absentes sont retirées). */
export function applyStructure(t: Track, st: StructureFields) {
  const rec = t as unknown as Record<string, unknown>;
  for (const k of STRUCTURE_KEYS) {
    const v = (st as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === false) delete rec[k];
    else rec[k] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }
}

/** Réglages de mix d'une piste, champ par champ (volume absent s'il est verrouillé par l'artiste). */
export function mixFieldsOf(t: Track): MixFields {
  const out: MixFields = {
    pan: t.pan, isMuted: t.isMuted, outputTrackId: t.outputTrackId,
    sends: t.sends || [], pluginOrder: (t.plugins || []).map(p => p.id),
    structure: structureOf(t),
  };
  if (!t.volumeLock) out.volume = t.volume;
  for (const p of t.plugins || []) out[PLUGIN_FIELD + p.id] = p;
  // Automation et tranche : avant, l'automation écrite par l'ingé restait chez lui.
  out.strip = stripOf(t);
  out.automationMode = t.automationMode ?? null;
  out.autoOrder = (t.automationLanes || []).map(l => l.id);
  for (const l of t.automationLanes || []) out[AUTO_FIELD + l.id] = laneForWire(l);
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
  if (m.structure && typeof m.structure === 'object') out.structure = m.structure;
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

/** Fusion par défaut de la file d'envoi : le mix champ par champ, les repères (et les accords, V20) un par un, le reste remplacé par le plus récent. */
export const mergeQueuedOps = (kind: string, older: Record<string, any>, newer: Record<string, any>): Record<string, any> =>
  (kind === 'mix' && older?.fields && newer?.fields ? mergeMixOps(older, newer)
    : kind === 'markers' || kind === 'chords' ? mergeMarkerOps(older, newer) : newer);

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
  if (fields.structure && typeof fields.structure === 'object' && take('structure')) applyStructure(t, fields.structure as StructureFields);
  if (fields.strip && typeof fields.strip === 'object' && take('strip')) {
    const st = fields.strip as Record<string, unknown>;
    const rec = t as unknown as Record<string, unknown>;
    for (const k of STRIP_KEYS) {
      const v = st[k];
      if (k === 'phaseInvert' || k === 'monoSum') { if (v === true) rec[k] = true; else delete rec[k]; }
      else if (typeof v === 'number' && Number.isFinite(v)) rec[k] = k === 'inputTrimDb' ? Math.max(-24, Math.min(24, v)) : Math.max(0, Math.min(2, v));
      else delete rec[k];
    }
  }
  if ('automationMode' in fields && take('automationMode')) {
    const m = fields.automationMode;
    if (m === 'off' || m === 'read' || m === 'touch' || m === 'latch' || m === 'write' || m === 'trim') t.automationMode = m; else delete t.automationMode;
  }
  // Automation : couloir par couloir ; la liste (ajouts, retraits, ordre) par « autoOrder ».
  const lanesIn = new Map<string, any>();
  for (const [k, v] of Object.entries(fields)) if (k.startsWith(AUTO_FIELD) && v && typeof v === 'object') lanesIn.set(k.slice(AUTO_FIELD.length), v);
  if (lanesIn.size || Array.isArray(fields.autoOrder)) {
    const cleanLane = (l: any, old?: any) => ({
      ...l, isExpanded: old ? !!old.isExpanded : true,
      points: (Array.isArray(l.points) ? l.points : []).filter((p: any) => p && Number.isFinite(p.time) && Number.isFinite(p.value)).sort((a: any, b: any) => a.time - b.time),
    });
    const lanes = [...(t.automationLanes || [])];
    lanesIn.forEach((l, id) => {
      const i = lanes.findIndex(x => x.id === id);
      if (i >= 0 && take(AUTO_FIELD + id)) lanes[i] = cleanLane(l, lanes[i]);
    });
    if (Array.isArray(fields.autoOrder) && take('autoOrder')) {
      const next: any[] = [];
      for (const id of (fields.autoOrder as unknown[]).filter((x): x is string => typeof x === 'string')) {
        const have = lanes.find(x => x.id === id);
        if (have) { next.push(have); continue; }
        const l = lanesIn.get(id);
        if (l) { next.push(cleanLane(l)); if (!applied.includes(AUTO_FIELD + id)) { accept(AUTO_FIELD + id); applied.push(AUTO_FIELD + id); } }
      }
      t.automationLanes = next;
    } else t.automationLanes = lanes;
  }
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
export const touchesAutomation = (fields: MixFields): boolean =>
  Object.keys(fields).some(k => k === 'autoOrder' || k === 'automationMode' || k.startsWith(AUTO_FIELD));

export const touchesPlugins = (fields: MixFields): boolean =>
  Object.keys(fields).some(k => k === 'pluginOrder' || k.startsWith(PLUGIN_FIELD));

export const isBaseField = (f: string): boolean => (BASE_FIELDS as readonly string[]).includes(f);

// ------------------------------------------- gain de clip, Heal, boucle (R5) en collaboration

/**
 * Le contenu d'une piste voyage avec ses clips tels quels (services/Collab
 * contentOf) : la ligne de gain (gainPoints), le rendu du gain (gainRender),
 * les itérations de boucle (loop) et les clips recollés (Heal) arrivent donc
 * chez l'autre sans format à part. À la réception, on vérifie seulement ces
 * champs (points triés et bornés, boucle cohérente) : une donnée abîmée ne
 * doit jamais faire taire un clip ni bloquer la lecture.
 */
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function sanitizeClipGainFields<T extends Record<string, any>>(c: T): T {
  if (!c || typeof c !== 'object') return c;
  const out: Record<string, any> = { ...c };
  if ('gainPoints' in out) {
    const pts = Array.isArray(out.gainPoints)
      ? out.gainPoints.filter((p: any) => p && finite(p.t) && finite(p.db))
        .map((p: any) => ({ t: p.t, db: Math.max(-60, Math.min(24, p.db)), ...(finite(p.curve) && p.curve !== 0 ? { curve: Math.max(-1, Math.min(1, p.curve)) } : {}) }))
        .sort((a: any, b: any) => a.t - b.t)
      : [];
    if (pts.length) out.gainPoints = pts; else delete out.gainPoints;
  }
  if ('loop' in out) {
    const l = out.loop;
    if (!l || typeof l.id !== 'string' || !finite(l.index) || !finite(l.unit) || l.unit <= 0) delete out.loop;
  }
  if ('gainRender' in out && (!out.gainRender || !Array.isArray(out.gainRender.gainPoints) || !finite(out.gainRender.gain))) delete out.gainRender;
  // Transposition / étirement (R13) : réglage vérifié ; abîmé, il est retiré (le son rendu, lui, joue normalement).
  if ('elastic' in out) {
    const e = out.elastic;
    const ok = e && finite(e.sourceOffset) && finite(e.sourceDuration) && e.sourceDuration > 0 && finite(e.duration) && e.duration > 0
      && finite(e.renderedOffset) && finite(e.semitones) && Math.abs(e.semitones) <= 12;
    if (!ok) delete out.elastic;
    else {
      const markers = Array.isArray(e.markers) ? e.markers.filter((m: any) => m && typeof m.id === 'string' && finite(m.src) && finite(m.dst)).sort((a: any, b: any) => a.src - b.src) : [];
      // Liste vide gardée vide (sinon l'empreinte du clip diffère d'un côté à l'autre).
      out.elastic = { ...e, markers: markers.length || Array.isArray(e.markers) ? markers : undefined };
    }
  }
  return out as T;
}

/** Clips reçus d'un collaborateur : champs R5 vérifiés (les autres passent tels quels). */
export const sanitizeIncomingClips = <T extends Record<string, any>>(clips: T[]): T[] =>
  clips.map(c => (c && ('gainPoints' in c || 'loop' in c || 'gainRender' in c || 'elastic' in c) ? sanitizeClipGainFields(c) : c));
