import type { VstAutomatableParam } from '../services/NovaBridge';

/**
 * Automation des VST (R9) : catalogue des réglages automatisables par effet VST
 * (id de l'effet → liste lue par le pont), et textes affichés par le plugin
 * (id::clé → textes pour 0, 0,01 … 1). Survit à la reconstruction des nœuds :
 * les voies gardent leur nom et leurs unités. Sans dépendance (étiquettes, tests).
 */
export const vstParamCatalog = new Map<string, VstAutomatableParam[]>();
export const vstParamTexts = new Map<string, string[]>();
const listeners = new Set<() => void>();
export const onVstCatalogChange = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const notifyVstCatalog = () => listeners.forEach(cb => { try { cb(); } catch { /* */ } });

/** Texte affiché par le plugin pour une valeur brute (null si inconnu). */
export function vstValueText(pluginId: string, key: string, raw: number): string | null {
  const t = vstParamTexts.get(`${pluginId}::${key}`);
  if (!t || !t.length || !Number.isFinite(raw)) return null;
  const i = Math.max(0, Math.min(t.length - 1, Math.round(raw * (t.length - 1))));
  return t[i] || null;
}

/** Nom affiché d'un réglage VST (« Threshold »), d'après le catalogue. */
export function vstParamDisplayName(pluginId: string, key: string): string | null {
  return vstParamCatalog.get(pluginId)?.find(p => p.name === key)?.displayName || null;
}
