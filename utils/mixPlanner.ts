/**
 * Planificateur de mix de Nova sur les plugins VST3 TIERS installés.
 *
 * Entrées : les plugins du PC (catégorie, rôles des paramètres RÉELS lus par le pont,
 * disponibilité), la chaîne actuelle de la piste, les « dimensions » demandées
 * (utils/mixStyles.ts) et le niveau de la voix. Sortie : un plan (chaîne ordonnée,
 * réglages par nom de paramètre + valeur texte ou réelle, envois, explication en
 * français) appliqué en une seule étape d'historique (Annuler / Ctrl+Z).
 *
 * Ordre de la chaîne voix (logique d'ingé son) :
 *   gain → nettoyage (coupe-bas / EQ correctif) → justesse (autotune) → compression n°1
 *   (rapide, VCA ou FET) → de-esser → saturation / couleur → EQ de tonalité (présence, air)
 *   → largeur ; puis compression n°2 sur le BUS VOIX (autre type, plus douce) ; reverb et
 *   délai en ENVOI (pistes de retour 100 % mouillées) plutôt qu'en insert.
 *
 * Règles maison (Romain, prioritaires) :
 *   - compresseur sur une voix : ratio 2:1, toujours (relu après réglage) ;
 *   - un compresseur à la prise (piste) + un autre d'un AUTRE TYPE sur le bus voix,
 *     ratio 2:1 aussi ; jamais deux fois le même modèle ; un seul compresseur installé :
 *     celui-ci sur la piste et le compresseur de NOVA (réglé autrement) sur le bus ;
 *   - un plugin sans ratio réglable (LA-2A optique, 1176 : 4/8/12/20) n'est pas pris pour
 *     une voix tant qu'un compresseur à ratio réglable existe ; sinon on le dit ;
 *   - jamais de plugin non installé, exclu (Slate sauf MetaTune / VerbSuite Classics,
 *     SSL) ou noté « non disponible » (licence, démo, plantage) ;
 *   - effets intégrés de NOVA seulement en repli, annoncés comme tels.
 */
import type { PluginInstance } from '../types';
import type { VstParam } from './autotuneVst';
import { classifyPlugin, CompType, FxCategory, paramRoles, PluginSetting, toSetting, unitOf } from './vstKnowledge';
import type { Dims } from './mixStyles';

export interface KnownPlugin {
  key: string;
  name: string;
  vendor: string;
  path: string;
  pluginName: string | null;
  category: FxCategory;
  compType?: CompType;
  /** Paramètres réels (introspection du pont, base data/vst-knowledge). */
  params: VstParam[];
  latency?: number;
  /** Raison d'indisponibilité (licence, démo, plantage), sinon null. */
  unavailable?: string | null;
}

export type Slot = 'clean' | 'tune' | 'comp1' | 'deess' | 'sat' | 'tone' | 'width' | 'comp2' | 'verb' | 'delay' | 'radio';

/** Place dans la chaîne voix (plus petit = plus tôt). */
export const SLOT_ORDER: Record<Slot, number> = {
  clean: 10, tune: 20, comp1: 30, deess: 40, sat: 50, radio: 55, tone: 60, width: 70, comp2: 80, verb: 90, delay: 95,
};

export const SLOT_LABEL_FR: Record<Slot, string> = {
  clean: 'nettoyage', tune: 'justesse', comp1: 'compression (prise)', deess: 'de-esser', sat: 'saturation',
  radio: 'filtre radio', tone: 'EQ de tonalité', width: 'largeur', comp2: 'compression (bus voix)', verb: 'reverb', delay: 'délai',
};

/** Effet intégré de NOVA qui joue le même rôle (repli, ou mis en pause quand un VST le remplace). */
const BUILTIN_FOR: Partial<Record<Slot, string>> = {
  clean: 'PROEQ12', comp1: 'COMPRESSOR', deess: 'DEESSER', sat: 'VOCALSATURATOR', tone: 'PROEQ12', width: 'DOUBLER', comp2: 'COMPRESSOR',
};

