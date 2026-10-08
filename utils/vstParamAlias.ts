/**
 * Noms et valeurs des réglages : de ce qu'on lit dans la fenêtre Pro Tools / AAX
 * (relevé de session, captures) vers le paramètre VST3 RÉEL lu par le pont.
 *
 * Trois étages, du plus sûr au plus large :
 *  1. table d'alias par plugin (PARAM_ALIASES), vérifiée sur les captures du
 *     relevé LENNON (08/10/2026) et la liste réelle des paramètres VST3 —
 *     prioritaire : un même nom peut désigner un autre contrôle (HG-2 « Air ») ;
 *  2. nom identique (casse, espaces, tirets près) ou clé pedalboard (« band_1_frequency ») ;
 *  3. correspondance approchée : mots normalisés, abréviations (Thresh,
 *     Rel., Freq, Xover…), numéros de bande (« Band 1 Freq » = « Frequency 1 »
 *     = « band_1_frequency »), synonymes (Wet/Dry = Mix). Une seule
 *     correspondance nettement meilleure est acceptée, sinon rien.
 *
 * Puis la VALEUR : texte exact d'une liste (« Alto / Tenor » → « Alto-Tenor »,
 * « normal » → « Norm », « 6 Sm Hall A » → « SmHall A », « Single Echo » →
 * « Single »), nombre dans l'unité du plugin (« 1K5 » → 1500 Hz, « 100 cps » →
 * 100 Hz, « 4.91 kHz » → 4910 Hz si le plugin affiche des Hz), interrupteur
 * (« On » sur un potard continu → maximum ; « Power On » → « bypass Off »),
 * conversions propres à un plugin (Auto-Tune : « Detune 440 Hz » → 0 cent).
 */

export interface ParamLike {
  name: string;
  displayName?: string;
  display_name?: string;
  text?: string;
  values?: string[];
  range?: (number | null)[];
  isBoolean?: boolean;
  is_boolean?: boolean;
  label?: string;
  units?: string;
}

export type ParamMatchHow = 'exact' | 'alias' | 'approx';

export interface ParamMatch {
  key: string;
  how: ParamMatchHow;
  /** Conversion de valeur propre à cet alias. */
  convert?: ValueConvert;
  /** Autres paramètres réglés à la même valeur (« Sens 1-4 » → les 4 bandes). */
  also?: string[];
}

/** Conversions de valeur propres à un réglage. */
export type ValueConvert =
  /** Interrupteur inversé (« Power On » → bypass « Off »). */
  | { kind: 'invert' }
  /** Hz de référence (La 440) → cents (Auto-Tune « Detune »). */
  | { kind: 'hz-to-cents'; reference?: number }
  /** Table de valeurs : texte lu → texte ou nombre à envoyer. */
  | { kind: 'map'; values: Record<string, string | number> }
  /** Multiplier le nombre lu (affichage en dixièmes…). */
  | { kind: 'scale'; factor: number }
  /** Valeur composée avec d'autres réglages lus du même plugin (« {Key} {Scale} » → « C Minor »). */
  | { kind: 'combine'; format: string };

export interface AliasTarget {
  /** Nom affiché OU clé pedalboard du paramètre VST3 ; null : réglage NON EXPOSÉ en VST3 (voir why). */
  to: string | null;
  convert?: ValueConvert;
  /** Autres paramètres à régler à la même valeur. */
  also?: string[];
  /** Pourquoi (non exposé, affichage seulement, lecture ambiguë…), vérifié sur la capture. */
  why?: string;
}

export type Setting = { name: string; text?: string; real?: number };

// ─── Normalisation ─────────────────────────────────────────────────────────────

const fold = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Forme compacte (« Pro-C 3 » → « proc3 »). */
export const compactName = (s: string) => fold(s).replace(/[^a-z0-9]/g, '');

