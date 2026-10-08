/**
 * Modèles de session (« Session Templates » de Pro Tools, « Templates » de Logic).
 *
 * Un modèle garde la STRUCTURE d'une session, sans l'audio :
 *  - pistes (nom, couleur, type, ordre), volume, pan, mute / solo, groupes ;
 *  - bus et envois (niveau, actif, pré / post-fader), sorties (routage) ;
 *  - chaînes d'effets avec leurs réglages : effets NOVA (params) et VST3 du PC
 *    (chemin, nom, éditeur, état binaire `stateB64` et / ou réglages en valeurs
 *    texte `novaSettings` relus par le pont), effets actifs, en bypass ou
 *    inactifs (PluginInstance.isInactive) ;
 *  - structure Pro Tools (utils/trackStructure) : pistes masquées / inactives,
 *    dossiers (routage / simples), VCA, 10 envois a-j avec pan et mute, bus
 *    nommés (rangés sur la piste master : ioBuses), entrées / sorties de bus ;
 *  - master et sa chaîne ; tempo, mesure et tonalité si on le veut ;
 *  - instruments (synthé NOVA, 808, VST3) sans leur rendu audio.
 * « Garder les clips » (désactivé par défaut) garde aussi les clips MIDI, les
 * repères et les clips audio dont le son est en ligne (URL).
 *
 * Fichier d'échange : `.novatemplate` (JSON, voir serializeTemplate / parseTemplate).
 * Aucune dépendance au moteur audio ni à React : utilisable dans les tests et
 * dans les scripts Node (scripts/template_from_spec.ts).
 */
import {
  AutomationLane, Clip, DAWState, Marker, PluginInstance, PluginType, ProjectPhase, TimeSignature, Track, TrackGroup, TrackType,
} from '../types';
import { TEMPLATE_ACCESS_GROUPS, privateLabel } from '../config/templateAccess';
import { BUILTIN_LABEL_FR, builtinFor, resolveVst, VstCandidate } from './vstMatch';

export const TEMPLATE_FORMAT = 'novatemplate';
export const TEMPLATE_VERSION = 1;
export const TEMPLATE_EXT = '.novatemplate';

/** Piste telle qu'enregistrée dans un modèle (sans rendu, sans prise, sans collaboration). */
export type TemplateTrack = Omit<Track, 'clips' | 'automationLanes' | 'totalLatency' | 'isTrackArmed' | 'isFrozen'> & {
  clips?: Clip[];
  automationLanes?: AutomationLane[];
};

export interface SessionTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  /** Groupe d'accès (config/templateAccess.ts) : absent = modèle visible par tous. */
  privateTo?: string;
  /** Livré avec l'appli (dossier templates/) : lecture seule. */
  bundled?: boolean;
  /** Origine : session NOVA, fiche (Pro Tools relevé par Claude), import. */
  source?: { kind: 'session' | 'spec' | 'import'; from?: string };
  /** Le modèle garde aussi les clips (MIDI, audio en ligne) et les repères. */
  keepClips?: boolean;
  session: {
    bpm?: number;
    timeSignature?: TimeSignature;
    projectKey?: number;
    projectScale?: string;
    projectMode?: DAWState['projectMode'];
    vocalMixStyle?: string;
    isDelayCompEnabled?: boolean;
    tracks: TemplateTrack[];
    trackGroups: TrackGroup[];
    markers?: Marker[];
  };
}

export interface TemplateInfo {
  tracks: number;
  buses: number;
  sends: number;
  plugins: number;
  vst: number;
  /** Effets inactifs ou en bypass. */
  inactive: number;
  /** Pistes masquées / inactives, dossiers, VCA, bus nommés. */
  hiddenTracks?: number;
  inactiveTracks?: number;
  folders?: number;
  vcas?: number;
  namedBuses?: number;
}

// ─── Outils ────────────────────────────────────────────────────────────────────

const clone = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

