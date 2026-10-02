import { useEffect, useState } from 'react';
import { novaBridge, BridgeState } from '../services/NovaBridge';
import { liveVstNodes, onVstNodesChange, VstNodeInfo } from '../engine/VSTPluginNode';

/** État du pont VST (connexion, nombre de plugins). */
export const useBridgeState = (): BridgeState => {
  const [s, setS] = useState<BridgeState>(() => novaBridge.getBridgeState());
  useEffect(() => novaBridge.subscribe(setS), []);
  return s;
};

/** État de l'effet VST3 chargé pour ce plugin (null : pas instancié). */
export const useVstNodeInfo = (pluginId: string): VstNodeInfo | null => {
  const read = () => liveVstNodes.get(pluginId)?.getInfo() || null;
  const [info, setInfo] = useState<VstNodeInfo | null>(read);
  useEffect(() => {
    setInfo(read());
    return onVstNodesChange(() => setInfo(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId]);
  return info;
};
