import type { BridgePlugin } from '../services/NovaBridge';
import { groupVstPlugins } from './vstGroups';
import { araPluginKey } from './araEdit';
import { vstFxId } from './fxFavorites';

/** Métadonnées enregistrées dans plugin.params à l'ajout d'un VST3. */
export const vstMetadata = (p: BridgePlugin) => ({
  name: p.name, vendor: p.vendor, uid: p.uid, localPath: p.path, pluginName: p.pluginName || undefined,
});

/**
 * VST du PC dans le menu « Ajouter un effet » d'une tranche (audit mix 22/10/2026) : avant, un VST ne
 * s'ajoutait que depuis l'onglet VST du navigateur (choisir la piste, ouvrir l'onglet, chercher) ;
 * dans un DAW, le clic sur un insert vide propose tous les plugins. Une ligne par plugin (variantes
 * Waves regroupées, la stéréo posée), rangés par éditeur. Écartés : instruments, groupes Waves pas
 * encore lus, plugins isolés (plantage), et Melodyne / VocAlign (déjà proposés en insert ARA). Module pur.
 */
export interface VstMenuEntry { id: string; name: string; icon: string; cat: string; kind: string; also: string; plugin: BridgePlugin }

export function vstMenuEntries(plugins: BridgePlugin[]): VstMenuEntry[] {
  const usable = plugins.filter(p => p.category !== 'Instrument' && !p.unstable && !p.quarantined
    && !(!p.shell && !p.pluginName && /shell/i.test(p.name)) && !araPluginKey(p.path || p.name));
  return groupVstPlugins(usable).map(r => ({
    id: vstFxId(r.main),
    name: r.name,
    icon: 'fa-plug',
    cat: `VST · ${r.main.vendor || 'autres'}`,
    kind: r.variants.length ? 'VST3 · stéréo' : 'VST3',
    also: `vst plugin ${r.main.vendor || ''} ${r.main.name}`,
    plugin: r.main,
  }));
}
