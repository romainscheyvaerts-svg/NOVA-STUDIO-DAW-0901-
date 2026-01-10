

import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * MODULE FX_03 : VOCAL SATURATOR (ANALOG COLORATION v2.0)
 * -----------------------------------------------------
 * DSP: Drive -> Shaper (Oversampled) -> Tilt Tone -> 3-Band EQ -> Mix.
 */

export type SaturationMode = 'TUBE' | 'TAPE' | 'TRANSISTOR' | 'SOFT_CLIP';

export interface SaturatorParams {
  drive: number;      // 0 to 100
  mix: number;        // 0 to 1
  tone: number;       // -1.0 to 1.0 (Tilt)
  eqLow: number;      // -12 to 12 dB (200Hz)
  eqMid: number;      // -12 to 12 dB (1.5kHz)
  eqHigh: number;     // -12 to 12 dB (8kHz)
  mode: SaturationMode;
  isEnabled: boolean;
  outputGain: number; // Added to interface to match usage
}

export class VocalSaturatorNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private driveGain: GainNode;
  private shaper: WaveShaperNode;
  private autoGain: GainNode;
  private tiltLow: BiquadFilterNode;
  private tiltHigh: BiquadFilterNode;
  private eqLowNode: BiquadFilterNode;
  private eqMidNode: BiquadFilterNode;
  private eqHighNode: BiquadFilterNode;
  private wetGain: GainNode;
  private dryGain: GainNode;
  private makeupGain: GainNode;

  private params: SaturatorParams = {
    drive: 20,
    mix: 0.5,
    tone: 0.0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    mode: 'TAPE',
    isEnabled: true,
    outputGain: 1.0
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.driveGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.autoGain = ctx.createGain();
    this.tiltLow = ctx.createBiquadFilter();
    this.tiltLow.type = 'lowshelf';
    this.tiltLow.frequency.value = 800;
    this.tiltHigh = ctx.createBiquadFilter();
    this.tiltHigh.type = 'highshelf';
    this.tiltHigh.frequency.value = 1200;
    this.eqLowNode = ctx.createBiquadFilter();
    this.eqLowNode.type = 'lowshelf';
    this.eqLowNode.frequency.value = 200;
    this.eqMidNode = ctx.createBiquadFilter();
    this.eqMidNode.type = 'peaking';
    this.eqMidNode.frequency.value = 1500;
    this.eqMidNode.Q.value = 1.0;
    this.eqHighNode = ctx.createBiquadFilter();
    this.eqHighNode.type = 'highshelf';
    this.eqHighNode.frequency.value = 8000;
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.makeupGain = ctx.createGain();
    this.setupChain();
    this.generateCurve();
  }

  private setupChain() {
    this.input.disconnect();

    // -- DRY PATH --
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.makeupGain);

    // -- WET PATH --
    this.input.connect(this.driveGain);
    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.autoGain);
    this.autoGain.connect(this.tiltLow);
    this.tiltLow.connect(this.tiltHigh);
    this.tiltHigh.connect(this.eqLowNode);
    this.eqLowNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighNode);
    this.eqHighNode.connect(this.wetGain);
    this.wetGain.connect(this.makeupGain);

    this.makeupGain.connect(this.output);

    this.applyParams();
  }

  public updateParams(p: Partial<SaturatorParams>) {
    const oldMode = this.params.mode;
    const oldDrive = this.params.drive;
    this.params = { ...this.params, ...p };

    if (this.params.mode !== oldMode || this.params.drive !== oldDrive) {
      this.generateCurve();
    }
    this.applyParams();
  }

  private generateCurve() {
    const n = 4096;
    const curve = new Float32Array(n);
    const safeDrive = Number.isFinite(this.params.drive) ? this.params.drive : 20;
    const drive = 1 + (safeDrive / 10);
    const mode = this.params.mode;
    for (let i = 0; i < n; i++) {
      let x = (i * 2) / n - 1;

      if (this.params.mode === 'TAPE') {
        curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
      } 
      else if (this.params.mode === 'TUBE') {
        const absX = Math.abs(x);
        if (x < 0) {
          curve[i] = - (1 - Math.exp(-absX * drive)) / (1 - Math.exp(-drive));
        } else {
          curve[i] = (Math.pow(absX, 0.5) * (1 - Math.exp(-absX * drive))) / (1 - Math.exp(-drive));
        }
      } 
      else if (this.params.mode === 'SOFT_CLIP') {
        const gainX = x * drive * 0.5;
        curve[i] = Math.abs(gainX) < 1 ? gainX - (Math.pow(gainX, 3) / 3) : (gainX > 0 ? 0.66 : -0.66);
        curve[i] *= 1.5;
      }
    }
    this.shaper.curve = curve;
  }

  private applyParams() {
    const now = this.ctx.currentTime;
    const { drive, tone, mix, outputGain, isEnabled } = this.params;
    const safe = (v: number) => Number.isFinite(v) ? v : 0;

    if (isEnabled) {
      const sDrive = safe(drive);
      this.driveGain.gain.setTargetAtTime(1 + (sDrive / 25), now, 0.02);
      this.autoGain.gain.setTargetAtTime(1 / (1 + (sDrive / 60)), now, 0.02);
      
      const sTone = safe(tone);
      this.tiltHigh.gain.setTargetAtTime(sTone * 12, now, 0.02);
      this.tiltLow.gain.setTargetAtTime(-sTone * 12, now, 0.02);
      
      this.eqLowNode.gain.setTargetAtTime(safe(this.params.eqLow), now, 0.02);
      this.eqMidNode.gain.setTargetAtTime(safe(this.params.eqMid), now, 0.02);
      this.eqHighNode.gain.setTargetAtTime(safe(this.params.eqHigh), now, 0.02);
      
      const sMix = safe(mix);
      this.dryGain.gain.setTargetAtTime(1 - sMix, now, 0.02);
      this.wetGain.gain.setTargetAtTime(sMix, now, 0.02);
      this.makeupGain.gain.setTargetAtTime(safe(outputGain), now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  public getParams() { return { ...this.params }; }
}

interface VocalSaturationUIProps {
  node: VocalSaturatorNode;
  initialParams: SaturatorParams;
}

/**
 * VOCAL SATURATION UI (Converted to Functional Component for fix)
 */
export const VocalSaturatorUI: React.FC<VocalSaturationUIProps> = ({ node, initialParams }) => {
  const [params, setParams] = useState<SaturatorParams>(initialParams);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof SaturatorParams | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(0, h); ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    const { drive, mode } = params;

    ctx.beginPath();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#facc1544';

    for (let i = 0; i < w; i++) {
      const x = (i / w) * 2 - 1;
      let y = 0;

      if (mode === 'TAPE') {
        y = Math.tanh(x * drive) / Math.tanh(drive);
      } else if (mode === 'TUBE') {
        const absX = Math.abs(x);
        if (x < 0) {
          y = - (1 - Math.exp(-absX * drive)) / (1 - Math.exp(-drive));
        } else {
          y = (Math.pow(absX, 0.5) * (1 - Math.exp(-absX * drive))) / (1 - Math.exp(-drive));
        }
      } else if (mode === 'SOFT_CLIP') {
        const gainX = x * drive * 0.5;
        y = Math.abs(gainX) < 1 ? gainX - (Math.pow(gainX, 3) / 3) : (gainX > 0 ? 0.66 : -0.66);
        y *= 1.5;
      }

      const py = (h / 2) - (y * (h / 2.2));
      if (i === 0) ctx.moveTo(i, py);
      else ctx.lineTo(i, py);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [params]);

  useEffect(() => {
    let animFrame = 0;
    const update = () => {
      draw();
      animFrame = requestAnimationFrame(update);
    };
    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    
    const delta = -e.movementY / 150;
    setParams(prev => {
      const current = prev[activeParam.current!];
      if (typeof current !== 'number') return prev;

      let min = 0, max = 1;
      if (activeParam.current === 'drive') { min = 1; max = 10; }
      if (activeParam.current === 'tone') { min = -1; max = 1; }
      if (activeParam.current === 'outputGain') { min = 0; max = 2; }
      if (['eqLow', 'eqMid', 'eqHigh'].includes(activeParam.current)) { min = -12; max = 12; }

      const newVal = Math.max(min, Math.min(max, current + delta * (max - min)));
      const newParams = { ...prev, [activeParam.current!]: newVal };
      node.updateParams(newParams);
      return newParams;
    });
  }, [node]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    activeParam.current = null;
    document.body.style.cursor = 'default';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const handleMouseDown = (param: keyof SaturatorParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  const setMode = (mode: SaturationMode) => {
    const newParams = { ...params, mode };
    setParams(newParams);
    node.updateParams(newParams);
  };

  const togglePower = () => {
    const isEnabled = !params.isEnabled;
    const newParams = { ...params, isEnabled };
    setParams(newParams);
    node.updateParams(newParams);
  };

  return (
    <div className="w-[520px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10 shadow-2xl flex flex-col space-y-10 animate-in fade-in zoom-in duration-300 select-none text-white">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-5">
          <div className="w-14 h-14 rounded-2xl bg-yellow-500/10 flex items-center justify-center text-yellow-400 border border-yellow-500/20 shadow-lg shadow-yellow-500/5">
            <i className="fas fa