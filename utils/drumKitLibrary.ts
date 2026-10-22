/**
 * Kits de batterie de NOVA : ~2 000 sons courts (kicks, snares, 808, percussions…) et des kits
 * prêts à jouer, préparés par tools/kits/prepare_kits.py.
 *
 * - L'index (data/drum-kits/index.json) est chargé à la demande (import dynamique : son propre
 *   fichier, ~90 Ko, ~20 Ko compressé).
 * - Un son n'est téléchargé que quand on l'écoute ou qu'on le pose sur un pad, jamais tous d'un coup.
 *   Il est gardé dans le cache du navigateur (Cache API « nova-kits-v1 », sous sa forme brouillée :
 *   voir drumKitCodec.ts), puis en mémoire une fois décodé.
 * - Un pad qui utilise un son de kit garde seulement sa référence « kit:<id> » : aucun audio de kit
 *   n'est écrit dans une sauvegarde, un kit perso, la collaboration ou le cloud ; le poste qui rouvre
 *   le projet recharge le son depuis sa propre bibliothèque NOVA.
 * - Les 808 et les basses ont une hauteur connue : elles sont réaccordées sur la tonique du morceau.
 * - Les noms sont génériques (« Kick 12 », « 808 3 », kits « Trap 2 ») : rien de l'origine des sons.
 */
import type { DrumMachine, DrumRow } from './drumKits';
import { openKitContainer, KitCodecError } from './drumKitCodec';
import { mapPatternRecords, STEPS_PER_BAR } from './drumPatterns';
import { MAX_PADS, userSampleId } from './drumSamples';

export const KIT_REF_PREFIX = 'kit:';
export const KIT_BASE = '/drums/kits/';
export const KIT_EXT = '.nks';
export const KIT_CACHE = 'nova-kits-v1';
/** Type glissé d'un son de kit (navigateur de kits → pad, piste de batterie). */
export const KIT_DRAG_TYPE = 'application/x-nova-kit-sound';
/** Son de kit lâché sur la timeline : App le pose sur un nouveau pad de la boîte à rythmes. */
export const KIT_SOUND_DROP_EVENT = 'nova:kit-sound-drop';

export type KitCategory =
  | 'kick' | 'snare' | 'clap' | 'snap' | 'rim' | 'hihat' | 'openhat' | 'roll' | 'crash' | 'tom' | 'perc'
  | 'shaker' | '808' | 'bass' | 'fill' | 'vocal' | 'oneshot' | 'bongo' | 'conga' | 'djembe' | 'dundun'
  | 'balafon' | 'kalimba' | 'marimba' | 'udu';

export type KitRole =
  | 'kick' | 'snare' | 'clap' | 'hihat' | 'openhat' | '808' | 'perc' | 'rim' | 'crash' | 'tom'
  | 'shaker' | 'perc2' | 'snap' | 'roll' | 'vocal' | 'fill';

export interface KitSound {
  id: string;
  cat: KitCategory;
  num: number;
  /** Nom affiché : « Kick 12 ». */
  name: string;
  /** Durée (s). */
  dur: number;
  ch: 1 | 2;
  styles: string[];
  /** Note MIDI de la fondamentale (808 et basses), sinon absent. */
  midi?: number;
}

export interface KitDef {
  id: string;
  name: string;
  style: string;
  pads: Partial<Record<KitRole, string>>;
}

export interface KitIndex {
  categories: { id: KitCategory; label: string; count: number }[];
  styles: Record<string, string>;
  sounds: KitSound[];
  byId: Map<string, KitSound>;
  kits: KitDef[];
  totalBytes: number;
}