/** Préférences (du meilleur au moins bon) parmi les plugins installés, par emplacement. */
const FAVORITES: Partial<Record<Slot, RegExp[]>> = {
  clean: [/pro-?q ?4/i, /pro-?q/i, /ozone 9 equalizer/i, /air para eq/i],
  tone: [/pro-?q ?4/i, /pro-?q/i, /ozone 9 equalizer/i, /air para eq/i],
  comp1: [/pro-?c/i, /distressor/i, /comp vca-?65/i, /mpc ?compressor/i, /lookahead ?compressor/i, /comp fet-?76/i, /air compressor/i, /khs compressor/i],
  comp2: [/tube-?tech|cl ?1b/i, /bettermaker/i, /comp vca-?65/i, /shadow hills/i, /pro-?c/i, /comp tube-?sta/i, /comp diode/i, /air compressor/i],
  deess: [/pro-?ds/i, /weiss deess/i, /harrison.?de-?esser/i, /e2deesser/i, /rx \d+ de-?ess/i, /desibilizer/i, /deedger/i],
  sat: [/decapitator/i, /saturn/i, /radiator/i, /harrison tape/i, /studer|ampex|oxide/i, /devil ?loc/i, /tube drive/i],
  radio: [/pro-?q ?4/i, /pro-?q/i],
  verb: [/verbsuite classics/i, /valhalla ?vintage ?verb/i, /valhalla ?plate/i, /lustrous plates/i, /seventh heaven/i, /pure plate/i, /valhalla ?room/i, /superplate/i, /air reverb/i],
  delay: [/echoboy(?!jr)/i, /valhalla ?delay/i, /timeless/i, /galaxy/i, /primaltap/i, /air delay pro/i, /delay tape-?201/i],
  width: [/microshift/i, /ozone 9 imager/i, /air stereo width/i],
};

const SLOT_CATEGORY: Record<Slot, FxCategory[]> = {
  clean: ['eq'], tone: ['eq'], radio: ['eq'], tune: ['autotune'], comp1: ['compressor'], comp2: ['compressor'],
  deess: ['deesser'], sat: ['saturation'], verb: ['reverb'], delay: ['delay'], width: ['pitch', 'stereo', 'modulation'],
};

// ─── Égaliseurs à bandes (Pro-Q…) ────────────────────────────────────────────────

interface Band { n: number; used?: VstParam; enabled?: VstParam; freq?: VstParam; gain?: VstParam; q?: VstParam; shape?: VstParam }

/** Bandes d'un égaliseur paramétrique : « band_3_frequency », « Band 3 Gain »… */
export const eqBands = (params: VstParam[]): Band[] => {
  const map = new Map<number, Band>();
  for (const p of params) {
    const m = p.name.toLowerCase().match(/^band[ _]?(\d+)[ _](used|enabled|frequency|freq|gain|q|shape|type)$/);
    if (!m) continue;
    const k = Number(m[1]);
    const b = map.get(k) || { n: k };
    const field = m[2] === 'freq' ? 'frequency' : m[2] === 'type' ? 'shape' : m[2];
    (b as any)[field === 'frequency' ? 'freq' : field] = p;
    map.set(k, b);
  }
  return [...map.values()].filter(b => b.freq && b.shape).sort((a, b) => a.n - b.n);
};

const SHAPES: Record<'lowcut' | 'bell' | 'highshelf' | 'lowshelf' | 'highcut', RegExp> = {
  lowcut: /^(low ?cut|high ?pass|hp|hpf)$/i, highcut: /^(high ?cut|low ?pass|lp|lpf)$/i,
  bell: /^(bell|peak|peaking|parametric)$/i, highshelf: /^(high ?shelf|hi ?shelf)$/i, lowshelf: /^(low ?shelf|lo ?shelf)$/i,
};

export interface EqMove { shape: keyof typeof SHAPES; freq: number; gain?: number; q?: number; label: string }

/** Réglages d'un EQ à bandes : une bande par mouvement, en partant des bandes libres. */
export const eqSettings = (params: VstParam[], moves: EqMove[], firstBand = 1): PluginSetting[] | null => {
  const bands = eqBands(params).filter(b => b.n >= firstBand);
  if (bands.length < moves.length) return null;
  const out: PluginSetting[] = [];
  moves.forEach((mv, i) => {
    const b = bands[i];
    const shapeText = b.shape!.values?.find(v => SHAPES[mv.shape].test(v.trim()));
    if (!shapeText) return;
    if (b.used) {
      const on = b.used.values?.find(v => /^(used|on|true|1)$/i.test(v)) || 'On';
      out.push({ name: b.used.name, text: on, why: `bande ${b.n} active` });
    }
    if (b.enabled) out.push({ name: b.enabled.name, text: 'On', why: `bande ${b.n} allumée` });
    out.push({ name: b.shape!.name, text: shapeText, why: mv.label });
    const f = toSetting(b.freq!, { value: mv.freq, unit: 'hz' }, mv.label);
    if (f) out.push(f);
    if (typeof mv.gain === 'number' && b.gain) { const g = toSetting(b.gain, { value: mv.gain, unit: 'db' }, mv.label); if (g) out.push(g); }
    if (typeof mv.q === 'number' && b.q) { const q = toSetting(b.q, { value: mv.q, unit: 'none' }, mv.label); if (q) out.push(q); }
  });
  return out.length ? out : null;
};

