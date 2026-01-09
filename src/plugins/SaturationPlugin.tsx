
import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * MODULE FX_03 : VOCAL SATURATION ENGINE
 * --------------------------------------
 * DSP: High-quality waveshaping with oversampling.
 */

export type SaturationMode = 'TAPE' | 'TUBE' | 'SOFT_CLIP';

export interface SaturationParams {
  drive: number;      
  tone: number;       
  mix: number;        
  outputGain: number; 
  mode: SaturationMode;
  isEnabled: boolean;
}

export class SaturationNode {
  private ctx: AudioContext;
  public input: GainNode;
  public output: GainNode;

  private driveGain: GainNode;
  private shaper: WaveShaperNode;
  private tiltLow: BiquadFilterNode;
  private tiltHigh: BiquadFilterNode;
  private wetGain: GainNode;
  private dryGain: GainNode;
  private makeupGain: GainNode;

  private params: SaturationParams = {
    drive: 2.5,
    tone: 0.0,
    mix: 0.6,
    outputGain: 1.0,
    mode: 'TAPE',
    isEnabled: true
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.driveGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';

    this.tiltLow = ctx.createBiquadFilter();
    this.tiltLow.type = 'lowshelf';
    this.tiltLow.frequency.value = 800;

    this.tiltHigh = ctx.createBiquadFilter();
    this.tiltHigh.type = 'highshelf';
    this.tiltHigh.frequency.value = 1200;

    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.makeupGain = ctx.createGain();

    this.setupChain();
    this.updateCurve();
  }

  private setupChain() {
    this.input.disconnect();
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.makeupGain);
    this.input.connect(this.driveGain);
    this.driveGain.connect(this.shaper);
    this.shaper.connect(this.tiltLow);
    this.tiltLow.connect(this.tiltHigh);
    this.tiltHigh.connect(this.wetGain);
    this.wetGain.connect(this.makeupGain);
    this.makeupGain.connect(this.output);
    this.applyParams();
  }

  public updateParams(p: Partial<SaturationParams>) {
    const oldMode = this.params.mode;
    const oldDrive = this.params.drive;
    this.params = { ...this.params, ...p };

    if (this.params.mode !== oldMode || this.params.drive !== oldDrive) {
      this.updateCurve();
    }
    this.applyParams();
  }

  private updateCurve() {
    const n = 4096;
    const curve = new Float32Array(n);
    const drive = this.params.drive;

    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;

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
      this.driveGain.gain.setTargetAtTime(isFinite(drive * 0.5) ? drive * 0.5 : 1.0, now, 0.02);
      this.tiltLow.gain.setTargetAtTime(safe(-tone * 12), now, 0.02);
      this.tiltHigh.gain.setTargetAtTime(safe(tone * 12), now, 0.02);
      this.dryGain.gain.setTargetAtTime(safe(1 - mix), now, 0.02);
      this.wetGain.gain.setTargetAtTime(safe(mix), now, 0.02);
      this.makeupGain.gain.setTargetAtTime(safe(outputGain), now, 0.02);
    } else {
      this.dryGain.gain.setTargetAtTime(1.0, now, 0.02);
      this.wetGain.gain.setTargetAtTime(0.0, now, 0.02);
      this.makeupGain.gain.setTargetAtTime(1.0, now, 0.02);
    }
  }

  public getParams() { return { ...this.params }; }
}
