import React, { useState } from 'react';

// Audio node class for the saturator effect
export class VocalSaturatorNode {
  private context: AudioContext;
  public input: GainNode;
  public output: GainNode;
  private waveShaper: WaveShaperNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private drive: number = 50;
  private mix: number = 100;

  constructor(context: AudioContext) {
    this.context = context;
    this.input = context.createGain();
    this.output = context.createGain();
    this.dryGain = context.createGain();
    this.wetGain = context.createGain();
    this.waveShaper = context.createWaveShaper();
    this.setupCurve();

    this.input.connect(this.dryGain);
    this.input.connect(this.waveShaper);
    this.waveShaper.connect(this.wetGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);
    this.updateMix();
  }

  private setupCurve() {
    const samples = 44100;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.tanh(x * (this.drive / 50));
    }
    this.waveShaper.curve = curve;
  }

  setDrive(value: number) {
    this.drive = value;
    this.setupCurve();
  }

  setMix(value: number) {
    this.mix = value;
    this.updateMix();
  }

  private updateMix() {
    this.dryGain.gain.value = (100 - this.mix) / 100;
    this.wetGain.gain.value = this.mix / 100;
  }
}

interface VocalSaturatorPluginProps {
  isActive: boolean;
  onClose: () => void;
}

function VocalSaturatorPlugin({ isActive, onClose }: VocalSaturatorPluginProps) {
  const [drive, setDrive] = useState(50);
  const [tone, setTone] = useState(50);
  const [mix, setMix] = useState(100);

  if (!isActive) return null;

  return (
    <div className="w-full bg-[#0c0d10] border border-white/10 rounded-lg p-6 shadow-2xl flex flex-col space-y-6 text-white">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold">Vocal Saturator</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          ✕
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm mb-2">Drive: {drive}%</label>
          <input
            type="range"
            min="0"
            max="100"
            value={drive}
            onChange={(e) => setDrive(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div>
          <label className="block text-sm mb-2">Tone: {tone}%</label>
          <input
            type="range"
            min="0"
            max="100"
            value={tone}
            onChange={(e) => setTone(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div>
          <label className="block text-sm mb-2">Mix: {mix}%</label>
          <input
            type="range"
            min="0"
            max="100"
            value={mix}
            onChange={(e) => setMix(Number(e.target.value))}
            className="w-full"
          />
        </div>
      </div>

      <div className="text-xs text-gray-400 pt-4 border-t border-white/10">
        Drive → Tone → Mix
      </div>
    </div>
  );
}

export const VocalSaturatorUI = VocalSaturatorPlugin;
export default VocalSaturatorPlugin;
