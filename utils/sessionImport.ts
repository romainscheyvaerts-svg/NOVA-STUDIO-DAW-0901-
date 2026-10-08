import { AutomationLane, Clip, DAWState, NamedBus, PluginInstance, Track, TrackType } from '../types';

/**
 * R21 · Importer depuis une session (Pro Tools : File › Import › Session Data,
 * Alt+Maj+I ; Logic : All Files Browser › Import).
 *
 * Source : un autre projet NOVA (.zip), un modèle (.novatemplate) ou un projet
 * ouvert récemment (historique de l'appareil). On choisit les pistes et, pour
 * chacune, ce qu'on prend :
 *  - clips      : clips audio et MIDI (et le motif de la boîte à rythmes) ;
 *  - plugins    : effets et réglages (volume, pan, trim, largeur, instrument,
 *                 commentaire de piste) ;
 *  - sends      : envois et routage (sortie, bus nommés, side-chain) ;
 *  - automation : courbes d'automation ;
 *  - color      : couleur.
 *
 * Pistes du même nom : « remplacer » (Pro Tools : Match Tracks → les parties
 * choisies remplacent celles de la piste existante, le reste est gardé) ou
 * « ajouter » (nouvelle piste « Nom 2 »).
 * Bus manquants (sortie, envoi, side-chain vers une piste non importée et
 * absente du projet) : créés (copie du bus d'origine, effets et routage).
 * « Faire correspondre au tempo » : positions recalées sur les mêmes mesures ;
 * notes MIDI et automation suivent ; les clips audio à étirer sont rendus par
 * l'hôte (R13, utils/clipTranspose : withTempo).
 *
 * Les VST absents sont signalés par l'hôte, comme pour les modèles
 * (utils/sessionTemplate.instantiateTemplate). Module pur : tests/sessionImport.test.ts.
 */

export type ImportPart = 'clips' | 'plugins' | 'sends' | 'automation' | 'color';
export const ALL_PARTS: ImportPart[] = ['clips', 'plugins', 'sends', 'automation', 'color'];
export const PART_LABELS: Record<ImportPart, { label: string; hint: string }> = {
  clips: { label: 'Clips', hint: 'Clips audio et MIDI (Pro Tools : Clips and Media)' },
  plugins: { label: 'Effets et réglages', hint: 'Effets, instrument, volume, pan, largeur (Pro Tools : Plug-Ins + Main Playlist Options)' },
  sends: { label: 'Envois et routage', hint: 'Sortie, envois vers les bus, side-chain (Pro Tools : I/O + Sends)' },
  automation: { label: 'Automation', hint: 'Courbes de volume, pan et paramètres d\'effets (Pro Tools : Automation)' },
  color: { label: 'Couleur', hint: 'Couleur de la piste' },
};

export type SameNameMode = 'replace' | 'add';

export interface ImportChoice { sourceId: string; parts: ImportPart[] }
export interface ImportOptions {
  sameName: SameNameMode;
  /** Recaler sur les mêmes mesures quand les tempos diffèrent. */
  matchTempo: boolean;
}

export interface ImportSourceInfo {
  id: string;
  name: string;
  type: TrackType;
  color: string;
  clips: number;
  plugins: number;
  sends: number;
  automation: number;
  /** Piste du projet ouvert qui porte le même nom. */
  existingId: string | null;
  isBus: boolean;
  /** Bus et pistes dont elle dépend (sortie, envois, side-chain), par nom. */
  dependsOn: string[];
}

const norm = (s: string) => (s || '').trim().toLowerCase();
const isMaster = (t: Pick<Track, 'id'>) => t.id === 'master';

