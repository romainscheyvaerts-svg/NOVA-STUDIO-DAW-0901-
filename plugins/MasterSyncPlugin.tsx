

import React, { useState, useEffect } from 'react';
import { AudioAnalysisEngine } from '../engine/AudioAnalysisEngine';
// FIX: Centralized music theory constants by importing `NOTES` from the `AutoTunePlugin` module.
import { NOTES } from './AutoTunePlugin';
import { Faceplate, HwSection, HwWindow, Led, PushButton } from './hw';
import { tonaliteFr } from '../utils/keyName';

/**
 * MODULE FX_14 : MASTER SYNC (ANALYSE & INJECTION)
 * Utilise AudioAnalysisEngine pour scanner l'instru (WAV) et configurer la session.
 */

export interface MasterSyncParams {
  detectedBpm: number;
  detectedKey: number;
  detectedTransient: number; // Nouveau: Position du drop
  isMinor: boolean;
  isAnalyzing: boolean;
  analysisProgress: number;
  isEnabled: boolean;
  hasResult: boolean;
  error?: string;
  alignmentApplied?: string; // Info pour l'UI
}

export class MasterSyncNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private params: MasterSyncParams = {
    detectedBpm: 120,
    detectedKey: 0,
    detectedTransient: 0,
    isMinor: false,
    isAnalyzing: false,
    analysisProgress: 0,
    isEnabled: true,
    hasResult: false
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }

  public updateParams(p: Partial<MasterSyncParams>) {
    this.params = { ...this.params, ...p };
  }

  public async analyzeInstru(buffer: AudioBuffer) {
    this.updateParams({ isAnalyzing: true, analysisProgress: 5, hasResult: false, error: undefined, alignmentApplied: undefined });
    
    try {
      // Simulation de progression pour l'UX
      const progressTimer = setInterval(() => {
        if (this.params.analysisProgress < 90) {
          this.updateParams({ analysisProgress: this.params.analysisProgress + 10 });
        }
      }, 200);

      // Appel du vrai moteur DSP
      const result = await AudioAnalysisEngine.analyzeTrack(buffer);
      
      clearInterval(progressTimer);

      this.updateParams({ 
        detectedBpm: result.bpm, 
        detectedKey: result.rootKey,
        detectedTransient: result.firstTransient,
        isMinor: result.scale === 'MINOR', 
        analysisProgress: 100, 
        isAnalyzing: false,
        hasResult: true
      });
    } catch (e) {
      console.error(e);
      this.updateParams({ isAnalyzing: false, error: "Erreur DSP: Impossible d'analyser le fichier." });
    }
  }

  public getParams() { return this.params; }
}

/**
 * Fenêtre « Master » (analyse tempo / tonalité de l'instru), dessinée comme un
 * appareil de mesure de studio (kit plugins/hw) : façade gris laboratoire, deux
 * grands afficheurs ambre (tempo, tonalité en français), voyants Analyse / Prêt /
 * Calé / Erreur, barre de progression à LED, gros pads « Analyser l'instru » et
 * « Tout appliquer ». L'effet ne touche pas au son (entrée = sortie) ; les
 * analyses, le calage et les messages envoyés sont les mêmes qu'avant
 * (preuve : tests/pluginsFin.test.ts).
 */
const SYNC_ACCENT = '#0e7490';
const SYNC_HINTS = {
  analyse: "Analyser l'instru : NOVA écoute la piste INSTRU et trouve son tempo, sa tonalité et le moment du drop.",
  appliquer: 'Tout appliquer : met la séance au tempo trouvé, règle la justesse (Nova Tune) sur la tonalité et cale le drop de l’instru sur une mesure forte (5, 9, 13 ou 17).',
  reset: "Réinitialiser l'analyse : efface le résultat pour relancer une analyse.",
  bpm: 'Tempo détecté (BPM).',
  key: 'Tonalité détectée : la note de base et le mode (majeur ou mineur).',
};

