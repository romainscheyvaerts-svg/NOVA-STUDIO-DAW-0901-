import { useSyncExternalStore } from 'react';
import type { DAWState } from '../types';

/**
 * R21 · Bus de la session pro : les composants (panneau Session, liste des
 * clips, arrangements, notes, fenêtre d'import, menu ☰) parlent à App sans
 * qu'App passe des dizaines de props. Branché par hooks/useR21.
 */

export type R21Tab = 'notes' | 'clips' | 'arrangements' | 'versions';

export type R21Command =
  /** Ouvre le panneau Session sur un onglet (null : le ferme). */
  | { kind: 'panel'; tab: R21Tab | null }
  /** Ouvre la fenêtre « Importer depuis une session ». */
  | { kind: 'import'; open: boolean }
  /** Modification du projet (une étape d'annulation), avec un message. */
  | { kind: 'apply'; apply: (s: DAWState) => DAWState; label?: string }
  /** Modification sans étape d'annulation (texte des notes en cours de frappe). */
  | { kind: 'silent'; apply: (s: DAWState) => DAWState }
  /** Pose un clip de la liste sur une piste. */
  | { kind: 'placeClip'; key: string; trackId: string; time: number }
  /** « Enregistrer comme nouvelle version » (commentaire facultatif). */
  | { kind: 'saveVersion'; comment: string }
  /** Ouvre l'historique complet des versions. */
  | { kind: 'openVersions' }
  /** Restaure une version de l'historique. */
  | { kind: 'restoreVersion'; id: number; label: string }
  /** Exporte un arrangement (ouvre la fenêtre Exporter dessus). */
  | { kind: 'exportArrangement'; id: string }
  /** Message à l'utilisateur. */
  | { kind: 'notify'; text: string };

const ls = new Set<(c: R21Command) => void>();
export const r21Bus = {
  emit(c: R21Command) { ls.forEach(l => l(c)); },
  on(l: (c: R21Command) => void) { ls.add(l); return () => { ls.delete(l); }; },
};

export const openSessionPanel = (tab: R21Tab | null) => r21Bus.emit({ kind: 'panel', tab });
export const openImportSession = () => r21Bus.emit({ kind: 'import', open: true });
export const applyR21 = (apply: (s: DAWState) => DAWState, label?: string) => r21Bus.emit({ kind: 'apply', apply, label });
export const applyR21Silent = (apply: (s: DAWState) => DAWState) => r21Bus.emit({ kind: 'silent', apply });

// Arrangement à exporter : posé avant d'ouvrir la fenêtre Exporter, lu une fois par elle.
let pendingExport: string | null = null;
export const setExportArrangement = (id: string | null) => { pendingExport = id; };
export const takeExportArrangement = (): string | null => { const v = pendingExport; pendingExport = null; return v; };

// Onglet ouvert du panneau Session (lu par le dock, le menu ☰ et le panneau).
let tabNow: R21Tab | null = null;
const tl = new Set<() => void>();
export const sessionPanelStore = {
  get: () => tabNow,
  set(t: R21Tab | null) { if (t === tabNow) return; tabNow = t; tl.forEach(l => l()); },
  subscribe(l: () => void) { tl.add(l); return () => { tl.delete(l); }; },
};
export const useSessionPanel = () => useSyncExternalStore(sessionPanelStore.subscribe, sessionPanelStore.get, sessionPanelStore.get);