/** Nom d'un son par catégorie (même table que le script de préparation). */
export const KIT_SOUND_NAME: Record<KitCategory, string> = {
  kick: 'Kick', snare: 'Snare', clap: 'Clap', snap: 'Snap', rim: 'Rim', hihat: 'Hi-hat', openhat: 'Open hat',
  roll: 'Roll', crash: 'Crash', tom: 'Tom', perc: 'Perc', shaker: 'Shaker', '808': '808', bass: 'Bass',
  fill: 'Fill', vocal: 'Vox', oneshot: 'One-shot', bongo: 'Bongo', conga: 'Conga', djembe: 'Djembé',
  dundun: 'Dundun', balafon: 'Balafon', kalimba: 'Kalimba', marimba: 'Marimba', udu: 'Udu',
};

/** Crête visée par catégorie (dBFS), comme la bibliothèque d'origine : kicks / 808 devant, hats discrets. */
const KIT_PEAK_DB: Partial<Record<KitCategory, number>> = {
  kick: -3, snare: -3, clap: -4, snap: -6, rim: -6, hihat: -9, openhat: -10, roll: -9, crash: -11, tom: -4,
  perc: -6, shaker: -11, '808': -3, bass: -4, fill: -4, vocal: -6, oneshot: -6,
};
const PITCHED: ReadonlySet<KitCategory> = new Set(['808', 'bass']);

export const kitRef = (id: string) => `${KIT_REF_PREFIX}${id}`;
export const kitIdOf = (ref: string | undefined | null): string | null =>
  (ref && ref.startsWith(KIT_REF_PREFIX) ? ref.slice(KIT_REF_PREFIX.length) : null);
export const isKitRef = (ref: string | undefined | null) => !!kitIdOf(ref);
export const kitSoundUrl = (id: string) => `${KIT_BASE}${encodeURIComponent(id)}${KIT_EXT}`;
const catOfId = (id: string): KitCategory | null => {
  const c = /^([a-z0-9]+)-[0-9a-f]{8}$/.exec(id)?.[1];
  return c && c in KIT_SOUND_NAME ? (c as KitCategory) : null;
};

// ── Index ───────────────────────────────────────────────────────────────────────────────
type RawIndex = {
  categories: KitIndex['categories']; styles: Record<string, string>; totalBytes: number;
  sounds: [string, number, number, number, string[], number][]; kits: KitDef[];
};

export function parseKitIndex(raw: RawIndex): KitIndex {
  const sounds: KitSound[] = raw.sounds.map(([id, num, dur, ch, styles, midi]) => {
    const cat = catOfId(id) || 'perc';
    return { id, cat, num, name: `${KIT_SOUND_NAME[cat]} ${num}`, dur, ch: ch === 1 ? 1 : 2, styles, ...(midi ? { midi } : {}) };
  });
  return {
    categories: raw.categories, styles: raw.styles, sounds, kits: raw.kits, totalBytes: raw.totalBytes,
    byId: new Map(sounds.map(s => [s.id, s])),
  };
}

let indexPromise: Promise<KitIndex> | null = null;
let indexLoaded: KitIndex | null = null;
const indexListeners = new Set<() => void>();

