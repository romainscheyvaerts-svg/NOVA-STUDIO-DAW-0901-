/**
 * Lot 8c — One Knob : un gros bouton par piste voix (0 à 100 %) qui pilote plusieurs
 * réglages à la fois, sur les effets NATIFS de la piste. 8 macros :
 * Présence, Chaleur, Brillance, Compression, Espace, Autotune, Largeur, Saturation.
 *
 * Principe (déterministe, réversible) :
 *  - au premier tour d'une macro, les réglages de départ des effets pilotés sont notés
 *    (`voiceChain.base`) ; chaque position des 8 macros recalcule les réglages À PARTIR
 *    DE CE DÉPART : remettre toutes les macros à 0 % rend exactement la chaîne d'avant ;
 *  - une retouche à la main d'un réglage piloté (dans la fenêtre de l'effet) est détectée
 *    (`voiceChain.last`) et devient le nouveau départ de ce réglage ;
 *  - un effet absent est ajouté avec un réglage neutre (Nova Tune, Doubleur, Saturation,
 *    égaliseur, compresseur 2:1) et retiré quand ses macros reviennent à 0 % ;
 *  - Ctrl+Z : chaque mouvement est une modification de la piste ; les mouvements
 *    rapprochés d'un même geste se fondent en une étape (anti-rebond de l'historique).
 *
 * Courbes (a = position 0 à 1), documentées dans CONTENU/nova-bandlab/lot8_presets/RAPPORT.md :
 *  - Présence : présence (cloche 3,5 kHz) +5·a dB, boue (300 Hz) −3·a dB, envois de réverbe
 *    × (1 − 0,4·a) (courte) et × (1 − 0,5·a) (longue) : la voix vient devant.
 *  - Chaleur : corps (200 Hz) +3·a dB, air (12 kHz) −2·a dB, saturation à bande : dosage +25·a %,
 *    drive +10·a ; seuil de l'étage 2 +1,5·a dB (le grave ajouté ne fait pas dépasser 5 dB).
 *  - Brillance : air (12 kHz) +3·a dB, étagère 15 kHz +3·a dB (sauf voix secondaires coupées à
 *    15 kHz), de-esser +0,15·a de profondeur (les « s » suivent).
 *  - Compression : étage 1 seuil −marge1·a dB (marge1 = 2 × (4,8 − réduction calée) : en 2:1,
 *    1 dB de seuil ≈ 0,5 dB de réduction ; 4 dB sans preset) et gain +marge1·a/4 dB ; étage 2
 *    (Opto Vintage) seuil −marge2·a (marge mesurée au labo jusqu'à 5 dB au VU sur la pire prise),
 *    sortie +marge2·a/4 dB ; Vox Strip : « Compression » +marge2·a. 100 % = 5 dB max par étage,
 *    la règle maison, jamais plus (mesuré : RAPPORT.md).
 *  - Espace : envois réverbe courte +0,25·a, réverbe longue +0,15·a, écho +0,12·a (en ENVOI,
 *    jamais en insert : règle maison).
 *  - Autotune : Nova Tune vitesse × (1 − a) et naturel × (1 − a) : 100 % = effet robot ; ajouté
 *    à 49 ms / naturel 0,5 s'il manque (correction douce au début de la course).
 *  - Largeur : doubleur, niveau des copies +0,4·a, largeur → +80 % du reste, désaccord +0,25·a ;
 *    sortie de l'étage 2 −2·a dB (les copies ajoutent ~2 dB : niveau tenu).
 *  - Saturation : drive +35·a, dosage +50·a %, sortie +0,5·a dB (niveau tenu, mesuré).
 */
import type { OneKnobMacro, PluginInstance, PluginType, Track, TrackSend, VoiceChainState } from '../types';
import { EQ_BAND, findVoicePreset, makeVoicePlugin, SEND_IDS } from './voicePresets';