// ─── Plan ───────────────────────────────────────────────────────────────────────

export interface PlannedVst {
  slot: Slot;
  plugin: KnownPlugin;
  settings: PluginSetting[];
  /** Ce qui a été réglé, pour l'artiste (« coupe-bas à 90 Hz »). */
  says: string[];
}

export interface PlannedBuiltin {
  slot: Slot;
  type: string;
  params: Record<string, any>;
  says: string[];
  /** Pourquoi l'effet de NOVA (aucun VST adapté…). */
  reason: string;
}

export interface TrackPlan {
  trackId: string;
  trackName: string;
  vst: PlannedVst[];
  builtin: PlannedBuiltin[];
  /** Effets de NOVA mis en pause parce qu'un VST les remplace (ids). */
  pauseBuiltin: string[];
}

export interface MixPlan {
  tracks: TrackPlan[];
  /** Style complet (remplace le mix de la piste) ou retouche (« plus d'air ») qui ne touche qu'un aspect. */
  tweakOnly: boolean;
  /** Envois des voix vers les retours (0–1). */
  sends: { sendId: 'send-verb-short' | 'send-verb-long' | 'send-delay'; level: number }[];
  /** Phrases pour l'artiste (résumé), dans l'ordre de la chaîne. */
  summary: string[];
  warnings: string[];
  autotune?: { speed: number; humanize: number; mix: number };
}

