/**
 * Connaissance des plugins VST3 TIERS du PC (pas les effets intégrés de NOVA).
 *
 * - classifyPlugin()   : catégorie (EQ, compresseur, de-esser, saturation, reverb,
 *                        délai, autotune…) et, pour un compresseur, son type
 *                        (FET, VCA, optique, vari-mu, numérique), d'après le nom,
 *                        l'éditeur et les paramètres RÉELS (introspection du pont).
 * - paramRoles()       : quel paramètre réel joue quel rôle (seuil, ratio, attaque,
 *                        mix, decay…), par expressions sur les noms lus — jamais
 *                        d'index codé en dur.
 * - toSetting()        : valeur « physique » voulue (2:1, 90 Hz, -18 dB, 20 %) →
 *                        réglage du pont (valeur texte d'une liste, ou valeur réelle
 *                        dans l'unité du plugin), borné à sa plage.
 * La base générée (data/vst-knowledge/plugins.json, scripts/buildVstKnowledge.ts) est
 * faite avec ces mêmes fonctions à partir de l'introspection réelle de ce PC ; les
 * fiches rédigées (data/vst-knowledge/curated.json) ajoutent rôle, usages et pièges.
 */
import type { VstParam } from './autotuneVst';

export type FxCategory =
  | 'eq' | 'compressor' | 'limiter' | 'deesser' | 'saturation' | 'reverb' | 'delay' | 'autotune'
  | 'gate' | 'channel-strip' | 'modulation' | 'pitch' | 'filter' | 'amp' | 'stereo' | 'utility' | 'other';

export type CompType = 'fet' | 'vca' | 'opto' | 'varimu' | 'digital';

export type ParamRole =
  | 'threshold' | 'ratio' | 'attack' | 'release' | 'makeup' | 'input' | 'output' | 'mix' | 'knee'
  | 'drive' | 'tone' | 'style' | 'autogain'
  | 'decay' | 'predelay' | 'size' | 'damping' | 'lowcut' | 'highcut' | 'width'
  | 'time' | 'feedback' | 'sync'
  | 'frequency' | 'range' | 'listen'
  | 'ceiling' | 'gain' | 'bypass';

export const CATEGORY_LABEL_FR: Record<FxCategory, string> = {
  eq: 'égaliseur', compressor: 'compresseur', limiter: 'limiteur', deesser: 'de-esser', saturation: 'saturation',
  reverb: 'reverb', delay: 'délai', autotune: 'autotune', gate: 'gate', 'channel-strip': 'tranche de console',
  modulation: 'modulation', pitch: 'hauteur', filter: 'filtre', amp: 'ampli', stereo: 'stéréo', utility: 'utilitaire', other: 'autre',
};

