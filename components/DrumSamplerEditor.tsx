import React, { useState, useEffect, useRef } from 'react';
import { PluginInstance } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import WaveformRenderer from './WaveformRenderer';
import { DrumSamplerNode, DrumSamplerParams } from '../engine/DrumSamplerNode';
import { Faceplate, HwSection, HwWindow, Knob, PushButton, type KnobProps } from '../plugins/hw';

/**
 * Drum sampler (instrument DRUM_SAMPLER), dessiné comme un sampler de batterie de
 * studio (kit plugins/hw) : façade bleu ciel, écran du son avec début / fin à
 * glisser, gros pad « Écouter », blocs Source, Enveloppe et Filtre en boutons
 * rotatifs, poussoirs Inverser / Normaliser, groupe d'étouffement à LED.
 * Mêmes réglages, mêmes bornes, mêmes envois au moteur qu'avant (updateParams avec
 * la seule valeur changée) : preuve dans tests/pluginsFin.test.ts.
 */
interface DrumSamplerEditorProps {
  plugin: PluginInstance;
  trackId: string;
  onClose: () => void;
}

const DRUM_ACCENT = '#ea580c';
const DRUM_DEFAULTS: DrumSamplerParams = {
  gain: 0, transpose: 0, fineTune: 0, sampleStart: 0, sampleEnd: 1,
  attack: 0.005, hold: 0.05, decay: 0.2, sustain: 0, release: 0.1,
  cutoff: 20000, resonance: 0, pan: 0, velocitySens: 0.8,
  reverse: false, normalize: false, chokeGroup: 1, isEnabled: true,
};
const fr = (v: number, d = 0) => v.toFixed(d).replace('.', ',');
const signed = (v: number, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + fr(Math.abs(v), d);
const msTxt = (s: number) => `${Math.round(s * 1000)} ms`;
const hzTxt = (v: number) => (v >= 1000 ? `${fr(v / 1000, v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const HINTS: Record<string, string> = {
  gain: 'Volume du son (dB).',
  pan: 'Place le son à gauche ou à droite.',
  transpose: 'Accord : monte ou descend le son, en demi-tons (12 = une octave).',
  fineTune: 'Accord fin, en centièmes de demi-ton.',
  attack: 'Attaque : temps pour atteindre le volume. Court = coup sec.',
  hold: 'Tenue : temps pendant lequel le son reste au maximum.',
  decay: 'Déclin : temps pour descendre au maintien. Court = son sec, long = son qui traîne.',
  sustain: 'Maintien : niveau tant que la note est tenue (0 % pour une batterie, en général).',
  release: 'Relâche : extinction après la note.',
  cutoff: 'Filtre coupe-haut : à gauche le son devient plus sourd, tout à droite il est ouvert.',
  resonance: 'Résonance du filtre : accentue la fréquence de coupure.',
  velocitySens: 'Vélocité : à quel point la force de frappe change le volume.',
  reverse: 'Inverser : joue le son à l’envers.',
  normalize: 'Normaliser : remonte le son à son niveau maximal.',
  choke: 'Groupe d’étouffement : un son coupe les autres sons du même groupe (charley ouvert coupé par le fermé).',
};

const DrumSamplerEditor: React.FC<DrumSamplerEditorProps> = ({ trackId, onClose }) => {
  const [params, setParams] = useState<DrumSamplerParams>({ ...DRUM_DEFAULTS });
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [loadError, setLoadError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Nœud audio de la piste
  const nodeRef = useRef<DrumSamplerNode | null>(null);

  useEffect(() => {
     const node = audioEngine.getDrumSamplerNode(trackId);
     if (node) {
         nodeRef.current = node;
         setParams(node.getParams());
         if (node.getBuffer()) {
             setBuffer(node.getBuffer());
             setFileName('Son chargé');
         }
     }
  }, [trackId]);

  // Même envoi qu'avant : seule la valeur changée part au moteur.
  const updateParam = (key: keyof DrumSamplerParams, value: any) => {
      const newParams = { ...params, [key]: value };
      setParams(newParams);
      if (nodeRef.current) {
          nodeRef.current.updateParams({ [key]: value });
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
          nodeRef.current = audioEngine.getDrumSamplerNode(trackId);
      } catch (e) {
          console.error("Drum Sample Load Error:", e);
          setLoadError(true);
      }
  };

  const previewSound = () => {
      if (nodeRef.current) {
          nodeRef.current.trigger(1.0, 0);
      }
  };

  // Début / fin du son : on glisse le repère (souris ou doigt).
  const dragMarker = (which: 'sampleStart' | 'sampleEnd') => (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      const rect = e.currentTarget.parentElement!.getBoundingClientRect();
      const onMove = (m: PointerEvent) => {
          const x = (m.clientX - rect.left) / rect.width;
          const p = which === 'sampleStart' ? Math.max(0, Math.min(params.sampleEnd, x)) : Math.max(params.sampleStart, Math.min(1, x));
          updateParam(which, p);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', onMove), { once: true });
  };

  const K = (id: keyof DrumSamplerParams, label: string, o: Pick<KnobProps, 'min' | 'max'> & Partial<KnobProps>) => (
    <Knob paramId={id} label={label} hint={HINTS[id]} value={params[id] as number} defaultValue={DRUM_DEFAULTS[id] as number}
      onChange={v => updateParam(id, v)} cap="black" arc={DRUM_ACCENT} size="S" {...o} />
  );
  const pick = () => fileInputRef.current?.click();

  return (
    <HwWindow type="DRUM_SAMPLER" width={760} accent={DRUM_ACCENT} accentInk="#ffffff"
      toolbar={
        <div className="hw-toolbar-row">
          <button type="button" className="hw-chip" onClick={pick} title="Choisir un son (WAV, MP3, AIFF…) sur l'ordinateur ou le téléphone">
            <i className="fas fa-folder-open mr-1.5" aria-hidden="true" />Charger un son
          </button>
          <button type="button" className="hw-chip hidden sm:inline-block ml-auto" aria-label="Fermer" title="Fermer" onClick={onClose}><i className="fas fa-times" aria-hidden="true" /></button>
        </div>
      }
      idleHelp={<>Un son de batterie par piste : règle sa source, son enveloppe et son filtre. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="sky" model="Drum sampler" kicker="Un coup · zéro latence" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: DRUM_ACCENT }}>
        <div className="flex flex-wrap sm:flex-nowrap items-stretch gap-3">
          <div className="hw-screen w-full sm:flex-1 min-w-0">
            <div className="hw-screen-glass" style={{ height: 130 }} data-nova-drum-screen
              onDragOver={(e) => e.preventDefault()} onDrop={handleFileDrop}>
              {buffer ? (
                <div className="absolute inset-0 w-full h-full">
                  <WaveformRenderer buffer={buffer} color="#fb923c" height={130} offset={0} duration={buffer.duration} pixelsPerSecond={760 / buffer.duration} />
                  <div className="absolute top-0 bottom-0 left-0 bg-black/55 pointer-events-none" style={{ width: `${params.sampleStart * 100}%` }} />
                  <div className="absolute top-0 bottom-0 right-0 bg-black/55 pointer-events-none" style={{ width: `${(1 - params.sampleEnd) * 100}%` }} />
                  <div role="slider" aria-label="Début du son" aria-valuemin={0} aria-valuemax={1} aria-valuenow={params.sampleStart} title="Début du son : glisse le repère vert"
                    className="absolute top-0 bottom-0 w-3 -ml-1.5 cursor-ew-resize z-10 touch-none" style={{ left: `${params.sampleStart * 100}%` }} onPointerDown={dragMarker('sampleStart')}>
                    <span className="absolute left-1/2 top-0 bottom-0 w-0.5 -ml-px" style={{ background: '#22c55e' }} />
                  </div>
                  <div role="slider" aria-label="Fin du son" aria-valuemin={0} aria-valuemax={1} aria-valuenow={params.sampleEnd} title="Fin du son : glisse le repère rouge"
                    className="absolute top-0 bottom-0 w-3 -ml-1.5 cursor-ew-resize z-10 touch-none" style={{ left: `${params.sampleEnd * 100}%` }} onPointerDown={dragMarker('sampleEnd')}>
                    <span className="absolute left-1/2 top-0 bottom-0 w-0.5 -ml-px" style={{ background: '#ef4444' }} />
                  </div>
                </div>
              ) : (
                <button type="button" onClick={pick} className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center" style={{ color: '#cbd5e1' }}>
                  <i className="fas fa-drum text-2xl" aria-hidden="true" />
                  <span className="text-[12px] font-bold">Glisse un son de batterie ici</span>
                  <span className="text-[11px]" style={{ color: '#a3aec0' }}>ou touche pour le choisir</span>
                </button>
              )}
              {(fileName || loadError) && (
                <span className="hw-screen-label" style={{ top: 6, left: 8 }} role={loadError ? 'alert' : 'status'}>
                  {loadError ? <>Fichier illisible : essaie un WAV ou un MP3</> : <b>{fileName}</b>}
                </span>
              )}
            </div>
            <input type="file" ref={fileInputRef} className="hidden" accept="audio/*" onChange={handleFileSelect} />
          </div>
          <button type="button" className="hw-pad w-full sm:w-32" onClick={previewSound} data-nova-drum-preview title="Écouter le son (comme un coup sur le pad)"
            style={{ ['--hw-pad-lit' as any]: '#fb923c' }}>
            <i className="fas fa-play" aria-hidden="true" /> Écouter<small>un coup</small>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.4fr_1fr] gap-3 mt-3">
          <HwSection title="Source">
            <div className="grid grid-cols-2 justify-items-center gap-y-2">
              {K('gain', 'Volume', { min: -60, max: 12, format: v => `${signed(v, 1)} dB`, scale: [{ v: -60, label: '−60' }, { v: 0, label: '0' }, { v: 12, label: '+12' }] })}
              {K('pan', 'Pan', { min: -1, max: 1, bipolar: true, format: v => (Math.abs(v) < 0.005 ? 'centre' : `${v < 0 ? 'G' : 'D'} ${Math.round(Math.abs(v) * 100)}`), scale: [{ v: -1, label: 'G' }, { v: 0, label: '0' }, { v: 1, label: 'D' }] })}
              {K('transpose', 'Accord', { min: -24, max: 24, step: 1, bipolar: true, format: v => `${signed(v)} dt`, scale: [{ v: -24, label: '−24' }, { v: 0, label: '0' }, { v: 24, label: '+24' }] })}
              {K('fineTune', 'Fin', { min: -100, max: 100, bipolar: true, format: v => `${signed(v)} ct`, scale: [{ v: -100, label: '−' }, { v: 0, label: '0' }, { v: 100, label: '+' }] })}
            </div>
            <div className="flex justify-center gap-2 mt-2">
              <span data-nova-param="reverse"><PushButton role="checkbox" active={!!params.reverse} onClick={() => updateParam('reverse', !params.reverse)} text="Inverser" led={DRUM_ACCENT} hint={HINTS.reverse} dark /></span>
              <span data-nova-param="normalize"><PushButton role="checkbox" active={!!params.normalize} onClick={() => updateParam('normalize', !params.normalize)} text="Normaliser" led={DRUM_ACCENT} hint={HINTS.normalize} dark /></span>
            </div>
          </HwSection>
          <HwSection title="Enveloppe">
            <div className="flex flex-wrap items-start justify-around gap-x-1 gap-y-2">
              {K('attack', 'Attaque', { min: 0, max: 0.5, format: msTxt, scale: [{ v: 0, label: '0' }, { v: 0.5, label: '500' }] })}
              {K('hold', 'Tenue', { min: 0, max: 0.5, format: msTxt, scale: [{ v: 0, label: '0' }, { v: 0.5, label: '500' }] })}
              {K('decay', 'Déclin', { min: 0, max: 1, format: msTxt, scale: [{ v: 0, label: '0' }, { v: 1, label: '1 s' }] })}
              {K('sustain', 'Maintien', { min: 0, max: 1, format: v => `${Math.round(v * 100)} %`, scale: [{ v: 0, label: '0' }, { v: 1, label: '100' }] })}
              {K('release', 'Relâche', { min: 0, max: 1, format: msTxt, scale: [{ v: 0, label: '0' }, { v: 1, label: '1 s' }] })}
            </div>
          </HwSection>
          <HwSection title="Filtre et frappe">
            <div className="flex flex-wrap items-start justify-around gap-x-1 gap-y-2">
              {K('cutoff', 'Coupure', { min: 20, max: 20000, curve: 'log', format: v => (v >= 19999 ? 'ouvert' : hzTxt(v)), scale: [{ v: 20, label: '20' }, { v: 1000, label: '1k' }, { v: 20000, label: '20k' }] })}
              {K('resonance', 'Résonance', { min: 0, max: 20, format: v => fr(v, 1), scale: [{ v: 0, label: '0' }, { v: 20, label: '20' }] })}
              {K('velocitySens', 'Vélocité', { min: 0, max: 1, format: v => `${Math.round(v * 100)} %`, scale: [{ v: 0, label: '0' }, { v: 1, label: '100' }] })}
            </div>
            <div className="flex flex-col items-center gap-1 mt-2" title={HINTS.choke}>
              <span className="hw-silk">Étouffement</span>
              <div className="flex gap-1.5" role="radiogroup" aria-label="Groupe d'étouffement" data-nova-param="chokeGroup">
                {[1, 2, 3, 4].map(g => (
                  <PushButton key={g} role="radio" active={params.chokeGroup === g} onClick={() => updateParam('chokeGroup', g)} text={String(g)} led={DRUM_ACCENT}
                    ariaLabel={`Groupe d'étouffement ${g}`} hint={HINTS.choke} dark />
                ))}
              </div>
            </div>
          </HwSection>
        </div>
      </Faceplate>
    </HwWindow>
  );
};

export default DrumSamplerEditor;