/** Index des kits (chargé une seule fois). */
export function loadKitIndex(): Promise<KitIndex> {
  if (!indexPromise) {
    indexPromise = import('../data/drum-kits/index.json')
      .then(m => parseKitIndex(((m as any).default || m) as RawIndex))
      .then(ix => { indexLoaded = ix; indexListeners.forEach(f => f()); return ix; });
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}
export const kitIndexIfLoaded = () => indexLoaded;
/** Pour les tests. */
export function setKitIndexForTests(ix: KitIndex | null) { indexLoaded = ix; indexPromise = ix ? Promise.resolve(ix) : null; }

/** Nom affiché d'une référence « kit:<id> » (« Kick 12 »), ou null si ce n'est pas un son de kit. */
export function kitSoundLabel(ref: string | undefined | null): string | null {
  const id = kitIdOf(ref);
  if (!id) return null;
  const s = indexLoaded?.byId.get(id);
  if (s) return s.name;
  const cat = catOfId(id);
  return cat ? `${KIT_SOUND_NAME[cat]} (kit)` : 'Son de kit';
}

// ── Téléchargement + cache ─────────────────────────────────────────────────────────────
export type KitSoundErrorCode = 'offline' | 'missing' | 'format' | 'crypto' | 'decode';
export class KitSoundError extends Error {
  constructor(public code: KitSoundErrorCode, message: string) { super(message); this.name = 'KitSoundError'; }
}
export const KIT_ERROR_TEXT: Record<KitSoundErrorCode, string> = {
  offline: "Hors ligne : ce son n'a encore jamais été écouté sur cet appareil. Reconnecte-toi pour le charger ; les sons déjà écoutés restent disponibles.",
  missing: 'Son introuvable sur le serveur. Recharge NOVA (une nouvelle version est peut-être en ligne) ou choisis un autre son.',
  format: 'Son illisible. Recharge NOVA ; si le problème continue, choisis un autre son et signale-le.',
  crypto: 'Ce navigateur ne peut pas ouvrir les sons des kits : ouvre NOVA en https (adresse sécurisée).',
  decode: 'Ce navigateur ne sait pas lire ce son. Mets-le à jour (Chrome, Edge, Safari récents) ou choisis un autre son.',
};
const err = (code: KitSoundErrorCode) => new KitSoundError(code, KIT_ERROR_TEXT[code]);

const inflight = new Map<string, Promise<ArrayBuffer>>();
let fetchCount = 0;
/** Nombre de téléchargements réseau effectués (tests / QA : preuve du chargement à la demande). */
export const kitFetchCount = () => fetchCount;

async function openCache(): Promise<Cache | null> {
  try { return typeof caches !== 'undefined' ? await caches.open(KIT_CACHE) : null; } catch { return null; }
}

/** Octets brouillés d'un son (cache d'abord, sinon réseau puis mise en cache). */
export const fetchKitBytes = (id: string): Promise<ArrayBuffer> => fetchScrambled(kitSoundUrl(id));

/**
 * Octets brouillés (« NVK1 ») servis à `url` : kits NOVA (/drums/kits/) et batterie du studio
 * (/drums/lib/, même mécanisme). Cache API « nova-kits-v1 » d'abord, sinon réseau puis mise en cache.
 */
export function fetchScrambled(url: string): Promise<ArrayBuffer> {
  let p = inflight.get(url);
  if (p) return p;
  p = (async () => {
    const cache = await openCache();
    const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
    if (hit) return hit.arrayBuffer();
    let res: Response;
    try {
      if (url.startsWith(KIT_BASE)) fetchCount++;
      res = await fetch(url, { credentials: 'same-origin' });
    } catch {
      throw err(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'offline');
    }
    // Vercel renvoie index.html (200) pour un fichier absent : on le reconnaît au type.
    if (!res.ok || /text\/html/i.test(res.headers.get('content-type') || '')) throw err('missing');
    const buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (!(head[0] === 0x4e && head[1] === 0x56 && head[2] === 0x4b && head[3] === 0x31)) throw err('missing');
    if (cache) {
      cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => { /* quota : tant pis */ });
    }
    return buf;
  })();
  inflight.set(url, p);
  p.finally(() => inflight.delete(url)).catch(() => {});
  return p;
}

// ── Décodage, niveau, accordage ────────────────────────────────────────────────────────
function normalizePeak(buf: AudioBuffer, db: number): AudioBuffer {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; }
  }
  if (pk <= 0) return buf;
  const g = Math.pow(10, db / 20) / pk;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return buf;
}

/**
 * Demi-tons pour amener une note (MIDI) sur la tonique `root` (0-11 ou MIDI), au plus près
 * (-6 … +5) : une 808 en Fa# sur un morceau en La monte de 3 demi-tons.
 */
