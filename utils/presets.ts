/**
 * Presets d'effets et Track Presets (R4).
 *
 *  - Preset d'effet (`.novapreset`) : le réglage d'UN effet. Effet NOVA : ses
 *    params ; VST3 du PC : son état binaire (`stateB64`, lu par le pont) et les
 *    paramètres relus à l'enregistrement (pour vérifier au rechargement).
 *    Pro Tools : menu « Librarian » de la fenêtre de plug-in ; Logic : menu
 *    « Réglages » ; Ableton : « Save Preset » ; FL : « Save preset as ».
 *  - Comparer (Pro Tools « Compare », Logic « Compare ») : bascule entre le
 *    réglage enregistré / chargé et ce que tu as modifié depuis.
 *  - Track Preset (`.novachain`, Pro Tools 2020+) : toute la chaîne d'une piste
 *    (inserts dans l'ordre avec actif / bypass / inactif, envois, volume, pan,
 *    sortie), rappelée sur une piste existante ou à la création d'une piste.
 *    Les retours visés par les envois (reverb, délai) sont décrits dans le
 *    preset : s'ils manquent dans la session, ils sont créés.
 *
 * Même logique que les modèles de session (utils/sessionTemplate : effets
 * nettoyés par sanitizePlugin, VST absent remplacé par l'effet NOVA proche).
 * Aucune dépendance au moteur audio ni à React : testable tel quel.
 */
import { PluginInstance, PluginType, Track, TrackSend, TrackType } from '../types';
import { instantiateTemplate, InstantiateOptions, sanitizePlugin, SessionTemplate, TEMPLATE_FORMAT, TEMPLATE_VERSION, TemplateLoadReport } from './sessionTemplate';
import { busesOf, findBusByName, outputOf, setTrackOutput } from './trackStructure';

export const PRESET_FORMAT = 'novapreset';
export const CHAIN_FORMAT = 'novachain';
export const PRESET_VERSION = 1;
export const PRESET_EXT = '.novapreset';
export const CHAIN_EXT = '.novachain';

/** Identité d'un VST3 (le preset ne se recharge que sur ce plugin). */
export interface VstIdentity {
  name: string;
  vendor?: string;
  localPath?: string;
  pluginName?: string | null;
}

/** Paramètre relu sur le pont (valeur texte telle que l'affiche le plugin). */
export interface ParamReadback { name: string; text: string }

export interface PluginPreset {
  format: typeof PRESET_FORMAT;
  version: number;
  id: string;
  name: string;
  pluginType: PluginType;
  /** VST3 : quel plugin. */
  vst?: VstIdentity;
  /** Effet NOVA : ses réglages ; VST3 : { stateB64, novaSettings? }. */
  params: Record<string, any>;
  /** VST3 : paramètres relus sur le pont à l'enregistrement. */
  readback?: ParamReadback[];
  description?: string;
  createdAt: number;
  updatedAt: number;
  /** Livré avec NOVA : lecture seule. */
  bundled?: boolean;
}

/** Destination d'un envoi, décrite pour la retrouver dans une autre session. */
export interface ChainSend extends Omit<TrackSend, 'id'> {
  to: { id: string; name: string };
}

export type ChainOutput =
  | { kind: 'master' }
  | { kind: 'track'; id: string; name: string }
  | { kind: 'bus'; id: string; name: string }
  | { kind: 'none' };

/** Retour d'effet visé par un envoi : créé s'il n'existe pas dans la session. */
export interface ChainReturn {
  id: string;
  name: string;
  type: TrackType;
  color?: string;
  volume?: number;
  plugins: PluginInstance[];
}

export interface TrackPreset {
  format: typeof CHAIN_FORMAT;
  version: number;
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  bundled?: boolean;
  /** Type de piste d'origine (création d'une piste depuis le preset). */
  trackType?: TrackType;
  color?: string;
  /** Inserts dans l'ordre (actif / bypass / inactif compris). */
  plugins: PluginInstance[];
  sends: ChainSend[];
  volume: number;
  pan: number;
  output: ChainOutput;
  returns?: ChainReturn[];
  source?: { from?: string };
}

