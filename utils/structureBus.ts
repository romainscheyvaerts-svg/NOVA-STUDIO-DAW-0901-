import type { Track } from '../types';
import type { PluginState } from './trackStructure';

/**
 * Commandes de structure (pistes masquées / inactives, dossiers, VCA, bus,
 * état des effets) envoyées par n'importe quel écran (en-tête de piste,
 * console, liste des pistes, menus) et appliquées par App, sans faire passer
 * de nouvelles props dans les gros composants.
 */
export type StructurePanel = 'tracks' | 'buses' | 'hidden';

export type StructureCommand =
  /** Transformation pure des pistes (utils/trackStructure) ; `label` = message affiché (facultatif). */
  | { kind: 'tracks'; apply: (tracks: Track[]) => Track[]; label?: string }
  /** État d'un effet : actif / bypass / inactif (un VST inactif garde son état stateB64). */
  | { kind: 'pluginState'; trackId: string; pluginId: string; state: PluginState }
  /** Ouvre (ou ferme, null) un panneau : liste des pistes, bus nommés, pistes masquées (téléphone). */
  | { kind: 'panel'; panel: StructurePanel | null }
  /** Envoi en grand dans la console (Send View) : 0 à 9 = a à j, null = vue normale. */
  | { kind: 'sendView'; slot: number | null };

type Listener = (cmd: StructureCommand) => void;
const listeners = new Set<Listener>();

export const structureBus = {
  on(cb: Listener): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; },
  emit(cmd: StructureCommand) { listeners.forEach(cb => { try { cb(cmd); } catch (e) { console.warn('[structure]', e); } }); },
};

/** Raccourci : appliquer une transformation de pistes. */
export const applyTracks = (apply: (tracks: Track[]) => Track[], label?: string) => structureBus.emit({ kind: 'tracks', apply, label });