export function tuneToRoot(midi: number, root: number): number {
  const d = (((Math.round(root) % 12) - (Math.round(midi) % 12)) % 12 + 12) % 12;
  return d > 5 ? d - 12 : d;
}

/** Nom de note (« F#1 ») d'un numéro MIDI. */
export const midiNoteName = (m: number) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
export const PITCH_CLASS_FR = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

async function retune(buf: AudioBuffer, semitones: number): Promise<AudioBuffer> {
  if (!semitones || typeof OfflineAudioContext === 'undefined') return buf;
  const rate = Math.pow(2, semitones / 12);
  const len = Math.max(1, Math.ceil(buf.length / rate));
  const off = new OfflineAudioContext(buf.numberOfChannels, len, buf.sampleRate);
  const src = off.createBufferSource();
  src.buffer = buf; src.playbackRate.value = rate;
  src.connect(off.destination); src.start(0);
  return off.startRendering();
}

const decoded = new Map<string, Promise<AudioBuffer>>();
let openMs = 0, decodeMs = 0, decodeN = 0;
/** Coût moyen par son, en ms : ouverture du conteneur (déchiffrement) et décodage audio (mesure). */
export const kitDecodeStats = () => ({ count: decodeN, avgOpenMs: decodeN ? openMs / decodeN : 0, avgDecodeMs: decodeN ? decodeMs / decodeN : 0 });
// Scénarios de bout en bout (serveur de développement seulement) : coût mesuré dans le navigateur.
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__novaKits = { stats: kitDecodeStats, fetches: () => fetchCount };

/**
 * Son prêt à jouer d'une référence « kit:<id> ». `root` = tonique du morceau : les 808 et les basses
 * y sont réaccordées (au plus près), les autres sons l'ignorent.
 */
export function loadKitSound(ref: string, ctx: BaseAudioContext, root = 0): Promise<AudioBuffer> {
  const id = kitIdOf(ref);
  if (!id) return Promise.reject(err('missing'));
  const cat = catOfId(id);
  const pitched = !!cat && PITCHED.has(cat);
  const key = `${id}|${ctx.sampleRate}|${pitched ? root : ''}`;
  let p = decoded.get(key);
  if (!p) {
    p = (async () => {
      const ix = pitched ? await loadKitIndex().catch(() => null) : null;
      const bytes = await fetchKitBytes(id);
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      let flac: ArrayBuffer;
      try { flac = await openKitContainer(bytes); } catch (e) {
        throw err(e instanceof KitCodecError && e.code === 'crypto' ? 'crypto' : 'format');
      }
      const t1 = typeof performance !== 'undefined' ? performance.now() : 0;
      let buf: AudioBuffer;
      try { buf = await ctx.decodeAudioData(flac); } catch { throw err('decode'); }
      if (typeof performance !== 'undefined') { openMs += t1 - t0; decodeMs += performance.now() - t1; decodeN++; }
      normalizePeak(buf, (cat && KIT_PEAK_DB[cat]) ?? -6);
      const midi = ix?.byId.get(id)?.midi;
      if (pitched && midi) buf = await retune(buf, tuneToRoot(midi, root));
      return buf;
    })();
    decoded.set(key, p);
    p.catch(() => decoded.delete(key));
    if (decoded.size > 160) decoded.delete(decoded.keys().next().value as string);
  }
  return p;
}

// ── Favoris (par appareil) ─────────────────────────────────────────────────────────────
const FAV_KEY = 'nova_kit_favs';
export function kitFavorites(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
}
export function toggleKitFavorite(id: string): Set<string> {
  const s = kitFavorites();
  if (s.has(id)) s.delete(id); else s.add(id);
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch { /* stockage plein ou bloqué */ }
  return s;
}

