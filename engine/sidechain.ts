/**
 * R7 · Side-chain natif (Pro Tools « Key Input », Ableton « Sidechain »).
 *
 * Un effet à clé (Compresseur, compresseurs analogiques du labo, Gate, Gate
 * rythmique, De-esser en écoute externe) détecte sur une AUTRE piste ou un bus nommé au lieu du son de sa
 * piste : la 808 qui s'efface sous le kick, le beat qui se creuse sous la voix.
 *
 *  - Source : `PluginInstance.sidechainSourceId` = id d'une piste, ou
 *    « bus:<id> » d'un bus nommé (I/O Setup) : la clé est alors la somme des
 *    pistes qui sortent sur ce bus, même si aucun aux ne l'écoute (bus « Clé
 *    kick » de Pro Tools).
 *  - Prise : « pre » (défaut) = après les effets de la source, AVANT son fader
 *    et son mute (un kick fantôme muet garde la pompe ; baisser le kick ne
 *    change pas la profondeur du ducking) ; « post » = après le fader.
 *  - Chemin : prise → retard (PDC) → passe-haut → passe-bas → entrée de clé de
 *    l'effet. Le retard vient de utils/pdc (clés = sorties de la source) : la
 *    clé arrive ALIGNÉE avec le son traité, en lecture comme à l'export, même
 *    quand des effets à latence sont en amont de l'un ou de l'autre.
 *  - Boucles refusées : une clé qui ferait revenir le son sur lui-même (piste
 *    qui écoute un bus où elle arrive, chaînes de clés circulaires) est refusée
 *    avec un message clair, et le moteur ne la câble jamais.
 *
 * Logique de graphe pure (testable) + petites classes Web Audio.
 */
import type { PluginInstance, Track } from '../types';
import type { PdcKey, PdcResult } from '../utils/pdc';
import { busById, busesOf, engineView } from '../utils/trackStructure';

/** Effets qui acceptent une clé externe. Le limiteur à crête vraie n'en a pas : son plafond doit suivre SON signal. */
export const SIDECHAIN_TYPES = ['COMPRESSOR', 'GATE', 'GATEFX', 'DEESSER', 'OPTO_VINTAGE', 'FET76', 'LEVELER2A', 'VOXSTRIP'] as const;
export const supportsSidechain = (type: string) => (SIDECHAIN_TYPES as readonly string[]).includes(type);

export const BUS_KEY_PREFIX = 'bus:';
export const busKeyRef = (busId: string) => `${BUS_KEY_PREFIX}${busId}`;
export const parseKeyRef = (ref: string | undefined | null): { kind: 'track' | 'bus'; id: string } | null => {
  if (!ref) return null;
  return ref.startsWith(BUS_KEY_PREFIX) ? { kind: 'bus', id: ref.slice(BUS_KEY_PREFIX.length) } : { kind: 'track', id: ref };
};

/** Filtre de la clé : bornes et valeurs « éteintes ». */
export const KEY_HPF_OFF = 20;
export const KEY_LPF_OFF = 20000;
export const keyFilterOf = (p: Record<string, any> | undefined) => {
  const n = (v: any, d: number, lo: number, hi: number) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
  return { hpf: n(p?.keyHpf, KEY_HPF_OFF, 20, 2000), lpf: n(p?.keyLpf, KEY_LPF_OFF, 100, 20000), listen: Number(p?.keyListen) >= 0.5 };
};

/** Nom lisible d'une source de clé (« Kick », « Bus Clé kick »). */
export function keySourceLabel(tracks: Track[], ref: string | undefined): string {
  const k = parseKeyRef(ref);
  if (!k) return 'Aucune';
  if (k.kind === 'bus') { const b = busById(tracks, k.id); return b ? `Bus ${b.name}` : 'Bus disparu'; }
  return tracks.find(t => t.id === k.id)?.name || 'Piste disparue';
}

/** Pistes dont le son forme la clé (une piste ; pour un bus nommé, celles qui y sortent). */
export function keySourceTrackIds(tracks: Track[], ref: string | undefined): string[] {
  const k = parseKeyRef(ref);
  if (!k) return [];
  if (k.kind === 'track') return tracks.some(t => t.id === k.id) ? [k.id] : [];
  return tracks.filter(t => t.outputBusId === k.id && t.id !== 'master').map(t => t.id);
}