let seq = 0;
export const newTemplateId = () => `tpl-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Nom de fichier sûr (« Voix lead · Romain » → « voix-lead-romain »). */
export const templateSlug = (name: string) =>
  (name || 'modele').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'modele';

const isOnlineUrl = (s?: string) => !!s && /^https?:\/\//i.test(s);

/** Effet propre, sérialisable (aucun nœud, aucune URL locale éphémère). */
export const sanitizePlugin = (p: PluginInstance): PluginInstance => {
  const params = clone(p.params || {}) as Record<string, any>;
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (typeof v === 'string' && /^blob:/i.test(v)) delete params[k];
    if (typeof v === 'function' || (v && typeof v === 'object' && (v instanceof Object) && 'getChannelData' in v)) delete params[k];
  }
  // Analyse en cours (MasterSync) : sans objet dans un modèle.
  delete params.isAnalyzing;
  delete params.analysisProgress;
  // Inactif (Pro Tools « Make Inactive ») : gardé tel quel, avec ses réglages.
  return {
    id: p.id, name: p.name, type: p.type, isEnabled: !!p.isEnabled, params, latency: 0, ...(p.isInactive ? { isInactive: true } : {}),
    // Side-chain (R7) : la clé voyage avec l'effet (id + nom pour la retrouver dans une autre session).
    ...(p.sidechainSourceId ? { sidechainSourceId: p.sidechainSourceId, ...(p.sidechainSourceName ? { sidechainSourceName: p.sidechainSourceName } : {}) } : {}),
    ...(p.sidechainTap ? { sidechainTap: p.sidechainTap } : {}),
  };
};

const sanitizeClip = (c: Clip): Clip | null => {
  if (c.isFreezeSlice) return null;
  const { buffer, freezeRef, ...rest } = c as Clip & { buffer?: unknown };
  void buffer; void freezeRef;
  const out = clone(rest) as Clip;
  if (out.type === TrackType.MIDI || (out.notes && out.notes.length)) return out;
  // Clip audio : gardé seulement si son son est en ligne (le modèle n'a pas d'audio).
  if (!isOnlineUrl(out.audioRef)) return null;
  delete out.bufferId;
  return out;
};

const TRANSIENT_TRACK_KEYS: (keyof Track)[] = [
  'frozenClip', 'frozenUpToPluginIndex', 'frozenClipIds', 'frozenSourceSig', 'frozenPluginSig', 'frozenAuto',
  'freezeBase', 'preFxJournal', 'sendFreezes', 'collabOwner', 'collabOwnerKey', 'collabOwnerName', 'collabOwnerColor',
  'remote', 'livePreview', 'volumeLock', 'events', 'inputDeviceId', 'totalLatency', 'isTrackArmed', 'isFrozen',
];

export interface CreateTemplateOptions {
  name: string;
  description?: string;
  /** Garder les clips MIDI / audio en ligne et les repères (désactivé par défaut). */
  keepClips?: boolean;
  /** Garder le tempo, la mesure et la tonalité de la session (activé par défaut). */
  keepTempoKey?: boolean;
  privateTo?: string;
  id?: string;
  now?: number;
  source?: SessionTemplate['source'];
}

/** Modèle à partir de la session en cours (rien n'est modifié dans la session). */
export const createTemplateFromState = (state: DAWState, opts: CreateTemplateOptions): SessionTemplate => {
  const now = opts.now ?? Date.now();
  const keepClips = !!opts.keepClips;
  const keepTempo = opts.keepTempoKey !== false;
  const tracks: TemplateTrack[] = (state.tracks || []).map(t => {
    const src = clone({ ...t, clips: [], plugins: [], automationLanes: [], frozenClip: undefined, freezeBase: undefined, sendFreezes: undefined }) as any;
    for (const k of TRANSIENT_TRACK_KEYS) delete src[k];
    const out: TemplateTrack = {
      ...src,
      sends: (t.sends || []).map(s => ({ ...s })),
      plugins: (t.plugins || []).map(sanitizePlugin),
    };
    if (keepClips) {
      out.clips = (t.clips || []).map(sanitizeClip).filter((c): c is Clip => !!c);
      out.automationLanes = clone(t.automationLanes || []);
      if (t.takeMeta) out.takeMeta = clone(t.takeMeta);
    } else {
      delete out.clips;
      delete out.automationLanes;
      delete out.takeMeta;
    }
    if (out.vstInstrument) { out.vstInstrument = { ...out.vstInstrument }; delete out.vstInstrument.renderSig; }
    if (out.drumPads) out.drumPads = out.drumPads.map(p => { const { buffer, ...rest } = p as any; void buffer; return { ...rest, audioRef: isOnlineUrl(rest.audioRef) ? rest.audioRef : undefined }; });
    return out;
  });
  const session: SessionTemplate['session'] = {
    tracks,
    trackGroups: clone(state.trackGroups || []),
    isDelayCompEnabled: state.isDelayCompEnabled,
    ...(state.projectMode ? { projectMode: state.projectMode } : {}),
    ...(state.vocalMixStyle ? { vocalMixStyle: state.vocalMixStyle } : {}),
  };
  if (keepTempo) {
    session.bpm = state.bpm;
    session.timeSignature = clone(state.timeSignature);
    if (state.projectKey !== undefined) session.projectKey = state.projectKey;
    if (state.projectScale !== undefined) session.projectScale = state.projectScale;
  }
  if (keepClips) session.markers = clone(state.markers || []);
  return {
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION,
    id: opts.id || newTemplateId(), name: (opts.name || 'Mon modèle').trim(),
    ...(opts.description ? { description: opts.description } : {}),
    createdAt: now, updatedAt: now,
    ...(opts.privateTo ? { privateTo: opts.privateTo } : {}),
    source: opts.source || { kind: 'session', from: state.name },
    keepClips,
    session,
  };
};

// ─── Fichier .novatemplate ─────────────────────────────────────────────────────

export const serializeTemplate = (tpl: SessionTemplate): string => {
  const { bundled, ...rest } = tpl;
  void bundled;
  return JSON.stringify(rest, null, 2);
};

/** Lit un fichier .novatemplate ; message clair si ce n'en est pas un. */
export const parseTemplate = (text: string): SessionTemplate => {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error("Ce fichier n'est pas un modèle NOVA lisible (JSON abîmé)."); }
  if (!raw || raw.format !== TEMPLATE_FORMAT) throw new Error("Ce fichier n'est pas un modèle NOVA (.novatemplate).");
  if (typeof raw.version !== 'number' || raw.version > TEMPLATE_VERSION) throw new Error('Ce modèle vient d’une version plus récente de NOVA : mets NOVA à jour pour l’ouvrir.');
  if (!raw.session || !Array.isArray(raw.session.tracks)) throw new Error('Ce modèle ne contient aucune piste.');
  for (const t of raw.session.tracks) {
    if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || !Array.isArray(t.plugins) || !Array.isArray(t.sends)) {
      throw new Error('Une piste du modèle est incomplète (id, nom, effets ou envois manquants).');
    }
  }
  const tpl: SessionTemplate = {
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : newTemplateId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Modèle importé',
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    session: { ...raw.session, trackGroups: Array.isArray(raw.session.trackGroups) ? raw.session.trackGroups : [] },
  };
  delete (tpl as any).bundled;
  return tpl;
};

// ─── Accès (modèles « privé : romain ») ────────────────────────────────────────

const normEmail = (e?: string | null) => (e || '').trim().toLowerCase();

/** Le compte (e-mail, null = invité) peut-il voir et charger ce modèle ? */
export const canAccessTemplate = (tpl: Pick<SessionTemplate, 'privateTo'>, email: string | null | undefined): boolean => {
  if (!tpl.privateTo) return true;
  const group = TEMPLATE_ACCESS_GROUPS[tpl.privateTo];
  const e = normEmail(email);
  if (!group || !e) return false;
  return group.some(x => normEmail(x) === e);
};

export const visibleTemplates = <T extends Pick<SessionTemplate, 'privateTo'>>(list: T[], email: string | null | undefined): T[] =>
  list.filter(t => canAccessTemplate(t, email));

/** Groupes privés auxquels ce compte appartient (pour « Garder ce modèle privé »). */
export const accessGroupsOf = (email: string | null | undefined): string[] => {
  const e = normEmail(email);
  if (!e) return [];
  return Object.entries(TEMPLATE_ACCESS_GROUPS).filter(([, list]) => list.some(x => normEmail(x) === e)).map(([g]) => g);
};

export const templateBadge = (tpl: Pick<SessionTemplate, 'privateTo'>) => (tpl.privateTo ? privateLabel(tpl.privateTo) : null);

// ─── Résumé ────────────────────────────────────────────────────────────────────

export const templateInfo = (tpl: SessionTemplate): TemplateInfo => {
  const ts = tpl.session.tracks;
  const plugins = ts.flatMap(t => t.plugins || []);
  return {
    tracks: ts.filter(t => t.type !== TrackType.BUS && t.type !== TrackType.SEND).length,
    buses: ts.filter(t => t.type === TrackType.BUS && t.id !== 'master' && !t.folder && !t.isVca).length,
    sends: ts.filter(t => t.type === TrackType.SEND).length,
    plugins: plugins.length,
    vst: plugins.filter(p => p.type === 'VST3').length,
    inactive: plugins.filter(p => !p.isEnabled || p.isInactive).length,
    hiddenTracks: ts.filter(t => t.isHidden).length,
    inactiveTracks: ts.filter(t => t.isInactive).length,
    folders: ts.filter(t => t.folder).length,
    vcas: ts.filter(t => t.isVca).length,
    namedBuses: ts.find(t => t.id === 'master')?.ioBuses?.length || 0,
  };
};

// ─── Effets de NOVA par défaut (repli d'un VST absent, fiches) ──────────────────

/** Réglages de départ des effets de NOVA (mêmes valeurs que le studio). */
export const defaultBuiltinParams = (type: PluginType, bpm = 120): Record<string, any> => {
  switch (type) {
    case 'DELAY': return { division: '1/4', feedback: 0.4, feedbackLP: 5000, feedbackHP: 150, mix: 1, pingPong: false, bpm, isEnabled: true };
    case 'REVERB': return { decay: 2.5, preDelay: 0.02, damping: 0.4, mix: 1, size: 0.7, mode: 'HALL', isEnabled: true };
    case 'COMPRESSOR': return { threshold: -18, ratio: 2, knee: 6, attack: 0.005, release: 0.1, makeupGain: 1.4, isEnabled: true };
    case 'AUTOTUNE': return { speed: 0.1, humanize: 0.2, mix: 1.0, rootKey: 0, scale: 'CHROMATIC', isEnabled: true };
    case 'CHORUS': return { rate: 1.2, depth: 0.35, spread: 0.5, mix: 0.4, isEnabled: true };
    case 'STEREOSPREADER': return { width: 1.0, haasDelay: 0.015, lowBypass: 0.8, isEnabled: true };
    case 'DEESSER': return { threshold: -30, frequency: 8000, q: 1.0, reduction: 0.6, mode: 'BELL', isEnabled: true, detection: 'RELATIVE', relThreshold: -6, listen: 0 };
    case 'DENOISER': return { threshold: -45, range: -20, attack: 0.005, hold: 0.05, release: 0.15, scFreq: 1000, flip: false, isEnabled: true };
    case 'VOCALSATURATOR': return { drive: 20, mix: 0.5, tone: 0, eqLow: 0, eqMid: 0, eqHigh: 0, mode: 'TAPE', isEnabled: true, outputGain: 1 };
    case 'LIMITER': return { ceiling: -1, inputGain: 0, release: 100, lookahead: 3, oversample: 4, isEnabled: true };
    case 'PROEQ12': {
      const f = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
      return { isEnabled: true, masterGain: 1, bands: f.map((frequency, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking', frequency, gain: 0, q: 1, isEnabled: true, isSolo: false })) };
    }
    default: return { isEnabled: true };
  }
};

const firstNum = (s: string | number | undefined): number | null => {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const m = String(s ?? '').replace(',', '.').match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/**
 * Réglages approchés d'un effet de NOVA d'après les réglages d'un VST (valeurs
 * texte : « 2.00:1 », « -18.0 dB », « 20 ms », « 35 % »). Best effort : ce qui
 * n'est pas reconnu garde la valeur par défaut.
 */
export const approxBuiltinParams = (type: PluginType, settings: { name: string; text?: string; real?: number }[] = []): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const s of settings) {
    const k = s.name.toLowerCase();
    const raw = s.text ?? s.real;
    const v = firstNum(raw);
    if (v === null) continue;
    const ms = /ms\b/i.test(String(raw ?? '')) || /_ms$|\bms$/.test(k);
    const pct = /%/.test(String(raw ?? ''));
    if (type === 'COMPRESSOR') {
      if (/ratio/.test(k)) out.ratio = v;
      else if (/thresh/.test(k)) out.threshold = v;
      else if (/attack/.test(k)) out.attack = ms ? v / 1000 : v;
      else if (/release/.test(k)) out.release = ms ? v / 1000 : v;
      else if (/knee/.test(k)) out.knee = v;
    } else if (type === 'REVERB') {
      if (/decay|time/.test(k)) out.decay = ms ? v / 1000 : v;
      else if (/pre.?delay/.test(k)) out.preDelay = ms || v > 1 ? v / 1000 : v;
      else if (/size/.test(k)) out.size = pct || v > 1 ? v / 100 : v;
    } else if (type === 'DELAY') {
      if (/feedback/.test(k)) out.feedback = pct || v > 1.5 ? v / 100 : v;
      else if (/note|division|time|sync/.test(k) && /\d+\/\d+/.test(String(raw))) out.division = String(raw).match(/\d+\/\d+/)![0];
    } else if (type === 'DEESSER') {
      if (/freq/.test(k)) out.frequency = /khz/i.test(String(raw)) ? v * 1000 : v;
      else if (/thresh/.test(k)) out.threshold = v;
    } else if (type === 'LIMITER') {
      if (/ceiling|output/.test(k)) out.ceiling = v;
    }
    if (/^(mix|dry.?wet|wet)$/.test(k.replace(/[_\s]/g, '')) && type !== 'COMPRESSOR') out.mix = pct || v > 1 ? v / 100 : v;
  }
  return out;
};

export const builtinPlugin = (type: PluginType, overrides: Record<string, any> = {}, id?: string, bpm = 120): PluginInstance => ({
  id: id || `pl-tpl-${Date.now().toString(36)}-${(seq++).toString(36)}`,
  name: overrides.name || type,
  type,
  isEnabled: overrides.isEnabled !== false,
  params: { ...defaultBuiltinParams(type, bpm), ...overrides },
  latency: 0,
});

// ─── Nouveau projet depuis un modèle ───────────────────────────────────────────

export type MissingVstMode = 'replace' | 'disable';

export interface InstantiateOptions {
  /** Nom du nouveau projet (sinon le nom du modèle). */
  name?: string;
  /** Plugins VST3 du PC (liste du pont). null : pont absent (on ne peut pas savoir). */
  plugins?: VstCandidate[] | null;
  /** VST absent du PC : remplacé par l'effet de NOVA équivalent, ou laissé inactif. */
  missingVst?: MissingVstMode;
  /** Activer tous les effets (effets désactivés dans la session d'origine compris). */
  enableAll?: boolean;
  /** Fabrique d'effets de NOVA du studio (App) ; sinon les réglages par défaut d'ici. */
  makeBuiltin?: (type: PluginType, overrides: Record<string, any>) => PluginInstance;
  projectId?: string;
}

export interface TemplateLoadReport {
  /** Plugin absent remplacé par un effet de NOVA. */
  replaced: { track: string; plugin: string; by: string }[];
  /** Plugin absent laissé inactif (ou sans équivalent NOVA). */
  disabled: { track: string; plugin: string; reason: string }[];
  /** Plugin retrouvé sous un autre chemin / une autre variante. */
  relinked: { track: string; plugin: string; to: string; note?: string }[];
  /** Effets VST en attente du pont (pont absent : ils se chargeront quand il sera là). */
  waitingBridge: number;
  /** Effets activés par « Activer tous les effets ». */
  enabled: number;
  /** Lignes prêtes à afficher. */
  messages: string[];
}

const defaultVolumeLane = (color: string): AutomationLane => ({
  id: `auto-${Date.now().toString(36)}-${(seq++).toString(36)}`, parameterName: 'volume', points: [], color, isExpanded: false, min: 0, max: 1.5,
});

const masterTrack = (): TemplateTrack => ({
  id: 'master', name: 'MASTER BUS', type: TrackType.BUS, color: '#00f2ff', isMuted: false, isSolo: false,
  volume: 1, pan: 0, outputTrackId: '', sends: [], plugins: [],
});

const vstLabel = (p: PluginInstance) => String(p.params?.pluginName || p.params?.name || p.name || 'Plugin VST');

/** Crée la session complète d'un modèle, avec le rapport des plugins absents / remplacés. */
export const instantiateTemplate = (tpl: SessionTemplate, opts: InstantiateOptions = {}): { state: DAWState; report: TemplateLoadReport } => {
  const report: TemplateLoadReport = { replaced: [], disabled: [], relinked: [], waitingBridge: 0, enabled: 0, messages: [] };
  const s = clone(tpl.session);
  const bpm = s.bpm || 120;
  const make = opts.makeBuiltin || ((type: PluginType, o: Record<string, any>) => builtinPlugin(type, o, undefined, bpm));
  const mode: MissingVstMode = opts.missingVst || 'replace';
  const list = opts.plugins;
  const srcTracks = s.tracks.some(t => t.id === 'master') ? s.tracks : [...s.tracks, masterTrack()];

  const tracks: Track[] = srcTracks.map(t => {
    const plugins: PluginInstance[] = [];
    for (const p0 of t.plugins || []) {
      let p: PluginInstance = { ...p0, params: { ...(p0.params || {}) } };
      // Plugin absent remplacé dès la fabrication du modèle (templateSpec : True Iron → saturation NOVA…).
      const repl = p.params.templateReplacement as { from: string; to: string; inactive?: boolean; note?: string } | undefined;
      if (repl?.from && repl.to) {
        report.replaced.push({ track: t.name, plugin: repl.from, by: repl.to });
        // Court : la raison détaillée reste dans l'effet (params.templateReplacement.note) et le rapport du modèle.
        report.messages.push(`${repl.from} manquant sur ${t.name} : remplacé par ${repl.to}${repl.inactive ? ' (laissé inactif)' : ''}.`);
      }
      // « Activer tous les effets » : inactifs (info gardée : templateWasInactive) et en bypass.
      // Un remplaçant « laissé inactif » (équivalence lointaine) n'est jamais activé d'office.
      if (opts.enableAll && !repl?.inactive && (!p.isEnabled || p.isInactive)) {
        if (p.isInactive) { delete p.isInactive; p.params.templateWasInactive = true; }
        p.isEnabled = true;
        report.enabled++;
      }
      if (p.type === 'VST3') {
        const label = vstLabel(p);
        if (list === null || list === undefined) {
          report.waitingBridge++;
        } else {
          const path = String(p.params.localPath || '');
          const wantSub = p.params.pluginName || null;
          const direct = path && list.find(c => c.path.toLowerCase() === path.toLowerCase() && (!wantSub || !c.pluginName || c.pluginName === wantSub));
          const m = direct ? null : resolveVst(label, p.params.vendor, list);
          if (!direct && m) {
            p.params = { ...p.params, localPath: m.plugin.path, pluginName: m.plugin.pluginName || null, name: p.params.name || m.plugin.name };
            // Autre version du plugin : l'état enregistré ne lui correspond pas.
            if (m.kind === 'other-version') delete p.params.stateB64;
            delete p.params.templateMissing;
            report.relinked.push({ track: t.name, plugin: label, to: m.plugin.pluginName || m.plugin.name, note: m.note });
          } else if (!direct) {
            const type = builtinFor(label, p.params.vendor || '');
            if (mode === 'replace' && type) {
              const by = BUILTIN_LABEL_FR[type] || type;
              const repl = make(type, { ...approxBuiltinParams(type, p.params.novaSettings || []), name: `${type} (remplace ${label})` });
              repl.isEnabled = p.isEnabled;
              if (p.isInactive) repl.isInactive = true;
              repl.params = { ...repl.params, isEnabled: p.isEnabled, templateReplaced: { name: label, vendor: p.params.vendor || '', localPath: path, pluginName: wantSub } };
              p = repl;
              report.replaced.push({ track: t.name, plugin: label, by });
              report.messages.push(`${label} manquant sur ${t.name} : remplacé par ${by}.`);
            } else {
              p.isEnabled = false;
              p.params = { ...p.params, templateMissing: true };
              const reason = mode === 'replace' ? 'aucun effet NOVA équivalent' : 'laissé inactif (choix)';
              report.disabled.push({ track: t.name, plugin: label, reason });
              report.messages.push(`${label} manquant sur ${t.name} : laissé inactif${mode === 'replace' ? ' (aucun effet NOVA équivalent)' : ''}.`);
            }
          }
        }
      }
      plugins.push(p);
    }
    const lanes = t.automationLanes && t.automationLanes.length ? t.automationLanes : [defaultVolumeLane(t.color || '#94a3b8')];
    return {
      ...(t as any),
      isTrackArmed: false,
      isFrozen: false,
      totalLatency: 0,
      clips: t.clips || [],
      automationLanes: lanes,
      sends: (t.sends || []).map(x => ({ ...x })),
      plugins,
    } as Track;
  });

  if (report.relinked.length) report.messages.unshift(...report.relinked.map(r => `${r.plugin} (${r.track}) retrouvé : ${r.to}${r.note ? ` (${r.note})` : ''}.`));
  if (report.waitingBridge) report.messages.push(`${report.waitingBridge} effet${report.waitingBridge > 1 ? 's' : ''} VST attend${report.waitingBridge > 1 ? 'ent' : ''} le pont VST : ${report.waitingBridge > 1 ? 'ils se chargeront' : 'il se chargera'} dès que le pont sera connecté (appli Windows Nova Studio).`);
  if (report.enabled) report.messages.push(`${report.enabled} effet${report.enabled > 1 ? 's' : ''} désactivé${report.enabled > 1 ? 's' : ''} dans le modèle ${report.enabled > 1 ? 'ont été activés' : 'a été activé'}.`);

  const firstVoice = tracks.find(t => t.type === TrackType.AUDIO && t.id !== 'instrumental');
  const state: DAWState = {
    id: opts.projectId || `proj-${Date.now().toString(36)}`,
    name: (opts.name || tpl.name || 'Projet').slice(0, 80),
    schemaVersion: 2,
    bpm,
    timeSignature: s.timeSignature || { numerator: 4, denominator: 4 },
    ...(s.projectKey !== undefined ? { projectKey: s.projectKey } : {}),
    ...(s.projectScale !== undefined ? { projectScale: s.projectScale } : {}),
    ...(s.projectMode ? { projectMode: s.projectMode } : {}),
    ...(s.vocalMixStyle ? { vocalMixStyle: s.vocalMixStyle } : {}),
    isPlaying: false, isRecording: false, currentTime: 0,
    isLoopActive: false, loopStart: 0, loopEnd: 8,
    tracks,
    trackGroups: s.trackGroups || [],
    markers: s.markers || [],
    selectedTrackId: firstVoice?.id || tracks[0]?.id || null,
    currentView: 'ARRANGEMENT',
    projectPhase: ProjectPhase.SETUP,
    isLowLatencyMode: false, isRecModeActive: false, systemMaxLatency: 0, recStartTime: null,
    isDelayCompEnabled: s.isDelayCompEnabled !== false,
    metronome: { enabled: false, volume: 0.7, countIn: 0, accentDownbeat: true, sound: 'CLICK' },
    punch: { enabled: false, punchIn: 0, punchOut: 0, preRoll: 0, postRoll: 0 },
  };
  return { state, report };
};