export interface OneKnobMacroDef {
  id: OneKnobMacro;
  name: string;
  /** Ce que fait la macro, pour l'artiste (infobulle, ligne d'info). */
  hint: string;
  /** Effets qu'elle pilote (et qu'elle ajoute s'ils manquent). */
  drives: PluginType[];
}

export const ONE_KNOB_MACROS: OneKnobMacroDef[] = [
  { id: 'presence', name: 'Présence', hint: 'La voix vient devant : plus de présence vers 3,5 kHz, moins de boue, un peu moins de réverbe.', drives: ['PROEQ12'] },
  { id: 'chaleur', name: 'Chaleur', hint: 'Plus ronde et plus proche : du corps vers 200 Hz, aigus adoucis, une touche de saturation à bande.', drives: ['PROEQ12', 'VOCALSATURATOR'] },
  { id: 'brillance', name: 'Brillance', hint: 'Plus d’air et de brillance (12-15 kHz) ; le de-esser suit pour garder les « s » doux.', drives: ['PROEQ12'] },
  { id: 'compression', name: 'Compression', hint: 'Voix plus tenue et plus dense ; à 100 %, 5 dB de réduction au VU, la règle du studio, jamais plus.', drives: ['COMPRESSOR'] },
  { id: 'espace', name: 'Espace', hint: 'Plus de réverbe et d’écho, en envoi (la voix reste nette).', drives: [] },
  { id: 'autotune', name: 'Autotune', hint: 'De la justesse naturelle (début de course) à l’effet robot (100 %), dans la tonalité du projet.', drives: ['AUTOTUNE'] },
  { id: 'largeur', name: 'Largeur', hint: 'Doubleur : la voix s’ouvre à gauche et à droite, le centre reste en place.', drives: ['DOUBLER'] },
  { id: 'saturation', name: 'Saturation', hint: 'Du grain et de l’agressivité (saturation à bande), niveau tenu.', drives: ['VOCALSATURATOR'] },
];

export const macroDef = (id: OneKnobMacro) => ONE_KNOB_MACROS.find(m => m.id === id)!;
export const MACRO_ORDER: OneKnobMacro[] = ONE_KNOB_MACROS.map(m => m.id);

// ---------------------------------------------------------------------------
// Réglages pilotés : chemins « clé » ou « bands.6.gain »
// ---------------------------------------------------------------------------

type Params = Record<string, any>;
const getPath = (p: Params, path: string): any => path.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), p);
function setPath(p: Params, path: string, v: any) {
  const ks = path.split('.');
  let o: any = p;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
  o[ks[ks.length - 1]] = v;
}
const band = (i: number, k: string) => `bands.${i}.${k}`;

/** Réglages pilotés par effet (tous les chemins que les macros peuvent écrire). */
const CONTROLLED: Partial<Record<PluginType, string[]>> = {
  PROEQ12: [EQ_BAND.body, EQ_BAND.mud, EQ_BAND.presence, EQ_BAND.air, EQ_BAND.shelf].flatMap(i => ['gain', 'frequency', 'q', 'isEnabled', 'type'].map(k => band(i, k))),
  COMPRESSOR: ['threshold', 'makeupGain'],
  OPTO_VINTAGE: ['threshold', 'output'],
  VOXSTRIP: ['compThresh', 'output'],
  DEESSER: ['reduction'],
  AUTOTUNE: ['speed', 'humanize', 'mix'],
  DOUBLER: ['gainL', 'gainR', 'width', 'detune'],
  VOCALSATURATOR: ['drive', 'mix', 'outputGain'],
};

/** Réglages neutres d'un effet ajouté par le One Knob. */
const ADDED_PARAMS: Partial<Record<PluginType, Params>> = {
  AUTOTUNE: { speed: 0.45, humanize: 0.5, mix: 1 },
  DOUBLER: { detune: 0.2, width: 0.5, gainL: 0, gainR: 0, directOn: true },
  VOCALSATURATOR: { drive: 10, mix: 0, tone: 0, eqLow: 0, eqMid: 0, eqHigh: 0, mode: 'TAPE', outputGain: 1 },
  COMPRESSOR: { threshold: -18, ratio: 2, knee: 6, attack: 0.005, release: 0.08, makeupGain: 1, autoMakeup: false, mix: 1, scHpFreq: 100, lookahead: 0, mode: 'CLEAN' },
};

