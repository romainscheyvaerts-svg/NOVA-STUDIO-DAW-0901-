/**
 * Retrouver un plugin VST3 dans la liste du PC, par son nom et son éditeur, en
 * tolérant les variantes d'écriture d'une session à l'autre :
 *  - versions Waves (WaveShell1-VST3 14.12 / 17.1… : le chemin change, pas le nom) ;
 *  - mono / stéréo : « CLA-76 Mono », « H-Delay Mono/Stereo », « (s) », « (m) »,
 *    « (stereo) » comme les écrit Pro Tools ;
 *  - préfixe d'éditeur dans le nom (« FabFilter Pro-C 3 » / « Pro-C 3 »), tirets,
 *    espaces et casse (« Pro-C3 », « pro c 3 ») ;
 *  - en dernier recours, une autre version du même plugin (« Pro-Q 3 » pour
 *    « Pro-Q 4 ») : signalée, et l'état enregistré n'est pas réutilisé.
 * Les plugins exclus (Slate sauf MetaTune / VerbSuite Classics, SSL…) ne sont
 * jamais choisis (utils/autotuneVst.isExcluded).
 */
import { DEFAULT_EXCLUSIONS, ExclusionList, isExcluded } from './autotuneVst';
import { classifyPlugin, FxCategory } from './vstKnowledge';
import type { PluginType } from '../types';

/** Plugin installé (liste du pont, ou base de connaissance générée). */
export interface VstCandidate {
  name: string;
  vendor?: string;
  path: string;
  pluginName?: string | null;
  isInstrument?: boolean | null;
  /** Licence, démo ou plantage connus : à éviter. */
  unavailable?: boolean;
  /** Nom lu au scan (« FabFilter Pro-C 3 »), si différent du nom. */
  scanName?: string;
}

export type MatchKind = 'exact' | 'variant' | 'fuzzy' | 'other-version';

export interface VstMatch {
  plugin: VstCandidate;
  kind: MatchKind;
  /** Explication courte en français (« version stéréo », « autre version : Pro-Q 3 »…). */
  note?: string;
}

export type Channels = 'mono' | 'stereo' | 'mono/stereo' | null;

const fold = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const VENDOR_PREFIX = /^(fabfilter|waves|uadx|uad|universal audio|soundtoys|antares|slate digital|softube|plugin alliance|brainworx|arturia|izotope|kilohearts|kHs|eventide|sonnox|valhalla dsp|a\.o\.m\.?)\s+/i;

/** Variante mono / stéréo écrite dans le nom. */
export const channelsOf = (name: string): Channels => {
  const x = fold(name).trim();
  if (/(\(|\s)(mono\/stereo|m\/s|m2s)\)?$/.test(x)) return 'mono/stereo';
  if (/(\(|\s)(stereo|st|s)\)?$/.test(x)) return 'stereo';
  if (/(\(|\s)(mono|m)\)?$/.test(x)) return 'mono';
  return null;
};

/** Nom sans éditeur, sans variante mono / stéréo, sans format (« x64 », « VST3 »). */
export const baseName = (name: string): string => {
  let x = fold(name).trim();
  x = x.replace(/\.vst3$/, '');
  for (let i = 0; i < 3; i++) {
    const before = x;
    x = x
      .replace(/\s*\((mono\/stereo|m\/s|m2s|stereo|mono|st|s|m|x64|vst3?|aax|native)\)\s*$/, '')
      .replace(/\s+(mono\/stereo|m\/s|m2s|stereo|mono|x64|vst3?)\s*$/, '')
      .trim();
    if (x === before) break;
  }
  x = x.replace(VENDOR_PREFIX, '');
  return x.trim();
};

/** Forme compacte pour comparer (« Pro-C 3 » → « proc3 »). */
export const compact = (s: string) => fold(s).replace(/[^a-z0-9]/g, '');

/** Nom compact sans le numéro de version final (« proc3 » → « proc »). */
const family = (s: string) => compact(s).replace(/(v|mk)?\d+$/, '');

const vendorCompact = (v?: string) => compact((v || '').replace(/\(.*?\)|,?\s*(llc|inc\.?|gmbh|ltd\.?)$/gi, ''));