/** Abréviations et synonymes → mot canonique. */
const WORDS: Record<string, string> = {
  thresh: 'threshold', thr: 'threshold', thres: 'threshold',
  rel: 'release', rls: 'release', att: 'attack', atk: 'attack', atck: 'attack',
  freq: 'frequency', frq: 'frequency', fr: 'frequency', cps: 'frequency', hz: 'frequency',
  out: 'output', outp: 'output', inp: 'input', lvl: 'level', vol: 'volume',
  hpf: 'highpass', hp: 'highpass', lowcut: 'highpass', locut: 'highpass', lpf: 'lowpass', lp: 'lowpass', highcut: 'lowpass', hicut: 'lowpass',
  hi: 'high', lo: 'low', lf: 'low', hf: 'high', md: 'mid', med: 'mid', lm: 'lowmid', hm: 'highmid',
  xover: 'crossover', xovr: 'crossover', xo: 'crossover', cross: 'crossover',
  fb: 'feedback', fbk: 'feedback', dly: 'delay', predly: 'predelay', dec: 'decay', diff: 'diffusion',
  sens: 'sensitivity', amt: 'amount', comp: 'compression', sat: 'saturation', thd: 'distortion',
  wet: 'mix', dry: 'mix', drywet: 'mix', wetdry: 'mix', blend: 'mix', w: 'mix',
  st: 'stereo', stndrd: 'standard', std: 'standard', byp: 'bypass',
  atten: 'attenuation', sel: 'select', gr: 'reduction', mkup: 'makeup', makeupgain: 'makeup',
  ratio: 'ratio', rto: 'ratio', knee: 'knee', bw: 'q', res: 'resonance',
  l: 'left', r: 'right', lr: 'stereo',
};

/** Mots sans valeur pour comparer des noms (« Band 1 » : le numéro suffit). */
const FILLER = new Set(['band', 'the', 'of', 'de', 'du', 'la', 'le', 'and', 'et', 'param', 'parameter']);

