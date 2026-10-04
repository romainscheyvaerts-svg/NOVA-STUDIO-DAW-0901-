/**
 * Autotune du PC (VST3 tiers via le pont) à la place de l'autotune de NOVA.
 *
 * Logique pure (sans navigateur ni pont), testée dans tests/autotuneVst.test.ts :
 *  1. detectAutotunes()      : reconnaît les autotunes parmi les plugins scannés
 *                              (nom + éditeur), les classe par préférence et
 *                              applique la liste d'exclusion (Slate sauf MetaTune…).
 *  2. parseKeyText()         : « F# minor », « Bbm », « Fa# mineur », « B HAMONIC minor »…
 *  3. resolveAutotuneSettings() : à partir des paramètres RÉELS lus sur le plugin
 *                              (introspection du pont v7 : noms, valeurs texte, listes
 *                              de choix), calcule les réglages tonalité / gamme /
 *                              vitesse / mélange / basse latence. Aucun index codé
 *                              en dur : un tableau de correspondance par plugin
 *                              (AUTOTUNE_PROFILES) donne les noms préférés, et une
 *                              recherche générique prend le relais pour un plugin
 *                              inconnu.
 *
 * Vitesse de correction (documentée, d'après le guide Antares « How to build a
 * professional rap and R&B vocal chain » et les styles de NOVA) :
 *   style NOVA        speed  →  retune      humanize   mélange  usage
 *   Trap autotune     0      →  0 ms        0          100 %    effet robot / trap
 *   (réglage défaut)  0,10   →  10 ms       20         100 %    correction nette
 *   Drill             0,25   →  25 ms       30         50 %     discret
 *   Chant / R&B       0,35   →  35 ms       45 (+Flex) 100 %    naturel
 * Règle : retune (ms) = speed × 100, humanize = humanize × 100, mélange = mix × 100,
 * bornés à la plage du plugin. Flex-Tune (Antares) : 0 en dessous de 25 ms, 25 au-delà
 * (garde les glissés naturels des styles chantés).
 */

// ─── Plugins vus par le pont ─────────────────────────────────────────────────

export interface ScannedPlugin {
  id: string;
  name: string;
  vendor: string;
  path: string;
  pluginName?: string | null;
  category?: string;
  isInstrument?: boolean | null;
  license?: 'activation' | 'nag' | null;
  scanStatus?: string | null;
}

export type AutotuneFamily = 'antares' | 'metatune' | 'waves-tune' | 'graillon' | 'little-alterboy' | 'other';

export interface AutotuneCandidate {
  /** Identifiant stable (chemin + nom de classe) : sert à mémoriser le choix. */
  key: string;
  id: string;
  name: string;
  vendor: string;
  path: string;
  pluginName: string | null;
  family: AutotuneFamily;
  /** Plus petit = préféré (Auto-Tune Pro d'abord). */
  rank: number;
  /** Le plugin sait suivre une gamme (faux pour Little AlterBoy : demi-tons seulement). */
  followsKey: boolean;
  /** Raison pour laquelle il n'est pas utilisable maintenant (licence…), sinon null. */
  unavailable: string | null;
  /**
   * Le pont a déjà vu une fenêtre de licence pour ce plugin (souvent à l'ancienne
   * lecture en arrière-plan). Pas bloquant : NOVA l'essaie en chargement discret
   * (aucune fenêtre ne surgit) et ne le note « non disponible » que s'il redemande
   * une licence.
   */
  licenseHint: string | null;
}