const n = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Règles par nom (et éditeur), de la plus précise à la plus large. */
const NAME_RULES: { re: RegExp; cat: FxCategory; comp?: CompType }[] = [
  { re: /auto[\s-]?tune|meta ?tune|waves tune|graillon|little ?alter ?boy|mautopitch/, cat: 'autotune' },
  { re: /melodyne|auto[\s-]?key|tuner\b|bx tuner|pitch ?shift|micro ?shift|soundshifter|metapitch|elastique|vocalign/, cat: 'pitch' },
  { re: /de[\s-]?ess|deesser|sibilan|sibiliz|pro-ds|s-?killer|de-?edger|\bdeedger\b|weiss ds1/, cat: 'deesser' },
  // Noms précis avant les familles larges (« Massive Passive » est un EQ, pas un vari-mu).
  { re: /massive passive|pultec|eqp|meq|hlf|bax eq|clariphonic|sieq|equivocate|aireq|air ?eq|kill eq|para eq|2098|niveau ?filter|tract (mono|stereo|linphase)|pro-?q|carve eq|slice eq|dynamic eq|match eq|vintage eq|ozone 9 equalizer|sitral|legacyeq|masteringeq|ultramarine4eq|gold5eq/, cat: 'eq' },
  { re: /pro-?g\b|gate|expander|spectral ?gate/, cat: 'gate' },
  { re: /(^|[\s-])eq(\b|\d)|3-band eq/, cat: 'eq' },
  { re: /valhalla ?(room|plate|vintage)|rev(zl)?$|pro-?r\b|seventh heaven|lustrous|^rev\b|verb|reverb|plate|\bhall\b|\broom\b|chamber|lexicon|\b224\b|capitol|\bemt\b|bricasti|atlas reverb|shimmer|supermassive|spaceblender|convolver|futureverb/, cat: 'reverb' },
  { re: /brigade chorus|studio d chorus|chorus|flanger|phaser|tremolo|tremolator|vibrato|rotary|ensemble|dimension|doubler|panman|crystallizer|phasemistress|space ?modulator|ubermod/, cat: 'modulation' },
  { re: /delay|echo|galaxy|primal ?tap|repeater|timeless|replika/, cat: 'delay' },
  { re: /\b1176|\b76\b|fet|distressor|la[\s-]?6176|purple ?4|mc77|cla-?76|bomber/, cat: 'compressor', comp: 'fet' },
  { re: /la[\s-]?2a|teletronix|opto|cla-?2a|la-?3a|\bla[\s-]?2\b|tube[\s-]?tech|cl ?1b/, cat: 'compressor', comp: 'opto' },
  { re: /fairchild|vari[\s-]?mu|\b660\b|\b670\b|\b17[56]\b/, cat: 'compressor', comp: 'varimu' },
  { re: /pro-?mb|multi ?band/, cat: 'compressor', comp: 'digital' },
  { re: /bus comp|buss comp|\bg ?comp|glue|api ?2500|dbx|\b160\b|vca|pro-?c|renaissance comp|r-?comp|\bc1\b|bettermaker|dynomite|lookahead ?compressor|mpc ?compressor|drawmer|vocal ?intensity/, cat: 'compressor', comp: 'vca' },
  { re: /limit|maximi[sz]er|pro-?l|clipper|\bclip\b|standardclip|diode clip|elevate|bus peak|inflator/, cat: 'limiter' },
  { re: /comp(ressor)?\b|comp\b|dynamics|leveler|\bcomp\d|gold5comp|mastering comp/, cat: 'compressor', comp: 'digital' },
  { re: /channel ?strip|vision ?channel|console|\bssl e|neve|\b1073\b|\bvcc\b|century|voxbox|strip\b|32bus|vocalflow|fastrack/, cat: 'channel-strip' },
  { re: /saturat|decapitator|devil ?loc|\btape\b|ampex|studer|\batr\b|oxide|\btube\b|drive|distort|bitcrush|crush|heatwave|\bwarm|hg-?2|radiator|fuzz|overdrive|vt-?\d+|saturn|faturator|\bshaper\b|retro color|rc-20|lo-?fi|mello-?fi|exciter|enhancer|thermal|coldfire|\bpre (1973|trida|v76)/, cat: 'saturation' },
  { re: /filter|subfilter|cleansweep|\bwah\b|simplon|volcano|fabfilter micro/, cat: 'filter' },
  { re: /\bamp\b|amplifier|amp ?sim|guitar ?rig|archetype|rockrack|\bcab\b|screamer|megasingle|metal2|blackdist|distorange|yellowdrive|th-?u/, cat: 'amp' },
  { re: /stereo|imager|widen|width|spread|haas/, cat: 'stereo' },
  { re: /meter|analy[sz]|spectrum|scope|tonal balance|insight|\bsolo\b|tract measure|spl meter|gainstation|\bgain\b|transient|punctuate|de-?noise|denoiser|de-?hum|de-?click|de-?plosive|breath|dither|trackspacer/, cat: 'utility' },
];

export interface Classification {
  category: FxCategory;
  compType?: CompType;
  /** 'name' : reconnu au nom ; 'params' : déduit des paramètres ; 'none' : inconnu. */
  by: 'name' | 'params' | 'none';
}