/** Effets que chaque macro ajoute s'ils manquent. */
const ADDS: Partial<Record<OneKnobMacro, PluginType[]>> = {
  presence: ['PROEQ12'], chaleur: ['PROEQ12', 'VOCALSATURATOR'], brillance: ['PROEQ12'], compression: ['COMPRESSOR'],
  autotune: ['AUTOTUNE'], largeur: ['DOUBLER'], saturation: ['VOCALSATURATOR'],
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const same = (a: any, b: any) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b);

/** Place d'un effet ajouté dans la chaîne (ordre d'un preset). */
function insertIndex(plugins: PluginInstance[], type: PluginType): number {
  const pos = (t: PluginType[]) => plugins.findIndex(p => t.includes(p.type));
  const after = (t: PluginType[]) => { let i = -1; plugins.forEach((p, k) => { if (t.includes(p.type)) i = k; }); return i; };
  switch (type) {
    case 'AUTOTUNE': { const i = after(['DENOISER', 'GATE']); return i + 1; }
    case 'PROEQ12': { const i = pos(['COMPRESSOR', 'DEESSER', 'OPTO_VINTAGE', 'VOXSTRIP']); return i >= 0 ? i : after(['DENOISER', 'AUTOTUNE', 'VOICESHIFT']) + 1; }
    case 'COMPRESSOR': { const i = after(['PROEQ12']); return i >= 0 ? i + 1 : after(['DENOISER', 'AUTOTUNE', 'VOICESHIFT']) + 1; }
    case 'VOCALSATURATOR': { const i = after(['OPTO_VINTAGE', 'VOXSTRIP', 'COMPRESSOR', 'DEESSER']); return i >= 0 ? i + 1 : (pos(['DOUBLER', 'LOFI']) >= 0 ? pos(['DOUBLER', 'LOFI']) : plugins.length); }
    default: return plugins.length;
  }
}

/** Neutre d'un égaliseur ajouté : bandes à 0 dB, coupe-bas 80 Hz. */
function neutralEq(): Params {
  const freqs = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
  // Q en convention v2 (engine/eqQ.ts) : 0,7071 = Butterworth, coupe-bas à −3 dB pile à 80 Hz.
  return { masterGain: 1, qVersion: 2, bands: freqs.map((frequency, id) => ({ id, type: id === 0 ? 'highpass' : id === 11 ? 'lowpass' : 'peaking', frequency, gain: 0, q: id === 0 || id === 11 ? Math.SQRT1_2 : 1, isEnabled: id === 0, isSolo: false })) };
}

export interface OneKnobOptions {
  /** Retours présents dans le projet (ids) : la macro Espace y crée l'envoi s'il manque. */
  returns?: string[];
  projectKey?: number | null;
  projectScale?: string | null;
}

/**
 * Tourne une macro du One Knob sur une piste. Pur : renvoie la nouvelle piste.
 * `amount` 0 à 1. La macro affichée devient `macro`.
 */
