import { registerEditCommands } from './editCommands';
import { monitorStore, type SoloListen } from './monitorSection';

/**
 * Commandes de la section d'écoute (raccourcis Alt+M, Ctrl+Alt+D, Alt+X, palette
 * Ctrl+K) : branchées une fois, au chargement de l'appli (App.tsx). Elles ne
 * touchent qu'à l'écoute (utils/monitorSection) : ni le projet, ni l'historique
 * d'annulation, ni l'export. Les pastilles de la barre montrent l'état.
 */
let installed = false;

export function installMonitorCommands(): void {
  if (installed) return;
  installed = true;
  registerEditCommands({
    monitorMono: () => { monitorStore.toggleMono(); return true; },
    monitorSide: () => { monitorStore.toggleSide(); return true; },
    monitorDim: () => { monitorStore.toggleDim(); return true; },
    monitorCut: () => { monitorStore.toggleCut(); return true; },
    monitorReset: () => { monitorStore.reset(); return true; },
    soloListen: (arg?: { mode?: SoloListen }) => {
      const cur = monitorStore.get().listen;
      const mode: SoloListen = arg?.mode || (cur === 'sip' ? 'afl' : cur === 'afl' ? 'pfl' : 'sip');
      monitorStore.set({ listen: mode });
      return true;
    },
  });
}