export type AnyPreset = PluginPreset | TrackPreset;

// ─── Outils ────────────────────────────────────────────────────────────────────

const clone = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const fold = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

let seq = 0;
const rnd = () => Math.random().toString(36).slice(2, 6);
export const newPresetId = (kind: 'p' | 'c' = 'p') => `${kind === 'p' ? 'pre' : 'chain'}-${Date.now().toString(36)}-${(seq++).toString(36)}${rnd()}`;
export const newPluginId = () => `pl-${Date.now().toString(36)}-${(seq++).toString(36)}${rnd()}`;

/** Nom de fichier sûr. */
export const presetSlug = (name: string) =>
  (name || 'preset').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'preset';

/** JSON stable (clés triées) : deux réglages identiques donnent la même chaîne. */
export const stableJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
};

/**
 * Clés qui ne sont pas « le son » d'un effet : tempo de la session, analyse en
 * cours, mode basse latence de la prise, marques des modèles, interrupteur
 * interne (le bypass de la barre fait foi), nom du dernier preset chargé.
 */
const NOT_SOUND = new Set([
  'bpm', 'isAnalyzing', 'analysisProgress', 'lowLatency', 'isEnabled', 'presetName',
  'templateMissing', 'templateReplaced', 'templateWasInactive', 'templateSpec', 'novaSlot', 'novaQuiet',
]);
/** Identité d'un VST : reste celle de l'effet chargé. */
const VST_IDENTITY = ['name', 'vendor', 'localPath', 'pluginName'];

const isVstPlugin = (p: Pick<PluginInstance, 'type'>) => p.type === 'VST3';

/** Identité du VST d'un effet. */
export const vstIdentityOf = (p: PluginInstance): VstIdentity => ({
  name: String(p.params?.pluginName || p.params?.name || p.name || 'Plugin VST'),
  ...(p.params?.vendor ? { vendor: String(p.params.vendor) } : {}),
  ...(p.params?.localPath ? { localPath: String(p.params.localPath) } : {}),
  pluginName: p.params?.pluginName ?? null,
});

const pathKey = (path?: string) => fold((path || '').split(/[\\/]/).pop() || '').replace(/\.vst3$/, '');

/** Clé de rangement : quels presets vont avec quel effet. */
export const presetTargetKey = (p: { type?: PluginType; pluginType?: PluginType; vst?: VstIdentity; params?: Record<string, any>; name?: string }): string => {
  const type = (p.pluginType || p.type) as PluginType;
  if (type !== 'VST3') return `nova:${type}`;
  const v = p.vst || (p.params ? vstIdentityOf(p as PluginInstance) : undefined);
  if (!v) return 'vst:?';
  const sub = v.pluginName ? `#${fold(v.pluginName)}` : '';
  return `vst:${pathKey(v.localPath) || fold(v.name)}${sub}`;
};

/** Ce preset se charge-t-il sur cet effet ? */
export const presetMatches = (preset: PluginPreset, plugin: PluginInstance): boolean =>
  presetTargetKey(preset) === presetTargetKey(plugin);

/**
 * Réglages « son » d'un effet, tels qu'un preset les garde et que Comparer les
 * échange : effets NOVA = params nettoyés ; VST = état binaire (+ réglages
 * texte posés par NOVA s'il n'a pas encore d'état).
 */
export const soundSettingsOf = (p: PluginInstance): Record<string, any> => {
  if (isVstPlugin(p)) {
    const out: Record<string, any> = {};
    if (p.params?.stateB64) out.stateB64 = p.params.stateB64;
    else if (p.params?.novaSettings) out.novaSettings = clone(p.params.novaSettings);
    return out;
  }
  const params = sanitizePlugin(p).params;
  for (const k of Object.keys(params)) if (NOT_SOUND.has(k)) delete params[k];
  return params;
};

/** Deux réglages identiques ? */
export const sameSettings = (a: Record<string, any> | null | undefined, b: Record<string, any> | null | undefined): boolean =>
  stableJson(a || {}) === stableJson(b || {});

/**
 * Pose des réglages sur un effet (preset, Comparer). L'effet garde son id, son
 * nom, son état actif / bypass / inactif et, pour un VST, son identité.
 * Renvoie le nouvel effet ET le patch de params à envoyer au moteur.
 */