// ── Recherche ──────────────────────────────────────────────────────────────────────────
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Filtre les sons : texte libre (« kick 12 », « 808 fa », « afro conga »), catégorie, style, favoris. */
export function searchKitSounds(ix: KitIndex, q: { text?: string; cat?: string; style?: string; favs?: Set<string> | null }): KitSound[] {
  const words = fold(q.text || '').split(/\s+/).filter(Boolean);
  const catLabel = new Map(ix.categories.map(c => [c.id, fold(c.label)]));
  return ix.sounds.filter(s => {
    if (q.cat && s.cat !== q.cat) return false;
    if (q.style && !s.styles.includes(q.style)) return false;
    if (q.favs && !q.favs.has(s.id)) return false;
    if (!words.length) return true;
    const note = s.midi ? `${fold(midiNoteName(s.midi))} ${fold(PITCH_CLASS_FR[s.midi % 12])}` : '';
    const hay = `${fold(s.name)} ${s.cat} ${catLabel.get(s.cat) || ''} ${s.styles.map(st => fold(ix.styles[st] || st)).join(' ')} ${note}`;
    return words.every(w => (/^\d+$/.test(w) ? hay.split(/\s+/).includes(w) : hay.includes(w)));
  });
}

// ── Kits → pads de la boîte à rythmes ──────────────────────────────────────────────────
/** Pads remplis par « Charger ce kit » (rôle du kit → pad de la boîte à rythmes). */
export const KIT_PAD_LAYOUT: { role: KitRole; id: string; name: string; choke?: number; volume?: number; pan?: number }[] = [
  { role: 'kick', id: 'kick', name: 'Kick' },
  { role: 'snare', id: 'snare', name: 'Snare' },
  { role: 'clap', id: 'clap', name: 'Clap' },
  { role: 'hihat', id: 'hatc', name: 'Hi-hat fermé', choke: 1, volume: 0.7, pan: 0.15 },
  { role: 'openhat', id: 'hato', name: 'Hi-hat ouvert', choke: 1, volume: 0.6, pan: 0.15 },
  { role: 'perc', id: 'perc', name: 'Perc', volume: 0.7, pan: -0.2 },
  { role: 'rim', id: 'fx', name: 'Rim', volume: 0.7, pan: -0.1 },
  { role: '808', id: 'k808', name: '808', volume: 0.85 },
  { role: 'crash', id: 'crash', name: 'Crash', volume: 0.6 },
  { role: 'tom', id: 'tom', name: 'Tom', volume: 0.75, pan: 0.1 },
  { role: 'shaker', id: 'shaker', name: 'Shaker', volume: 0.6, pan: 0.25 },
  { role: 'perc2', id: 'perc2', name: 'Perc 2', volume: 0.7, pan: 0.2 },
];

/** Nom d'un pad chargé depuis un kit : le nom du son (« Kick 12 », « Snap 7 »), court pour la grille. */
const padName = (base: string, s?: KitSound) => (s ? s.name : base);

/**
 * Charge un kit dans la boîte à rythmes. Les pads du kit remplacent les pads de même rôle et gardent
 * leurs pas (dans tous les motifs) ; les pads perso (samples importés) sont gardés à la suite.
 * Une seule étape d'annulation côté App (un seul onChange).
 */