/** Résumé des pistes de la source, pour la fenêtre d'import. */
export function planImport(target: Pick<DAWState, 'tracks'>, source: Pick<DAWState, 'tracks'>): ImportSourceInfo[] {
  const buses = source.tracks.find(isMaster)?.ioBuses || [];
  return source.tracks.filter(t => !isMaster(t)).map(t => {
    const deps = new Set<string>();
    const nameOf = (id?: string) => source.tracks.find(x => x.id === id && !isMaster(x))?.name;
    const o = nameOf(t.outputTrackId); if (o) deps.add(o);
    (t.sends || []).forEach(s => { const n = nameOf(s.id); if (n) deps.add(n); });
    (t.plugins || []).forEach(p => { const n = nameOf(p.sidechainSourceId); if (n) deps.add(n); });
    if (t.outputBusId) { const b = buses.find(x => x.id === t.outputBusId); if (b) deps.add(b.name); }
    const existing = target.tracks.find(x => !isMaster(x) && norm(x.name) === norm(t.name));
    return {
      id: t.id, name: t.name, type: t.type, color: t.color, clips: (t.clips || []).length, plugins: (t.plugins || []).length,
      sends: (t.sends || []).length, automation: (t.automationLanes || []).filter(l => l.points?.length).length,
      existingId: existing ? existing.id : null, isBus: t.type === TrackType.BUS || !!t.inputBusId, dependsOn: [...deps],
    };
  });
}

export interface ImportReport {
  added: string[];
  replaced: string[];
  busesCreated: string[];
  namedBusesCreated: string[];
  /** Clips audio à étirer au tempo du projet (rendu par l'hôte). */
  toStretch: { trackId: string; clipId: string }[];
  /** Rapport des tempos (source / projet) quand le recalage s'applique. */
  tempoRatio: number | null;
  clips: number;
  messages: string[];
}

export interface ImportResult<S> { state: S; report: ImportReport; trackIds: string[] }

/** Champs « réglages » d'une piste (pris avec les effets). */
const SETTING_KEYS = ['volume', 'pan', 'inputTrimDb', 'phaseInvert', 'monoSum', 'stereoWidth', 'novaSynth', 'bass808', 'vstInstrument', 'drumPads',
  'isGuide', 'guideLevel', 'guideMuted', 'breathKind', 'automationMode', 'comment', 'midiChannel', 'volumeLock'] as const;
/** Contenu pris avec les clips. */
const CONTENT_KEYS = ['drumMachine', 'takeMeta'] as const;

const copy = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/**
 * Importe les pistes choisies dans `target`. `newId(base)` : fabrique
 * d'identifiants (unique dans le projet). Ne touche ni au moteur ni aux sons :
 * les clips gardent leur `bufferId` (sons déjà enregistrés par l'appelant).
 */
