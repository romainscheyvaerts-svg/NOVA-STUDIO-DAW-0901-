/**
 * Fiche de session lisible (« spec ») → modèle NOVA.
 *
 * Le jour où Claude relève une session Pro Tools (voir
 * D:\1 WORK\CONTENU\nova-modeles\METHODE_PROTOOLS.md), il écrit une fiche JSON
 * simple, au plus près de ce qu'on voit dans Pro Tools :
 *
 * {
 *   "format": "nova-template-spec", "version": 1,
 *   "name": "Voix lead · Romain", "privateTo": "romain",
 *   "bpm": 140, "timeSignature": "4/4", "key": "F# minor",
 *   "tracks": [
 *     { "name": "Voix lead", "kind": "audio", "color": "#3b82f6",
 *       "volumeDb": -2.5, "pan": 0, "output": "Bus voix",
 *       "inserts": [
 *         { "vendor": "FabFilter", "plugin": "Pro-C 3", "active": true,
 *           "params": { "Ratio": "2.00:1", "Threshold": "-18.00 dB" } } ],
 *       "sends": [ { "to": "Reverb courte", "levelDb": -12, "pre": false } ] },
 *     { "name": "Bus voix", "kind": "bus", "output": "Master" },
 *     { "name": "Reverb courte", "kind": "aux" },
 *     { "name": "Master", "kind": "master" }
 *   ]
 * }
 *
 *  - kind : audio, midi, instrument, bus (sous-groupe : des pistes y SORTENT),
 *    aux (retour d'effet : des pistes y ENVOIENT ; « aux » choisit tout seul
 *    entre retour et bus selon l'usage), master ;
 *  - volumeDb : fader en dB (0 = unité) ; pan : -100 (gauche) … 100 (droite) ;
 *  - inserts : dans l'ordre de la chaîne ; vendor « NOVA » = effet intégré (les
 *    params sont alors ceux de NOVA) ; params = VALEURS TEXTE comme les affiche
 *    le plugin, rangées par le nom affiché du réglage (« Ratio », « Threshold ») ;
 *    stateB64 facultatif (état complet du plugin, si on l'a) ;
 *  - sends : vers une piste aux / bus par son nom, levelDb, pre (pré-fader), active.
 *
 * STRUCTURE PRO TOOLS (session LENNON : voir utils/trackStructure.ts) — champs
 * facultatifs, ignorés par les anciennes versions :
 *  - piste : "hidden": true (masquée), "inactive": true (inactive, « prête à
 *    servir ») ;
 *  - dossiers : une piste dossier s'écrit { "name": "VOX", "kind": "folder",
 *    "folderKind": "routing" | "basic" } (ou kind "routing-folder" /
 *    "basic-folder") ; une piste rangée dedans porte "folder": { "kind":
 *    "routing" | "basic", "name": "VOX" } (ou "folder": "VOX", ou "parent":
 *    "VOX"). Un dossier cité mais absent de la liste est créé avant sa 1re
 *    piste. Dossier de routage = un bus : ses pistes y sortent par défaut ;
 *  - VCA : { "name": "PRE ALL VOX", "kind": "vca" } ; un membre porte
 *    "vca": "PRE ALL VOX" (VCA créé s'il manque) ;
 *  - inserts : "state": "active" | "bypass" | "inactive" (Pro Tools : actif,
 *    en bypass, désactivé). Compatibilité : "active": false ou "enabled": false
 *    = inactif (« désactivé » dans le Session Info de Pro Tools) ;
 *  - envois a à j : { "to": "RV", "levelDb": -12, "pan": -30 (ou "<30", "30>",
 *    "L30", "C"), "mute": true, "pre": true, "slot": "c" (ou 2) } ;
 *  - bus internes nommés (I/O Setup) : "buses": ["LEAD A", "VOX ALL", …] en
 *    tête de fiche ; "input": "LEAD A" sur un aux (il écoute ce bus) ;
 *    "output": "LEAD A" (nom de bus OU de piste ; une piste du même nom passe
 *    en premier). Un bus cité en entrée / sortie est créé s'il manque ;
 *  - option du constructeur « activer tous les effets inactifs »
 *    (BuildOptions.activateAll, --activate-all) : les effets inactifs dans Pro
 *    Tools deviennent actifs, l'information est gardée (params.templateSpec.state,
 *    params.templateWasInactive) ; les effets en bypass restent en bypass.
 *
 * buildTemplateFromSpec() résout chaque plugin dans la liste VST du PC (nom +
 * éditeur, variantes tolérées : utils/vstMatch) et chaque réglage dans les
 * paramètres connus du plugin (base data/vst-knowledge ou relecture du pont).
 * scripts/template_from_spec.ts fait le contrôle réel : réglage puis relecture
 * sur le pont VST, état du plugin capturé, rapport.
 */