export function applyKitDef(dm: DrumMachine, kit: KitDef, ix: KitIndex | null): DrumMachine {
  const bars = dm.bars || 1;
  const len = STEPS_PER_BAR * bars;
  const old = dm.rows;
  const rows: DrumRow[] = [];
  for (const slot of KIT_PAD_LAYOUT) {
    const sid = kit.pads[slot.role];
    if (!sid) continue;
    const prev = old.find(r => r.id === slot.id);
    const s = ix?.byId.get(sid);
    rows.push({
      ...(prev ? { ...prev, start: undefined, end: undefined, fadeIn: undefined, fadeOut: undefined, reverse: undefined, slice: undefined, smp: undefined } : {}),
      id: slot.id, name: padName(slot.name, s), sound: kitRef(sid),
      steps: prev ? [...prev.steps] : new Array(len).fill(0),
      ratchet: prev ? [...prev.ratchet] : new Array(len).fill(1),
      volume: prev?.volume ?? slot.volume ?? 0.85, pan: prev?.pan ?? slot.pan ?? 0,
      ...(slot.choke ? { choke: slot.choke } : {}),
      tune: 0, decay: prev?.decay ?? 1,
    } as DrumRow);
  }
  const ids = new Set(rows.map(r => r.id));
  for (const r of old) {
    if (rows.length >= MAX_PADS) break;
    if (!ids.has(r.id) && userSampleId(r.sound)) { rows.push(r); ids.add(r.id); }
  }
  const keep = (rec: Record<string, number[]>) => Object.fromEntries(Object.entries(rec).filter(([k]) => ids.has(k)));
  const patterns = dm.patterns?.map(p => mapPatternRecords(p, keep));
  const used = new Set(rows.map(r => userSampleId(r.sound)).filter(Boolean) as string[]);
  const samples = dm.samples ? Object.fromEntries(Object.entries(dm.samples).filter(([k]) => used.has(k))) : dm.samples;
  return { ...dm, kitId: `nova:${kit.id}`, rows, ...(patterns ? { patterns } : {}), ...(samples ? { samples } : {}) };
}

/** Pose un son de kit sur un pad existant (ou un nouveau pad si `rowIndex` est null). */
export function setPadKitSound(dm: DrumMachine, id: string, rowIndex: number | null, ix: KitIndex | null): { dm: DrumMachine; rowIndex: number } | null {
  const s = ix?.byId.get(id);
  const reset = { start: undefined, end: undefined, fadeIn: undefined, fadeOut: undefined, reverse: undefined, slice: undefined };
  const label = s?.name || kitSoundLabel(kitRef(id)) || 'Son de kit';
  if (rowIndex !== null && dm.rows[rowIndex]) {
    const rows = dm.rows.map((r, i) => (i === rowIndex ? { ...r, ...reset, sound: kitRef(id), name: label, tune: 0, decay: 1 } : r));
    const used = new Set(rows.map(r => userSampleId(r.sound)).filter(Boolean) as string[]);
    const samples = dm.samples ? Object.fromEntries(Object.entries(dm.samples).filter(([k]) => used.has(k))) : dm.samples;
    return { dm: { ...dm, rows, ...(samples ? { samples } : {}) }, rowIndex };
  }
  if (dm.rows.length >= MAX_PADS) return null;
  const len = STEPS_PER_BAR * (dm.bars || 1);
  let n = dm.rows.length + 1, rid = `kit${n}`;
  while (dm.rows.some(r => r.id === rid)) rid = `kit${++n}`;
  const row: DrumRow = { id: rid, name: label, sound: kitRef(id), steps: new Array(len).fill(0), ratchet: new Array(len).fill(1), volume: 0.85, pan: 0 };
  return { dm: { ...dm, rows: [...dm.rows, row] }, rowIndex: dm.rows.length };
}

/**
 * La piste joue-t-elle des sons des kits NOVA ? (boîte à rythmes, sampler chargé depuis un pad de kit).
 * Une telle piste n'est JAMAIS rendue dans un fichier audio (gel, commit, impression, AAF, zip) :
 * les sons des kits ne sortent du DAW que dans un export payant (mix / stems).
 */
export function usesKitSounds(t: { drumMachine?: DrumMachine | null; melodicSampler?: { kitRef?: string } | null } | null | undefined): boolean {
  if (!t) return false;
  if (t.melodicSampler?.kitRef) return true;
  return !!t.drumMachine?.rows?.some(r => isKitRef(r.sound));
}

export const KIT_BAKE_REFUSAL = 'Les sons des kits NOVA restent dans la boîte à rythmes : ils ne sont jamais rendus en fichier audio (gel, impression, sauvegarde). Exporte le morceau ou les stems pour les avoir en audio.';