export const withSoundSettings = (p: PluginInstance, settings: Record<string, any>): { plugin: PluginInstance; patch: Record<string, any> } => {
  if (isVstPlugin(p)) {
    const params: Record<string, any> = { ...(p.params || {}) };
    const patch: Record<string, any> = {};
    if (settings.stateB64) {
      params.stateB64 = settings.stateB64;
      patch.stateB64 = settings.stateB64;
      // L'état complet fait foi : sinon le pont réappliquerait les anciens réglages texte au chargement.
      delete params.novaSettings;
    } else if (settings.novaSettings) {
      params.novaSettings = clone(settings.novaSettings);
      patch.novaSettings = params.novaSettings;
    }
    for (const k of VST_IDENTITY) if (p.params && k in p.params) params[k] = p.params[k];
    return { plugin: { ...p, params }, patch };
  }
  const keep: Record<string, any> = {};
  for (const k of Object.keys(p.params || {})) if (NOT_SOUND.has(k)) keep[k] = p.params[k];
  const params = { ...clone(settings), ...keep };
  return { plugin: { ...p, params }, patch: params };
};

// ─── Presets d'effet ───────────────────────────────────────────────────────────

export interface MakePresetOptions {
  id?: string;
  now?: number;
  description?: string;
  readback?: ParamReadback[];
}