const has = (params: VstParam[] | undefined, re: RegExp) => !!params?.some(p => re.test(n(p.name)) || re.test(n(p.displayName || '')));

/** Catégorie d'un plugin tiers, d'après son nom, son éditeur et ses paramètres réels. */
export const classifyPlugin = (name: string, vendor = '', params?: VstParam[]): Classification => {
  // L'éditeur n'entre pas dans la recherche (« Softube » n'est pas un « tube »).
  const x = n(name).replace(/uaudio_/g, 'uad ').replace(/_/g, ' ');
  void vendor;
  for (const r of NAME_RULES) {
    if (r.re.test(x)) {
      // Une « tranche » qui n'a que des réglages de compresseur reste un compresseur.
      return { category: r.cat, compType: r.cat === 'compressor' ? r.comp : undefined, by: 'name' };
    }
  }
  if (params?.length) {
    if (has(params, /threshold/) && has(params, /ratio/)) return { category: 'compressor', compType: 'digital', by: 'params' };
    if (has(params, /ceiling|true ?peak/)) return { category: 'limiter', by: 'params' };
    if (has(params, /decay|reverb|pre ?delay|predelay|room ?size/)) return { category: 'reverb', by: 'params' };
    if (has(params, /feedback/) && has(params, /time|delay|sync/)) return { category: 'delay', by: 'params' };
    if (has(params, /band ?\d.*(freq|gain)|(freq|gain).*band ?\d|\bq\b/)) return { category: 'eq', by: 'params' };
    if (has(params, /drive|saturat/)) return { category: 'saturation', by: 'params' };
  }
  return { category: 'other', by: 'none' };
};

// ─── Rôles des paramètres ────────────────────────────────────────────────────

/** Expressions par rôle (sur les clés pedalboard, ex. « threshold_db », « attack_ms »). */
const ROLE_RES: Record<ParamRole, RegExp> = {
  threshold: /^(threshold|thresh|thr|input ?threshold|peak ?reduction)( ?db)?$|threshold/,
  ratio: /^ratio|ratio$/,
  attack: /^attack|attack( ?ms)?$/,
  release: /^release|release( ?ms)?$|recovery/,
  makeup: /make ?up|^gain( ?db)?$|^output ?gain|^out ?gain/,
  input: /^input( ?gain)?( ?db)?$|^in ?gain|^input ?trim|^drive ?in/,
  output: /^output( ?db)?$|^out( ?put)? ?(level|trim)?( ?db)?$|outputtrim|^trim|^volume$|^level$/,
  mix: /^(mix|dry ?wet|wet ?dry|blend|wet|amount)( ?%| ?pct| ?percent)?$|^mix\b|dry ?wet ?mix|parallel/,
  knee: /knee/,
  drive: /drive|saturation|^sat\b|heat|warmth|^amount$/,
  tone: /^tone|tilt|color|colour/,
  style: /^style$|^mode$|^type$|^character|^algorithm$|^model$/,
  autogain: /auto ?gain|auto ?makeup|auto ?comp/,
  decay: /decay|rt60|reverb ?time|^time$|^length$/,
  predelay: /pre ?delay|predelay/,
  size: /size|room ?size|^space$/,
  damping: /damp|hi ?cut ?damp|high ?damp/,
  lowcut: /low ?cut|lo ?cut|hp ?freq|high ?pass|hpf|lowcut/,
  highcut: /high ?cut|hi ?cut|lp ?freq|low ?pass|lpf|highcut/,
  width: /width|spread|stereo/,
  time: /^(time|delay ?time|delay|time ?l|left ?time|note|division)( ?ms)?$|delay ?time|^time/,
  feedback: /feedback|regen|repeats/,
  sync: /sync|tempo/,
  frequency: /^freq|frequency|^ds ?freq|split ?freq/,
  range: /^range|reduction|depth|max ?reduction|^amount/,
  listen: /listen|monitor|audition|solo/,
  ceiling: /ceiling|out ?ceiling|true ?peak/,
  gain: /^gain$|^band ?gain/,
  bypass: /^bypass$|^master ?bypass$|^power$|^on ?off$/,
};