/** Sources proposées dans la fenêtre de l'effet : pistes (sauf la sienne et le master) et bus nommés. */
export function keySourceOptions(tracks: Track[], selfTrackId: string): { ref: string; label: string; kind: 'track' | 'bus' }[] {
  const out: { ref: string; label: string; kind: 'track' | 'bus' }[] = [];
  for (const t of tracks) {
    if (t.id === selfTrackId || t.id === 'master' || t.isVca || t.folder?.kind === 'basic') continue;
    out.push({ ref: t.id, label: t.name || t.id, kind: 'track' });
  }
  for (const b of busesOf(tracks)) out.push({ ref: busKeyRef(b.id), label: `Bus ${b.name}`, kind: 'bus' });
  return out;
}

/** Routage audio joué : piste → destinations (sortie résolue + envois). Le master n'a pas de sortie. */
function audioEdges(tracks: Track[]): Map<string, string[]> {
  const played = engineView(tracks).tracks;
  const hasMaster = played.some(t => t.id === 'master');
  const out = new Map<string, string[]>();
  for (const t of played) {
    if (t.id === 'master') { out.set(t.id, []); continue; }
    const d: string[] = [];
    const o = t.outputTrackId;
    if (o && o !== t.id && played.some(x => x.id === o)) d.push(o);
    else if (!o && hasMaster) d.push('master');
    for (const s of t.sends || []) if (s.id && s.id !== t.id && s.isEnabled !== false) d.push(s.id);
    out.set(t.id, d);
  }
  return out;
}

const nameOf = (tracks: Track[], id: string) => tracks.find(t => t.id === id)?.name || id;

export interface KeyLoop { message: string; path: string[] }

/**
 * La clé `ref` sur un effet de la piste `targetTrackId` ferait-elle une boucle
 * (le son de la cible reviendrait dans sa propre clé) ? Renvoie le message à
 * afficher et le chemin en cause, sinon null. `pluginId` : l'effet modifié
 * (sa clé actuelle est ignorée).
 */
export function sidechainLoop(tracks: Track[], targetTrackId: string, ref: string | undefined, pluginId?: string): KeyLoop | null {
  const sources = keySourceTrackIds(tracks, ref);
  if (!sources.length) return null;
  const tname = nameOf(tracks, targetTrackId);
  if (sources.includes(targetTrackId)) {
    return { message: `« ${tname} » ne peut pas être sa propre clé : c'est déjà le son que l'effet écoute sans clé. Choisis une autre piste ou « Aucune ».`, path: [targetTrackId] };
  }
  // Graphe : routage audio + clés existantes (source → cible), sauf celle de cet effet.
  const g = audioEdges(tracks);
  const add = (a: string, b: string) => { const l = g.get(a) || []; l.push(b); g.set(a, l); };
  for (const t of tracks) for (const p of t.plugins || []) {
    if (p.id === pluginId || !p.sidechainSourceId || p.isInactive || !supportsSidechain(p.type)) continue;
    for (const s of keySourceTrackIds(tracks, p.sidechainSourceId)) if (s !== t.id) add(s, t.id);
  }
  // Ajouter source → cible fait une boucle si la cible atteint déjà la source.
  for (const s of sources) {
    const prev = new Map<string, string>();
    const seen = new Set([targetTrackId]);
    const queue = [targetTrackId];
    while (queue.length) {
      const x = queue.shift()!;
      if (x === s) {
        const path = [s];
        let y = s;
        while (prev.has(y)) { y = prev.get(y)!; path.unshift(y); }
        const chain = path.map(id => `« ${nameOf(tracks, id)} »`).join(' → ');
        const sname = nameOf(tracks, s);
        const viaBus = parseKeyRef(ref)?.kind === 'bus' ? ` (qui sort sur ${keySourceLabel(tracks, ref)})` : '';
        return {
          message: `Boucle de routage refusée : le son de « ${tname} » arrive déjà dans « ${sname} »${viaBus} (${chain}). En clé, il reviendrait sur lui-même. Choisis une source qui ne reçoit pas « ${tname} ».`,
          path,
        };
      }
      for (const n of g.get(x) || []) if (!seen.has(n)) { seen.add(n); prev.set(n, x); queue.push(n); }
    }
  }
  return null;
}