export interface PlanContext {
  installed: KnownPlugin[];
  dims: Dims;
  voice: { id: string; name: string; plugins: PluginInstance[] };
  bus?: { id: string; name: string; plugins: PluginInstance[] } | null;
  sendTracks?: { id: string; name: string; plugins: PluginInstance[] }[];
  /** Niveau des passages forts de la voix (dBFS, ~90e centile des niveaux courts). */
  loudDb?: number;
  bpm?: number;
  /** Voix grave (homme) ou aiguë : déplace le coupe-bas et le de-esser. */
  voiceRange?: 'low' | 'mid' | 'high';
  tuneSpeed?: number;
  tweakOnly?: boolean;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const fmtHz = (hz: number) => (hz >= 1000 ? `${r1(hz / 1000)} kHz` : `${Math.round(hz)} Hz`);

const usable = (p: KnownPlugin) => !p.unavailable && p.params && p.params.length > 0;

/** Plugins candidats pour un emplacement, du préféré au moins bon. */
export const candidatesFor = (slot: Slot, installed: KnownPlugin[]): KnownPlugin[] => {
  const cats = SLOT_CATEGORY[slot];
  const fav = FAVORITES[slot] || [];
  const list = installed.filter(p => usable(p) && cats.includes(p.category));
  const rank = (p: KnownPlugin) => { const i = fav.findIndex(re => re.test(p.name)); return i < 0 ? 100 : i; };
  return list.sort((a, b) => rank(a) - rank(b) || (a.latency || 0) - (b.latency || 0) || a.name.localeCompare(b.name));
};

const roleParam = (p: KnownPlugin, role: string) => {
  const roles = paramRoles(p.category === 'channel-strip' ? 'compressor' : p.category, p.params) as Record<string, string>;
  const name = roles[role];
  return name ? p.params.find(x => x.name === name) || null : null;
};

const set = (out: PluginSetting[], says: string[], p: KnownPlugin, role: string, value: number, unit: Parameters<typeof toSetting>[1]['unit'], say?: string) => {
  const prm = roleParam(p, role);
  if (!prm) return false;
  const s = toSetting(prm, { value, unit }, say || role);
  if (!s) return false;
  out.push(s);
  if (say) says.push(say);
  return true;
};

/** Position relative dans la plage (0–1) pour un bouton sans unité (drive 0–10…). */
const setPos = (out: PluginSetting[], p: KnownPlugin, role: string, pos: number, why: string) => {
  const prm = roleParam(p, role);
  if (!prm || !prm.range) return false;
  const [lo, hi] = prm.range;
  if (typeof lo !== 'number' || typeof hi !== 'number') return false;
  out.push({ name: prm.name, real: Math.round((lo + (hi - lo) * Math.max(0, Math.min(1, pos))) * 100) / 100, why });
  return true;
};

const setText = (out: PluginSetting[], p: KnownPlugin, role: string, wanted: RegExp, why: string) => {
  const prm = roleParam(p, role);
  const v = prm?.values?.find(x => wanted.test(x));
  if (!prm || !v) return false;
  out.push({ name: prm.name, text: v, why });
  return true;
};

const bypassOff = (out: PluginSetting[], p: KnownPlugin) => {
  const prm = roleParam(p, 'bypass');
  if (prm && /bypass/i.test(prm.name)) out.push({ name: prm.name, text: 'Off', why: 'plugin actif' });
};

/** Compresseur voix : ratio 2:1 (règle maison), seuil pour ~3–6 dB de réduction, temps selon le type. */
export const compressorRecipe = (p: KnownPlugin, opts: { stage: 1 | 2; loudDb: number; amount: number; trap?: boolean }): { settings: PluginSetting[]; says: string[]; ratioOk: boolean; grDb: number } => {
  const out: PluginSetting[] = [];
  const says: string[] = [];
  bypassOff(out, p);
  const ratioOk = set(out, says, p, 'ratio', 2, 'ratio', 'ratio 2:1');
  // Réduction visée sur les passages forts : prise 3–6 dB, bus 1,5–3 dB.
  const gr = opts.stage === 1 ? 3 + 3 * opts.amount : 1.5 + 1.5 * opts.amount;
  // Ratio 2:1 : réduction = (niveau − seuil) / 2  →  seuil = niveau − 2 × réduction.
  const thr = Math.max(-45, Math.min(-6, opts.loudDb - 2 * gr));
  set(out, says, p, 'threshold', Math.round(thr), 'db', `seuil ${Math.round(thr)} dB (≈ ${r1(gr)} dB de réduction sur les passages forts)`);
  const fast = opts.stage === 1;
  const atk = fast ? (p.compType === 'fet' ? 3 : 8) : 30;
  const rel = fast ? (opts.trap ? 60 : 90) : 250;
  set(out, says, p, 'attack', atk, 'ms', `attaque ${atk} ms`);
  set(out, says, p, 'release', rel, 'ms', `relâchement ${rel} ms`);
  const makeup = Math.round(gr * 0.6 * 10) / 10;
  if (!set(out, says, p, 'makeup', makeup, 'db', `gain de compensation +${makeup} dB`)) {
    const auto = roleParam(p, 'autogain');
    if (auto && auto.values?.length) { out.push({ name: auto.name, text: 'On', why: 'compensation automatique' }); says.push('compensation automatique'); }
  }
  set(out, says, p, 'mix', 100, 'pct');
  return { settings: out, says, ratioOk, grDb: gr };
};

/** Dimensions → plan sur une piste voix (+ bus voix + retours). */
export const planVoiceMix = (ctx: PlanContext): MixPlan => {
  const d = ctx.dims;
  const v = (k: keyof Dims) => d[k] ?? 0;
  const plan: MixPlan = { tracks: [], sends: [], summary: [], warnings: [], tweakOnly: !!ctx.tweakOnly };
  const voice: TrackPlan = { trackId: ctx.voice.id, trackName: ctx.voice.name, vst: [], builtin: [], pauseBuiltin: [] };
  const loud = typeof ctx.loudDb === 'number' && Number.isFinite(ctx.loudDb) ? ctx.loudDb : -14;
  const low = ctx.voiceRange === 'low';
  const used = new Set<string>();
  const take = (slot: Slot, extra?: (p: KnownPlugin) => boolean): KnownPlugin | null => {
    const c = candidatesFor(slot, ctx.installed).find(p => !used.has(p.key) && (!extra || extra(p)));
    if (c) used.add(c.key);
    return c || null;
  };
  const builtinOnTrack = (type: string) => ctx.voice.plugins.find(p => p.type === type && p.isEnabled);
  const addVst = (tp: TrackPlan, slot: Slot, plugin: KnownPlugin, settings: PluginSetting[], says: string[]) => {
    tp.vst.push({ slot, plugin, settings, says });
    const b = BUILTIN_FOR[slot];
    const existing = b && (tp === voice ? ctx.voice.plugins : ctx.bus?.plugins || []).find(p => p.type === b && p.isEnabled);
    if (existing && !tp.pauseBuiltin.includes(existing.id)) tp.pauseBuiltin.push(existing.id);
  };
  const say = (slot: Slot, who: string, says: string[]) => plan.summary.push(`${SLOT_LABEL_FR[slot]} : ${who}${says.length ? ` (${says.join(', ')})` : ''}`);
  const label = (p: KnownPlugin) => `${p.name}${p.vendor ? ` de ${p.vendor}` : ''}`;

  // 1. Nettoyage : coupe-bas (+ boue) sur un EQ à bandes.
  const hp = low ? 80 : ctx.voiceRange === 'high' ? 120 : 100;
  if (v('clean') > 0.2 || v('radio') > 0.5) {
    const radio = v('radio') > 0.5;
    const eq = take(radio ? 'radio' : 'clean', p => eqBands(p.params).length >= 3);
    const moves: EqMove[] = radio
      ? [{ shape: 'lowcut', freq: 450, label: 'coupe-bas 450 Hz' }, { shape: 'highcut', freq: 3500, label: 'coupe-haut 3,5 kHz' }, { shape: 'bell', freq: 1500, gain: 5, q: 1, label: '+5 dB à 1,5 kHz' }]
      : [{ shape: 'lowcut', freq: hp, label: `coupe-bas à ${hp} Hz` }, ...(v('clean') > 0.5 ? [{ shape: 'bell', freq: 300, gain: -2.5, q: 1.2, label: '−2,5 dB à 300 Hz (boue)' } as EqMove] : [])];
    const s = eq ? eqSettings(eq.params, moves) : null;
    if (eq && s) {
      bypassOff(s, eq);
      addVst(voice, radio ? 'radio' : 'clean', eq, s, moves.map(m => m.label));
      say(radio ? 'radio' : 'clean', label(eq), moves.map(m => m.label));
    } else {
      voice.builtin.push({ slot: 'clean', type: 'PROEQ12', params: { highpass: radio ? 450 : hp }, says: [`coupe-bas à ${radio ? 450 : hp} Hz`], reason: 'aucun égaliseur VST pilotable' });
      plan.summary.push(`nettoyage : égaliseur de NOVA (aucun égaliseur VST pilotable) — coupe-bas à ${radio ? 450 : hp} Hz`);
    }
  }

  // 2. Justesse : l'autotune de la piste (celui du PC choisi par l'artiste, sinon NOVA).
  if (v('tune') > 0.2) {
    const speed = typeof ctx.tuneSpeed === 'number' ? ctx.tuneSpeed : v('tune') >= 0.9 ? 0 : 0.25;
    plan.autotune = { speed, humanize: speed >= 0.25 ? 0.35 : 0, mix: v('tune') >= 0.6 ? 1 : 0.6 };
    plan.summary.push(`justesse : autotune calé sur la gamme du beat (vitesse ${Math.round(speed * 100)} ms)`);
  }

  // 3. Compression n°1 (prise) : rapide, VCA ou FET, ratio 2:1 réglable OBLIGATOIRE.
  let comp1Type: CompType | undefined;
  let comp1Key: string | undefined;
  if (v('compression') > 0.2) {
    const c1 = take('comp1', p => (p.compType === 'vca' || p.compType === 'fet' || p.compType === 'digital') && !!compressorRecipe(p, { stage: 1, loudDb: loud, amount: 0 }).ratioOk);
    if (c1) {
      const r = compressorRecipe(c1, { stage: 1, loudDb: loud, amount: v('compression'), trap: v('tune') > 0.8 });
      addVst(voice, 'comp1', c1, r.settings, r.says);
      say('comp1', label(c1), r.says);
      comp1Type = c1.compType; comp1Key = c1.key;
    } else {
      const noRatio = candidatesFor('comp1', ctx.installed).filter(p => !compressorRecipe(p, { stage: 1, loudDb: loud, amount: 0 }).ratioOk).map(p => p.name);
      voice.builtin.push({ slot: 'comp1', type: 'COMPRESSOR', params: { ratio: 2, threshold: Math.round(loud - 8), attack: 0.005, release: 0.09, mode: 'FET' }, says: ['ratio 2:1'], reason: 'aucun compresseur VST à ratio 2:1 réglable' });
      plan.summary.push('compression (prise) : compresseur de NOVA, ratio 2:1 (aucun compresseur VST à ratio 2:1 réglable)');
      if (noRatio.length) plan.warnings.push(`${noRatio.slice(0, 3).join(', ')} : pas de ratio 2:1 possible (règle maison), non utilisé(s) sur la voix.`);
    }
  }

  // 4. De-esser.
  if (v('deess') > 0.3) {
    const de = take('deess');
    if (de) {
      const s: PluginSetting[] = []; const says: string[] = [];
      bypassOff(s, de);
      const f = low ? 5500 : 6500;
      set(s, says, de, 'frequency', f, 'hz', `vers ${fmtHz(f)}`);
      set(s, says, de, 'threshold', Math.round(loud - 12 - 10 * v('deess')), 'db', `seuil ${Math.round(loud - 12 - 10 * v('deess'))} dB`);
      set(s, says, de, 'range', Math.round(3 + 5 * v('deess')), 'db', `jusqu'à −${Math.round(3 + 5 * v('deess'))} dB sur les « s »`);
      addVst(voice, 'deess', de, s, says);
      say('deess', label(de), says);
    } else {
      voice.builtin.push({ slot: 'deess', type: 'DEESSER', params: { threshold: -40, frequency: 6500, reduction: 0.4 + 0.4 * v('deess') }, says: [], reason: 'aucun de-esser VST' });
      plan.summary.push('de-esser : celui de NOVA (aucun de-esser VST installé)');
    }
  }

  // 5. Saturation / couleur (lo-fi : RC-20 si présent).
  const satAmt = Math.max(v('saturation'), v('lofi') * 0.8, v('warmth') * 0.6);
  if (satAmt > 0.25) {
    const sat = v('lofi') > 0.5 ? (take('sat', p => /rc-?20|retro color|lo-?fi|mello/i.test(p.name)) || take('sat')) : take('sat', p => !/bitcrush|fuzz|distortion|phase dist/i.test(p.name));
    if (sat) {
      const s: PluginSetting[] = []; const says: string[] = [];
      bypassOff(s, sat);
      setPos(s, sat, 'drive', 0.15 + 0.45 * satAmt, 'drive');
      says.push(`drive ${Math.round((0.15 + 0.45 * satAmt) * 100)} % de la course`);
      // Saturation parallèle : la voix reste lisible.
      if (set(s, says, sat, 'mix', Math.round(35 + 45 * satAmt), 'pct', `mélange ${Math.round(35 + 45 * satAmt)} %`)) { /* ok */ }
      const ag = roleParam(sat, 'autogain');
      if (ag && ag.values?.some(x => /^(on|true)$/i.test(x))) { s.push({ name: ag.name, text: 'On', why: 'niveau compensé' }); says.push('niveau compensé'); }
      addVst(voice, 'sat', sat, s, says);
      say('sat', label(sat), says);
    } else {
      voice.builtin.push({ slot: 'sat', type: 'VOCALSATURATOR', params: { drive: Math.round(15 + 25 * satAmt), mix: 0.3 + 0.3 * satAmt, mode: 'TAPE' }, says: [], reason: 'aucune saturation VST' });
      plan.summary.push('saturation : celle de NOVA (aucune saturation VST)');
    }
  }

  // 6. EQ de tonalité : présence, air, ou plus sombre.
  const air = v('air'); const pres = v('presence'); const dark = Math.max(v('dark'), v('lofi') * 0.7);
  if (air > 0.25 || pres > 0.25 || dark > 0.3) {
    const moves: EqMove[] = [];
    if (pres > 0.25) moves.push({ shape: 'bell', freq: 3500, gain: r1(1 + 2 * pres), q: 0.9, label: `présence +${r1(1 + 2 * pres)} dB à 3,5 kHz` });
    if (air > 0.25 && dark < 0.3) moves.push({ shape: 'highshelf', freq: 12000, gain: r1(1.5 + 3 * air), q: 0.7, label: `air +${r1(1.5 + 3 * air)} dB au-dessus de 12 kHz` });
    if (dark >= 0.3) moves.push({ shape: 'highcut', freq: Math.round(12000 - 6000 * dark), label: `aigus adoucis (coupe-haut ${fmtHz(12000 - 6000 * dark)})` });
    // Même égaliseur que le nettoyage s'il a des bandes libres : une instance de moins.
    const cleanEq = voice.vst.find(x => x.slot === 'clean' || x.slot === 'radio');
    if (cleanEq && eqBands(cleanEq.plugin.params).length >= (cleanEq.settings.filter(s => /shape|type/i.test(s.name)).length + moves.length)) {
      const used2 = cleanEq.settings.filter(s => /shape|type/i.test(s.name)).length;
      const s = eqSettings(cleanEq.plugin.params, moves, (eqBands(cleanEq.plugin.params)[used2]?.n) || 1);
      if (s) { cleanEq.settings.push(...s); cleanEq.says.push(...moves.map(m => m.label)); plan.summary.push(`EQ de tonalité : ${cleanEq.plugin.name} (${moves.map(m => m.label).join(', ')})`); }
    } else {
      const eq = take('tone', p => eqBands(p.params).length >= moves.length);
      const s = eq ? eqSettings(eq.params, moves) : null;
      if (eq && s) { bypassOff(s, eq); addVst(voice, 'tone', eq, s, moves.map(m => m.label)); say('tone', label(eq), moves.map(m => m.label)); }
      else {
        voice.builtin.push({ slot: 'tone', type: 'PROEQ12', params: { air: air > 0.25, presence: pres }, says: moves.map(m => m.label), reason: 'aucun égaliseur VST pilotable' });
        plan.summary.push(`EQ de tonalité : égaliseur de NOVA (${moves.map(m => m.label).join(', ')})`);
      }
    }
  }

  // 7. Compression n°2 sur le BUS VOIX : autre type, autre modèle, ratio 2:1.
  if (v('compression') > 0.2 && ctx.bus) {
    const bus: TrackPlan = { trackId: ctx.bus.id, trackName: ctx.bus.name, vst: [], builtin: [], pauseBuiltin: [] };
    const different = (p: KnownPlugin) => p.key !== comp1Key && p.name !== voice.vst.find(x => x.slot === 'comp1')?.plugin.name
      && (!comp1Type || p.compType !== comp1Type) && !!compressorRecipe(p, { stage: 2, loudDb: loud, amount: 0 }).ratioOk;
    const c2 = take('comp2', different);
    if (c2) {
      const r = compressorRecipe(c2, { stage: 2, loudDb: loud + 1, amount: v('compression') });
      bus.vst.push({ slot: 'comp2', plugin: c2, settings: r.settings, says: r.says });
      const existing = ctx.bus.plugins.find(p => p.type === 'COMPRESSOR' && p.isEnabled);
      if (existing) bus.pauseBuiltin.push(existing.id);
      plan.summary.push(`compression (bus voix, type ${c2.compType === 'opto' ? 'optique' : c2.compType === 'varimu' ? 'vari-mu' : c2.compType === 'fet' ? 'FET' : 'VCA'} différent de la prise) : ${label(c2)} (${r.says.join(', ')})`);
    } else {
      bus.builtin.push({ slot: 'comp2', type: 'COMPRESSOR', params: { ratio: 2, threshold: Math.round(loud - 4), attack: 0.03, release: 0.25, knee: 10, mode: 'OPTO' }, says: ['ratio 2:1', 'optique, lent'], reason: 'un seul compresseur VST adapté : celui de NOVA, réglé autrement, sur le bus' });
      plan.summary.push('compression (bus voix) : compresseur de NOVA en mode optique lent, ratio 2:1 (pas de 2e compresseur VST d’un autre type)');
    }
    plan.tracks.push(bus);
  }

  // 8. Reverb et délai en ENVOI : sur les pistes de retour (100 % mouillé), dosés par les envois.
  const space = v('space'); const dly = v('delay');
  const sendFor = (id: string) => ctx.sendTracks?.find(t => t.id === id);
  if (space > 0.1) {
    const longVerb = space >= 0.6;
    const sendId = longVerb ? 'send-verb-long' : 'send-verb-short';
    plan.sends.push({ sendId, level: Math.round((0.08 + 0.32 * space) * 100) / 100 });
    const rv = take('verb');
    const target = sendFor(sendId);
    if (rv && target) {
      const s: PluginSetting[] = []; const says: string[] = [];
      bypassOff(s, rv);
      set(s, says, rv, 'mix', 100, 'pct');
      const decay = longVerb ? r1(1.8 + 1.7 * space) : r1(0.8 + 0.6 * space);
      set(s, says, rv, 'decay', decay, 's', `durée ${decay} s`);
      const pre = longVerb ? 40 : 20;
      set(s, says, rv, 'predelay', pre, 'ms', `pré-délai ${pre} ms`);
      set(s, says, rv, 'lowcut', 250, 'hz', 'coupe-bas 250 Hz');
      set(s, says, rv, 'highcut', dark > 0.3 ? 7000 : 11000, 'hz');
      const tp: TrackPlan = { trackId: target.id, trackName: target.name, vst: [{ slot: 'verb', plugin: rv, settings: s, says }], builtin: [], pauseBuiltin: target.plugins.filter(p => p.type === 'REVERB' && p.isEnabled).map(p => p.id) };
      plan.tracks.push(tp);
      plan.summary.push(`reverb en envoi (${target.name}, envoi ${Math.round((0.08 + 0.32 * space) * 100)} %) : ${label(rv)}${says.length ? ` (${says.join(', ')})` : ''}`);
    } else {
      plan.summary.push(`reverb en envoi : celle de NOVA (${longVerb ? 'longue' : 'courte'}), envoi ${Math.round((0.08 + 0.32 * space) * 100)} %`);
    }
  }
  if (dly > 0.1) {
    plan.sends.push({ sendId: 'send-delay', level: Math.round((0.06 + 0.3 * dly) * 100) / 100 });
    const dl = take('delay');
    const target = sendFor('send-delay');
    if (dl && target) {
      const s: PluginSetting[] = []; const says: string[] = [];
      bypassOff(s, dl);
      set(s, says, dl, 'mix', 100, 'pct');
      const sync = roleParam(dl, 'sync');
      if (sync?.values?.some(x => /^(on|true)$/i.test(x))) s.push({ name: sync.name, text: 'On', why: 'calé sur le tempo' });
      const t = roleParam(dl, 'time');
      const quarterMs = 60000 / Math.max(60, ctx.bpm || 120);
      const div = dly >= 0.8 ? '1/4' : '1/8';
      if (t?.values?.length) {
        const hit = t.values.find(x => x.replace(/\s/g, '') === div) || t.values.find(x => x.includes(div));
        if (hit) { s.push({ name: t.name, text: hit, why: `croche ${div}` }); says.push(`calé à la ${div === '1/4' ? 'noire' : 'croche'}`); }
      } else if (t && unitOf(t) !== 'none') {
        const ms = Math.round(div === '1/4' ? quarterMs : quarterMs / 2);
        const st = toSetting(t, { value: ms, unit: 'ms' }, `délai ${ms} ms`);
        if (st) { s.push(st); says.push(`${ms} ms (${div === '1/4' ? 'noire' : 'croche'} à ${ctx.bpm || 120} BPM)`); }
      }
      set(s, says, dl, 'feedback', Math.round(20 + 30 * dly), 'pct', `${Math.round(20 + 30 * dly)} % de répétitions`);
      set(s, says, dl, 'lowcut', 300, 'hz');
      set(s, says, dl, 'highcut', 6000, 'hz', 'échos adoucis (6 kHz)');
      const tp: TrackPlan = { trackId: target.id, trackName: target.name, vst: [{ slot: 'delay', plugin: dl, settings: s, says }], builtin: [], pauseBuiltin: target.plugins.filter(p => p.type === 'DELAY' && p.isEnabled).map(p => p.id) };
      plan.tracks.push(tp);
      plan.summary.push(`délai en envoi (${target.name}, envoi ${Math.round((0.06 + 0.3 * dly) * 100)} %) : ${label(dl)}${says.length ? ` (${says.join(', ')})` : ''}`);
    } else {
      plan.summary.push(`délai en envoi : celui de NOVA, envoi ${Math.round((0.06 + 0.3 * dly) * 100)} %`);
    }
  }

  // Style complet : ce qui n'est pas demandé est retiré des envois (un mix neutre n'a pas de délai).
  if (!ctx.tweakOnly) {
    if (space <= 0.1) plan.sends.push({ sendId: 'send-verb-short', level: 0 }, { sendId: 'send-verb-long', level: 0 });
    else plan.sends.push({ sendId: space >= 0.6 ? 'send-verb-short' : 'send-verb-long', level: 0 });
    if (dly <= 0.1) plan.sends.push({ sendId: 'send-delay', level: 0 });
  }
  plan.tracks.unshift(voice);
  void builtinOnTrack;
  return plan;
};

/**
 * Niveau des passages forts d'une voix (dBFS) : 90e centile des niveaux efficaces sur
 * 400 ms, en ignorant les silences (< −50 dBFS). Sert à placer le seuil des compresseurs
 * pour une réduction de 3 à 6 dB mesurée, quel que soit le niveau de la prise.
 */
export const estimateLoudDb = (samples: Float32Array, sampleRate: number): number | null => {
  const win = Math.max(1, Math.round(sampleRate * 0.4));
  const levels: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let acc = 0;
    for (let k = i; k < i + win; k++) acc += samples[k] * samples[k];
    const db = 10 * Math.log10(acc / win + 1e-12);
    if (db > -50) levels.push(db);
  }
  if (!levels.length) return null;
  levels.sort((a, b) => a - b);
  return Math.round(levels[Math.floor(levels.length * 0.9)] * 10) / 10;
};