/** Rôles utiles par catégorie (dans l'ordre de recherche). */
export const CATEGORY_ROLES: Partial<Record<FxCategory, ParamRole[]>> = {
  compressor: ['bypass', 'threshold', 'ratio', 'attack', 'release', 'makeup', 'input', 'output', 'mix', 'knee', 'autogain', 'style'],
  limiter: ['bypass', 'threshold', 'ceiling', 'release', 'input', 'output'],
  deesser: ['bypass', 'threshold', 'frequency', 'range', 'listen', 'mix', 'output'],
  saturation: ['bypass', 'drive', 'mix', 'tone', 'style', 'lowcut', 'highcut', 'autogain', 'output', 'input'],
  reverb: ['bypass', 'mix', 'decay', 'predelay', 'size', 'damping', 'lowcut', 'highcut', 'width', 'style'],
  delay: ['bypass', 'mix', 'time', 'feedback', 'sync', 'lowcut', 'highcut', 'width', 'style'],
  eq: ['bypass', 'lowcut', 'highcut', 'gain', 'output'],
  'channel-strip': ['bypass', 'threshold', 'ratio', 'attack', 'release', 'lowcut', 'highcut', 'input', 'output', 'mix'],
  modulation: ['bypass', 'mix', 'width'],
  stereo: ['bypass', 'width', 'mix'],
};

const key = (p: VstParam) => n(p.name).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const disp = (p: VstParam) => n(p.displayName || '').replace(/_/g, ' ').trim();

/** Paramètre réel → rôle, pour les rôles utiles à la catégorie. Un paramètre ne joue qu'un rôle. */
export const paramRoles = (category: FxCategory, params: VstParam[]): Partial<Record<ParamRole, string>> => {
  const wanted = CATEGORY_ROLES[category] || [];
  const used = new Set<string>();
  const out: Partial<Record<ParamRole, string>> = {};
  // Paramètres « de bande » (EQ, multibande) : jamais pris pour un rôle global.
  const usable = params.filter(p => !/(band|^b\d|\bb\d\b|hp_|object_|sidechain ?eq|sc ?eq|midi|cc ?\d|preset|program|ui|zoom|view|meter|analy)/.test(key(p)));
  for (const role of wanted) {
    const re = ROLE_RES[role];
    const hit = usable.find(p => !used.has(p.name) && (re.test(key(p)) || re.test(disp(p))));
    if (hit) { out[role] = hit.name; used.add(hit.name); }
  }
  return out;
};

// ─── Valeurs : physique → réglage du plugin ─────────────────────────────────────

export type Unit = 'db' | 'ms' | 's' | 'hz' | 'khz' | 'pct' | 'ratio' | 'none';

/** Unité d'un paramètre, d'après son nom, son étiquette et sa valeur affichée. */
export const unitOf = (p: VstParam): Unit => {
  const k = key(p);
  const t = n(p.text || '');
  if (/ratio/.test(k)) return 'ratio';
  if (/( |^)db$|_db$|db\b/.test(k) || /db\s*$/.test(t)) return 'db';
  if (/( |^)ms$|ms\b/.test(k) || /\bms\s*$/.test(t)) return 'ms';
  if (/khz/.test(k) || /khz\s*$/.test(t)) return 'khz';
  if (/( |^)hz$|hz\b/.test(k) || /hz\s*$/.test(t)) return 'hz';
  if (/( |^)s$|sec/.test(k) || /\d\s*s\s*$/.test(t)) return 's';
  if (/pct|percent|%/.test(k) || /%\s*$/.test(t)) return 'pct';
  return 'none';
};