/** Effet à clé câblé par le moteur. */
export interface KeyRoute {
  targetTrackId: string;
  pluginId: string;
  sources: string[];
  tap: 'pre' | 'post';
  hpf: number;
  lpf: number;
}

const routesCache = new WeakMap<Track[], KeyRoute[]>();

/**
 * Effets à clé à câbler (pistes JOUÉES : engineView). Ignorés : effet inactif
 * ou en bypass, source absente, boucle de routage (jamais câblée).
 */
export function keyRoutes(tracks: Track[]): KeyRoute[] {
  const cached = routesCache.get(tracks);
  if (cached) return cached;
  const out: KeyRoute[] = [];
  for (const t of tracks) for (const p of t.plugins || []) {
    if (!p.sidechainSourceId || !supportsSidechain(p.type) || p.isInactive || !p.isEnabled) continue;
    const sources = keySourceTrackIds(tracks, p.sidechainSourceId).filter(s => s !== t.id);
    if (!sources.length || sidechainLoop(tracks, t.id, p.sidechainSourceId, p.id)) continue;
    const f = keyFilterOf(p.params);
    out.push({ targetTrackId: t.id, pluginId: p.id, sources, tap: p.sidechainTap === 'post' ? 'post' : 'pre', hpf: f.hpf, lpf: f.lpf });
  }
  routesCache.set(tracks, out);
  return out;
}

/** Clés PDC prises sur la piste `sourceId` ; `offsetOf` = latence des effets avant l'effet à clé sur sa piste. */
export function pdcKeysFor(routes: KeyRoute[], sourceId: string, offsetOf: (targetTrackId: string, pluginId: string) => number): PdcKey[] {
  const out: PdcKey[] = [];
  for (const r of routes) if (r.sources.includes(sourceId)) out.push({ id: r.pluginId, target: r.targetTrackId, offset: offsetOf(r.targetTrackId, r.pluginId) });
  return out;
}