import { NamedBus, PluginInstance, PluginType, TrackSend, TrackType } from '../types';
import { isExcluded } from './autotuneVst';
import { classifyPlugin } from './vstKnowledge';
import { compact, resolveVst, VstCandidate, VstMatch } from './vstMatch';
import { builtinPlugin, newTemplateId, SessionTemplate, TEMPLATE_FORMAT, TEMPLATE_VERSION, TemplateTrack } from './sessionTemplate';
import { SEND_LABELS } from './sendLabels';

export const SPEC_FORMAT = 'nova-template-spec';

export type SpecParamValue = string | number | boolean;

export type SpecInsertState = 'active' | 'bypass' | 'inactive';

export interface SpecInsert {
  plugin: string;
  vendor?: string;
  /** État dans la session d'origine (Pro Tools : actif, en bypass, désactivé). Prioritaire sur active / enabled. */
  state?: SpecInsertState;
  /** Ancien format : false = inactif (« désactivé » dans Pro Tools). Défaut : actif. */
  active?: boolean;
  /** Ancien format (synonyme de active). */
  enabled?: boolean;
  /** Réglages : nom affiché → valeur texte affichée par le plugin. */
  params?: Record<string, SpecParamValue>;
  /** État complet du plugin (base64), si on l'a. */
  stateB64?: string;
  /** Remarque libre (preset chargé, pourquoi c'est désactivé…). */
  note?: string;
}

export interface SpecSend {
  /** Piste (aux / bus) ou bus nommé de destination. */
  to: string;
  levelDb?: number;
  /** Niveau linéaire 0–1 (si levelDb absent). */
  level?: number;
  pre?: boolean;
  active?: boolean;
  /** Pan de l'envoi : -100 … 100, « <30 », « 30> », « L30 », « C ». Absent : suit le pan de la piste. */
  pan?: number | string;
  /** Envoi muet (Pro Tools). */
  mute?: boolean;
  /** Emplacement : « a » … « j » ou 0 … 9. */
  slot?: number | string;
}

export type SpecKind = 'audio' | 'midi' | 'instrument' | 'bus' | 'aux' | 'return' | 'master'
  | 'folder' | 'routing-folder' | 'basic-folder' | 'vca';

/** Dossier parent d'une piste : { kind, name } ou son nom. */
export type SpecFolderRef = { kind?: 'routing' | 'basic'; name: string } | string;

export interface SpecTrack {
  name: string;
  kind: SpecKind;
  id?: string;
  color?: string;
  volumeDb?: number;
  /** -100 … 100, ou « L30 » / « R30 » / « C ». */
  pan?: number | string;
  mute?: boolean;
  solo?: boolean;
  /** Piste de sortie ou bus nommé (« Bus voix », « LEAD A », « Master »). Défaut : master (ou le dossier de routage parent). */
  output?: string;
  /** Entrée : bus nommé écouté (aux / bus). */
  input?: string;
  inserts?: SpecInsert[];
  sends?: SpecSend[];
  /** Piste masquée (liste des pistes). */
  hidden?: boolean;
  /** Piste inactive (Pro Tools « Make Inactive »). */
  inactive?: boolean;
  /** Piste dossier : routage (bus) ou simple (range). Avec kind « folder ». */
  folderKind?: 'routing' | 'basic';
  /** Dossier parent. */
  folder?: SpecFolderRef;
  /** Dossier parent (nom), synonyme de folder. */
  parent?: string;
  /** VCA qui pilote la piste (nom). */
  vca?: string;
}

export interface TemplateSpec {
  format: typeof SPEC_FORMAT;
  version: number;
  name: string;
  description?: string;
  privateTo?: string;
  /** D'où vient la fiche (« Pro Tools, Session Info as Text du 12/10 »). */
  source?: string;
  bpm?: number;
  /** « 4/4 », « 6/8 ». */
  timeSignature?: string;
  /** « F# minor », « C major ». */
  key?: string;
  /** Bus internes nommés (I/O Setup) : noms, ou { name, channels }. */
  buses?: (string | { name: string; channels?: 1 | 2 })[];
  tracks: SpecTrack[];
}

/** Paramètre connu d'un plugin (base de connaissance ou relecture du pont). */
export interface KnownParam {
  name: string;
  displayName?: string;
  display_name?: string;
  text?: string;
  values?: string[];
  range?: (number | null)[];
  isBoolean?: boolean;
  is_boolean?: boolean;
}

/** Entrée de la base de connaissance (data/vst-knowledge/plugins.json). */
export interface KnowledgeEntry {
  name: string;
  scanName?: string;
  vendor?: string;
  path: string;
  pluginName?: string | null;
  status?: string;
  params?: KnownParam[];
}

export interface ParamResolution {
  /** Nom affiché demandé par la fiche. */
  asked: string;
  value: string;
  /** Clé du paramètre côté pont (null : introuvable). */
  key: string | null;
  how: 'known' | 'guessed' | 'missing';
  warning?: string;
}