export const MasterSyncUI: React.FC<{ node: MasterSyncNode, initialParams: MasterSyncParams, onParamsChange?: (p: MasterSyncParams) => void, trackId?: string }> = ({ node, initialParams, onParamsChange, trackId }) => {
  const [params, setParams] = useState<MasterSyncParams>(initialParams);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = node.getParams();
      // On compare superficiellement pour éviter les updates infinis si identiques
      if (JSON.stringify(current) !== JSON.stringify(params)) {
          setParams({ ...current });
          if (onParamsChange) onParamsChange(current);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [node, onParamsChange, params]);

  const handleStartAnalysis = async () => {
    if (!window.DAW_CONTROL) return;

    // Récupérer le buffer de la piste INSTRUMENTAL ou de la piste actuelle
    const buffer = window.DAW_CONTROL.getInstrumentalBuffer();

    if (!buffer) {
      const update = { error: "Aucun audio détecté sur la piste INSTRU (Instrumental)." };
      node.updateParams(update);
      return;
    }

    await node.analyzeInstru(buffer);
  };

  const applyFullSync = () => {
    if (!window.DAW_CONTROL || !params.hasResult) return;

    // 1. Appliquer BPM
    window.DAW_CONTROL.setBpm(params.detectedBpm);

    // 2. Appliquer Auto-Tune Scale
    const scale = params.isMinor ? 'MINOR' : 'MAJOR';
    window.DAW_CONTROL.syncAutoTuneScale(params.detectedKey, scale);

    // 3. Calage du drop sur une mesure forte (5, 9, 13 ou 17), mesure 1 = 0 s.
    const secondsPerBar = (60 / params.detectedBpm) * 4;
    const targets = [
        secondsPerBar * 4,  // Mesure 5
        secondsPerBar * 8,  // Mesure 9
        secondsPerBar * 12, // Mesure 13
        secondsPerBar * 16  // Mesure 17
    ];

    // Cible la plus proche du drop détecté ; nouveau début du clip = cible − drop.
    let bestTarget = targets[0];
    let minDiff = Infinity;

    targets.forEach(t => {
        const diff = Math.abs(t - params.detectedTransient);
        if (diff < minDiff) {
            minDiff = diff;
            bestTarget = t;
        }
    });

    const newStartTime = bestTarget - params.detectedTransient;

    // Piste visée : celle de l'effet, sinon 'instrumental'.
    const targetTrackId = trackId || 'instrumental';
    const dawState = window.DAW_CONTROL.getState();
    const track = dawState.tracks.find(t => t.id === targetTrackId);

    if (track && track.clips.length > 0) {
        // On aligne le premier clip (un départ négatif est ramené à 0).
        const clipId = track.clips[0].id;
        if ((window.DAW_CONTROL as any).editClip) {
            (window.DAW_CONTROL as any).editClip(targetTrackId, clipId, 'UPDATE_PROPS', { start: Math.max(0, newStartTime) });
        }

        const barNumber = Math.round(bestTarget / secondsPerBar) + 1;
        node.updateParams({ alignmentApplied: `Drop calé Mesure ${barNumber}` });
    }
  };

  const busy = !!params.isAnalyzing;
  const ready = !!params.hasResult && !busy;
  const progress = Math.max(0, Math.min(100, Number(params.analysisProgress) || 0));
  const keyText = ready ? tonaliteFr(`${NOTES[params.detectedKey] || 'C'} ${params.isMinor ? 'minor' : 'major'}`) : '— —';
  const bpmText = ready ? String(Math.round(params.detectedBpm * 10) / 10).replace('.', ',') : '– – –';
  const lit = Math.round(progress / 10);
  const status = params.error ? params.error
    : params.alignmentApplied ? params.alignmentApplied.replace('Mesure', 'mesure')
    : busy ? `Analyse en cours… ${progress} %`
    : ready ? 'Résultat prêt : « Tout appliquer » cale la séance dessus.'
    : "Prêt : lance l'analyse de l'instru.";

  return (
    <HwWindow type="MASTERSYNC" width={560} accent={SYNC_ACCENT} accentInk="#ffffff"
      idleHelp={<>Détecte le tempo et la tonalité de l’instru, et cale la séance dessus. Ne change pas le son. <span style={{ color: '#7d8696' }}>Survole ou touche un bouton : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="labgrey" model="Master" kicker="Tempo · tonalité · calage" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: SYNC_ACCENT }}>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col items-center gap-1 min-w-0" title={SYNC_HINTS.bpm}>
            <span className="hw-silk">Tempo</span>
            <span className="hw-lcd hw-lcd-amber hw-lcd-big" data-nova-sync="bpm"><span>{bpmText}</span><small>BPM</small></span>
          </div>
          <div className="flex flex-col items-center gap-1 min-w-0" title={SYNC_HINTS.key}>
            <span className="hw-silk">Tonalité</span>
            <span className="hw-lcd hw-lcd-amber hw-lcd-big" data-nova-sync="key" style={{ maxWidth: '100%', overflow: 'hidden' }}><span>{keyText}</span></span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mt-3" aria-hidden="true">
          {[{ t: 'Analyse', on: busy, c: '#f59e0b' }, { t: 'Prêt', on: ready, c: '#16a34a' }, { t: 'Calé', on: !!params.alignmentApplied, c: SYNC_ACCENT }, { t: 'Erreur', on: !!params.error, c: '#dc2626' }].map(l => (
            <span key={l.t} className="flex items-center gap-1.5"><Led on={l.on} color={l.c} /><span className="hw-silk">{l.t}</span></span>
          ))}
        </div>

        <HwSection title="Progression" className="mt-3">
          <div className="flex items-center justify-center gap-1.5" role="progressbar" aria-label="Progression de l'analyse" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            {Array.from({ length: 10 }, (_, i) => <Led key={i} on={i < lit} color={SYNC_ACCENT} large />)}
          </div>
          <div className="flex justify-center mt-2">
            <span className={`hw-lcd${params.error ? ' hw-lcd-amber' : ''}`} role="status" data-nova-sync="message" style={{ whiteSpace: 'normal', maxWidth: '100%' }}>{status}</span>
          </div>
        </HwSection>

        <div className="grid grid-cols-2 gap-3 mt-3">
          <button type="button" className="hw-pad" data-nova-sync="analyse" aria-pressed={busy} disabled={busy}
            title={SYNC_HINTS.analyse} onClick={handleStartAnalysis} style={{ ['--hw-pad-lit' as any]: '#fbbf24' }}>
            {busy ? 'Analyse…' : ready ? 'Relancer' : "Analyser l'instru"}<small>Tempo · tonalité · drop</small>
          </button>
          <button type="button" className="hw-pad" data-nova-sync="appliquer" disabled={!params.hasResult || busy}
            title={SYNC_HINTS.appliquer} onClick={applyFullSync} style={{ ['--hw-pad-lit' as any]: '#22d3ee' }}>
            Tout appliquer<small>Tempo + tonalité + calage</small>
          </button>
        </div>
        {params.hasResult && (
          <div className="flex justify-center mt-3">
            <PushButton active={false} onClick={() => {
              const reset = { hasResult: false, analysisProgress: 0, error: undefined, alignmentApplied: undefined };
              node.updateParams(reset);
            }} text="Réinitialiser" ariaLabel="Réinitialiser l'analyse" hint={SYNC_HINTS.reset} led={false} dark />
          </div>
        )}
      </Faceplate>
    </HwWindow>
  );
};