const num = (s: string): number | null => {
  const m = String(s).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

export interface Target {
  /** Valeur physique : dB, ms, Hz, %, ratio (2 = 2:1), secondes pour un decay. */
  value: number;
  unit: Unit;
}

export interface PluginSetting { name: string; text?: string; real?: number; why: string }

/**
 * Réglage d'un paramètre réel pour une valeur physique. Liste de choix : la valeur
 * la plus proche (« 2:1 », « 2 », « 4 ») ; numérique : conversion d'unité puis borne.
 * null si la valeur ne peut pas être représentée (ex. ratio 2 sur un 1176 : 4, 8, 12, 20).
 */
export const toSetting = (p: VstParam, t: Target, why: string, tolerance = 0.25): PluginSetting | null => {
  const unit = unitOf(p);
  if (p.values && p.values.length && p.values.length <= 128 && !p.isBoolean) {
    const parsed = p.values.map(v => ({ v, x: num(v) })).filter(o => o.x !== null) as { v: string; x: number }[];
    if (!parsed.length) return null;
    let want = t.value;
    if (t.unit === 'khz' && unit !== 'khz') want *= 1000;
    if (t.unit === 'hz' && /khz/.test(n(p.values.join(' ')))) want /= 1000;
    const best = parsed.reduce((a, b) => (Math.abs(b.x - want) < Math.abs(a.x - want) ? b : a));
    // Pour un ratio, « proche » = même valeur (2:1 exigé par la règle maison).
    const rel = Math.abs(best.x - want) / Math.max(1e-6, Math.abs(want));
    if (t.unit === 'ratio' && Math.abs(best.x - want) > 0.05) return null;
    if (rel > tolerance && t.unit !== 'ratio') return null;
    return { name: p.name, text: best.v, why };
  }
  let v = t.value;
  const lo = p.range?.[0];
  const hi = p.range?.[1];
  // Unités physiques incompatibles (secondes vers un bouton en %, Hz vers un bouton
  // 0–10…) : on ne devine pas, le réglage d'usine du plugin reste (mesuré en réel :
  // VerbSuite « decay » en %, EchoBoy en graduations 0–10).
  const family = (u: Unit) => (u === 'ms' || u === 's' ? 'time' : u === 'hz' || u === 'khz' ? 'freq' : u);
  const physical = (u: Unit) => u === 'db' || u === 'ms' || u === 's' || u === 'hz' || u === 'khz';
  if (physical(t.unit) && family(t.unit) !== family(unit)) return null;
  // Conversion vers l'unité du plugin.
  if (t.unit === 'ms' && unit === 's') v = v / 1000;
  if (t.unit === 's' && unit === 'ms') v = v * 1000;
  if (t.unit === 'hz' && unit === 'khz') v = v / 1000;
  if (t.unit === 'khz' && unit === 'hz') v = v * 1000;
  if (t.unit === 'pct' && unit !== 'pct') {
    const finite = typeof lo === 'number' && typeof hi === 'number' && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
    if (!finite) return null;
    // Bouton sans unité : le pourcentage devient une position sur sa course (47 % → 4,7 sur 0–10).
    v = (lo as number) + ((hi as number) - (lo as number)) * (v / 100);
  }
  if (typeof lo === 'number' && Number.isFinite(lo)) v = Math.max(lo, v);
  if (typeof hi === 'number' && Number.isFinite(hi)) v = Math.min(hi, v);
  if (t.unit === 'ratio' && Math.abs(v - t.value) > 0.05) return null; // ratio 2:1 hors plage
  return { name: p.name, real: Math.round(v * 1000) / 1000, why };
};

/** Le plugin permet-il un ratio de 2:1 exactement ? (règle maison des compresseurs voix) */
export const supportsRatio = (params: VstParam[], ratio = 2): boolean => {
  const roles = paramRoles('compressor', params);
  const p = params.find(x => x.name === roles.ratio);
  if (!p) return false;
  return toSetting(p, { value: ratio, unit: 'ratio' }, 'ratio') !== null;
};