/** Éditeurs compatibles (vide = inconnu = compatible). */
export const sameVendor = (a?: string, b?: string): boolean => {
  const x = vendorCompact(a);
  const y = vendorCompact(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const alias = (v: string) => (/^(uadx?|universalaudio)/.test(v) ? 'ua' : /^(brainworx|pluginalliance)$/.test(v) ? 'pa' : /^(ssl|solidstatelogic)$/.test(v) ? 'ssl' : v);
  return alias(x) === alias(y);
};

/** Ordre de préférence des variantes : NOVA traite tout en stéréo. */
const channelRank = (wanted: Channels, got: Channels): number => {
  if (wanted && wanted === got) return 0;
  const order: Channels[] = ['stereo', 'mono/stereo', null, 'mono'];
  return 1 + order.indexOf(got);
};

const namesOf = (c: VstCandidate) => [c.pluginName, c.name, c.scanName].filter((x): x is string => !!x);

export interface ResolveOptions {
  exclusions?: ExclusionList;
  /** Autoriser une autre version du même plugin (dernier recours, signalé). */
  allowOtherVersion?: boolean;
}

/**
 * Plugin du PC correspondant à `name` (+ éditeur). null : rien d'utilisable.
 * Les plugins exclus ou marqués indisponibles passent après tout le reste
 * (exclus : jamais).
 */
export const resolveVst = (
  name: string, vendor: string | undefined, list: VstCandidate[], opts: ResolveOptions = {},
): VstMatch | null => {
  const ex = opts.exclusions || DEFAULT_EXCLUSIONS;
  const wantedCh = channelsOf(name);
  const wantFull = compact(name);
  const wantBase = compact(baseName(name));
  const wantFamily = family(baseName(name));
  const pool = list.filter(c => c.isInstrument !== true && !isExcluded({ name: c.name, vendor: c.vendor || '', path: c.path }, ex));
  type Scored = { c: VstCandidate; kind: MatchKind; score: number; note?: string };
  const scored: Scored[] = [];
  for (const c of pool) {
    const names = namesOf(c);
    const vendorOk = sameVendor(vendor, c.vendor);
    const gotCh = names.map(channelsOf).find(x => x) || null;
    const penalty = (c.unavailable ? 50 : 0) + (vendorOk ? 0 : 20);
    const chNote = gotCh ? `version ${gotCh === 'mono/stereo' ? 'mono/stéréo' : gotCh === 'stereo' ? 'stéréo' : 'mono'}` : 'version standard';
    if (wantBase && names.some(x => compact(x) === wantFull || compact(baseName(x)) === wantBase)) {
      // Même plugin (éditeur / tirets / casse près) : exact si la variante est la même.
      const exact = wantedCh === gotCh && vendorOk;
      scored.push({ c, kind: exact ? 'exact' : 'variant', score: (exact ? 0 : 10) + penalty + channelRank(wantedCh, gotCh), note: exact ? undefined : chNote });
      continue;
    }
    if (!vendorOk) continue;
    if (wantBase.length >= 5 && names.some(x => { const b = compact(baseName(x)); return b.length >= 5 && (b.includes(wantBase) || wantBase.includes(b)); })) {
      scored.push({ c, kind: 'fuzzy', score: 30 + penalty + channelRank(wantedCh, gotCh), note: `nom proche : ${c.name}` });
      continue;
    }
    if (opts.allowOtherVersion !== false && wantFamily.length >= 3 && names.some(x => family(baseName(x)) === wantFamily)) {
      scored.push({ c, kind: 'other-version', score: 60 + penalty + channelRank(wantedCh, gotCh), note: `autre version : ${c.name}` });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name));
  const best = scored[0];
  return { plugin: best.c, kind: best.kind, note: best.c.unavailable ? `${best.note ? `${best.note}, ` : ''}licence ou démo à vérifier` : best.note };
};

/** Effet de NOVA qui remplace un plugin absent, d'après sa catégorie (null : aucun). */
export const builtinForCategory = (cat: FxCategory): PluginType | null => {
  const map: Partial<Record<FxCategory, PluginType>> = {
    eq: 'PROEQ12', compressor: 'COMPRESSOR', 'channel-strip': 'COMPRESSOR', limiter: 'LIMITER', deesser: 'DEESSER',
    saturation: 'VOCALSATURATOR', amp: 'VOCALSATURATOR', reverb: 'REVERB', delay: 'DELAY', autotune: 'AUTOTUNE',
    modulation: 'CHORUS', stereo: 'STEREOSPREADER', gate: 'DENOISER',
  };
  return map[cat] || null;
};

/** Effet de NOVA de remplacement pour un plugin tiers. */
export const builtinFor = (name: string, vendor = ''): PluginType | null => builtinForCategory(classifyPlugin(name, vendor).category);

/** Libellés français des effets de NOVA (rapports, messages). */
export const BUILTIN_LABEL_FR: Partial<Record<PluginType, string>> = {
  PROEQ12: "l'égaliseur NOVA", COMPRESSOR: 'le compresseur NOVA', LIMITER: 'le limiteur NOVA', DEESSER: 'le de-esser NOVA',
  VOCALSATURATOR: 'la saturation NOVA', REVERB: 'la reverb NOVA', DELAY: "l'écho NOVA", AUTOTUNE: "l'autotune NOVA",
  CHORUS: 'le chorus NOVA', STEREOSPREADER: "l'élargisseur stéréo NOVA", DENOISER: 'la porte de bruit NOVA',
};