export interface InsertReport {
  track: string;
  plugin: string;
  vendor?: string;
  active: boolean;
  builtin: boolean;
  match: VstMatch | null;
  excluded: boolean;
  params: ParamResolution[];
  /** Index de l'effet dans la piste du modèle. */
  index: number;
  pluginId: string;
}

export interface SpecBuildReport {
  inserts: InsertReport[];
  warnings: string[];
  /** Règles de mix du studio (voir checkMixRules). */
  mixRules: string[];
}

// ─── Outils ────────────────────────────────────────────────────────────────────

const fold = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Clé pedalboard probable d'un nom affiché (« Band 1 Frequency » → « band_1_frequency »). */
export const pedalboardKey = (display: string): string => {
  let k = fold(display).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (/^\d/.test(k)) k = `_${k}`;
  return k;
};

/** Clé réelle d'un réglage d'après son nom affiché (casse, espaces, tirets ignorés). */
export const matchParamName = (asked: string, params: KnownParam[]): string | null => {
  const a = compact(asked);
  if (!a) return null;
  const disp = (p: KnownParam) => p.displayName || p.display_name || '';
  const hit = params.find(p => compact(disp(p)) === a) || params.find(p => compact(p.name) === a)
    || params.find(p => p.name === pedalboardKey(asked));
  return hit ? hit.name : null;
};

/** La valeur demandée est-elle plausible pour ce paramètre (liste de choix connue) ? */
const valueWarning = (p: KnownParam | undefined, value: string): string | undefined => {
  if (!p?.values?.length || p.values.length > 200) return undefined;
  const v = compact(value);
  if (p.values.some(x => compact(x) === v)) return undefined;
  if (/^[-+]?\d/.test(value.trim())) return undefined; // nombre : le pont prend la valeur la plus proche
  if (/^(on|off|true|false|oui|non)$/i.test(value.trim())) return undefined;
  return `« ${value} » n'est pas dans les choix connus (${p.values.slice(0, 6).join(', ')}${p.values.length > 6 ? '…' : ''})`;
};

const UNIT_RE = /(khz|hz|ms|s|db(?:tp|fs)?|%)\s*$/i;
const unitOfText = (t?: string) => ((t || '').trim().match(UNIT_RE)?.[1] || '').toLowerCase();

/**
 * Réglage à envoyer au pont pour une valeur texte de la fiche :
 *  - paramètre à liste de choix (« Vocal », « Low Cut », « On ») : le texte, que le
 *    pont retrouve dans la liste (casse, « 2:1 » → « 2.00:1 », valeur la plus proche) ;
 *  - paramètre continu : le NOMBRE dans l'unité du plugin (« 7 kHz » → 7000 si le
 *    plugin affiche des Hz, « 0.2 s » → 200 si le plugin affiche des ms ; « 35 % »
 *    → 0.35 si le plugin va de 0 à 1).
 */
export const settingForParam = (p: KnownParam | undefined, key: string, value: string): { name: string; text?: string; real?: number } => {
  const v = String(value).trim();
  if (!p) return { name: key, text: v };
  const bool = p.isBoolean || p.is_boolean;
  if ((p.values && p.values.length && !/^[-+]?\d/.test(v)) || bool || /:\d/.test(v)) return { name: key, text: v };
  const m = v.replace(',', '.').match(/^([-+]?\d+(?:\.\d+)?)\s*([a-z%]*)/i);
  if (!m) return { name: key, text: v };
  let n = Number(m[1]);
  const from = (m[2] || '').toLowerCase();
  const to = unitOfText(p.text);
  if (from === 'khz' && to === 'hz') n *= 1000;
  else if (from === 'hz' && to === 'khz') n /= 1000;
  else if (from === 's' && to === 'ms') n *= 1000;
  else if (from === 'ms' && to === 's') n /= 1000;
  else if (from === '%' && to !== '%') {
    const hi = Array.isArray(p.range) ? Number(p.range[1]) : NaN;
    if (Number.isFinite(hi) && hi <= 1.5) n /= 100;
  }
  return { name: key, real: Math.round(n * 1e6) / 1e6 };
};

export const dbToGain = (db: number) => Math.pow(10, db / 20);

const panOf = (p: SpecTrack['pan']): number => {
  if (p === undefined || p === null || p === '') return 0;
  if (typeof p === 'number') return Math.max(-1, Math.min(1, p / 100));
  // Pro Tools écrit « <30 » (30 à gauche) et « 30> » (30 à droite).
  const s = String(p).trim().toUpperCase().replace(',', '.');
  if (s === 'C' || s === '0' || s === '<>' || s === '<0>') return 0;
  const left = s.match(/^(?:<|L|G)\s*(\d+(?:\.\d+)?)$/);
  if (left) return -Math.min(1, Number(left[1]) / 100);
  const right = s.match(/^(?:R|D)\s*(\d+(?:\.\d+)?)$/) || s.match(/^(\d+(?:\.\d+)?)\s*>$/);
  if (right) return Math.min(1, Number(right[1]) / 100);
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n / 100)) : 0;
};