/** Latence (s) des effets placés avant `pluginId` dans une chaîne (ids dans l'ordre, latence par id). */
export function latencyBefore(chainIds: string[], pluginId: string, latencyOf: (id: string) => number): number {
  let acc = 0;
  for (const id of chainIds) {
    if (id === pluginId) return acc;
    const l = latencyOf(id);
    if (Number.isFinite(l) && l > 0 && l < 0.5) acc += l;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Web Audio
// ---------------------------------------------------------------------------

/**
 * Chemin d'une clé : un retard (PDC) par source → somme → passe-haut →
 * passe-bas → entrée de clé de l'effet.
 */
export class KeyPath {
  readonly sum: GainNode;
  readonly hpf: BiquadFilterNode;
  readonly lpf: BiquadFilterNode;
  private delays = new Map<string, { delay: DelayNode; tap: AudioNode }>();
  private dest: AudioNode | null = null;

  constructor(private ctx: BaseAudioContext, maxDelay = 4) {
    this.sum = ctx.createGain();
    this.sum.channelCount = 2; this.sum.channelCountMode = 'explicit'; this.sum.channelInterpretation = 'speakers';
    this.hpf = ctx.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.Q.value = 0.7071;
    this.lpf = ctx.createBiquadFilter(); this.lpf.type = 'lowpass'; this.lpf.Q.value = 0.7071;
    this.sum.connect(this.hpf); this.hpf.connect(this.lpf);
    void maxDelay;
  }

  setFilters(hpf: number, lpf: number) {
    const ny = this.ctx.sampleRate / 2 * 0.99;
    this.hpf.frequency.value = Math.min(ny, Math.max(10, hpf));
    this.lpf.frequency.value = Math.min(ny, Math.max(20, lpf));
  }

  /** Branche (ou rebranche, idempotent) la prise d'une source. */
  setSource(sourceId: string, tap: AudioNode) {
    let d = this.delays.get(sourceId);
    if (d && d.tap !== tap) { try { d.tap.disconnect(d.delay); } catch { /* */ } d.tap = tap; }
    if (!d) {
      const delay = this.ctx.createDelay(4);
      delay.connect(this.sum);
      d = { delay, tap };
      this.delays.set(sourceId, d);
    }
    // connect() est idempotent pour une même paire : le recâblage d'une piste (qui coupe ses sorties) est réparé ici.
    tap.connect(d.delay);
  }

  /** Retire les sources qui ne font plus partie de la clé. */
  keepSources(ids: string[]) {
    for (const [id, d] of [...this.delays]) {
      if (ids.includes(id)) continue;
      try { d.tap.disconnect(d.delay); } catch { /* */ }
      try { d.delay.disconnect(); } catch { /* */ }
      this.delays.delete(id);
    }
  }

  delayOf(sourceId: string): DelayNode | null { return this.delays.get(sourceId)?.delay || null; }
  sources() { return [...this.delays.keys()]; }

  connectTo(node: AudioNode) {
    if (this.dest === node) { this.lpf.connect(node); return; }
    if (this.dest) { try { this.lpf.disconnect(this.dest); } catch { /* */ } }
    this.dest = node;
    this.lpf.connect(node);
  }

  dispose() {
    for (const d of this.delays.values()) {
      try { d.tap.disconnect(d.delay); } catch { /* */ }
      try { d.delay.disconnect(); } catch { /* */ }
    }
    this.delays.clear();
    for (const n of [this.sum, this.hpf, this.lpf]) { try { n.disconnect(); } catch { /* */ } }
    this.dest = null;
  }
}

/** Effet à clé tel que le voit le moteur (Compresseur, Gate, Gate rythmique, De-esser). */
export interface KeyedNode { sidechainInput?: AudioNode | null; setSidechainActive?: (on: boolean) => void }
export const isKeyedNode = (n: any): n is KeyedNode & { sidechainInput: AudioNode } => !!n && !!n.sidechainInput && typeof n.setSidechainActive === 'function';

/**
 * Clés de la lecture : tient un KeyPath par effet à clé, le recâble quand les
 * pistes changent (idempotent, appelé à chaque mise à jour de piste).
 */
export class SidechainRouter {
  private paths = new Map<string, { path: KeyPath; inst: KeyedNode; route: KeyRoute }>();
  private routes: KeyRoute[] = [];
  private sig = '';

  constructor(private ctxOf: () => BaseAudioContext | null) {}

  /**
   * `instanceOf` : nœud de l'effet sur sa piste (null s'il n'est pas câblé) ;
   * `tapOf` : point de prise d'une piste. Renvoie vrai si la topologie des clés a changé (PDC à refaire).
   */
  sync(routes: KeyRoute[], instanceOf: (trackId: string, pluginId: string) => any, tapOf: (trackId: string, tap: 'pre' | 'post') => AudioNode | null): boolean {
    const ctx = this.ctxOf();
    if (!ctx) return false;
    const live: KeyRoute[] = [];
    const keep = new Set<string>();
    for (const r of routes) {
      const inst = instanceOf(r.targetTrackId, r.pluginId);
      if (!isKeyedNode(inst)) continue;
      const taps = r.sources.map(s => [s, tapOf(s, r.tap)] as const).filter(([, n]) => !!n) as [string, AudioNode][];
      if (!taps.length) continue;
      let e = this.paths.get(r.pluginId);
      if (e && e.inst !== inst) { try { e.inst.setSidechainActive?.(false); } catch { /* */ } e.path.dispose(); e = undefined; this.paths.delete(r.pluginId); }
      if (!e) { e = { path: new KeyPath(ctx), inst, route: r }; this.paths.set(r.pluginId, e); }
      e.route = r;
      e.path.setFilters(r.hpf, r.lpf);
      e.path.keepSources(taps.map(([s]) => s));
      for (const [s, n] of taps) e.path.setSource(s, n);
      e.path.connectTo(inst.sidechainInput!);
      inst.setSidechainActive!(true);
      keep.add(r.pluginId);
      live.push({ ...r, sources: taps.map(([s]) => s) });
    }
    for (const [id, e] of [...this.paths]) {
      if (keep.has(id)) continue;
      try { e.inst.setSidechainActive?.(false); } catch { /* */ }
      e.path.dispose();
      this.paths.delete(id);
    }
    this.routes = live;
    const sig = live.map(r => `${r.targetTrackId}/${r.pluginId}<${r.sources.join('+')}:${r.tap}`).join('|');
    const changed = sig !== this.sig;
    this.sig = sig;
    return changed;
  }

  /** Routes câblées (clés PDC). */
  current(): KeyRoute[] { return this.routes; }

  /** Vrai si la piste sert de clé « avant fader » : muette, elle doit quand même jouer (kick fantôme). */
  isPreKeySource(trackId: string): boolean { return this.routes.some(r => r.tap === 'pre' && r.sources.includes(trackId)); }

  /** Pose les retards PDC de chaque clé (`set` mémorise et lisse comme les autres retards du moteur). */
  applyDelays(results: Map<string, PdcResult>, set: (node: DelayNode, sec: number) => void, suspended: boolean) {
    for (const [pluginId, e] of this.paths) {
      for (const s of e.path.sources()) {
        const d = e.path.delayOf(s);
        if (!d) continue;
        set(d, suspended ? 0 : (results.get(s)?.keyDelays.get(pluginId) ?? 0));
      }
    }
  }

  /** Nœud « clé » d'un effet (mesures, tests). */
  pathOf(pluginId: string): KeyPath | null { return this.paths.get(pluginId)?.path || null; }

  disposeAll() {
    for (const e of this.paths.values()) { try { e.inst.setSidechainActive?.(false); } catch { /* */ } e.path.dispose(); }
    this.paths.clear();
    this.routes = [];
    this.sig = '';
  }
}

// ---------------------------------------------------------------------------
// Préréglages trap (fenêtre de l'effet)
// ---------------------------------------------------------------------------

export interface SidechainPreset {
  id: string;
  name: string;
  hint: string;
  /** Effet concerné. */
  type: 'COMPRESSOR' | 'GATE' | 'GATEFX';
  /** Réglages de l'effet (clé comprise : keyHpf, keyLpf). */
  params: Record<string, number | string | boolean>;
  /** Source devinée d'après le nom des pistes (« kick », « voix »…). */
  guess: RegExp;
  tap?: 'pre' | 'post';
}

export const SIDECHAIN_PRESETS: SidechainPreset[] = [
  {
    id: '808-sous-kick', name: '808 sous le kick', type: 'COMPRESSOR',
    hint: 'La 808 s’efface d’environ 6 à 10 dB à chaque kick puis revient en ~120 ms : le kick perce sans monter le volume. Clé filtrée sur le bas du kick (40–200 Hz). À poser sur la 808, clé = le kick.',
    params: { threshold: -14, ratio: 4, knee: 6, attack: 0.0005, release: 0.12, makeupGain: 1, mix: 1, scHpFreq: 20, lookahead: 0, autoMakeup: false, mode: 'CLEAN', keyHpf: 40, keyLpf: 200 },
    guess: /\b(kick|kck|bd|grosse ?caisse|kik)\b/i,
  },
  {
    id: 'voix-creuse-beat', name: 'Voix qui creuse le beat', type: 'COMPRESSOR',
    hint: 'Le beat baisse de 1 à 3 dB seulement quand la voix est là, et remonte entre les phrases : la voix passe devant sans toucher au mix. Compression parallèle (mix 30 %) : jamais plus de 3 dB, même sur un refrain crié. Clé filtrée sur la présence de la voix (150 Hz – 6 kHz). À poser sur le beat (ou son bus), clé = la voix lead ou le bus voix.',
    params: { threshold: -32, ratio: 4, knee: 10, attack: 0.01, release: 0.25, makeupGain: 1, mix: 0.3, scHpFreq: 20, lookahead: 0, autoMakeup: false, mode: 'VCA', keyHpf: 150, keyLpf: 6000 },
    guess: /\b(voix|vocal|vox|lead|chant|rap|couplet|refrain)\b/i,
  },
  {
    id: 'pompe', name: 'Pompe', type: 'COMPRESSOR',
    hint: 'Grosse pompe à chaque kick (10 à 15 dB, relâchement 180 ms) : l’effet « EDM / trap festival » sur les pads, les accords ou tout le beat. Clé = le kick.',
    params: { threshold: -20, ratio: 6, knee: 0, attack: 0.0005, release: 0.18, makeupGain: 1, mix: 1, scHpFreq: 20, lookahead: 0, autoMakeup: false, mode: 'CLEAN', keyHpf: 30, keyLpf: 250 },
    guess: /\b(kick|kck|bd|grosse ?caisse|kik)\b/i,
  },
  {
    id: 'gate-cle-hats', name: 'Haché par les charleys', type: 'GATE',
    hint: 'Le son ne passe que sur les coups de charley : un pad ou une nappe hachés au rythme des hats. Clé = la piste des charleys (filtrée au-dessus de 5 kHz).',
    params: { threshold: -30, range: 80, attack: 0.3, hold: 0, release: 20, keyHpf: 5000, keyLpf: 20000 },
    guess: /\b(hat|hats|hh|charley|charleys|hihat|hi-hat)\b/i,
  },
];

/** Préréglages proposés pour un effet. */
export const sidechainPresetsFor = (type: string) => SIDECHAIN_PRESETS.filter(p => p.type === type);

/** Source devinée pour un préréglage (piste dont le nom correspond, hors la sienne), ou null. */
export function guessKeySource(tracks: Track[], selfTrackId: string, preset: SidechainPreset): string | null {
  const t = tracks.find(x => x.id !== selfTrackId && x.id !== 'master' && preset.guess.test(x.name || ''));
  if (t) return t.id;
  const b = busesOf(tracks).find(x => preset.guess.test(x.name || ''));
  return b ? busKeyRef(b.id) : null;
}

/**
 * Applique une source à un effet (une seule transformation des pistes) ; refuse
 * une boucle. Renvoie les pistes à jour, ou le message d'erreur.
 */
export function setPluginKeySource(tracks: Track[], trackId: string, pluginId: string, ref: string | null, tap?: 'pre' | 'post'): { tracks: Track[] } | { error: string } {
  if (ref) {
    const loop = sidechainLoop(tracks, trackId, ref, pluginId);
    if (loop) return { error: loop.message };
  }
  const label = ref ? keySourceLabel(tracks, ref) : undefined;
  return {
    tracks: tracks.map(t => (t.id !== trackId ? t : {
      ...t,
      plugins: (t.plugins || []).map(p => {
        if (p.id !== pluginId) return p;
        const { sidechainSourceId: _a, sidechainSourceName: _b, ...rest } = p;
        void _a; void _b;
        const next: PluginInstance = ref ? { ...rest, sidechainSourceId: ref, sidechainSourceName: label } : rest;
        if (tap) next.sidechainTap = tap;
        return next;
      }),
    })),
  };
}

/**
 * Retrouve une clé dans une autre session (preset de chaîne, modèle) : même
 * id, sinon même nom (piste ou bus). null si introuvable.
 */
export function resolveKeySource(tracks: Track[], ref: string | undefined, name: string | undefined, selfTrackId: string): string | null {
  if (!ref) return null;
  const k = parseKeyRef(ref);
  if (k?.kind === 'bus') {
    if (busById(tracks, k.id)) return ref;
    const n = (name || '').replace(/^Bus\s+/i, '').trim().toLowerCase();
    const b = n ? busesOf(tracks).find(x => (x.name || '').trim().toLowerCase() === n) : undefined;
    return b ? busKeyRef(b.id) : null;
  }
  if (k && k.id !== selfTrackId && tracks.some(t => t.id === k.id)) return ref;
  const n = (name || '').trim().toLowerCase();
  const t = n ? tracks.find(x => x.id !== selfTrackId && (x.name || '').trim().toLowerCase() === n) : undefined;
  return t ? t.id : null;
}