/** Mots du nom, normalisés : « Band 1 Freq » → ['1', 'frequency'] ; « masterGain » → ['master', 'gain']. */
export const nameTokens = (s: string): string[] => {
  const spaced = (s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')          // camelCase
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')          // x1 → x 1
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');
  const raw = fold(spaced).split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (const w of raw) {
    const t = WORDS[w] || w;
    if (FILLER.has(t)) continue;
    if (t === 'predelay') { out.push('pre', 'delay'); continue; }
    out.push(t);
  }
  return [...new Set(out)];
};

const displayOf = (p: ParamLike) => p.displayName || p.display_name || '';

/** Clé pedalboard probable d'un nom affiché (« Band 1 Frequency » → « band_1_frequency »). */
export const keyFromDisplay = (display: string): string => {
  let k = fold(display).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (/^\d/.test(k)) k = `_${k}`;
  return k;
};

// ─── Table d'alias par plugin ────────────────────────────────────────────────────

/**
 * Alias par plugin : nom du plugin (forme compacte, sans variante mono / stéréo)
 * → { nom lu dans Pro Tools (compact) → paramètre VST3 }. Une entrée « * »
 * s'applique à tous les plugins.
 */
const NOT_EXPOSED = (why: string): AliasTarget => ({ to: null, why });

export const PARAM_ALIASES: Record<string, Record<string, AliasTarget>> = {
  '*': {},
  // Antares Auto-Tune Pro (Pro Tools / AAX → VST3)
  autotunepro: {
    mode: { to: 'correction_mode' },                                    // « Auto » → « Auto mode »
    formant: { to: 'formant_correction' },
    formantamount: { to: 'throat_length' },                             // potard « Throat » (100 = neutre)
    mix: { to: 'wet_dry_mix' },
    algorithm: { to: 'use_classic_mode_dsp', convert: { kind: 'map', values: { Modern: '0.0', Classic: '1.0' } } },
    harmonyplayer: { to: 'hp_bypass_harmony_player', convert: { kind: 'invert' } },
    detune: { to: 'detune', convert: { kind: 'hz-to-cents', reference: 440 } },   // « 440.0 Hz » = 0 cent
    flextune: { to: 'flex_tune' },
  },
  autokey: {
    key: { to: 'key_scale', convert: { kind: 'combine', format: '{Key} {Scale}' } },
    scale: { to: 'key_scale', convert: { kind: 'combine', format: '{Key} {Scale}' } },
    detectionmethod: NOT_EXPOSED('mode de détection de la fenêtre (Listen / MIDI), pas un paramètre VST3'),
    relative: NOT_EXPOSED('tonalité relative affichée par Auto-Key, pas un réglage'),
  },
  wavestunerealtime: {
    vibrato: { to: 'vibrato_on_off' },
    vibratoamount: { to: 'vibrato_depth' },
    correction: { to: 'correction_on_off' },
    correctionamount: { to: 'correction' },
    reference: { to: 'reference_frequencey' },
    scale: { to: 'scale_type' },
    root: { to: 'scale_root' },
    formant: NOT_EXPOSED('sélecteur Formant de Waves Tune Real-Time absent des paramètres VST3'),
    range: NOT_EXPOSED('sélecteur Range (Generic…) absent des paramètres VST3'),
  },
  tubetechcl1bmkii: {
    attackreleaseselect: { to: 'select_attack_release' },
    generation: { to: 'cl1b_generation' },
  },
  manleyvoxbox: {
    highpass: { to: 'low_cut' },
    source: { to: 'source_select' },
    link: { to: 'sc_link' },
    compressor: { to: 'comp_byp', convert: { kind: 'map', values: { 'Compress 3:1': 'In', Compress: 'In', Limit: 'In', Bypass: 'Byp' } } },
    attack: { to: 'comp_attack' },
    release: { to: 'comp_rel' },
    deess: { to: 'de_ess_byp' },
    eq: { to: 'eq_byp' },
    lowpeakfreq: { to: 'lo_peak_freq' },
    transformer: { to: 'transformer_byp' },
  },
  gemdopamine64: {
    // Capture : les voyants « 361 » et « 180 » sont tous deux allumés ; le sélecteur de
    // modèle (paramètre « model ») ne peut pas être déduit sans ambiguïté.
    '361': NOT_EXPOSED('voyants 361 et 180 allumés tous les deux sur la capture : modèle ambigu, laissé à 361 (défaut)'),
    '180': NOT_EXPOSED('voyants 361 et 180 allumés tous les deux sur la capture : modèle ambigu, laissé à 361 (défaut)'),
  },
  f6rta: {
    averaging: NOT_EXPOSED('moyennage de l’analyseur (affichage), pas un paramètre VST3'),
    out: { to: 'out' },
  },
  sslev2channel: {
    '20db': { to: '20db_pad', convert: { kind: 'map', values: { On: '-20db', Off: 'Off' } } },
    gate: { to: 'gate_exp', convert: { kind: 'map', values: { On: 'Gate', Off: 'Exp' } } },
    eqto: { to: 'eq_bypass', convert: { kind: 'map', values: { BYP: 'On', 'DYN S.C': 'Off', DYNSC: 'Off' } } },
    width: { to: 'width', convert: { kind: 'map', values: { Stndrd: 0, Standard: 0 } } },   // potard au minimum « STNDRD »
    output: { to: 'output' },
  },
  deedger: {
    mode: { to: 'ch_mode' },
  },
  ua1176ae: {
    hr: NOT_EXPOSED('inverseur HR de la fenêtre UADx, sans paramètre VST3 équivalent (« headroom » est un autre réglage)'),
  },
  abbeyroadsaturator: {
    stereomode: { to: 'st_mode', convert: { kind: 'map', values: { ST: 'Stereo', M: 'Mid', S: 'Sides' } } },
    saturatormode: { to: 'saturator_type' },
    compander: NOT_EXPOSED('section Compander sans interrupteur en VST3 (ratio_compander seul) : lecture « Off » non transposable'),
  },
  teletronixla2asilver: {
    mode: { to: 'comp_limit' },
  },
  c6: {
    releasemode: { to: 'release' },
    crossoverlow: { to: 'low_crossover' },
    crossovermid: { to: 'mid_crossover' },
    crossoverhigh: { to: 'high_crossover' },
    output: { to: 'output_gain' },
  },
  echoboy: {
    echotime: { to: 'echo1note' },
    timemode: { to: 'echo1mode' },
    pingtime: { to: 'echo1note' },
    pongtime: { to: 'echo2note' },
  },
  pulteceqp1a: {
    lowfrequency: { to: 'low_freq' },
    attensel: { to: 'hf_atten_freq' },
    gain: { to: 'output' },                                              // potard « Gain » (OFF / 0 / 12 dB) de la sortie
  },
  sslcomp: {
    in: { to: 'in' },
    analog: { to: 'anlg' },
    fade: { to: 'autofade' },
  },
  airchorus: {
    lrphase: { to: 'offset' },
  },
  panman: {
    rhythm: NOT_EXPOSED('rythme synchronisé de la fenêtre (« 4 bars »), PanMan n’expose que rate_hz en VST3'),
  },
  flangerbl20: {
    outputgain: NOT_EXPOSED('gain de sortie de la fenêtre Arturia, absent des paramètres VST3'),
  },
  chorusdimensiond: {
    outputgain: NOT_EXPOSED('gain de sortie de la fenêtre Arturia, absent des paramètres VST3'),
    mode: { to: 'stereo_mode' },
  },
  rvox: {
    comp: { to: 'compression' },
  },
  lexicon224: {
    reverbtime: { to: 'mid' },                                           // temps de réverbération principal (médiums)
    immed: { to: 'immediate' },
    solo100wet: { to: 'wet_solo' },
  },
  l1limiter: {
    outceiling: { to: 'ceiling' },
  },
  capitolchambers: {
    chamber: { to: 'chambers' },
  },
  verbsuiteclassics: {
    unit: NOT_EXPOSED('programme (appareil) choisi dans la fenêtre : pas de paramètre VST3 (état du plugin seulement)'),
    type: NOT_EXPOSED('programme (catégorie) choisi dans la fenêtre : pas de paramètre VST3'),
    name: NOT_EXPOSED('programme (nom) choisi dans la fenêtre : pas de paramètre VST3'),
    decay: NOT_EXPOSED('durée en secondes de la fenêtre ; le paramètre VST3 « reverb_decay » est un pourcentage du programme'),
    eq: { to: 'eq_on_off' },
    low: { to: 'low_eq_gain' },
    mid: { to: 'mid_eq_gain' },
    high: { to: 'high_eq_gain' },
    gain: { to: 'output_gain' },
  },
  mc2000mc404: {
    crossoverx1: { to: 'x_over_1_freq_hz' },
    crossoverx2: { to: 'x_over_2_freq_hz' },
    crossoverx3: { to: 'x_over_3_freq_hz' },
  },
  rverb: {
    dec: { to: 'decorrelation' },
    reverb: { to: 'reverb_mix' },
  },
  superplate: {
    model: { to: 'plate_style' },
  },
  airflanger: {
    sync: NOT_EXPOSED('AIR Flanger n’expose que rate, depth, feedback, mix et headroom en VST3'),
    predelay: NOT_EXPOSED('AIR Flanger n’expose que rate, depth, feedback, mix et headroom en VST3'),
    lroffset: NOT_EXPOSED('AIR Flanger n’expose que rate, depth, feedback, mix et headroom en VST3'),
    retrigger: NOT_EXPOSED('AIR Flanger n’expose que rate, depth, feedback, mix et headroom en VST3'),
    lowcut: NOT_EXPOSED('AIR Flanger n’expose que rate, depth, feedback, mix et headroom en VST3'),
    phaseinvert: NOT_EXPOSED('AIR Flanger n’expose que rate, depth, feedback, mix et headroom en VST3'),
  },
  doubler2: {
    direct: { to: 'direct_onoff' },
    align: { to: 'aligndirect' },
    fbhpf: { to: 'feedback_hipass' },
    feedback: { to: 'voice1_feedback', also: ['voice2_feedback'] },
    depth: { to: 'voice1_depth', also: ['voice2_depth'] },
    rate: { to: 'voice1_rate', also: ['voice2_rate'] },
    lowgainfreq: { to: 'eqlowfrq' },
    highfreq: { to: 'eqhighfrq' },
    output: { to: 'master_gain' },
  },
  instantflangermkii: {
    oscillator: { to: 'osc_on_off' },
    envelope: { to: 'env_flwr_on_off' },
    sync: { to: 'sync_on_off' },
    remote: { to: 'remote_on_off' },
  },
  studiodchorus: {
    modulationmode: { to: 'mod_mode' },
    input: { to: 'input_mode' },
  },
  manleymassivepassivem: {
    lowpass: { to: 'ch1lopass', also: ['ch2lopass'] },
    highpass: { to: 'ch1hipass', also: ['ch2hipass'] },
    gain: { to: 'ch1gain', also: ['ch2gain'] },
    link: { to: 'ctrllink', convert: { kind: 'map', values: { On: 'LINKED', Off: 'UNLINKED' } } },
  },
  lineqlowband: {
    dither: { to: 'dither_type' },
  },
  l3multimaximizer: {
    xoverlo: { to: 'low_crossover' },
    xoverlm: { to: 'lomid_crossover' },
    xoverhm: { to: 'himid_crossover' },
    xoverhi: { to: 'high_crossover' },
    masterrelease: { to: 'release_type' },
    idr: NOT_EXPOSED('IDR (dither du L3) : pas d’interrupteur VST3 ; le type de dither est réglé par « Dither »'),
  },
  transxmulti: {
    xoverlow: { to: 'low_crossover' },
    xovermid: { to: 'mid_crossover' },
    xoverhigh: { to: 'high_crossover' },
    sens14: { to: 'band_1_sense', also: ['band_2_sense', 'band_3_sense', 'band_4_sense'] },
    trim: { to: 'output_gain' },                                         // fader « Trim » de la fenêtre = gain de sortie
  },
  oxfordinflator: {
    effectin: { to: 'in' },
    input: { to: 'input_gain' },
    output: { to: 'output_gain' },
  },
  oxforddynamiceq: {
    detect: { to: '1_detect_mode', also: ['2_detect_mode', '3_detect_mode', '4_detect_mode', '5_detect_mode'] },
    trigger: { to: '1_trigger_mode', also: ['2_trigger_mode', '3_trigger_mode', '4_trigger_mode', '5_trigger_mode'] },
    trim: { to: 'output_trim' },
  },
  bettermakerbuscompressordsp: {
    gain: { to: 'output' },
  },
  compdiode609: {
    link: { to: 'stereo_mode', convert: { kind: 'map', values: { On: 'Stereo', Off: 'Dual Mono' } } },
    output: NOT_EXPOSED('gain de sortie de la fenêtre Arturia : seuls les gains de compensation par canal sont exposés en VST3'),
  },
  busforce: {
    mix: NOT_EXPOSED('Bus FORCE n’a pas de mix global en VST3 (niveaux des chemins sec / compresseur / saturation)'),
  },
  dangerousbaxeqmix: {
    engage: { to: 'power' },
    highlevel: { to: 'high_shelf_level_db' },
    output: { to: 'output_level_db' },
  },
  blackboxanalogdesignhg2: {
    air: { to: 'air_in' },                                               // interrupteur « Air » (On / Off) ; le potard reste
    satfreq: { to: 'saturation_frequency' },
  },
  fabfilterproq4: {
    output: { to: 'output_level' },
  },
};

/** Nom de plugin → clés possibles de PARAM_ALIASES (« C6 Stereo » → c6stereo, c6). */
const pluginKeys = (plugin?: string | null): string[] => {
  if (!plugin) return [];
  const c = compactName(plugin);
  const base = compactName(plugin.replace(/\s+(mono\/stereo|stereo|mono)$/i, ''));
  return [...new Set([c, base, base.replace(/vst3$/, ''), base.replace(/^(uadx|uaudio)/, '')])];
};

export const aliasesFor = (plugin?: string | null): Record<string, AliasTarget> => {
  const out: Record<string, AliasTarget> = { ...PARAM_ALIASES['*'] };
  for (const k of pluginKeys(plugin)) Object.assign(out, PARAM_ALIASES[k] || {});
  return out;
};

// ─── Correspondance des noms ────────────────────────────────────────────────────

const findParam = (params: ParamLike[], target: string): ParamLike | undefined => {
  const t = compactName(target);
  return params.find(p => p.name === target) || params.find(p => compactName(displayOf(p)) === t) || params.find(p => compactName(p.name) === t);
};

/** Interrupteurs d'engagement (« Power », « Engage », « In/Out ») : sur un plugin qui n'a que « bypass », on inverse. */
const ENGAGE = new Set(['power', 'engage', 'active', 'inout', 'effectin', 'in', 'on', 'onoff', 'enable', 'enabled', 'effect']);

const isBoolLike = (p: ParamLike) => !!(p.isBoolean || p.is_boolean)
  || (Array.isArray(p.values) && p.values.length === 2 && p.values.some(v => /^(off|bypass(ed)?|not bypassed|out|in|on|false|true|active|inactive)$/i.test(v.trim())));

/**
 * Paramètre VST3 réel d'un réglage lu dans Pro Tools. null : introuvable.
 * `plugin` : nom du plugin (alias propres à ce plugin).
 */
export const matchParam = (asked: string, params: ParamLike[], plugin?: string | null): ParamMatch | null => {
  const a = compactName(asked);
  if (!a || !params.length) return null;
  // 1. Alias du plugin, vérifiés sur les captures : prioritaires (« Air » du HG-2 = l'interrupteur air_in, pas le potard air) (to: null = réglage non exposé en VST3 : rien à chercher)
  const al = aliasesFor(plugin)[a];
  if (al && al.to === null) return null;
  if (al && al.to) {
    const hit = findParam(params, al.to);
    if (hit) {
      const also = (al.also || []).map(x => findParam(params, x)?.name).filter((x): x is string => !!x);
      return { key: hit.name, how: 'alias', ...(al.convert ? { convert: al.convert } : {}), ...(also.length ? { also } : {}) };
    }
  }
  // 2. Identique
  const exact = params.find(p => compactName(displayOf(p)) === a) || params.find(p => compactName(p.name) === a)
    || params.find(p => p.name === keyFromDisplay(asked));
  if (exact) return { key: exact.name, how: 'exact' };
  // 2b. Interrupteur d'engagement → bypass inversé
  if (ENGAGE.has(a)) {
    const byp = params.find(p => /^bypass(ed)?$/i.test(p.name) || /^bypass$/i.test(displayOf(p)));
    if (byp && isBoolLike(byp)) return { key: byp.name, how: 'alias', convert: { kind: 'invert' } };
  }
  // 3. Approché : mots normalisés
  const want = nameTokens(asked);
  if (!want.length) return null;
  const nums = (t: string[]) => t.filter(x => /^\d+$/.test(x)).sort().join(',');
  const wantNums = nums(want);
  let best: { p: ParamLike; score: number } | null = null;
  let tie = false;
  for (const p of params) {
    for (const label of [displayOf(p), p.name]) {
      if (!label) continue;
      const got = nameTokens(label);
      if (!got.length || nums(got) !== wantNums) continue;
      // Un vu-mètre (« Gain Reduction Meter ») n'est jamais un réglage.
      if (got.some(x => x === 'meter' || x === 'reduction') && !want.some(x => x === 'meter' || x === 'reduction')) continue;
      const inGot = want.filter(x => got.includes(x)).length;
      const inWant = got.filter(x => want.includes(x)).length;
      let score = 0;
      if (inGot === want.length && inWant === got.length) score = 100;
      else if (inGot === want.length) score = 80 - 6 * (got.length - inWant);             // tout le demandé, + mots en trop
      else if (inWant === got.length && got.some(x => !/^\d+$/.test(x))) score = 62 - 8 * (want.length - inGot); // le candidat est un sous-ensemble
      if (score < 60) continue;
      if (!best || score > best.score) { best = { p, score }; tie = false; } else if (best.p !== p && score === best.score) tie = true;
    }
  }
  if (!best || tie) return null;
  return { key: best.p.name, how: 'approx' };
};

/** Réglage lu mais NON EXPOSÉ en VST3 (table d'alias) : la raison, sinon null. */
export const unexposedReason = (asked: string, plugin?: string | null): string | null => {
  const al = aliasesFor(plugin)[compactName(asked)];
  return al && al.to === null ? (al.why || 'non exposé en VST3') : null;
};

// ─── Valeurs ──────────────────────────────────────────────────────────────────

const ON_WORDS = /^(on|in|true|oui|yes|enabled|active|engaged?|used)$/i;
const OFF_WORDS = /^(off|out|false|non|no|disabled|inactive|bypass(ed)?|byp|none)$/i;

/** Nombre d'un texte de console : « 1K5 » → 1500, « 12K » → 12000, « -Inf » → -Infinity, « x 1.50 » → 1.5. */
export const parseNumber = (v: string): { n: number; unit: string } | null => {
  const t = String(v).trim().replace(',', '.');
  if (/^[-−]\s*inf/i.test(t)) return { n: -Infinity, unit: '' };
  const k = t.match(/^([-+]?\d+)\s*[kK]\s*(\d+)?\s*(hz)?$/);
  if (k) return { n: Number(`${k[1]}.${k[2] || 0}`) * 1000, unit: 'hz' };
  const m = t.match(/^[x×]?\s*([-+]?\d+(?:\.\d+)?)\s*([a-zA-Z%°]*)/);
  if (!m) return null;
  let unit = m[2].toLowerCase();
  if (unit === 'cps') unit = 'hz';
  if (unit === 'deg') unit = '°';
  return { n: Number(m[1]), unit };
};

const UNIT_RE = /(khz|hz|ms|s|db(?:tp|fs)?|%|cents?|ct)\s*$/i;
const unitOfParam = (p: ParamLike): string => {
  const u = (p.label || p.units || '').trim().toLowerCase();
  if (u) return u;
  return ((p.text || '').trim().match(UNIT_RE)?.[1] || '').toLowerCase();
};

/** Valeur exacte de la liste du plugin correspondant au texte lu (null : aucune sûre). */
export const pickListValue = (values: string[], v: string): string | null => {
  if (!values.length) return null;
  const same = values.find(x => x.trim().toLowerCase() === v.trim().toLowerCase());
  if (same) return same;
  const c = compactName(v);
  const byCompact = values.filter(x => compactName(x) === c);
  if (byCompact.length === 1) return byCompact[0];               // « L/R » ≠ « L+R » : ambigu → on ne devine pas
  // « 6 Sm Hall A » (numéro de programme devant) → « SmHall A »
  const noIndex = compactName(v.replace(/^\s*\d+\s+/, ''));
  if (noIndex && noIndex !== c) {
    const hit = values.find(x => compactName(x) === noIndex);
    if (hit) return hit;
  }
  // Préfixe unique : « normal » → « Norm », « Single Echo » → « Single »
  if (c.length >= 3) {
    const pre = values.filter(x => { const y = compactName(x); return y.length >= 3 && (c.startsWith(y) || y.startsWith(c)); });
    if (pre.length === 1) return pre[0];
    if (pre.length > 1) {
      const longest = [...pre].sort((x, y) => compactName(y).length - compactName(x).length);
      if (compactName(longest[0]).length > compactName(longest[1]).length) return longest[0];
    }
  }
  // Interrupteur à deux états (« In » / « Out », « Off » / « On »)
  if (values.length === 2 && (ON_WORDS.test(v.trim()) || OFF_WORDS.test(v.trim()))) {
    // Même règle que le pont : l'état « éteint » est celui qui dit not / off / out… (« Not Bypassed » / « Bypassed »).
    const offs = values.filter(x => /\b(not|off|disabled|inactive|no|out|false)\b|^0$/i.test(x.trim()));
    if (offs.length === 1) return ON_WORDS.test(v.trim()) ? values.find(x => x !== offs[0])! : offs[0];
  }
  // Nombre : la valeur de la liste au nombre le plus proche (« 4 » → « 4:1 », « 3:1 » → « Compress 3:1 »)
  const want = parseNumber(v.replace(/^.*?([-+]?\d)/, '$1'));
  if (want && Number.isFinite(want.n)) {
    let best: string | null = null; let gap = Infinity;
    for (const x of values) {
      const m = x.replace(',', '.').match(/[-+]?\d+(?:\.\d+)?/);
      if (!m) continue;
      const d = Math.abs(Number(m[0]) - want.n);
      if (d < gap) { gap = d; best = x; }
    }
    if (best !== null && gap <= Math.max(0.02 * Math.abs(want.n), 1e-6)) return best;
  }
  return null;
};

const invertBool = (v: string): string => (ON_WORDS.test(v.trim()) ? 'Off' : OFF_WORDS.test(v.trim()) ? 'On' : v);

/**
 * Réglage à envoyer au pont pour la valeur lue `value` :
 *  - liste de choix : le texte EXACT de la liste (voir pickListValue), sinon le
 *    texte tel quel (le pont prend la valeur la plus proche) ;
 *  - interrupteur : « On » / « Off » ;
 *  - continu : le NOMBRE dans l'unité du plugin (kHz → Hz, s → ms, % → 0–1).
 */
export const settingFor = (p: ParamLike | undefined, key: string, value: string, convert?: ValueConvert, siblings?: Record<string, string>): Setting => {
  let v = String(value).trim();
  if (convert?.kind === 'combine' && siblings) {
    const byCompact = Object.fromEntries(Object.entries(siblings).map(([k, x]) => [compactName(k), String(x)]));
    const out = convert.format.replace(/\{([^}]+)\}/g, (_, k) => byCompact[compactName(k)] ?? '');
    if (out.trim() && !/\{|\}/.test(out)) v = out.replace(/\s+/g, ' ').trim();
  }
  if (convert?.kind === 'invert') v = invertBool(v);
  if (convert?.kind === 'map') {
    const hit = Object.entries(convert.values).find(([k]) => compactName(k) === compactName(v));
    if (hit) {
      if (typeof hit[1] === 'number') return { name: key, real: hit[1] };
      v = hit[1];
    }
  }
  if (convert?.kind === 'hz-to-cents') {
    const n = parseNumber(v);
    if (n && Number.isFinite(n.n) && n.n > 0) return { name: key, real: Math.round(1200 * Math.log2(n.n / (convert.reference || 440)) * 100) / 100 };
  }
  if (!p) return { name: key, text: v };
  const bool = !!(p.isBoolean || p.is_boolean);
  if (bool) return { name: key, text: ON_WORDS.test(v) ? 'On' : OFF_WORDS.test(v) ? 'Off' : v };
  if (p.values && p.values.length) {
    const hit = pickListValue(p.values, v);
    return { name: key, text: hit ?? v };
  }
  if (/^\d+(\.\d+)?\s*:\s*1$/.test(v)) return { name: key, text: v };     // ratio « 2.00:1 » (Pro-C 3 : liste non publiée)
  const range = Array.isArray(p.range) ? p.range : [];
  const lo = range[0] === null || range[0] === undefined ? NaN : Number(range[0]);
  const hi = range[1] === null || range[1] === undefined ? NaN : Number(range[1]);
  if (ON_WORDS.test(v) || OFF_WORDS.test(v)) {
    // Potard continu à position « Off » (HG-2 « Air », Gem « Power ») : extrémité de la plage.
    if (Number.isFinite(lo) && Number.isFinite(hi)) return { name: key, real: ON_WORDS.test(v) ? hi : lo };
    return { name: key, text: v };
  }
  const parsed = parseNumber(v);
  if (!parsed) return { name: key, text: v };
  let n = parsed.n;
  if (n === -Infinity) return Number.isFinite(lo) ? { name: key, real: lo } : { name: key, text: v };
  if (convert?.kind === 'scale') n *= convert.factor;
  const from = parsed.unit;
  const to = unitOfParam(p);
  if (from === 'khz' && to === 'hz') n *= 1000;
  else if (from === 'hz' && to === 'khz') n /= 1000;
  else if (from === 's' && to === 'ms') n *= 1000;
  else if (from === 'ms' && to === 's') n /= 1000;
  else if (from === '%' && to !== '%') {
    if (Number.isFinite(hi) && hi <= 1.5) n /= 100;
  } else if (!from && to === 'hz' && Number.isFinite(lo) && n < lo && n * 1000 >= lo && (!Number.isFinite(hi) || n * 1000 <= hi)) n *= 1000; // « 12 » lu sur un afficheur en kHz
  return { name: key, real: Math.round(n * 1e6) / 1e6 };
};