const NOTE_INDEX: Record<string, number> = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };

/** « F# minor » → { key: 6, scale: 'MINOR' }. */
export const parseKey = (k?: string): { key: number; scale: string } | null => {
  if (!k) return null;
  const m = k.trim().toUpperCase().replace('♯', '#').replace('♭', 'B').match(/^([A-G])\s*(#|B)?\s*(.*)$/);
  if (!m) return null;
  const idx = NOTE_INDEX[`${m[1]}${m[2] || ''}`];
  if (idx === undefined) return null;
  const rest = m[3] || '';
  const scale = /HARM/.test(rest) ? 'MINOR_HARMONIC' : /MIN|^M$|MOLL|MINEUR/.test(rest) ? 'MINOR' : /MAJ|MAJEUR/.test(rest) ? 'MAJOR' : 'MINOR';
  return { key: idx, scale };
};

const BUILTIN_TYPES: PluginType[] = ['REVERB', 'DELAY', 'CHORUS', 'FLANGER', 'DOUBLER', 'STEREOSPREADER', 'COMPRESSOR', 'AUTOTUNE', 'DEESSER', 'DENOISER', 'PROEQ12', 'VOCALSATURATOR', 'LIMITER'];

const builtinTypeOf = (ins: SpecInsert): PluginType | null => {
  const isNova = /^nova$/i.test((ins.vendor || '').trim());
  const t = ins.plugin.trim().toUpperCase().replace(/[\s-]+/g, '');
  const hit = BUILTIN_TYPES.find(x => x === t);
  return isNova || hit ? (hit || null) : null;
};

const KIND_TYPE: Record<SpecKind, TrackType> = {
  audio: TrackType.AUDIO, midi: TrackType.MIDI, instrument: TrackType.MIDI, bus: TrackType.BUS,
  aux: TrackType.SEND, return: TrackType.SEND, master: TrackType.BUS,
  folder: TrackType.BUS, 'routing-folder': TrackType.BUS, 'basic-folder': TrackType.BUS, vca: TrackType.BUS,
};

/** État d'un insert de la fiche (state, puis ancien active / enabled). */
export const specInsertState = (ins: SpecInsert): SpecInsertState => {
  if (ins.state === 'active' || ins.state === 'bypass' || ins.state === 'inactive') return ins.state;
  if (ins.active === false || ins.enabled === false) return 'inactive';
  return 'active';
};

/** Type de dossier d'une piste de la fiche (null : pas un dossier). */
const folderKindOf = (t: SpecTrack): 'routing' | 'basic' | null =>
  t.kind === 'routing-folder' ? 'routing' : t.kind === 'basic-folder' ? 'basic' : t.kind === 'folder' ? (t.folderKind || 'basic') : null;

/** Dossier de routage : c'est un bus (on peut y sortir). */
const isRoutingKind = (t: SpecTrack): boolean => folderKindOf(t) === 'routing';

const folderRefOf = (t: SpecTrack): { kind?: 'routing' | 'basic'; name: string } | null => {
  const f = t.folder ?? t.parent;
  if (!f) return null;
  return typeof f === 'string' ? { name: f } : (f.name ? f : null);
};

/** « c » → 2, « 3 » → 3 (emplacement d'envoi a-j). */
const slotOf = (v: SpecSend['slot']): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v >= 0 && v < 10 ? Math.floor(v) : undefined;
  const t = String(v).trim().toLowerCase();
  if (/^[a-j]$/.test(t)) return t.charCodeAt(0) - 97;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n < 10 ? Math.floor(n) : undefined;
};

/**
 * Fiche complétée : dossiers et VCA cités mais absents ajoutés (dossier avant
 * sa 1re piste, VCA avant le master).
 */
const normalizeSpecTracks = (spec: TemplateSpec): SpecTrack[] => {
  const list = [...spec.tracks];
  const isNamed = (name: string, pred: (t: SpecTrack) => boolean) => list.some(t => pred(t) && compact(t.name) === compact(name));
  for (const t of [...list]) {
    const ref = folderRefOf(t);
    if (ref && !isNamed(ref.name, x => !!folderKindOf(x))) {
      const at = list.indexOf(t);
      list.splice(at, 0, { name: ref.name, kind: 'folder', folderKind: ref.kind || 'basic' });
    }
  }
  for (const t of [...list]) {
    if (t.vca && !isNamed(t.vca, x => x.kind === 'vca')) {
      const mi = list.findIndex(x => x.kind === 'master');
      list.splice(mi < 0 ? list.length : mi, 0, { name: t.vca, kind: 'vca' });
    }
  }
  return list;
};

const PALETTE = ['#3b82f6', '#60a5fa', '#a855f7', '#c084fc', '#22c55e', '#eab308', '#f97316', '#ef4444', '#14b8a6', '#ec4899'];

/** Identifiants NOVA des pistes (les retours standard gardent leur id : couleurs, libellés, mix piloté). */
const assignIds = (spec: TemplateSpec, typeOf: (t: SpecTrack) => TrackType): Map<SpecTrack, string> => {
  const ids = new Map<SpecTrack, string>();
  const used = new Set<string>();
  const take = (want: string) => { let id = want; let n = 2; while (used.has(id)) id = `${want}-${n++}`; used.add(id); return id; };
  for (const t of spec.tracks) {
    if (t.id) { ids.set(t, take(t.id)); continue; }
    if (t.kind === 'master') { ids.set(t, take('master')); continue; }
    const type = typeOf(t);
    const f = fold(t.name);
    if (type === TrackType.SEND) {
      const std = Object.entries(SEND_LABELS).find(([, v]) => fold(v.label) === f || compact(v.label) === compact(t.name));
      ids.set(t, take(std && !used.has(std[0]) ? std[0] : `send-${pedalboardKey(t.name).replace(/_/g, '-')}`));
    } else if (type === TrackType.BUS) {
      ids.set(t, take(/bus\s*vo(x|ix)|vox\s*bus|voix\s*bus/.test(f) && !used.has('bus-vox') ? 'bus-vox' : `bus-${pedalboardKey(t.name).replace(/_/g, '-')}`));
    } else {
      ids.set(t, take(pedalboardKey(t.name).replace(/_/g, '-') || 'piste'));
    }
  }
  return ids;
};

export interface BuildOptions {
  /** Plugins VST3 du PC (pont) ; sinon la base de connaissance sert de liste. */
  plugins?: VstCandidate[];
  /** Base de connaissance (paramètres connus par plugin). */
  knowledge?: KnowledgeEntry[];
  /** « Activer tous les effets » : les effets désactivés dans Pro Tools sont activés. */
  activateAll?: boolean;
  id?: string;
  now?: number;
}

const knownParamsFor = (m: VstMatch | null, kb: KnowledgeEntry[] | undefined, name: string): KnownParam[] => {
  if (!kb?.length) return [];
  const path = m?.plugin.path?.toLowerCase();
  const byPath = path ? kb.find(e => e.path.toLowerCase() === path && (!m!.plugin.pluginName || !e.pluginName || e.pluginName === m!.plugin.pluginName)) : undefined;
  const e = byPath || kb.find(x => compact(x.name) === compact(name) || compact(x.scanName || '') === compact(name));
  return e?.params || [];
};

/** Fiche → modèle NOVA + rapport (plugins trouvés, réglages résolus, avertissements). */
export const buildTemplateFromSpec = (spec0: TemplateSpec, opts: BuildOptions = {}): { template: SessionTemplate; report: SpecBuildReport } => {
  if (!spec0 || spec0.format !== SPEC_FORMAT) throw new Error("Ce n'est pas une fiche de modèle NOVA (format « nova-template-spec »).");
  if (!Array.isArray(spec0.tracks) || !spec0.tracks.length) throw new Error('La fiche ne contient aucune piste.');
  const spec: TemplateSpec = { ...spec0, tracks: normalizeSpecTracks(spec0) };
  const report: SpecBuildReport = { inserts: [], warnings: [], mixRules: [] };
  const list: VstCandidate[] = opts.plugins || (opts.knowledge || []).map(e => ({ name: e.name, scanName: e.scanName, vendor: e.vendor, path: e.path, pluginName: e.pluginName ?? null, unavailable: !!e.status && e.status !== 'ok' }));

  // Retours (aux) : ceux qui reçoivent des envois ; bus : ceux où des pistes sortent.
  const sentTo = new Set(spec.tracks.flatMap(t => (t.sends || []).map(s => compact(s.to))));
  // Bus nommés (I/O Setup) : déclarés, ou cités en entrée d'un aux.
  const buses: NamedBus[] = [];
  const busByName = new Map<string, NamedBus>();
  const addBus = (name: string, channels?: 1 | 2): NamedBus => {
    const k = compact(name);
    const have = busByName.get(k);
    if (have) return have;
    let id = `bus:${pedalboardKey(name).replace(/_/g, '-') || 'bus'}`; let n = 2;
    while (buses.some(b => b.id === id)) id = `bus:${pedalboardKey(name).replace(/_/g, '-')}-${n++}`;
    const b: NamedBus = { id, name: name.trim(), ...(channels === 1 ? { channels: 1 as const } : {}) };
    buses.push(b); busByName.set(k, b);
    return b;
  };
  for (const b of spec.buses || []) { if (typeof b === 'string') addBus(b); else if (b?.name) addBus(b.name, b.channels); }
  for (const t of spec.tracks) if (t.input) addBus(t.input);
  // Aux qui écoute un bus : c'est un retour si on y envoie (par son nom ou par celui de son bus).
  for (const t of spec.tracks) if (t.input && sentTo.has(compact(t.input))) sentTo.add(compact(t.name));
  const typeOf = (t: SpecTrack): TrackType => (t.kind === 'aux' ? (sentTo.has(compact(t.name)) ? TrackType.SEND : TrackType.BUS) : KIND_TYPE[t.kind] ?? TrackType.AUDIO);
  const ids = assignIds(spec, typeOf);
  const byName = new Map<string, string>();
  // Les pistes « sonores » d'abord : un dossier ne masque pas une piste du même nom.
  [...spec.tracks].sort((a, b) => Number(!!folderKindOf(b) || b.kind === 'vca') - Number(!!folderKindOf(a) || a.kind === 'vca'))
    .forEach(t => { if (!folderKindOf(t) || isRoutingKind(t)) byName.set(compact(t.name), ids.get(t)!); });
  const folderIdByName = new Map<string, string>();
  spec.tracks.forEach(t => { if (folderKindOf(t)) folderIdByName.set(compact(t.name), ids.get(t)!); });
  const vcaIdByName = new Map<string, string>();
  spec.tracks.forEach(t => { if (t.kind === 'vca') vcaIdByName.set(compact(t.name), ids.get(t)!); });
  /** Piste qui écoute un bus (la 1re). */
  const listenerOf = (busId: string): string | undefined => {
    const t = spec.tracks.find(x => x.input && busByName.get(compact(x.input))?.id === busId);
    return t ? ids.get(t) : undefined;
  };
  byName.set('master', ids.get(spec.tracks.find(t => t.kind === 'master')!) || 'master');
  byName.set('masterbus', byName.get('master')!);
  const targetId = (name: string | undefined, from: string): string => {
    if (!name) return byName.get('master')!;
    const id = byName.get(compact(name));
    if (!id) report.warnings.push(`${from} : sortie « ${name} » introuvable, envoyée au master.`);
    return id || byName.get('master')!;
  };
  /** Sortie : piste du même nom, sinon bus nommé (créé s'il manque). */
  const outputOfSpec = (t: SpecTrack, parentFolder: SpecTrack | undefined): { outputTrackId: string; outputBusId?: string } => {
    if (t.kind === 'master') return { outputTrackId: '' };
    if (!t.output) {
      if (parentFolder && isRoutingKind(parentFolder)) return { outputTrackId: ids.get(parentFolder)! };
      return { outputTrackId: byName.get('master')! };
    }
    const id = byName.get(compact(t.output));
    if (id && id !== ids.get(t)) return { outputTrackId: id };
    const bus = busByName.get(compact(t.output));
    if (bus) return { outputTrackId: listenerOf(bus.id) || byName.get('master')!, outputBusId: bus.id };
    // Ni piste ni bus déclaré : on crée le bus (Pro Tools sort vers un bus par son nom).
    if (!/^(master|main|out|sortie)/i.test(t.output.trim())) {
      const b = addBus(t.output);
      report.warnings.push(`${t.name} : sortie « ${t.output} » = bus nommé sans piste qui l'écoute (son coupé tant qu'aucun aux ne l'écoute).`);
      return { outputTrackId: byName.get('master')!, outputBusId: b.id };
    }
    return { outputTrackId: targetId(t.output, t.name) };
  };

  const tracks: TemplateTrack[] = spec.tracks.map((t, ti) => {
    const id = ids.get(t)!;
    const type = typeOf(t);
    let volume = t.volumeDb === undefined ? (type === TrackType.SEND ? 0.8 : 1) : dbToGain(t.volumeDb);
    if (volume > 1.5) { report.warnings.push(`${t.name} : fader à ${t.volumeDb} dB ramené à +3.5 dB (maximum de NOVA).`); volume = 1.5; }
    const plugins: PluginInstance[] = [];
    (t.inserts || []).forEach((ins, i) => {
      const pluginId = `pl-${id}-${i + 1}`;
      // Pro Tools : actif / bypass / inactif. « Activer tous les effets inactifs » : l'inactif devient actif (info gardée).
      const srcState = specInsertState(ins);
      const state: SpecInsertState = opts.activateAll && srcState === 'inactive' ? 'active' : srcState;
      const active = state === 'active';
      const bType = builtinTypeOf(ins);
      if (bType) {
        const params: Record<string, any> = {};
        for (const [k, v] of Object.entries(ins.params || {})) params[k] = v;
        const p = builtinPlugin(bType, { ...params, isEnabled: state !== 'bypass' }, pluginId, spec.bpm || 120);
        p.isEnabled = state !== 'bypass';
        if (state === 'inactive') p.isInactive = true;
        if (srcState === 'inactive') p.params.templateWasInactive = true;
        if (srcState !== 'active') p.params.templateSpecState = srcState;
        plugins.push(p);
        report.inserts.push({ track: t.name, plugin: ins.plugin, vendor: 'NOVA', active, builtin: true, match: null, excluded: false, params: [], index: i, pluginId });
        return;
      }
      const excluded = isExcluded({ name: ins.plugin, vendor: ins.vendor || '', path: '' });
      const match = excluded ? null : resolveVst(ins.plugin, ins.vendor, list);
      if (excluded) report.warnings.push(`${t.name} : ${ins.plugin} est exclu (règle du studio : Slate sauf MetaTune / VerbSuite Classics, SSL).`);
      else if (!match) report.warnings.push(`${t.name} : ${ins.plugin}${ins.vendor ? ` (${ins.vendor})` : ''} absent de ce PC.`);
      else if (match.kind !== 'exact') report.warnings.push(`${t.name} : ${ins.plugin} → ${match.plugin.name}${match.note ? ` (${match.note})` : ''}.`);
      const known = knownParamsFor(match, opts.knowledge, ins.plugin);
      const params: ParamResolution[] = Object.entries(ins.params || {}).map(([asked, raw]) => {
        const value = typeof raw === 'boolean' ? (raw ? 'On' : 'Off') : String(raw);
        const key = known.length ? matchParamName(asked, known) : null;
        if (key) return { asked, value, key, how: 'known', warning: valueWarning(known.find(p => p.name === key), value) };
        const guess = pedalboardKey(asked);
        return guess ? { asked, value, key: guess, how: 'guessed' as const } : { asked, value, key: null, how: 'missing' as const };
      });
      const p: PluginInstance = {
        id: pluginId, name: match?.plugin.name || ins.plugin, type: 'VST3', isEnabled: state !== 'bypass' && !excluded, latency: 0,
        ...(state === 'inactive' ? { isInactive: true } : {}),
        params: {
          name: match?.plugin.name || ins.plugin,
          vendor: ins.vendor || match?.plugin.vendor || '',
          localPath: match?.plugin.path || '',
          pluginName: match?.plugin.pluginName || null,
          novaQuiet: true,
          novaSettings: params.filter(x => x.key).map(x => (x.how === 'known' ? settingForParam(known.find(k => k.name === x.key), x.key!, x.value) : { name: x.key!, text: x.value })),
          ...(ins.stateB64 ? { stateB64: ins.stateB64 } : {}),
          templateSpec: { plugin: ins.plugin, vendor: ins.vendor || '', active: srcState === 'active', state: srcState, ...(ins.note ? { note: ins.note } : {}) },
          ...(srcState === 'inactive' ? { templateWasInactive: true } : {}),
          ...(match ? {} : { templateMissing: true }),
        },
      };
      plugins.push(p);
      report.inserts.push({ track: t.name, plugin: ins.plugin, vendor: ins.vendor, active, builtin: false, match, excluded, params, index: i, pluginId });
    });
    const sends: TrackSend[] = (t.sends || []).map(s => {
      // Vers une piste par son nom, sinon vers la piste qui écoute le bus de ce nom.
      const bus = busByName.get(compact(s.to));
      const to = byName.get(compact(s.to)) || (bus ? listenerOf(bus.id) : undefined);
      if (!to) report.warnings.push(`${t.name} : envoi vers « ${s.to} » introuvable (ignoré).`);
      const level = s.levelDb !== undefined ? Math.min(1.5, dbToGain(s.levelDb)) : Math.max(0, Math.min(1.5, s.level ?? 0.25));
      const slot = slotOf(s.slot);
      return to ? {
        id: to, level, isEnabled: s.active !== false, ...(s.pre ? { preFader: true } : {}),
        ...(s.pan !== undefined && s.pan !== null && s.pan !== '' ? { pan: panOf(s.pan) } : {}),
        ...(s.mute ? { isMuted: true } : {}),
        ...(slot !== undefined ? { slot } : {}),
      } : null;
    }).filter((x): x is TrackSend => !!x);
    const parentRef = folderRefOf(t);
    const parentFolder = parentRef ? spec.tracks.find(x => folderKindOf(x) && compact(x.name) === compact(parentRef.name)) : undefined;
    const fk = folderKindOf(t);
    const out = outputOfSpec(t, parentFolder);
    const inputBus = t.input ? busByName.get(compact(t.input)) : undefined;
    const vcaId = t.vca ? vcaIdByName.get(compact(t.vca)) : undefined;
    return {
      id, name: t.name, type,
      color: t.color || (t.kind === 'master' ? '#00f2ff' : fk ? (fk === 'routing' ? '#f59e0b' : '#64748b') : t.kind === 'vca' ? '#8b5cf6' : PALETTE[ti % PALETTE.length]),
      isMuted: !!t.mute, isSolo: !!t.solo,
      volume: Math.round(volume * 10000) / 10000,
      pan: panOf(t.pan),
      outputTrackId: t.kind === 'vca' || fk === 'basic' ? '' : out.outputTrackId,
      ...(out.outputBusId && t.kind !== 'vca' && fk !== 'basic' ? { outputBusId: out.outputBusId } : {}),
      sends,
      plugins,
      ...(t.hidden ? { isHidden: true } : {}),
      ...(t.inactive ? { isInactive: true } : {}),
      ...(fk ? { folder: { kind: fk, isOpen: true } } : {}),
      ...(parentFolder ? { parentFolderId: ids.get(parentFolder)! } : {}),
      ...(t.kind === 'vca' ? { isVca: true } : {}),
      ...(vcaId ? { vcaId } : {}),
      ...(inputBus ? { inputBusId: inputBus.id } : {}),
    } as TemplateTrack;
  });
  // Bus nommés : rangés sur la piste master (comme l'I/O Setup est rangé avec la session).
  if (buses.length) {
    const m = tracks.find(x => x.id === byName.get('master'));
    if (m) m.ioBuses = buses;
    else report.warnings.push('Bus nommés ignorés : la fiche n’a pas de piste master.');
  }

  const ts = spec.timeSignature?.match(/^(\d+)\s*\/\s*(\d+)$/);
  const key = parseKey(spec.key);
  const now = opts.now ?? Date.now();
  const template: SessionTemplate = {
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION,
    id: opts.id || newTemplateId(), name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    createdAt: now, updatedAt: now,
    ...(spec.privateTo ? { privateTo: spec.privateTo } : {}),
    source: { kind: 'spec', from: spec.source || spec.name },
    keepClips: false,
    session: {
      ...(spec.bpm ? { bpm: spec.bpm } : {}),
      ...(ts ? { timeSignature: { numerator: Number(ts[1]), denominator: Number(ts[2]) } } : {}),
      ...(key ? { projectKey: key.key, projectScale: key.scale } : {}),
      isDelayCompEnabled: true,
      tracks,
      trackGroups: [],
    },
  };
  report.mixRules = checkMixRules(template);
  return { template, report };
};

// ─── Règles de mix du studio ───────────────────────────────────────────────────

const ratioOf = (p: PluginInstance): number | null => {
  if (p.type === 'COMPRESSOR') return Number(p.params?.ratio) || null;
  const s = (p.params?.novaSettings || []).find((x: any) => /ratio/i.test(x.name));
  if (!s) return null;
  const m = String(s.text ?? s.real ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const isCompressor = (p: PluginInstance): boolean => {
  if (p.type === 'COMPRESSOR') return true;
  if (p.type !== 'VST3') return false;
  const c = classifyPlugin(String(p.params?.name || p.name), String(p.params?.vendor || '')).category;
  return c === 'compressor';
};

const compKind = (p: PluginInstance): string =>
  p.type === 'COMPRESSOR' ? `nova-${p.params?.mode || 'comp'}` : `${compact(String(p.params?.name || p.name))}`;

/**
 * Règles de Romain, vérifiées sur un modèle :
 *  - voix : deux étages de compression (piste + bus), chacun en 2:1, et le
 *    deuxième d'un autre type que le premier ;
 *  - aucun plugin Slate (sauf MetaTune et VerbSuite Classics), aucun SSL.
 * Renvoie la liste des écarts (vide = conforme).
 */
export const checkMixRules = (tpl: SessionTemplate): string[] => {
  const out: string[] = [];
  const tracks = tpl.session.tracks;
  for (const t of tracks) {
    for (const p of t.plugins) {
      if (p.type !== 'VST3') continue;
      const name = String(p.params?.templateSpec?.plugin || p.params?.name || p.name);
      if (isExcluded({ name, vendor: String(p.params?.vendor || ''), path: String(p.params?.localPath || '') })) out.push(`${t.name} : ${name} est exclu (Slate sauf MetaTune / VerbSuite Classics, SSL).`);
    }
  }
  const voices = tracks.filter(t => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !/beat|instru|prod/i.test(t.name));
  for (const v of voices) {
    const chain: { track: string; p: PluginInstance }[] = [];
    let cur: TemplateTrack | undefined = v;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id) && cur.id !== 'master') {
      seen.add(cur.id);
      cur.plugins.filter(isCompressor).forEach(p => chain.push({ track: cur!.name, p }));
      const next = cur.outputTrackId;
      cur = tracks.find(x => x.id === next);
    }
    if (!chain.length) continue;
    if (chain.length < 2) out.push(`${v.name} : un seul étage de compression (il en faut deux, en 2:1).`);
    for (const c of chain) {
      const r = ratioOf(c.p);
      if (r !== null && Math.abs(r - 2) > 0.05) out.push(`${v.name} : ${c.p.params?.name || c.p.name} (${c.track}) est à ${r}:1 au lieu de 2:1.`);
    }
    if (chain.length >= 2 && compKind(chain[0].p) === compKind(chain[1].p)) out.push(`${v.name} : les deux compresseurs sont du même type (${chain[0].p.params?.name || chain[0].p.name}).`);
  }
  return out;
};