/** Preset à partir de l'effet tel qu'il est réglé (rien n'est modifié dans la session). */
export const makePluginPreset = (plugin: PluginInstance, name: string, opts: MakePresetOptions = {}): PluginPreset => {
  const now = opts.now ?? Date.now();
  const clean = (name || '').trim() || `${plugin.name || plugin.type} · réglage`;
  return {
    format: PRESET_FORMAT, version: PRESET_VERSION,
    id: opts.id || newPresetId('p'),
    name: clean.slice(0, 80),
    pluginType: plugin.type,
    ...(isVstPlugin(plugin) ? { vst: vstIdentityOf(plugin) } : {}),
    params: soundSettingsOf(plugin),
    ...(opts.readback && opts.readback.length ? { readback: opts.readback.map(r => ({ name: r.name, text: r.text })) } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    createdAt: now, updatedAt: now,
  };
};

/** Charge un preset sur un effet (même plugin). */
export const applyPluginPreset = (plugin: PluginInstance, preset: PluginPreset): { plugin: PluginInstance; patch: Record<string, any> } => {
  if (!presetMatches(preset, plugin)) {
    throw new Error(`Ce preset est fait pour ${preset.vst?.name || preset.pluginType}, pas pour ${plugin.params?.name || plugin.name}.`);
  }
  return withSoundSettings(plugin, preset.params);
};

/** L'effet est-il réglé exactement comme ce preset ? */
export const matchesPreset = (plugin: PluginInstance, preset: PluginPreset | null | undefined): boolean =>
  !!preset && sameSettings(soundSettingsOf(plugin), preset.params);

/**
 * Relecture d'un VST après chargement d'un preset : les paramètres relus
 * doivent valoir ceux relus à l'enregistrement. Renvoie les écarts.
 */
export const compareReadback = (want: ParamReadback[] | undefined, got: ParamReadback[]): { checked: number; diffs: { name: string; want: string; got: string }[] } => {
  if (!want || !want.length) return { checked: 0, diffs: [] };
  const map = new Map(got.map(g => [g.name, g.text]));
  const diffs: { name: string; want: string; got: string }[] = [];
  for (const w of want) {
    const g = map.get(w.name);
    if (g === undefined || g.trim() !== w.text.trim()) diffs.push({ name: w.name, want: w.text, got: g ?? '—' });
  }
  return { checked: want.length, diffs };
};

// ─── Comparer (Pro Tools « Compare ») ──────────────────────────────────────────

/**
 * Référence de Comparer : le dernier réglage enregistré ou chargé (à défaut,
 * le réglage à l'ouverture de la fenêtre). `stash` : tes modifications mises
 * de côté pendant que tu écoutes la référence.
 */
export interface CompareState {
  ref: Record<string, any>;
  refLabel: string;
  stash: Record<string, any> | null;
}

export const compareInit = (settings: Record<string, any>, refLabel: string): CompareState => ({ ref: clone(settings), refLabel, stash: null });

/** Le réglage actuel s'écarte-t-il de la référence ? (le bouton Comparer s'allume) */
export const compareModified = (cs: CompareState | null, current: Record<string, any>): boolean =>
  !!cs && (cs.stash !== null || !sameSettings(cs.ref, current));

/** On écoute la référence (tes modifications sont de côté). */
export const comparing = (cs: CompareState | null): boolean => !!cs && cs.stash !== null;

/**
 * Clic sur Comparer : réglage modifié → on écoute la référence ; on écoute la
 * référence → on retrouve les modifications. null : rien à comparer.
 */
export const compareToggle = (cs: CompareState, current: Record<string, any>): { next: CompareState; apply: Record<string, any> } | null => {
  if (cs.stash !== null) return { next: { ...cs, stash: null }, apply: clone(cs.stash) };
  if (sameSettings(cs.ref, current)) return null;
  return { next: { ...cs, stash: clone(current) }, apply: clone(cs.ref) };
};

/** Un réglage touché pendant qu'on écoute la référence : on repart de là (comme Pro Tools). */
export const compareOnEdit = (cs: CompareState): CompareState => (cs.stash === null ? cs : { ...cs, stash: null });

// ─── Track Presets ─────────────────────────────────────────────────────────────

/** Effets d'instrument : propres à la piste, jamais dans une chaîne d'effets. */
const INSTRUMENT_PLUGINS = new Set<PluginType>(['SAMPLER', 'DRUM_SAMPLER', 'MELODIC_SAMPLER', 'DRUM_RACK_UI']);

const chainPlugin = (p: PluginInstance): PluginInstance => {
  const s = sanitizePlugin(p);
  delete s.params.bpm;
  return s;
};

export interface RecallOptions {
  /** Inserts (dans l'ordre, actif / bypass / inactif). */
  inserts?: boolean;
  /** Envois (et retours manquants créés). */
  sends?: boolean;
  /** Volume et pan. */
  volumePan?: boolean;
  /** Sortie. */
  output?: boolean;
}
export const RECALL_ALL: Required<RecallOptions> = { inserts: true, sends: true, volumePan: true, output: true };

/** Track Preset depuis une piste (rien n'est modifié dans la session). */
export const makeTrackPreset = (track: Track, tracks: Track[], name: string, opts: { id?: string; now?: number; description?: string } = {}): TrackPreset => {
  const now = opts.now ?? Date.now();
  const byId = new Map(tracks.map(t => [t.id, t]));
  const sends: ChainSend[] = (track.sends || []).filter(s => byId.has(s.id)).map(s => {
    const { id, ...rest } = s;
    return { ...clone(rest), to: { id, name: byId.get(id)!.name } };
  });
  const returns: ChainReturn[] = sends.map(s => byId.get(s.to.id)!).filter(Boolean).map(r => ({
    id: r.id, name: r.name, type: r.type, color: r.color, volume: r.volume,
    plugins: (r.plugins || []).filter(p => !INSTRUMENT_PLUGINS.has(p.type)).map(chainPlugin),
  }));
  const o = outputOf(track);
  let output: ChainOutput = { kind: 'master' };
  if (o.kind === 'bus') output = { kind: 'bus', id: o.id, name: busesOf(tracks).find(b => b.id === o.id)?.name || o.id };
  else if (o.kind === 'track') output = { kind: 'track', id: o.id, name: byId.get(o.id)?.name || o.id };
  return {
    format: CHAIN_FORMAT, version: PRESET_VERSION,
    id: opts.id || newPresetId('c'),
    name: ((name || '').trim() || `${track.name} · chaîne`).slice(0, 80),
    ...(opts.description ? { description: opts.description } : {}),
    createdAt: now, updatedAt: now,
    trackType: track.type, color: track.color,
    plugins: (track.plugins || []).filter(p => !INSTRUMENT_PLUGINS.has(p.type)).map(chainPlugin),
    sends, volume: track.volume, pan: track.pan, output,
    ...(returns.length ? { returns } : {}),
    source: { from: track.name },
  };
};

export interface TrackPresetReport {
  /** Retours créés (absents de la session). */
  created: string[];
  /** Envois sans destination (ni dans la session, ni décrits dans le preset). */
  missingSends: string[];
  /** Sortie introuvable : repliée sur le master. */
  outputFallback?: string;
  messages: string[];
}

const isReturn = (t: Track) => t.type === TrackType.SEND || t.type === TrackType.BUS;

/**
 * Retour d'effet existant pour un envoi : même id, puis même nom. Sans
 * description du retour dans le preset (fichier ancien ou écrit à la main) :
 * le premier retour qui porte le même effet principal (reverb / délai).
 */
const findReturn = (tracks: Track[], to: ChainSend['to'], def: ChainReturn | undefined, selfId: string): Track | undefined => {
  const pool = tracks.filter(t => t.id !== selfId && t.id !== 'master' && isReturn(t));
  const byId = pool.find(t => t.id === to.id);
  if (byId) return byId;
  const byName = pool.find(t => fold(t.name) === fold(to.name));
  if (byName || def) return byName;
  const role = /verb|rév|rev/i.test(to.name) ? 'REVERB' : /delay|écho|echo|délai/i.test(to.name) ? 'DELAY' : null;
  return role ? pool.find(t => t.type === TrackType.SEND && (t.plugins || []).some(p => p.type === role && !p.isInactive)) : undefined;
};

const uniqueTrackId = (tracks: Track[], want: string) => {
  if (!tracks.some(t => t.id === want)) return want;
  let k = 2;
  while (tracks.some(t => t.id === `${want}-${k}`)) k++;
  return `${want}-${k}`;
};

/** Nouvelle piste retour à partir de sa description. */
const returnTrack = (def: ChainReturn, tracks: Track[]): Track => ({
  id: uniqueTrackId(tracks, def.id || `send-${presetSlug(def.name)}`),
  name: def.name, type: def.type === TrackType.BUS ? TrackType.BUS : TrackType.SEND,
  color: def.color || '#10b981', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: typeof def.volume === 'number' ? def.volume : 0.8, pan: 0, outputTrackId: 'master',
  sends: [], clips: [], plugins: def.plugins.map(p => ({ ...clone(p), id: newPluginId(), latency: 0 })),
  automationLanes: [{ id: `auto-${Date.now().toString(36)}${rnd()}`, parameterName: 'volume', points: [], color: def.color || '#10b981', isExpanded: false, min: 0, max: 1.5 }],
  totalLatency: 0,
});

export interface ApplyTrackPresetOptions extends RecallOptions {
  /** Inserts déjà résolus (VST du PC retrouvés / remplacés : resolvePresetPlugins). */
  plugins?: PluginInstance[];
}

/**
 * Rappelle un Track Preset sur une piste : UNE transformation des pistes (une
 * étape d'annulation, un seul envoi en collaboration). Les inserts reçoivent de
 * nouveaux identifiants (l'ancienne chaîne est remplacée, comme dans Pro Tools).
 */
export const applyTrackPreset = (tracks: Track[], trackId: string, preset: TrackPreset, opts: ApplyTrackPresetOptions = {}): { tracks: Track[]; report: TrackPresetReport } => {
  const o = { ...RECALL_ALL, ...opts };
  const report: TrackPresetReport = { created: [], missingSends: [], messages: [] };
  let out = [...tracks];
  const target = out.find(t => t.id === trackId);
  if (!target) throw new Error('Piste introuvable.');
  let next: Track = { ...target };

  if (o.inserts) {
    const src = opts.plugins || preset.plugins;
    next.plugins = src.map(p => ({ ...clone(p), id: newPluginId(), latency: 0 }));
  }
  if (o.volumePan) { next.volume = preset.volume; next.pan = preset.pan; }
  if (o.sends) {
    const sends: TrackSend[] = [];
    for (const s of preset.sends) {
      const def = preset.returns?.find(r => r.id === s.to.id || fold(r.name) === fold(s.to.name));
      let ret = findReturn(out, s.to, def, trackId);
      if (!ret && def) {
        ret = returnTrack(def, out);
        // Le retour se range juste avant le master (comme les retours de la session).
        const mi = out.findIndex(t => t.id === 'master');
        out = mi >= 0 ? [...out.slice(0, mi), ret, ...out.slice(mi)] : [...out, ret];
        report.created.push(ret.name);
      }
      if (!ret) { report.missingSends.push(s.to.name); continue; }
      const { to, ...rest } = s;
      void to;
      if (sends.some(x => x.id === ret!.id)) continue;
      sends.push({ ...clone(rest), id: ret.id });
    }
    next.sends = sends;
  }
  out = out.map(t => (t.id === trackId ? next : t));
  if (o.output) {
    const want = preset.output;
    if (want.kind === 'master') out = setTrackOutput(out, trackId, { kind: 'master' });
    else if (want.kind === 'none') out = setTrackOutput(out, trackId, { kind: 'none' });
    else {
      const bus = want.kind === 'bus' ? (busesOf(out).find(b => b.id === want.id) || findBusByName(out, want.name)) : undefined;
      const tr = !bus ? (out.find(t => t.id === want.id && t.id !== trackId && isReturn(t)) || out.find(t => t.id !== trackId && isReturn(t) && fold(t.name) === fold(want.name))) : undefined;
      if (bus) out = setTrackOutput(out, trackId, { kind: 'bus', id: bus.id });
      else if (tr) out = setTrackOutput(out, trackId, { kind: 'track', id: tr.id });
      else { out = setTrackOutput(out, trackId, { kind: 'master' }); report.outputFallback = want.name; }
    }
  }
  if (report.created.length) report.messages.push(`Retour${report.created.length > 1 ? 's' : ''} créé${report.created.length > 1 ? 's' : ''} : ${report.created.join(', ')}.`);
  if (report.missingSends.length) report.messages.push(`Envoi${report.missingSends.length > 1 ? 's' : ''} ignoré${report.missingSends.length > 1 ? 's' : ''} (destination absente) : ${report.missingSends.join(', ')}.`);
  if (report.outputFallback) report.messages.push(`Sortie « ${report.outputFallback} » absente de la session : la piste sort sur le master.`);
  return { tracks: out, report };
};

/** Nouvelle piste (vide) prête à recevoir un Track Preset. */
export const blankTrackFor = (preset: TrackPreset, o: { id: string; name?: string; color?: string; type?: TrackType }): Track => ({
  id: o.id, name: (o.name || preset.name).slice(0, 60), type: o.type || preset.trackType || TrackType.AUDIO,
  color: o.color || preset.color || '#3b82f6', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [],
  automationLanes: [{ id: `auto-${Date.now().toString(36)}${rnd()}`, parameterName: 'volume', points: [], color: o.color || preset.color || '#3b82f6', isExpanded: false, min: 0, max: 1.5 }],
  totalLatency: 0,
});

/** Crée une piste depuis un Track Preset (insérée après `afterId`, sinon avant les retours). */
export const createTrackFromPreset = (tracks: Track[], preset: TrackPreset, o: { id: string; name?: string; color?: string; afterId?: string | null } & ApplyTrackPresetOptions): { tracks: Track[]; trackId: string; report: TrackPresetReport } => {
  const t = blankTrackFor(preset, o);
  let at = o.afterId ? tracks.findIndex(x => x.id === o.afterId) + 1 : -1;
  if (at <= 0) { const firstReturn = tracks.findIndex(x => isReturn(x)); at = firstReturn >= 0 ? firstReturn : tracks.length; }
  const withTrack = [...tracks.slice(0, at), t, ...tracks.slice(at)];
  const r = applyTrackPreset(withTrack, t.id, preset, o);
  return { tracks: r.tracks, trackId: t.id, report: r.report };
};

/** Résumé lisible (« 5 effets · 2 envois · sortie BUS VOX »). */
export const trackPresetSummary = (p: TrackPreset): string => {
  const n = p.plugins.length;
  const vst = p.plugins.filter(x => x.type === 'VST3').length;
  const parts = [`${n} effet${n > 1 ? 's' : ''}${vst ? ` (dont ${vst} VST)` : ''}`];
  if (p.sends.length) parts.push(`${p.sends.length} envoi${p.sends.length > 1 ? 's' : ''} (${p.sends.map(s => s.to.name).join(', ')})`);
  parts.push(p.output.kind === 'master' ? 'sortie master' : p.output.kind === 'none' ? 'sans sortie' : `sortie ${p.output.name}`);
  return parts.join(' · ');
};

/**
 * VST du preset absents de ce PC : retrouvés sous un autre chemin, remplacés
 * par l'effet NOVA proche, ou laissés inactifs (même règle que les modèles de
 * session). candidates = liste du pont ; null = pont absent (chargés plus tard).
 */
export const resolvePresetPlugins = (preset: TrackPreset, candidates: InstantiateOptions['plugins'], makeBuiltin?: InstantiateOptions['makeBuiltin']): { plugins: PluginInstance[]; report: TemplateLoadReport } => {
  if (!preset.plugins.some(p => p.type === 'VST3')) {
    return { plugins: clone(preset.plugins), report: { replaced: [], disabled: [], relinked: [], waitingBridge: 0, enabled: 0, messages: [] } };
  }
  const tpl: SessionTemplate = {
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, id: 'chain', name: preset.name, createdAt: 0, updatedAt: 0,
    session: {
      trackGroups: [],
      tracks: [{ id: 'chain', name: preset.name, type: preset.trackType || TrackType.AUDIO, color: '#000', isMuted: false, isSolo: false, volume: 1, pan: 0, outputTrackId: 'master', sends: [], plugins: clone(preset.plugins) }],
    },
  };
  const { state, report } = instantiateTemplate(tpl, { plugins: candidates, missingVst: 'replace', makeBuiltin });
  return { plugins: state.tracks.find(t => t.id === 'chain')!.plugins, report };
};

// ─── Fichiers ──────────────────────────────────────────────────────────────────

export const serializePreset = (p: AnyPreset): string => {
  const { bundled, ...rest } = p as AnyPreset & { bundled?: boolean };
  void bundled;
  return JSON.stringify(rest, null, 2);
};

export const presetFilename = (p: AnyPreset) => `${presetSlug(p.name)}${p.format === CHAIN_FORMAT ? CHAIN_EXT : PRESET_EXT}`;

/** Lit un fichier .novapreset ou .novachain ; message clair sinon. */
export const parsePresetFile = (text: string): AnyPreset => {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error("Ce fichier n'est pas un preset NOVA lisible (JSON abîmé)."); }
  if (!raw || (raw.format !== PRESET_FORMAT && raw.format !== CHAIN_FORMAT)) throw new Error("Ce fichier n'est pas un preset NOVA (.novapreset ou .novachain).");
  if (typeof raw.version !== 'number' || raw.version > PRESET_VERSION) throw new Error('Ce preset vient d’une version plus récente de NOVA : mets NOVA à jour pour l’ouvrir.');
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newPresetId(raw.format === CHAIN_FORMAT ? 'c' : 'p'),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Preset importé',
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  if (raw.format === PRESET_FORMAT) {
    if (typeof raw.pluginType !== 'string' || !raw.params || typeof raw.params !== 'object') throw new Error('Ce preset est incomplet (effet ou réglages manquants).');
    const p = { ...raw, ...base } as PluginPreset;
    delete (p as any).bundled;
    return p;
  }
  if (!Array.isArray(raw.plugins) || !Array.isArray(raw.sends)) throw new Error('Ce Track Preset est incomplet (effets ou envois manquants).');
  for (const p of raw.plugins) if (!p || typeof p.type !== 'string' || typeof p.params !== 'object') throw new Error('Un effet du Track Preset est incomplet.');
  const c = {
    ...raw, ...base,
    volume: typeof raw.volume === 'number' ? raw.volume : 1,
    pan: typeof raw.pan === 'number' ? raw.pan : 0,
    output: raw.output && typeof raw.output.kind === 'string' ? raw.output : { kind: 'master' },
  } as TrackPreset;
  delete (c as any).bundled;
  return c;
};