export function applyImport<S extends DAWState>(
  target: S, source: Pick<DAWState, 'tracks' | 'bpm'>, choices: ImportChoice[], opts: ImportOptions, newId: (base: string) => string,
): ImportResult<S> {
  const report: ImportReport = { added: [], replaced: [], busesCreated: [], namedBusesCreated: [], toStretch: [], tempoRatio: null, clips: 0, messages: [] };
  const tracks: Track[] = target.tracks.map(t => t);
  const usedTrackIds = new Set(tracks.map(t => t.id));
  const usedClipIds = new Set<string>();
  tracks.forEach(t => t.clips.forEach(c => usedClipIds.add(c.id)));
  const uid = (base: string, used: Set<string>) => { let id = base; if (used.has(id)) id = newId(base); while (used.has(id)) id = newId(base); used.add(id); return id; };
  const k = opts.matchTempo && source.bpm > 0 && target.bpm > 0 && Math.abs(source.bpm / target.bpm - 1) > 1e-4 ? source.bpm / target.bpm : 1;
  if (k !== 1) report.tempoRatio = k;
  const srcById = new Map(source.tracks.map(t => [t.id, t]));
  const srcBuses: NamedBus[] = source.tracks.find(isMaster)?.ioBuses || [];
  const hasMaster = tracks.some(isMaster);
  const masterIdx = () => tracks.findIndex(isMaster);
  const map = new Map<string, string>(); // id source -> id cible
  const created = new Set<string>(); // pistes ajoutées par cet import (pas de « même nom » entre elles)
  const busMap = new Map<string, string>(); // bus nommé source -> cible
  const pending: { src: Track; parts: Set<ImportPart> }[] = [];

  const sameNameTarget = (name: string) => tracks.find(x => !isMaster(x) && !created.has(x.id) && norm(x.name) === norm(name));
  const uniqueName = (name: string) => {
    if (!tracks.some(x => norm(x.name) === norm(name))) return name;
    for (let n = 2; n < 100; n++) { const c = `${name} ${n}`; if (!tracks.some(x => norm(x.name) === norm(c))) return c; }
    return `${name} (importée)`;
  };
  const insert = (t: Track) => { const i = masterIdx(); if (i >= 0) tracks.splice(i, 0, t); else tracks.push(t); created.add(t.id); };

  const scaleClip = (c: Clip): Clip => {
    if (k === 1) return c;
    const out: Clip = { ...c, start: c.start * k };
    if (c.type === TrackType.MIDI || c.notes) {
      out.duration = c.duration * k;
      if (c.notes) out.notes = c.notes.map(n => ({ ...n, start: n.start * k, duration: n.duration * k }));
      if (c.cc) out.cc = Object.fromEntries(Object.entries(c.cc).map(([kk, pts]) => [kk, pts.map(p => ({ ...p, t: p.t * k }))]));
    }
    if (c.originStart !== undefined) out.originStart = c.originStart * k;
    return out;
  };
  const cloneClips = (t: Track, trackId: string): Clip[] => (t.clips || []).filter(c => !c.isFreezeSlice).map(c0 => {
    const { buffer: _b, freezeRef: _f, ...rest } = c0 as Clip;
    const c = scaleClip(copy(rest) as Clip);
    c.id = uid(c0.id, usedClipIds);
    if (c.type !== TrackType.MIDI && !c.notes && k !== 1 && c.bufferId) report.toStretch.push({ trackId, clipId: c.id });
    report.clips++;
    return c;
  });
  const cloneLanes = (t: Track): AutomationLane[] => (t.automationLanes || []).map(l => ({
    ...copy(l), id: newId(l.id || 'lane'), points: (l.points || []).map(p => ({ ...p, id: newId(p.id || 'pt'), time: p.time * k })),
  }));

  // 1. Pistes choisies : créées (ou retrouvées par leur nom) d'abord, pour que le routage les trouve.
  for (const ch of choices) {
    const src = srcById.get(ch.sourceId);
    if (!src || isMaster(src) || !ch.parts.length) continue;
    const parts = new Set(ch.parts);
    const existing = opts.sameName === 'replace' ? sameNameTarget(src.name) : undefined;
    if (existing) {
      map.set(src.id, existing.id);
      report.replaced.push(existing.name);
    } else {
      const id = uid(src.id, usedTrackIds);
      const t: Track = {
        id, name: uniqueName(src.name), type: src.type, color: src.color || '#94a3b8',
        isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
        outputTrackId: hasMaster ? 'master' : '', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
      };
      insert(t);
      map.set(src.id, id);
      report.added.push(t.name);
    }
    pending.push({ src, parts });
  }

  // Bus manquant : copie de la piste d'origine (effets, réglages, routage), sans clips.
  const resolveTrack = (srcId: string | undefined, depth = 0): string | undefined => {
    if (!srcId) return undefined;
    if (srcId === 'master') return hasMaster ? 'master' : '';
    if (map.has(srcId)) return map.get(srcId);
    const src = srcById.get(srcId);
    if (!src) return undefined;
    const same = tracks.find(x => !isMaster(x) && norm(x.name) === norm(src.name));
    if (same) { map.set(srcId, same.id); return same.id; }
    if (depth > 6) return undefined;
    const id = uid(src.id, usedTrackIds);
    map.set(srcId, id);
    const bus: Track = {
      ...copy({ ...src, clips: [], frozenClip: undefined, buffer: undefined } as any),
      id, name: uniqueName(src.name), clips: [], isTrackArmed: false, isFrozen: false, totalLatency: 0,
      automationLanes: cloneLanes(src),
    };
    delete (bus as any).frozenClip; delete bus.frozenClipIds; delete bus.frozenSourceSig; delete bus.frozenPluginSig; delete bus.frozenAuto;
    delete bus.freezeBase; delete bus.preFxJournal; delete bus.sendFreezes; delete bus.collabOwner; delete bus.collabOwnerKey; delete bus.remote; delete bus.livePreview;
    delete bus.parentFolderId; delete bus.groupId; delete bus.groupIds;
    insert(bus);
    report.busesCreated.push(bus.name);
    routeInto(bus, src, depth + 1, true);
    return id;
  };
  const resolveNamedBus = (srcBusId: string | undefined): string | undefined => {
    if (!srcBusId) return undefined;
    if (busMap.has(srcBusId)) return busMap.get(srcBusId);
    const b = srcBuses.find(x => x.id === srcBusId);
    if (!b) return undefined;
    const mi = masterIdx();
    const master = mi >= 0 ? tracks[mi] : null;
    const have = (master?.ioBuses || []).find(x => norm(x.name) === norm(b.name));
    let id: string;
    if (have) id = have.id;
    else {
      id = (master?.ioBuses || []).some(x => x.id === b.id) ? newId(b.id) : b.id;
      if (master) tracks[mi] = { ...master, ioBuses: [...(master.ioBuses || []), { ...b, id }] };
      report.namedBusesCreated.push(b.name);
    }
    busMap.set(srcBusId, id);
    return id;
  };
  const mapSidechain = (p: PluginInstance, depth: number): PluginInstance => {
    if (!p.sidechainSourceId) return p;
    const out = { ...p };
    if (p.sidechainSourceId.startsWith('bus:')) {
      const b = resolveNamedBus(p.sidechainSourceId.slice(4));
      if (b) out.sidechainSourceId = `bus:${b}`; else delete out.sidechainSourceId;
    } else {
      const id = resolveTrack(p.sidechainSourceId, depth);
      if (id) out.sidechainSourceId = id; else { delete out.sidechainSourceId; report.messages.push(`Side-chain de « ${p.name} » : source introuvable, retirée.`); }
    }
    return out;
  };
  /** Routage de `src` posé sur `t` (sortie, envois, bus nommés, side-chain, VCA). */
  function routeInto(t: Track, src: Track, depth: number, withPlugins: boolean) {
    const out = resolveTrack(src.outputTrackId, depth);
    t.outputTrackId = out !== undefined ? out : (hasMaster ? 'master' : '');
    t.sends = (src.sends || []).map(s => ({ ...s, id: resolveTrack(s.id, depth) || '' })).filter(s => s.id);
    const dropped = (src.sends || []).length - t.sends.length;
    if (dropped) report.messages.push(`« ${src.name} » : ${dropped} envoi${dropped > 1 ? 's' : ''} sans destination retiré${dropped > 1 ? 's' : ''}.`);
    if (src.outputBusId) {
      const b = resolveNamedBus(src.outputBusId);
      if (b) {
        t.outputBusId = b;
        // L'aux qui écoute ce bus doit exister (sinon le son ne va nulle part).
        const listener = source.tracks.find(x => x.inputBusId === src.outputBusId && !isMaster(x));
        if (listener && !tracks.some(x => x.inputBusId === b)) resolveTrack(listener.id, depth);
      } else delete t.outputBusId;
    } else delete t.outputBusId;
    if (src.inputBusId) { const b = resolveNamedBus(src.inputBusId); if (b) t.inputBusId = b; else delete t.inputBusId; } else delete t.inputBusId;
    if (src.vcaId) { const v = resolveTrack(src.vcaId, depth); if (v) t.vcaId = v; else delete t.vcaId; }
    if (withPlugins) t.plugins = (t.plugins || []).map(p => mapSidechain(p, depth));
  }

  // 2. Parties choisies posées sur chaque piste.
  for (const { src, parts } of pending) {
    const id = map.get(src.id)!;
    const i = tracks.findIndex(x => x.id === id);
    if (i < 0) continue;
    const t: Track = { ...tracks[i] };
    const replacing = !created.has(id);
    if (parts.has('clips')) {
      t.clips = cloneClips(src, id);
      for (const kk of CONTENT_KEYS) { if (src[kk] !== undefined) (t as any)[kk] = copy(src[kk]); else if (replacing) delete (t as any)[kk]; }
      if (replacing) { delete t.frozenClip; t.isFrozen = false; delete t.frozenClipIds; delete t.frozenSourceSig; delete t.frozenPluginSig; delete t.frozenAuto; }
    }
    if (parts.has('plugins')) {
      t.plugins = copy(src.plugins || []).map(p => mapSidechain(p, 0));
      for (const kk of SETTING_KEYS) { if (src[kk] !== undefined) (t as any)[kk] = copy(src[kk]); else if (replacing && kk !== 'volume' && kk !== 'pan') delete (t as any)[kk]; }
      if (src.vstInstrument) { delete t.frozenClip; t.isFrozen = false; } // le rendu de l'instrument sera refait
      if (src.type !== t.type && !replacing) t.type = src.type;
    }
    if (parts.has('sends')) routeInto(t, src, 0, false);
    if (parts.has('automation')) t.automationLanes = cloneLanes(src);
    if (parts.has('color')) t.color = src.color;
    tracks[i] = t;
  }

  if (report.tempoRatio) {
    report.messages.push(`Tempo : ${round(source.bpm)} → ${round(target.bpm)} BPM, positions recalées sur les mêmes mesures${report.toStretch.length ? ` ; ${report.toStretch.length} clip${report.toStretch.length > 1 ? 's' : ''} audio étiré${report.toStretch.length > 1 ? 's' : ''} au tempo` : ''}.`);
  }
  if (report.busesCreated.length) report.messages.push(`Bus créé${report.busesCreated.length > 1 ? 's' : ''} : ${report.busesCreated.map(x => `« ${x} »`).join(', ')}.`);
  if (report.namedBusesCreated.length) report.messages.push(`Bus nommé${report.namedBusesCreated.length > 1 ? 's' : ''} ajouté${report.namedBusesCreated.length > 1 ? 's' : ''} : ${report.namedBusesCreated.join(', ')}.`);
  const trackIds = pending.map(p => map.get(p.src.id)!).filter(Boolean);
  return { state: { ...target, tracks }, report, trackIds };
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Phrase de fin d'import. */
export function importSummary(r: ImportReport): string {
  const parts: string[] = [];
  if (r.added.length) parts.push(`${r.added.length} piste${r.added.length > 1 ? 's' : ''} ajoutée${r.added.length > 1 ? 's' : ''}`);
  if (r.replaced.length) parts.push(`${r.replaced.length} remplacée${r.replaced.length > 1 ? 's' : ''}`);
  if (r.clips) parts.push(`${r.clips} clip${r.clips > 1 ? 's' : ''}`);
  if (r.busesCreated.length) parts.push(`${r.busesCreated.length} bus créé${r.busesCreated.length > 1 ? 's' : ''}`);
  return parts.join(', ') || 'rien à importer';
}

/** Préréglages de la fenêtre : « Tout », « Effets et routage seulement »… */
export const PART_PRESETS: { id: string; label: string; parts: ImportPart[] }[] = [
  { id: 'all', label: 'Tout', parts: ALL_PARTS },
  { id: 'mix', label: 'Effets et routage (sans les clips)', parts: ['plugins', 'sends', 'automation', 'color'] },
  { id: 'clips', label: 'Clips seulement', parts: ['clips'] },
];