/** Ordre final d'une chaîne : effets existants gardés à leur place logique, nouveaux insérés au bon endroit. */
export const slotOfPlugin = (p: PluginInstance): number => {
  const novaSlot = p.params?.novaSlot as Slot | undefined;
  if (novaSlot && SLOT_ORDER[novaSlot]) return SLOT_ORDER[novaSlot];
  switch (p.type) {
    case 'DENOISER': return 5;
    case 'PROEQ12': return SLOT_ORDER.clean;
    case 'AUTOTUNE': return SLOT_ORDER.tune;
    case 'COMPRESSOR': return SLOT_ORDER.comp1;
    case 'DEESSER': return SLOT_ORDER.deess;
    case 'VOCALSATURATOR': return SLOT_ORDER.sat;
    case 'DOUBLER': case 'STEREOSPREADER': case 'CHORUS': return SLOT_ORDER.width;
    case 'REVERB': return SLOT_ORDER.verb;
    case 'DELAY': return SLOT_ORDER.delay;
    case 'VST3': {
      const c = classifyPlugin(p.params?.name || p.name, p.params?.vendor || '');
      const map: Partial<Record<FxCategory, number>> = { eq: SLOT_ORDER.tone, autotune: SLOT_ORDER.tune, compressor: SLOT_ORDER.comp1, deesser: SLOT_ORDER.deess, saturation: SLOT_ORDER.sat, reverb: SLOT_ORDER.verb, delay: SLOT_ORDER.delay, limiter: 99 };
      return map[c.category] ?? 75;
    }
    default: return 75;
  }
};
