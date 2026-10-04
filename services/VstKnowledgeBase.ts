/**
 * Plugins VST3 tiers utilisables par Nova pour mixer : la liste du pont (ce qui
 * est installé MAINTENANT) croisée avec la base de connaissance générée par
 * introspection réelle (data/vst-knowledge/plugins.json : catégorie, paramètres
 * clés, statut) et avec la liste d'exclusion / les plugins « non disponibles »
 * (réglages de l'onglet VST, services/AutotuneVst).
 *
 * Un plugin installé après la génération de la base est lu à la demande, en
 * chargement discret (aucune fenêtre), par introspectMissing().
 */
import { novaBridge, BridgePlugin } from './NovaBridge';
import { autotunePrefs } from './AutotuneVst';
import { candidateKey, isExcluded, toVstParams, vendorOf } from '../utils/autotuneVst';
import { classifyPlugin } from '../utils/vstKnowledge';
import type { KnownPlugin } from '../utils/mixPlanner';

export interface KbEntry {
  key: string; scanName: string; name: string; vendor: string; path: string; pluginName: string | null;
  category: KnownPlugin['category']; compType?: KnownPlugin['compType'];
  status: 'ok' | 'window' | 'error'; reason?: string; latency?: number | null; params?: any[]; roles?: Record<string, string>; bands?: number;
}

let kb: KbEntry[] | null = null;
let kbPromise: Promise<KbEntry[]> | null = null;
/** Paramètres lus à la demande (plugins absents de la base). */
const extra = new Map<string, KbEntry>();

/** Base de connaissance (chargée à la demande : ~ quelques centaines de Ko). */
export const loadKnowledge = (): Promise<KbEntry[]> => {
  if (kb) return Promise.resolve(kb);
  if (!kbPromise) {
    kbPromise = import('../data/vst-knowledge/plugins.json')
      .then((m: any) => { kb = ((m.default || m).plugins || []) as KbEntry[]; return kb; })
      .catch(() => { kb = []; return kb; });
  }
  return kbPromise;
};
export const knowledgeLoaded = () => kb !== null;
/** Tests / préchargement. */
export const setKnowledge = (entries: KbEntry[]) => { kb = entries; };

const byKey = (key: string): KbEntry | undefined => extra.get(key) || kb?.find(e => e.key === key);
const byName = (name: string, path: string): KbEntry | undefined =>
  kb?.find(e => (e.scanName === name || e.name === name) && e.path.toLowerCase() === path.toLowerCase());

/**
 * Plugins tiers installés, prêts pour le planificateur. Les plugins exclus (Slate sauf
 * MetaTune / VerbSuite Classics, SSL…) n'apparaissent pas ; ceux qui ont ouvert une
 * fenêtre de licence / démo ou ne se chargent pas sont gardés avec « unavailable ».
 */
export const installedForMix = (plugins: BridgePlugin[] = novaBridge.getCachedPlugins()): KnownPlugin[] => {
  const prefs = autotunePrefs.get();
  const out: KnownPlugin[] = [];
  const seen = new Set<string>();
  for (const p of plugins) {
    if (p.isInstrument === true) continue;
    const scanned = { name: p.name, vendor: p.vendor, path: p.path, pluginName: p.pluginName ?? null };
    if (isExcluded(scanned, prefs.exclusions)) continue;
    const key = candidateKey(scanned);
    const e = byKey(key) || byName(p.name, p.path);
    const name = e?.name || p.name;
    const vendor = e?.vendor || vendorOf(scanned);
    const dedupe = `${name.toLowerCase()}|${vendor.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const cls = e ? { category: e.category, compType: e.compType } : classifyPlugin(p.name, vendor);
    const unavailable = prefs.unavailable[key]
      || (e?.status === 'window' ? `Demande une licence ou est en démo${e.reason ? ` (${e.reason})` : ''}` : null)
      || (e?.status === 'error' ? 'Ne se charge pas' : null)
      || (p.license === 'nag' ? 'Version d’essai' : null);
    out.push({
      key, name, vendor, path: p.path, pluginName: p.pluginName ?? null,
      category: cls.category, compType: cls.compType,
      params: toVstParams(e?.params || []), latency: e?.latency ?? undefined, unavailable,
    });
  }
  return out;
};

/** Liste lisible par catégorie (commande « quels plugins j'ai ? »). */
export const pluginsByCategory = (list: KnownPlugin[]) => {
  const by = new Map<string, KnownPlugin[]>();
  for (const p of list) {
    const arr = by.get(p.category) || [];
    arr.push(p);
    by.set(p.category, arr);
  }
  return by;
};

/**
 * Lit les paramètres des plugins installés absents de la base (installés depuis),
 * un par un, en chargement discret. Au plus `max` plugins par appel.
 */
export const introspectMissing = async (list: KnownPlugin[], max = 4): Promise<number> => {
  if (!novaBridge.isConnected() || !novaBridge.getBridgeState().paramsText) return 0;
  let n = 0;
  for (const p of list) {
    if (n >= max) break;
    if (p.params.length || p.unavailable) continue;
    const slot = `nova-introspect-${Date.now().toString(36)}-${n}`;
    try {
      const r = await novaBridge.loadPlugin({ slotId: slot, path: p.path, pluginName: p.pluginName, sampleRate: 48000, quiet: true });
      const raw = await novaBridge.getParams(slot);
      const cls = classifyPlugin(r.name || p.name, r.vendor || p.vendor, toVstParams(raw));
      extra.set(p.key, {
        key: p.key, scanName: p.name, name: r.name || p.name, vendor: r.vendor || p.vendor, path: p.path, pluginName: p.pluginName,
        category: cls.category, compType: cls.compType, status: 'ok', latency: r.latencySamples, params: raw,
      });
    } catch (e: any) {
      autotunePrefs.markUnavailable(p.key, e?.licenseRequired ? 'Demande une licence ou une activation' : 'Ne se charge pas');
    } finally {
      novaBridge.unloadPlugin(slot);
      n++;
    }
  }
  return n;
};