export function applyOneKnob(track: Track, macro: OneKnobMacro, amount: number, opts: OneKnobOptions = {}): { track: Track; added: string[]; removed: string[] } {
  const vc: VoiceChainState = { ...(track.voiceChain || {}) };
  const amounts: Partial<Record<OneKnobMacro, number>> = { ...(vc.amounts || {}), [macro]: r3(clamp01(amount)) };
  const base: Record<string, Params> = structuredClone(vc.base || {});
  const last: Record<string, Params> = vc.last || {};
  let added = [...(vc.added || [])];
  const addedNow: string[] = [], removedNow: string[] = [];
  // Effets gardés tels quels (même objet) tant qu'une macro ne change pas leurs réglages :
  // le moteur ne retouche que ce qui bouge pendant qu'on tourne.
  let plugins: PluginInstance[] = [...track.plugins];
  const on = (m: OneKnobMacro) => (amounts[m] || 0) > 0;

  // 1. Effets à ajouter (macro active, effet absent), effets ajoutés devenus inutiles.
  for (const m of MACRO_ORDER) {
    if (!on(m)) continue;
    for (const type of ADDS[m] || []) {
      if (plugins.some(p => p.type === type)) continue;
      const params = type === 'PROEQ12' ? neutralEq()
        : type === 'AUTOTUNE' ? { ...ADDED_PARAMS.AUTOTUNE, rootKey: typeof opts.projectKey === 'number' && opts.projectScale ? opts.projectKey : 0, scale: typeof opts.projectKey === 'number' && opts.projectScale ? opts.projectScale : 'CHROMATIC' }
        : { ...ADDED_PARAMS[type] };
      const pl = makeVoicePlugin(type, params, 'pl-knob');
      plugins.splice(insertIndex(plugins, type), 0, pl);
      added.push(pl.id); addedNow.push(pl.id);
    }
  }
  plugins = plugins.filter(p => {
    if (!added.includes(p.id)) return true;
    const needed = MACRO_ORDER.some(m => on(m) && (ADDS[m] || []).includes(p.type));
    if (!needed) { removedNow.push(p.id); delete base[p.id]; }
    return needed;
  });
  added = added.filter(id => plugins.some(p => p.id === id));

  // 2. Départ de chaque réglage piloté (une retouche à la main devient le départ).
  for (const p of plugins) {
    const paths = CONTROLLED[p.type];
    if (!paths) continue;
    const b = base[p.id] || (base[p.id] = {});
    for (const path of paths) {
      const cur = getPath(p.params, path);
      if (cur === undefined) continue;
      if (!(path in b)) { b[path] = cur; continue; }
      const l = last[p.id]?.[path];
      if (l !== undefined && !same(cur, l)) b[path] = cur;
    }
  }
  // Envois : départ noté une fois, retouche détectée.
  const sendsBase: Record<string, number> = { ...(vc.sendsBase || {}) };
  const lastSends = (vc.last || {})['__sends'] || {};
  for (const s of track.sends || []) {
    if (!(s.id in sendsBase)) sendsBase[s.id] = s.level;
    else if (lastSends[s.id] !== undefined && !same(s.level, lastSends[s.id])) sendsBase[s.id] = s.level;
  }

  // 3. Réglages = départ, puis chaque macro dans l'ordre.
  const val: Record<string, Params> = {};
  for (const p of plugins) if (base[p.id]) val[p.id] = { ...base[p.id] };
  const first = (t: PluginType) => plugins.find(p => p.type === t);
  const V = (p: PluginInstance | undefined, path: string, fn: (v: number) => any) => {
    if (!p || !val[p.id] || val[p.id][path] === undefined) return;
    val[p.id][path] = fn(val[p.id][path]);
  };
  const eq = first('PROEQ12');
  /** Bande de l'égaliseur prête à l'emploi (activée à sa fréquence de rôle si elle dormait). */
  const eqBand = (i: number, freq: number, q: number, type = 'peaking') => {
    if (!eq || !val[eq.id]) return false;
    const v = val[eq.id];
    if (!v[band(i, 'isEnabled')] && Math.abs(v[band(i, 'gain')] || 0) < 1e-6) {
      v[band(i, 'frequency')] = freq; v[band(i, 'q')] = q; v[band(i, 'type')] = type; v[band(i, 'isEnabled')] = true;
    }
    return true;
  };
  const addGain = (i: number, db: number) => { if (eq && val[eq.id]) val[eq.id][band(i, 'gain')] = r3(clamp((val[eq.id][band(i, 'gain')] || 0) + db, -18, 18)); };
  const lpBelow = (hz: number) => { const b11 = eq?.params?.bands?.[EQ_BAND.lp]; return !!b11?.isEnabled && b11.frequency <= hz; };
  const sends: Record<string, number> = { ...sendsBase };
  const preset = findVoicePreset(vc.presetId);
  const head2 = preset?.calib?.head2 && preset.calib.head2 > 0 ? preset.calib.head2 : null;
  const head1 = preset?.calib?.gr1 ? clamp(2 * (4.8 - preset.calib.gr1), 0, 6) : 4;

  const A = (m: OneKnobMacro) => amounts[m] || 0;
  // Présence
  if (A('presence') > 0) {
    const a = A('presence');
    if (eqBand(EQ_BAND.presence, 3500, 0.9)) addGain(EQ_BAND.presence, 5 * a);
    if (eqBand(EQ_BAND.mud, 300, 1.2)) addGain(EQ_BAND.mud, -3 * a);
    if (sends[SEND_IDS.verbShort] !== undefined) sends[SEND_IDS.verbShort] *= 1 - 0.4 * a;
    if (sends[SEND_IDS.verbLong] !== undefined) sends[SEND_IDS.verbLong] *= 1 - 0.5 * a;
  }
  // Chaleur
  if (A('chaleur') > 0) {
    const a = A('chaleur');
    if (eqBand(EQ_BAND.body, 200, 0.8)) addGain(EQ_BAND.body, 3 * a);
    if (eqBand(EQ_BAND.air, 12000, 0.8)) addGain(EQ_BAND.air, -2 * a);
    const sat = first('VOCALSATURATOR');
    V(sat, 'mix', v => r3(clamp(v + 0.25 * a, 0, 1)));
    V(sat, 'drive', v => r3(clamp(v + 10 * a, 0, 100)));
    V(first('OPTO_VINTAGE'), 'threshold', v => r3(clamp(v + 1.5 * a, -60, 20)));
    V(first('VOXSTRIP'), 'compThresh', v => r3(clamp(v - 0.5 * a, 0, 10)));
  }
  // Brillance
  if (A('brillance') > 0) {
    const a = A('brillance');
    if (eqBand(EQ_BAND.air, 12000, 0.8)) addGain(EQ_BAND.air, 3 * a);
    if (!lpBelow(15500) && eqBand(EQ_BAND.shelf, 15000, 0.71, 'highshelf')) addGain(EQ_BAND.shelf, 3 * a);
    V(first('DEESSER'), 'reduction', v => r3(clamp(v + 0.15 * a, 0, 1)));
  }
  // Compression (règle maison : 5 dB max au VU à 100 %)
  if (A('compression') > 0) {
    const a = A('compression');
    const c1 = first('COMPRESSOR');
    V(c1, 'threshold', v => r3(clamp(v - head1 * a, -60, 0)));
    V(c1, 'makeupGain', v => r3(v * Math.pow(10, (head1 * a / 4) / 20)));
    const opto = first('OPTO_VINTAGE');
    const h = head2 ?? 4;
    V(opto, 'threshold', v => r3(clamp(v - h * a, -60, 20)));
    V(opto, 'output', v => r3(clamp(v + (h * a) / 4, -18, 28)));
    const vox = first('VOXSTRIP');
    const hv = head2 ?? 1.5;
    V(vox, 'compThresh', v => r3(clamp(v + hv * a, 0, 10)));
    V(vox, 'output', v => r3(clamp(v + 1.5 * a, -30, 12)));
  }
  // Espace (envois)
  if (A('espace') > 0) {
    const a = A('espace');
    const add = (id: string, d: number) => {
      if (sends[id] === undefined) { if (!opts.returns?.includes(id)) return; sends[id] = 0; }
      sends[id] = clamp(sends[id] + d * a, 0, 1);
    };
    add(SEND_IDS.verbShort, 0.25); add(SEND_IDS.verbLong, 0.15); add(SEND_IDS.delay, 0.12);
  }
  // Autotune
  if (A('autotune') > 0) {
    const a = A('autotune');
    const at = first('AUTOTUNE');
    V(at, 'speed', v => r3(v * (1 - a)));
    V(at, 'humanize', v => r3(v * (1 - a)));
    V(at, 'mix', v => (v < 1 ? r3(v + (1 - v) * a) : v));
  }
  // Largeur
  if (A('largeur') > 0) {
    const a = A('largeur');
    const d = first('DOUBLER');
    V(d, 'gainL', v => r3(clamp(v + 0.4 * a, 0, 0.9)));
    V(d, 'gainR', v => r3(clamp(v + 0.4 * a, 0, 0.9)));
    V(d, 'width', v => r3(clamp(v + (1 - v) * 0.8 * a, 0, 1)));
    V(d, 'detune', v => r3(clamp(v + 0.25 * a, 0, 1)));
    V(first('OPTO_VINTAGE'), 'output', v => r3(clamp(v - 2 * a, -18, 28)));
    V(first('VOXSTRIP'), 'output', v => r3(clamp(v - 2 * a, -30, 12)));
  }
  // Saturation
  if (A('saturation') > 0) {
    const a = A('saturation');
    const sat = first('VOCALSATURATOR');
    V(sat, 'drive', v => r3(clamp(v + 35 * a, 0, 100)));
    V(sat, 'mix', v => r3(clamp(v + 0.5 * a, 0, 1)));
    V(sat, 'outputGain', v => r3(v * Math.pow(10, (0.5 * a) / 20)));
  }

  // 4. Écriture (copie seulement des effets dont un réglage change).
  const newLast: Record<string, Params> = {};
  plugins = plugins.map(p => {
    const v = val[p.id];
    if (!v) return p;
    newLast[p.id] = v;
    const changed = Object.entries(v).some(([path, x]) => !same(getPath(p.params || {}, path), x));
    if (!changed) return p;
    const params = structuredClone(p.params || {});
    for (const [path, x] of Object.entries(v)) setPath(params, path, x);
    return { ...p, params };
  });
  const outSends: TrackSend[] = (track.sends || []).map(s => (sends[s.id] !== undefined ? { ...s, level: r3(sends[s.id]), isEnabled: sends[s.id] > 0 ? true : s.isEnabled } : s));
  for (const id of Object.keys(sends)) if (!outSends.some(s => s.id === id) && sends[id] > 0) outSends.push({ id, level: r3(sends[id]), isEnabled: true });
  newLast['__sends'] = Object.fromEntries(outSends.map(s => [s.id, s.level]));
  for (const s of outSends) if (!(s.id in sendsBase)) sendsBase[s.id] = 0;

  const nextVc: VoiceChainState = { ...vc, macro, amounts, base, last: newLast, sendsBase, added };
  return { track: { ...track, plugins, sends: outSends, voiceChain: nextVc }, added: addedNow, removed: removedNow };
}

/** Position d'une macro sur une piste (0 à 1). */
export const knobAmount = (track: Track, macro: OneKnobMacro) => clamp01(track.voiceChain?.amounts?.[macro] || 0);
/** Macro affichée sur le gros bouton (Présence par défaut). */
export const knobMacro = (track: Track): OneKnobMacro => track.voiceChain?.macro || 'presence';

/** Change la macro affichée sans rien toucher au son. */
export const selectKnobMacro = (track: Track, macro: OneKnobMacro): Track => ({ ...track, voiceChain: { ...(track.voiceChain || {}), macro } });

/** Remet toutes les macros à 0 % (la chaîne d'avant le One Knob). */
export function resetOneKnob(track: Track, opts: OneKnobOptions = {}): Track {
  let t = track;
  const am = track.voiceChain?.amounts || {};
  for (const m of MACRO_ORDER) if ((am[m] || 0) > 0) t = applyOneKnob(t, m, 0, opts).track;
  return t;
}

/** Texte d'une position (« Présence 40 % »). */
export const knobText = (macro: OneKnobMacro, amount: number) => `${macroDef(macro).name} ${Math.round(clamp01(amount) * 100)} %`;