/** Éditeur lisible : celui du scan, sinon déduit du nom / du dossier. */
export const vendorOf = (p: Pick<ScannedPlugin, 'vendor' | 'path' | 'name'>): string => {
  if (p.vendor && p.vendor.trim()) return p.vendor.trim();
  const path = (p.path || '').replace(/\\/g, '/');
  if (/\/slate digital\//i.test(path)) return 'Slate Digital';
  if (/waveshell/i.test(path)) return 'Waves';
  if (/\/uaudio_/i.test(path)) return 'Universal Audio';
  if (/auto-?tune/i.test(p.name)) return 'Antares';
  return '';
};

interface FamilyRule {
  family: AutotuneFamily;
  test: (name: string, vendor: string) => boolean;
  /** Rang dans la famille (Pro avant Artist…), ajouté au rang de la famille. */
  sub?: (name: string) => number;
  followsKey?: boolean;
}

const FAMILY_RANK: Record<AutotuneFamily, number> = {
  antares: 0, metatune: 100, 'waves-tune': 200, graillon: 300, other: 400, 'little-alterboy': 500,
};

const n = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const FAMILY_RULES: FamilyRule[] = [
  {
    family: 'antares',
    // Auto-Tune Pro / Pro X / Artist / Access / EFX+ / Hybrid / Unlimited.
    // Pas Auto-Key (détecteur de tonalité), ni Harmony Engine, ni Slice (instrument),
    // ni Mic Mod, ni Vocal Studio sans le mot « Tune ».
    test: (name) => /auto[\s-]?tune/.test(n(name)) && !/(key|harmony|slice|mic ?mod|vocodist|duo)/.test(n(name)),
    sub: (name) => {
      const x = n(name);
      if (/pro/.test(x)) return 0;
      if (/artist/.test(x)) return 1;
      if (/hybrid/.test(x)) return 2;
      if (/efx/.test(x)) return 3;
      if (/access/.test(x)) return 4;
      return 5;
    },
  },
  { family: 'metatune', test: (name) => /meta\s*tune/.test(n(name)) },
  {
    family: 'waves-tune',
    test: (name, vendor) => /waves\s*tune/.test(n(name)) || (/waves/.test(n(vendor)) && /^tune\b/.test(n(name))),
    // Real-Time d'abord (Waves Tune « tout court » demande une capture), mono avant stéréo.
    sub: (name) => (/real/.test(n(name)) ? 0 : 5) + (/stereo/.test(n(name)) ? 1 : 0),
  },
  { family: 'graillon', test: (name) => /graillon/.test(n(name)) },
  { family: 'little-alterboy', test: (name) => /little\s*alter\s*boy/.test(n(name)), followsKey: false },
  { family: 'other', test: (name) => /(mautopitch|gsnap|pitch ?correct|autotalent|auto ?pitch)/.test(n(name)) },
];

/** Jamais proposés comme autotune temps réel. */
const NOT_AUTOTUNE = /(melodyne|auto[\s-]?key|tuner\b|bx_tuner|meta ?pitch|harmony engine)/;

/** Famille d'autotune d'un plugin, ou null. */
export const autotuneFamilyOf = (name: string, vendor = ''): FamilyRule | null => {
  if (NOT_AUTOTUNE.test(n(name))) return null;
  return FAMILY_RULES.find(r => r.test(name, vendor)) || null;
};

// ─── Exclusions (éditeurs / plugins sans licence) ─────────────────────────────

export interface ExclusionList {
  /** Éditeurs exclus (comparaison sans casse, « SSL » couvre « Solid State Logic »). */
  vendors: string[];
  /** Plugins exclus par nom (sous-chaîne, sans casse). */
  plugins: string[];
  /** Exceptions : plugins autorisés même si leur éditeur est exclu. */
  allow: string[];
}

/**
 * Réglage par défaut de ce studio : Romain n'a pas les licences Slate Digital,
 * SAUF MetaTune et VerbSuite Classics ; Solid State Logic exclu par sécurité.
 */
export const DEFAULT_EXCLUSIONS: ExclusionList = {
  vendors: ['Slate Digital', 'Solid State Logic', 'SSL'],
  plugins: [],
  allow: ['MetaTune', 'VerbSuite Classics'],
};

const sameVendor = (a: string, b: string) => {
  const x = n(a).replace(/[^a-z0-9]/g, '');
  const y = n(b).replace(/[^a-z0-9]/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const ssl = (v: string) => v === 'ssl' || v === 'solidstatelogic';
  return ssl(x) && ssl(y);
};

/** Le plugin est-il exclu (éditeur ou nom), compte tenu des exceptions ? */
export const isExcluded = (p: Pick<ScannedPlugin, 'name' | 'vendor' | 'path'>, ex: ExclusionList = DEFAULT_EXCLUSIONS): boolean => {
  const name = n(p.name || '');
  if (ex.allow.some(a => a.trim() && name.includes(n(a.trim())))) return false;
  if (ex.plugins.some(x => x.trim() && name.includes(n(x.trim())))) return true;
  const vendor = vendorOf(p);
  // Éditeur vide : le dossier « Slate Digital » ou le préfixe « SSL » trahissent l'éditeur.
  if (ex.vendors.some(v => sameVendor(v, vendor))) return true;
  if (ex.vendors.some(v => sameVendor(v, 'SSL')) && /^ssl\b/.test(name)) return true;
  return false;
};

export const candidateKey = (p: Pick<ScannedPlugin, 'path' | 'pluginName' | 'name'>) => `${p.path}#${p.pluginName || p.name}`;

/**
 * Autotunes utilisables parmi les plugins scannés, du préféré au moins préféré :
 * 1) Antares (Pro, puis Artist, Hybrid, EFX, Access), 2) Slate MetaTune,
 * 3) Waves Tune (Real-Time d'abord), 4) Graillon, 5) autres, 6) Little AlterBoy
 * (ne suit pas la gamme). Exclus : liste d'exclusion, instruments.
 * `unavailable` : plugins notés « non disponibles » par NOVA (licence redemandée
 * en chargement discret, plantage, gamme non réglable) ou qui plantent au scan ;
 * ils restent listés (grisés) mais ne sont jamais chargés tout seuls.
 */
export const detectAutotunes = (
  plugins: ScannedPlugin[],
  opts: { exclusions?: ExclusionList; unavailable?: Record<string, string> } = {},
): AutotuneCandidate[] => {
  const ex = opts.exclusions || DEFAULT_EXCLUSIONS;
  const seen = new Set<string>();
  const out: AutotuneCandidate[] = [];
  for (const p of plugins || []) {
    if (!p || !p.name || !p.path) continue;
    if (p.isInstrument === true || p.category === 'Instrument') continue;
    const vendor = vendorOf(p);
    const rule = autotuneFamilyOf(p.name, vendor);
    if (!rule) continue;
    if (isExcluded(p, ex)) continue;
    const key = candidateKey(p);
    // Même plugin en plusieurs exemplaires (deux versions de WaveShell…) : un seul.
    const dedupe = `${n(p.name)}|${n(vendor)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const marked = opts.unavailable?.[key] || null;
    const lic = p.license === 'activation' ? 'Licence à vérifier' : p.license === 'nag' ? 'Version d’essai ou licence à vérifier' : null;
    const scan = p.scanStatus === 'crash' || p.scanStatus === 'hang' ? 'Ne se charge pas' : null;
    out.push({
      key, id: p.id, name: p.name, vendor, path: p.path, pluginName: p.pluginName ?? null,
      family: rule.family, rank: FAMILY_RANK[rule.family] + (rule.sub ? rule.sub(p.name) : 0),
      followsKey: rule.followsKey !== false, unavailable: marked || scan, licenseHint: lic,
    });
  }
  out.sort((a, b) => (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0) || a.rank - b.rank || a.name.localeCompare(b.name));
  return out;
};

/** Premier autotune utilisable (pour la présélection « Recommandé »). */
export const recommendedAutotune = (c: AutotuneCandidate[]): AutotuneCandidate | null =>
  c.find(x => !x.unavailable && x.followsKey) || null;

// ─── Tonalités ───────────────────────────────────────────────────────────────

/** Gammes de NOVA (AutoTunePlugin.SCALES). PENTATONIC = pentatonique mineure. */
export type NovaScale = 'CHROMATIC' | 'MAJOR' | 'MINOR' | 'MINOR_HARMONIC' | 'PENTATONIC';

export const SCALE_PITCHES: Record<NovaScale, number[]> = {
  CHROMATIC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  MAJOR: [0, 2, 4, 5, 7, 9, 11],
  MINOR: [0, 2, 3, 5, 7, 8, 10],
  MINOR_HARMONIC: [0, 2, 3, 5, 7, 8, 11],
  PENTATONIC: [0, 3, 5, 7, 10],
};

export const pitchClassesOf = (root: number, scale: NovaScale): number[] =>
  (SCALE_PITCHES[scale] || SCALE_PITCHES.CHROMATIC).map(i => (((root + i) % 12) + 12) % 12).sort((a, b) => a - b);

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SOLFEGE: [RegExp, number][] = [[/^do/, 0], [/^re/, 2], [/^mi/, 4], [/^fa/, 5], [/^sol/, 7], [/^la/, 9], [/^si/, 11]];

/**
 * Note écrite → classe de hauteur (0 = do). Accepte « F# », « F♯ », « Gb », « G♭ »,
 * « C#/Db », « F sharp », « Fa# », « Sib », « Ré bémol ». null si illisible.
 */
export const parseNote = (raw: string): number | null => {
  if (raw === undefined || raw === null) return null;
  let s = n(String(raw)).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  s = s.split(/[\/|]/)[0].trim(); // « C#/Db » → « C# »
  if (!s) return null;
  let base: number | null = null;
  let rest = '';
  const sol = SOLFEGE.find(([re]) => re.test(s));
  if (sol) {
    base = sol[1];
    rest = s.replace(sol[0], '');
  } else if (/^[a-g]/.test(s)) {
    base = LETTER[s[0]];
    rest = s.slice(1);
  }
  if (base === null) return null;
  rest = rest.trim();
  let acc = 0;
  if (/^(#|\s*sharp|\s*diese|\s*dièse)/.test(rest)) acc = 1;
  else if (/^(b(?![a-z])|\s*flat|\s*bemol|\s*bémol|b\s)/.test(rest) || rest === 'b') acc = -1;
  return (base + acc + 12) % 12;
};

/**
 * Tonalité écrite (catalogue des beats, saisie de l'artiste) → {root, scale}.
 * « F# minor », « B MIN », « Bbm », « C # minor », « B HAMONIC minor » (faute du
 * catalogue), « Fa# mineur », « Do majeur », « A minor pentatonic ».
 */
export const parseKeyText = (raw?: string | null): { root: number; scale: NovaScale } | null => {
  if (!raw) return null;
  const t = n(String(raw)).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const m = t.match(/^(do|re|mi|fa|sol|la|si|[a-g])\s*(#|♯|b(?![a-z]{2})|♭|sharp|flat|diese|bemol)?/);
  if (!m) return null;
  const root = parseNote(`${m[1]}${m[2] === undefined ? '' : (/^(#|♯|sharp|diese)$/.test(m[2]) ? '#' : 'b')}`);
  if (root === null) return null;
  const after = t.slice(m[0].length);
  let scale: NovaScale;
  if (/harm|hamonic/.test(after)) scale = 'MINOR_HARMONIC';
  else if (/penta/.test(after)) scale = /maj/.test(after) ? 'MAJOR' : 'PENTATONIC';
  else if (/chrom/.test(after)) scale = 'CHROMATIC';
  else if (/maj|major|majeur|\bM\b/.test(after) || /^\s*M$/.test(String(raw).trim().slice(m[0].length))) scale = 'MAJOR';
  else if (/min|mineur|^\s*m\b/.test(after)) scale = 'MINOR';
  else scale = 'MINOR'; // le catalogue est très majoritairement en mineur
  return { root, scale };
};

const NOMS_FR = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const NOMS_EN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const GAMMES_FR: Record<NovaScale, string> = {
  MAJOR: 'majeur', MINOR: 'mineur', MINOR_HARMONIC: 'mineur harmonique', PENTATONIC: 'penta mineure', CHROMATIC: 'chromatique',
};
/** « F# mineur » (notation anglaise des notes, comme sur les fiches des beats). */
export const keyLabel = (root?: number, scale?: string): string => {
  if (typeof root !== 'number' || !Number.isFinite(root)) return '';
  const s = (scale || 'MINOR') as NovaScale;
  if (s === 'CHROMATIC') return 'chromatique';
  return `${NOMS_EN[((Math.round(root) % 12) + 12) % 12]} ${GAMMES_FR[s] || ''}`.trim();
};
export const keyLabelFr = (root?: number, scale?: string): string => {
  if (typeof root !== 'number' || !Number.isFinite(root)) return '';
  const s = (scale || 'MINOR') as NovaScale;
  if (s === 'CHROMATIC') return 'chromatique';
  return `${NOMS_FR[((Math.round(root) % 12) + 12) % 12]} ${GAMMES_FR[s] || ''}`.trim();
};

// ─── Paramètres lus sur le plugin (pont v7) ─────────────────────────────────

export interface VstParam {
  /** Clé du paramètre (pedalboard), ex. « retune_speed_ms ». */
  name: string;
  displayName?: string;
  /** Valeur brute 0–1. */
  value: number;
  /** Valeur affichée par le plugin (« F# », « Minor », « 20 »). */
  text: string;
  numSteps?: number;
  isBoolean?: boolean;
  isDiscrete?: boolean;
  /** [min, max, pas] dans l'unité du plugin, si connue. */
  range?: [number | null, number | null, number | null];
  /** Choix possibles (paramètres à crans). */
  values?: string[];
}

export interface ParamSetting {
  name: string;
  text?: string;
  real?: number;
  /** Pourquoi ce réglage (journal, tests). */
  why: string;
}

export interface AutotuneTarget {
  root: number;
  scale: NovaScale;
  /** 0–1 (NOVA). 0 = robot. */
  speed: number;
  humanize: number;
  mix: number;
  /** Mode faible latence du plugin (par défaut : oui, réglage de Romain). */
  lowLatency: boolean;
}

export interface ResolvedAutotune {
  settings: ParamSetting[];
  /** Réglages à vérifier après relecture (tonalité, gamme, notes). */
  verify: { name: string; expect: string | boolean }[];
  /** Comment la gamme est réglée : liste de gammes, notes une à une, ou impossible. */
  keyMethod: 'scale-list' | 'note-toggles' | 'none';
  /** La gamme demandée n'existe pas dans le plugin : gamme voisine prise (ex. mineur). */
  approximated: string | null;
}

/** Correspondance par plugin : noms de paramètres préférés (lus par introspection). */
export interface AutotuneProfile {
  family: AutotuneFamily;
  test: RegExp;
  keyParams: string[];
  scaleParams: string[];
  retune?: { param: string; unit: 'ms' };
  humanize?: string;
  flex?: string;
  mix?: { param: string; percent: boolean };
  lowLatency?: { param: string; on: string | boolean; off: string | boolean };
  /** Réglages fixes sûrs (mode automatique plutôt que graphique…). */
  fixed?: { name: string; text: string; why: string }[];
}

/**
 * Tableau de correspondance (vérifié le 04/10/2026 sur ce PC par l'introspection du
 * pont : Auto-Tune Pro 120 paramètres, MetaTune 21). Waves Tune Real-Time, Graillon
 * et Little AlterBoy : pas installés ici, noms laissés à la recherche générique.
 */
export const AUTOTUNE_PROFILES: AutotuneProfile[] = [
  {
    family: 'antares', test: /auto[\s-]?tune/i,
    keyParams: ['key'],
    // « modern_scale » (Chromatic, Major, Minor, Harmonic Minor…) est la gamme active
    // d'Auto-Tune Pro ; « scale » (Major/Minor + tempéraments) n'agit pas quand
    // modern_scale est choisie (mesuré : seule modern_scale déplace les notes).
    scaleParams: ['modern_scale', 'scale'],
    retune: { param: 'retune_speed_ms', unit: 'ms' },
    humanize: 'humanize',
    flex: 'flex_tune',
    mix: { param: 'wet_dry_mix', percent: true },
    // Low Latency d'Auto-Tune Pro : 2 670 → 112 échantillons annoncés (mesuré).
    lowLatency: { param: 'latency_removal', on: 'On', off: 'Off' },
    fixed: [
      { name: 'correction_mode', text: 'Auto mode', why: 'mode automatique (pas le mode graphique)' },
      { name: 'master_bypass', text: 'Off', why: 'plugin actif' },
      { name: 'hp_bypass_harmony_player', text: 'On', why: 'pas d’harmonies ajoutées' },
    ],
  },
  {
    family: 'metatune', test: /meta\s*tune/i,
    keyParams: [], scaleParams: [],          // gamme = 12 interrupteurs de notes (c, c_sharp_db…)
    retune: { param: 'speed', unit: 'ms' },
    mix: { param: 'amount', percent: true },
    fixed: [{ name: 'bypass', text: 'Off', why: 'plugin actif' }],
  },
];

export const profileFor = (name: string): AutotuneProfile | null => AUTOTUNE_PROFILES.find(p => p.test.test(name)) || null;

const SCALE_SYNONYMS: Record<NovaScale, string[]> = {
  MAJOR: ['major', 'maj', 'ionian', 'majeur'],
  MINOR: ['minor', 'min', 'natural minor', 'aeolian', 'mineur'],
  MINOR_HARMONIC: ['harmonic minor', 'minor harmonic', 'harm minor', 'harm. minor', 'harmonicminor', 'mineur harmonique'],
  PENTATONIC: ['minor pentatonic', 'pentatonic minor', 'min pentatonic', 'minor penta'],
  CHROMATIC: ['chromatic', 'chromatique'],
};
const norm = (s: string) => n(s).replace(/[\s_.\-]+/g, ' ').trim();

const findValue = (values: string[] | undefined, scale: NovaScale): string | null => {
  if (!values) return null;
  for (const syn of SCALE_SYNONYMS[scale]) {
    const hit = values.find(v => norm(v) === norm(syn));
    if (hit) return hit;
  }
  return null;
};

const findNoteValue = (values: string[] | undefined, pc: number): string | null => {
  if (!values) return null;
  return values.find(v => parseNote(v) === pc) || null;
};

const isNoteList = (p: VstParam) => {
  const v = p.values || [];
  if (v.length < 12 || v.length > 24) return false;
  return new Set(v.map(parseNote).filter(x => x !== null)).size === 12;
};

const ignoredParam = (name: string) => /^(hp_|object_)/.test(name);

/** Paramètre interrupteur d'une note : « c », « c_sharp_db », « a_sharp_bb », « C#/Db »… */
export const noteOfToggle = (p: VstParam): number | null => {
  const key = n(p.name).replace(/[\s\-]+/g, '_');
  const m = key.match(/^([a-g])(?:_(sharp|flat|s|b))?(?:_[a-g](?:b|_flat|_sharp)?)?$/);
  if (m) {
    const base = LETTER[m[1]];
    const acc = m[2] === 'sharp' || m[2] === 's' ? 1 : m[2] === 'flat' || m[2] === 'b' ? -1 : 0;
    return (base + acc + 12) % 12;
  }
  if (p.displayName && /^[A-G][#b♯♭]?(\s*\/\s*[A-G][#b♯♭]?)?$/.test(p.displayName.trim())) return parseNote(p.displayName);
  return null;
};

const isBool = (p: VstParam) => p.isBoolean || (p.values && p.values.length === 2 && p.values.every(v => /^(on|off|true|false|0(\.0)?|1(\.0)?)$/i.test(v)));

const findByNames = (params: VstParam[], names: string[]) => {
  for (const nm of names) {
    const hit = params.find(p => p.name === nm);
    if (hit) return hit;
  }
  return null;
};

const clampReal = (p: VstParam, v: number) => {
  const lo = p.range?.[0];
  const hi = p.range?.[1];
  let x = v;
  if (typeof lo === 'number' && Number.isFinite(lo)) x = Math.max(lo, x);
  if (typeof hi === 'number' && Number.isFinite(hi)) x = Math.min(hi, x);
  return Math.round(x * 100) / 100;
};

/**
 * Réglages à envoyer au plugin (SET_PARAMS du pont v7) pour qu'il suive la tonalité
 * du beat et le style. Utilise d'abord le profil du plugin, puis une recherche
 * générique (noms « key »/« root », listes de gammes, 12 interrupteurs de notes).
 */
export const resolveAutotuneSettings = (pluginName: string, params: VstParam[], target: AutotuneTarget): ResolvedAutotune => {
  const profile = profileFor(pluginName);
  const usable = params.filter(p => !ignoredParam(p.name));
  const settings: ParamSetting[] = [];
  const verify: ResolvedAutotune['verify'] = [];
  let keyMethod: ResolvedAutotune['keyMethod'] = 'none';
  let approximated: string | null = null;
  const scale = target.scale;
  const root = ((Math.round(target.root) % 12) + 12) % 12;

  for (const f of profile?.fixed || []) {
    if (params.some(p => p.name === f.name)) settings.push({ name: f.name, text: f.text, why: f.why });
  }

  // 1) Liste de gammes + paramètre de tonalité
  const keyParam = findByNames(usable, profile?.keyParams || [])
    || usable.find(p => /^(key|root|root ?note|tonic|scale ?root|key ?root)$/i.test(n(p.displayName || p.name).replace(/_/g, ' ')) && isNoteList(p))
    || usable.find(p => /(key|root|tonic)/i.test(p.name) && isNoteList(p))
    || null;
  const scaleCands = [
    ...((profile?.scaleParams || []).map(nm => usable.find(p => p.name === nm)).filter(Boolean) as VstParam[]),
    ...usable.filter(p => /(scale|mode)/i.test(p.name) && (p.values || []).some(v => findValue([v], 'MAJOR') || findValue([v], 'MINOR'))),
  ];
  // Le paramètre qui connaît la gamme demandée, sinon celui qui a le plus de gammes.
  const scaleParam = scaleCands.find(p => findValue(p.values, scale)) || scaleCands[0] || null;
  if (keyParam && scaleParam) {
    const keyText = findNoteValue(keyParam.values, root);
    let scaleText = findValue(scaleParam.values, scale);
    if (!scaleText) {
      const near: NovaScale = scale === 'MAJOR' ? 'MAJOR' : scale === 'CHROMATIC' ? 'CHROMATIC' : 'MINOR';
      scaleText = findValue(scaleParam.values, near);
      if (scaleText) approximated = `${GAMMES_FR[scale]} → ${GAMMES_FR[near]}`;
    }
    if (keyText && scaleText) {
      keyMethod = 'scale-list';
      settings.push({ name: keyParam.name, text: keyText, why: 'tonique du beat' });
      settings.push({ name: scaleParam.name, text: scaleText, why: 'gamme du beat' });
      verify.push({ name: keyParam.name, expect: keyText }, { name: scaleParam.name, expect: scaleText });
    }
  }

  // 2) Interrupteurs de notes (MetaTune, Graillon…) : seulement si la liste ne suffit pas.
  if (keyMethod === 'none' || approximated) {
    const toggles = new Map<number, VstParam>();
    for (const p of usable) {
      if (!isBool(p)) continue;
      const pc = noteOfToggle(p);
      if (pc !== null && !toggles.has(pc)) toggles.set(pc, p);
    }
    if (toggles.size === 12) {
      if (keyMethod === 'scale-list') {
        // Liste de gammes trop pauvre : on garde la tonique et on affine note par note.
        approximated = null;
      }
      keyMethod = 'note-toggles';
      const inScale = new Set(pitchClassesOf(root, scale));
      for (let pc = 0; pc < 12; pc++) {
        const p = toggles.get(pc)!;
        const on = inScale.has(pc);
        settings.push({ name: p.name, text: on ? 'On' : 'Off', why: `${NOMS_EN[pc]} ${on ? 'dans' : 'hors de'} la gamme` });
        verify.push({ name: p.name, expect: on });
      }
    }
  }

  // 3) Vitesse, naturel, mélange, latence
  const retune = (profile?.retune && usable.find(p => p.name === profile.retune!.param))
    || usable.find(p => /retune/i.test(p.name))
    || usable.find(p => /(correction ?speed|^speed$|tune ?speed)/i.test(n(p.displayName || p.name).replace(/_/g, ' ')));
  if (retune) {
    const ms = Math.max(0, target.speed) * 100;
    settings.push({ name: retune.name, real: clampReal(retune, ms), why: `vitesse de correction ${Math.round(ms)} ms` });
  }
  const hum = (profile?.humanize && usable.find(p => p.name === profile.humanize)) || usable.find(p => /humani[sz]e/i.test(p.name));
  if (hum) settings.push({ name: hum.name, real: clampReal(hum, target.humanize * 100), why: 'naturel des notes tenues' });
  const flex = (profile?.flex && usable.find(p => p.name === profile.flex)) || null;
  if (flex) {
    const v = target.speed >= 0.25 ? 25 : 0;
    settings.push({ name: flex.name, real: clampReal(flex, v), why: v ? 'Flex-Tune : garde les glissés' : 'Flex-Tune coupé (effet net)' });
  }
  const mixP = (profile?.mix && usable.find(p => p.name === profile.mix!.param))
    || usable.find(p => /^(wet ?dry ?mix|mix|dry ?wet|amount|correction ?amount)$/i.test(n(p.name).replace(/_/g, ' ')));
  if (mixP) {
    const hi = mixP.range?.[1];
    const percent = profile?.mix?.percent ?? (typeof hi === 'number' && hi > 1.5);
    settings.push({ name: mixP.name, real: clampReal(mixP, percent ? target.mix * 100 : target.mix), why: 'dosage de la correction' });
  }
  const ll = (profile?.lowLatency && usable.find(p => p.name === profile.lowLatency!.param))
    || usable.find(p => /(low ?latency|latency ?removal|zero ?latency)/i.test(n(p.name).replace(/_/g, ' ')) && isBool(p));
  if (ll) {
    const on = profile?.lowLatency?.on ?? 'On';
    const off = profile?.lowLatency?.off ?? 'Off';
    const text = String(target.lowLatency ? on : off);
    settings.push({ name: ll.name, text, why: target.lowLatency ? 'faible latence (prise de voix)' : 'qualité maximale (mix)' });
    verify.push({ name: ll.name, expect: target.lowLatency });
  }

  return { settings, verify, keyMethod, approximated };
};

/** Valeur relue conforme à l'attendu (texte exact, ou état d'un interrupteur). */
export const readbackMatches = (expect: string | boolean, text: string): boolean => {
  if (typeof expect === 'boolean') {
    const t = n(text || '').trim();
    const on = /^(on|true|1(\.0+)?|yes|enabled)$/.test(t);
    const off = /^(off|false|0(\.0+)?|no|disabled)$/.test(t);
    return expect ? on : off;
  }
  return norm(expect) === norm(text || '');
};

/** Paramètres du pont (JSON) → VstParam. */
export const toVstParams = (raw: any[]): VstParam[] =>
  (raw || []).filter(Boolean).map((p: any) => ({
    name: String(p.name),
    displayName: p.display_name ?? p.displayName ?? undefined,
    value: Number(p.value) || 0,
    text: p.text === undefined || p.text === null ? '' : String(p.text),
    numSteps: typeof p.num_steps === 'number' ? p.num_steps : p.numSteps,
    isBoolean: p.is_boolean ?? p.isBoolean,
    isDiscrete: p.is_discrete ?? p.isDiscrete,
    range: Array.isArray(p.range) ? (p.range as any) : undefined,
    values: Array.isArray(p.values) ? p.values.map(String) : undefined,
  }));
