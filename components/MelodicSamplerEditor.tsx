import React, { useEffect } from 'react';
import { PluginInstance } from '../types';
import { openSamplerPanel } from '../utils/samplerPanelStore';

/**
 * Ancien éditeur du plugin « Melodic Sampler » (code mort avant R18). Le
 * sampler vit maintenant sur la piste (track.melodicSampler) avec son propre
 * écran (components/SamplerPanel) : ouvrir l'ancien plugin ouvre cet écran.
 */
interface MelodicSamplerEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onClose: () => void;
}

const MelodicSamplerEditor: React.FC<MelodicSamplerEditorProps> = ({ trackId, onClose }) => {
  useEffect(() => { openSamplerPanel(trackId); onClose(); }, [trackId, onClose]);
  return null;
};

export default MelodicSamplerEditor;
