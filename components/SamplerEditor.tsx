import React, { useState, useEffect, useRef } from 'react';
import { PluginInstance } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import WaveformRenderer from './WaveformRenderer';
import { Faceplate, HwSection, HwWindow, Knob } from '../plugins/hw';

/**
 * Sampler (instrument SAMPLER), dessiné comme un sampler de studio (kit plugins/hw) :
 * façade vieux rose, écran du son chargé (glisser-déposer ou clic), enveloppe en
 * quatre boutons rotatifs. Mêmes réglages et mêmes envois qu'avant au moteur
 * (setADSR avec l'enveloppe complète) : preuve dans tests/pluginsFin.test.ts.
 */
interface SamplerEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onClose: () => void;
}

const SAMPLER_ACCENT = '#be185d';
const ADSR_DEFAULTS = { attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.5 };
const secFr = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2).replace('.', ',')} s`);
const HINTS = {
  attack: 'Attaque : temps pour atteindre le volume quand la note démarre. Court = net, long = le son « monte ».',
  decay: 'Déclin : temps pour descendre jusqu’au niveau de maintien.',
  sustain: 'Maintien : niveau tant que la note est tenue.',
  release: 'Relâche : temps d’extinction après avoir lâché la note.',
};

const SamplerEditor: React.FC<SamplerEditorProps> = ({ trackId, onClose }) => {
  const [adsr, setAdsr] = useState({ ...ADSR_DEFAULTS });
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [loadError, setLoadError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // À l'ouverture : l'enveloppe affichée part au moteur, et on reprend le son déjà chargé.
  useEffect(() => {
     updateEngine();
  }, []);

  const updateEngine = () => {
     const dsp = (audioEngine as any).tracksDSP.get(trackId);
     if (dsp && dsp.sampler) {
         dsp.sampler.setADSR(adsr);
         if (dsp.sampler.getBuffer()) {
             setBuffer(dsp.sampler.getBuffer());
             setFileName('Son chargé');
         }
     }
  };

  const handleKnobChange = (param: keyof typeof adsr, value: number) => {
     const newAdsr = { ...adsr, [param]: value };
     setAdsr(newAdsr);
     const dsp = (audioEngine as any).tracksDSP.get(trackId);
     if (dsp && dsp.sampler) {
         dsp.sampler.setADSR(newAdsr);
     }
  };

  const handleFileDrop = async (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadFile(file);
  };

  const loadFile = async (file: File) => {
      setFileName(file.name);
      setLoadError(false);
      try {
          const arrayBuffer = await file.arrayBuffer();
          await audioEngine.init();
          const audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
          setBuffer(audioBuffer);
          audioEngine.loadSamplerBuffer(trackId, audioBuffer);
      } catch (e) {
          console.error("Sampler Load Error:", e);
          setLoadError(true);
      }
  };

  const K = (id: keyof typeof adsr, label: string, max: number, fmt: (v: number) => string, scale: { v: number; label: string }[]) => (
    <Knob paramId={id} label={label} hint={HINTS[id]} value={adsr[id]} min={0} max={max} defaultValue={ADSR_DEFAULTS[id]}
      onChange={v => handleKnobChange(id, v)} format={fmt} scale={scale} cap="black" arc={SAMPLER_ACCENT} size="M" />
  );
  const pick = () => fileInputRef.current?.click();

  return (
    <HwWindow type="SAMPLER" width={560} accent={SAMPLER_ACCENT} accentInk="#ffffff"
      toolbar={
        <div className="hw-toolbar-row">
          <button type="button" className="hw-chip" onClick={pick} title="Choisir un son (WAV, MP3, AIFF…) sur l'ordinateur ou le téléphone">
            <i className="fas fa-folder-open mr-1.5" aria-hidden="true" />Charger un son
          </button>
          <button type="button" className="hw-chip hidden sm:inline-block ml-auto" aria-label="Fermer" title="Fermer" onClick={onClose}><i className="fas fa-times" aria-hidden="true" /></button>
        </div>
      }
      idleHelp={<>Joue un son sur toutes les notes du clavier. <span style={{ color: '#7d8696' }}>Glisse un son sur l’écran, puis règle l’enveloppe.</span></>}>
      <Faceplate finish="rose" model="Sampler" kicker="Un son · toutes les notes" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: SAMPLER_ACCENT }}>
        <div className="hw-screen">
          <div className="hw-screen-glass cursor-pointer" style={{ height: 120 }} role="button" tabIndex={0} aria-label="Charger un son : glisse un fichier ici ou clique"
            data-nova-sampler-drop onDragOver={(e) => e.preventDefault()} onDrop={handleFileDrop}
            onClick={pick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}>
            {buffer ? (
              <WaveformRenderer buffer={buffer} color="#f9a8d4" height={120} offset={0} duration={buffer.duration} pixelsPerSecond={500 / buffer.duration} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center" style={{ color: '#cbd5e1' }}>
                <i className="fas fa-file-audio text-2xl" aria-hidden="true" />
                <span className="text-[12px] font-bold">Glisse un son ici</span>
                <span className="text-[11px]" style={{ color: '#a3aec0' }}>ou clique pour le choisir</span>
              </div>
            )}
            {(fileName || loadError) && (
              <span className="hw-screen-label" style={{ bottom: 6, left: 8 }} role={loadError ? 'alert' : 'status'}>
                {loadError ? <>Fichier illisible : essaie un WAV ou un MP3</> : <b>{fileName}</b>}
              </span>
            )}
          </div>
          <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={handleFileSelect} />
        </div>
        <HwSection title="Enveloppe" className="mt-3">
          <div className="flex flex-wrap items-start justify-around gap-x-2 gap-y-3">
            {K('attack', 'Attaque', 2, secFr, [{ v: 0, label: '0' }, { v: 1, label: '1' }, { v: 2, label: '2 s' }])}
            {K('decay', 'Déclin', 2, secFr, [{ v: 0, label: '0' }, { v: 1, label: '1' }, { v: 2, label: '2 s' }])}
            {K('sustain', 'Maintien', 1, v => `${Math.round(v * 100)} %`, [{ v: 0, label: '0' }, { v: 0.5, label: '50' }, { v: 1, label: '100' }])}
            {K('release', 'Relâche', 5, secFr, [{ v: 0, label: '0' }, { v: 2.5, label: '2,5' }, { v: 5, label: '5 s' }])}
          </div>
        </HwSection>
      </Faceplate>
    </HwWindow>
  );
};

export default SamplerEditor;
