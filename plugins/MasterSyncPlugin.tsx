
import React, { useState, useEffect } from 'react';
import { AudioAnalysisEngine } from '../engine/AudioAnalysisEngine';
import { NOTES } from './AutoTunePlugin';

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

    // 3. Calculer l'alignement sur la grille (Auto-Align Drop)
    // On veut caler le 'detectedTransient' sur le début d'une mesure forte (5, 9, 13, 17)
    // Mesure 1 = 0s
    // Durée d'une mesure (4 temps)
    const secondsPerBar = (60 / params.detectedBpm) * 4;
    
    // Cibles logiques (Début Mesure 5, 9, 13, 17)
    // On assume un intro de 4, 8, 12 ou 16 mesures
    const targets = [
        secondsPerBar * 4,  // Mesure 5
        secondsPerBar * 8,  // Mesure 9
        secondsPerBar * 12, // Mesure 13
        secondsPerBar * 16  // Mesure 17
    ];

    // Trouver la cible la plus proche du transient détecté
    // Exemple: Transient à 13s. BPM 140 -> Bar = 1.71s. Target 9 = 13.71s.
    // On doit décaler le clip pour que Transient soit à Target.
    // NouveauDebutClip = Target - Transient
    
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
    
    // On applique le déplacement du clip
    // Note: trackId doit être passé au composant, sinon on assume 'instrumental'
    const targetTrackId = trackId || 'instrumental';
    
    // On récupère l'ID du clip (supposé unique ou premier) via le state global
    const dawState = window.DAW_CONTROL.getState();
    const track = dawState.tracks.find(t => t.id === targetTrackId);
    
    if (track && track.clips.length > 0) {
        // On aligne le premier clip
        const clipId = track.clips[0].id;
        
        // Si le calcul donne un start négatif (le drop est trop tôt), on le met à 0 ou on crop
        // Ici on déplace simplement le start time
        if ((window.DAW_CONTROL as any).editClip) {
            (window.DAW_CONTROL as any).editClip(targetTrackId, clipId, 'UPDATE_PROPS', { start: Math.max(0, newStartTime) });
        }
        
        // Update UI info
        const barNumber = Math.round(bestTarget / secondsPerBar) + 1;
        node.updateParams({ alignmentApplied: `Drop calé Mesure ${barNumber}` });
    }
  };

  return (
    <div className="w-[480px] bg-[#0c0d10] border border-cyan-500/30 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-8 animate-in fade-in zoom-in duration-300 select-none text-white">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-lg shadow-cyan-500/5">
            <i className="fas fa-sync-alt text-2xl"></i>
          </div>
          <div>
            <h2 className="text-xl font-black italic text-white uppercase tracking-tighter leading-none">Master <span className="text-cyan-400">Sync</span></h2>
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-2">Neural Metadata Injector v2.0</p>
          </div>
        </div>
      </div>

      {/* ZONE D'ANALYSE PRINCIPALE */}
      <div className="relative group">
        <div className="grid grid-cols-2 gap-6">
          <div className="bg-black/60 rounded-[32px] border border-white/5 p-6 flex flex-col items-center justify-center space-y-2 group-hover:border-cyan-500/30 transition-all min-h-[140px]">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Detected Tempo</span>
            <span className={`text-4xl font-black font-mono leading-none transition-all ${params.hasResult ? 'text-white' : 'text-slate-800'}`}>
              {params.hasResult ? params.detectedBpm : '--'}
            </span>
            <span className="text-[8px] font-black text-cyan-500/50 uppercase">BPM</span>
          </div>
          <div className="bg-black/60 rounded-[32px] border border-white/5 p-6 flex flex-col items-center justify-center space-y-2 group-hover:border-cyan-500/30 transition-all min-h-[140px]">
            <span className="text-[7px] font-black text-slate-600 uppercase tracking-widest">Detected Key</span>
            <span className={`text-4xl font-black font-mono leading-none transition-all ${params.hasResult ? 'text-white' : 'text-slate-800'}`}>
              {params.hasResult ? NOTES[params.detectedKey] : '--'}
            </span>
            <span className="text-[8px] font-black text-cyan-500/50 uppercase">{params.hasResult ? (params.isMinor ? 'MINOR' : 'MAJOR') : 'NOT DETECTED'}</span>
          </div>
        </div>

        {/* BOUTON DE DÉTECTION CENTRAL */}
        {(!params.hasResult || params.isAnalyzing) && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0c0d10]/40 backdrop-blur-sm rounded-[32px] animate-in fade-in duration-300">
            {params.isAnalyzing ? (
              <div className="text-center space-y-4">
                <div className="w-16 h-16 rounded-full border-4 border-cyan-500/20 border-t-cyan-500 animate-spin mx-auto" />
                <span className="text-[10px] font-black text-cyan-400 uppercase tracking-[0.2em] animate-pulse">DSP Analysis...</span>
              </div>
            ) : (
              <button 
                onClick={handleStartAnalysis}
                className="px-10 h-16 bg-cyan-500 hover:bg-cyan-400 text-black rounded-[24px] text-[10px] font-black uppercase tracking-[0.2em] shadow-2xl shadow-cyan-500/40 transition-all transform active:scale-95 group/btn"
              >
                <i className="fas fa-search mr-3 group-hover/btn:scale-125 transition-transform"></i>
                Lancer l'analyse
              </button>
            )}
          </div>
        )}
      </div>

      {/* BARRE DE PROGRESSION */}
      {(params.isAnalyzing || params.analysisProgress > 0) && !params.hasResult && (
        <div className="space-y-3 px-2">
          <div className="flex justify-between items-end">
            <span className="text-[9px] font-black text-cyan-400 uppercase animate-pulse">Traitement Spectral...</span>
            <span className="text-[10px] font-mono text-slate-500">{params.analysisProgress}%</span>
          </div>
          <div className="h-2 bg-white/5 rounded-full overflow-hidden p-0.5 border border-white/5">
            <div className="h-full bg-cyan-500 rounded-full transition-all duration-300 shadow-[0_0_10px_#00f2ff]" style={{ width: `${params.analysisProgress}%` }} />
          </div>
        </div>
      )}

      {/* MESSAGE D'ERREUR */}
      {params.error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-center space-x-4 animate-in slide-in-from-top-2">
          <i className="fas fa-exclamation-triangle text-red-500 text-sm"></i>
          <span className="text-[9px] font-black text-red-400 uppercase">{params.error}</span>
        </div>
      )}

      {/* RESULTAT ALIGNEMENT */}
      {params.alignmentApplied && (
         <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-4 flex items-center justify-center space-x-4 animate-in slide-in-from-top-2">
            <i className="fas fa-check-circle text-green-500 text-sm"></i>
            <span className="text-[9px] font-black text-green-400 uppercase">{params.alignmentApplied}</span>
         </div>
      )}

      {/* BOUTON D'INJECTION GLOBAL */}
      <div className="flex flex-col space-y-4">
        <button 
          onClick={applyFullSync}
          disabled={!params.hasResult || params.isAnalyzing}
          className="w-full h-20 bg-white/[0.03] hover:bg-cyan-500 hover:text-black border border-white/10 hover:border-cyan-400 rounded-[24px] flex items-center justify-between px-8 transition-all group disabled:opacity-20 disabled:cursor-not-allowed"
        >
          <div className="flex items-center space-x-6">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center group-hover:bg-black/20">
               <i className="fas fa-check text-lg opacity-60 group-hover:opacity-100"></i>
            </div>
            <div className="flex flex-col text-left">
               <span className="text-[12px] font-black uppercase tracking-widest">Appliquer Tout</span>
               <span className="text-[8px] font-mono opacity-60 uppercase">BPM + Key + Calage Grille</span>
            </div>
          </div>
          <i className="fas fa-chevron-right text-xs opacity-20 group-hover:opacity-100"></i>
        </button>

        {params.hasResult && (
          <button 
            onClick={() => {
              const reset = { hasResult: false, analysisProgress: 0, error: undefined, alignmentApplied: undefined };
              node.updateParams(reset);
            }}
            className="text-[8px] font-black text-slate-600 uppercase tracking-widest hover:text-white transition-colors text-center mt-2"
          >
            Réinitialiser l'analyse
          </button>
        )}
      </div>

      <div className="pt-4 border-t border-white/5 flex justify-between items-center text-slate-700">
         <span className="text-[7px] font-black uppercase tracking-[0.3em]">Smart Session Sync v2.1</span>
         <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${params.isEnabled ? 'bg-cyan-500 shadow-[0_0_8px_cyan]' : 'bg-slate-800'}`} />
            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Auto-Align Active</span>
         </div>
      </div>
    </div>
  );
};
