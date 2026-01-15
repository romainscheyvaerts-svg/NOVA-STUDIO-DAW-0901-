
/**
 * METRONOME SERVICE
 * Professional metronome with count-in support
 * Inspired by Logic Pro, Ableton Live, and Reaper
 */

import { TimeSignature, MetronomeSettings } from '../types';

type MetronomeSound = 'CLICK' | 'WOODBLOCK' | 'BEEP' | 'CUSTOM';

interface ClickScheduleItem {
  time: number;
  isDownbeat: boolean;
}

class MetronomeService {
  private static instance: MetronomeService;
  private ctx: AudioContext | null = null;
  
  // Oscillator-based click (no samples needed)
  private clickFreqHigh = 1500;  // Downbeat
  private clickFreqLow = 1000;   // Other beats
  private clickDuration = 0.02;  // 20ms click
  
  // Settings
  private settings: MetronomeSettings = {
    enabled: false,
    volume: 0.7,
    countIn: 0,
    accentDownbeat: true,
    sound: 'CLICK'
  };
  
  private timeSignature: TimeSignature = { numerator: 4, denominator: 4 };
  private bpm: number = 120;
  
  // Scheduling
  private isPlaying: boolean = false;
  private nextClickTime: number = 0;
  private currentBeat: number = 0;
  private schedulerTimer: number | null = null;
  private lookaheadMs: number = 25;
  private scheduleAheadTime: number = 0.1;
  
  // Count-in state
  private isCountingIn: boolean = false;
  private countInBeatsRemaining: number = 0;
  private onCountInComplete: (() => void) | null = null;
  
  // Output
  private outputGain: GainNode | null = null;

  private constructor() {}

  public static getInstance(): MetronomeService {
    if (!MetronomeService.instance) {
      MetronomeService.instance = new MetronomeService();
    }
    return MetronomeService.instance;
  }

  public init(audioContext: AudioContext) {
    this.ctx = audioContext;
    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = this.settings.volume;
    this.outputGain.connect(this.ctx.destination);
  }

  public setSettings(settings: Partial<MetronomeSettings>) {
    this.settings = { ...this.settings, ...settings };
    if (this.outputGain) {
      this.outputGain.gain.value = this.settings.volume;
    }
  }

  public getSettings(): MetronomeSettings {
    return { ...this.settings };
  }

  public setTimeSignature(ts: TimeSignature) {
    this.timeSignature = ts;
  }

  public setBpm(bpm: number) {
    this.bpm = bpm;
  }

  /**
   * Start count-in before recording
   */
  public startCountIn(onComplete: () => void) {
    if (!this.ctx || this.settings.countIn === 0) {
      onComplete();
      return;
    }

    this.isCountingIn = true;
    this.countInBeatsRemaining = this.settings.countIn * this.timeSignature.numerator;
    this.onCountInComplete = onComplete;
    this.currentBeat = 0;
    this.nextClickTime = this.ctx.currentTime + 0.05;
    
    this.startScheduler();
  }

  /**
   * Start metronome (normal playback)
   */
  public start(startBeat: number = 0) {
    if (!this.ctx || !this.settings.enabled) return;
    
    this.isPlaying = true;
    this.currentBeat = startBeat;
    this.nextClickTime = this.ctx.currentTime + 0.01;
    
    this.startScheduler();
  }

  public stop() {
    this.isPlaying = false;
    this.isCountingIn = false;
    this.countInBeatsRemaining = 0;
    this.onCountInComplete = null;
    
    if (this.schedulerTimer !== null) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  public syncToTime(time: number) {
    if (!this.isPlaying || !this.ctx) return;
    
    // Calculate which beat we should be on
    const beatDuration = 60 / this.bpm;
    this.currentBeat = Math.floor(time / beatDuration) % this.timeSignature.numerator;
    this.nextClickTime = this.ctx.currentTime + (beatDuration - (time % beatDuration));
  }

  private startScheduler() {
    const schedule = () => {
      if (!this.ctx) return;
      
      while (this.nextClickTime < this.ctx.currentTime + this.scheduleAheadTime) {
        this.scheduleClick(this.nextClickTime, this.currentBeat === 0);
        this.advanceBeat();
      }
      
      this.schedulerTimer = window.setTimeout(schedule, this.lookaheadMs);
    };
    
    schedule();
  }

  private advanceBeat() {
    const beatDuration = 60 / this.bpm;
    this.nextClickTime += beatDuration;
    this.currentBeat = (this.currentBeat + 1) % this.timeSignature.numerator;
    
    // Handle count-in
    if (this.isCountingIn) {
      this.countInBeatsRemaining--;
      if (this.countInBeatsRemaining <= 0) {
        this.isCountingIn = false;
        if (this.onCountInComplete) {
          // Schedule the callback slightly ahead
          setTimeout(() => {
            this.onCountInComplete?.();
            this.onCountInComplete = null;
          }, 10);
        }
        if (!this.settings.enabled) {
          this.stop();
        }
      }
    }
  }

  private scheduleClick(time: number, isDownbeat: boolean) {
    if (!this.ctx || !this.outputGain) return;

    const freq = (isDownbeat && this.settings.accentDownbeat) 
      ? this.clickFreqHigh 
      : this.clickFreqLow;
    
    const volume = (isDownbeat && this.settings.accentDownbeat) ? 1.0 : 0.7;

    switch (this.settings.sound) {
      case 'CLICK':
        this.playOscillatorClick(time, freq, volume);
        break;
      case 'WOODBLOCK':
        this.playWoodblockClick(time, isDownbeat, volume);
        break;
      case 'BEEP':
        this.playBeepClick(time, freq, volume);
        break;
      default:
        this.playOscillatorClick(time, freq, volume);
    }
  }

  private playOscillatorClick(time: number, freq: number, volume: number) {
    if (!this.ctx || !this.outputGain) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.value = freq;
    
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, time + this.clickDuration);
    
    osc.connect(gain);
    gain.connect(this.outputGain);
    
    osc.start(time);
    osc.stop(time + this.clickDuration + 0.01);
  }

  private playWoodblockClick(time: number, isDownbeat: boolean, volume: number) {
    if (!this.ctx || !this.outputGain) return;

    // Woodblock uses noise + bandpass filter
    const bufferSize = this.ctx.sampleRate * 0.03;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    // Generate noise burst
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.1));
    }
    
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = isDownbeat ? 2500 : 2000;
    filter.Q.value = 15;
    
    const gain = this.ctx.createGain();
    gain.gain.value = volume * 0.8;
    
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.outputGain);
    
    source.start(time);
  }

  private playBeepClick(time: number, freq: number, volume: number) {
    if (!this.ctx || !this.outputGain) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'square';
    osc.frequency.value = freq * 0.8;
    
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume * 0.4, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.015);
    
    osc.connect(gain);
    gain.connect(this.outputGain);
    
    osc.start(time);
    osc.stop(time + 0.02);
  }

  /**
   * Play a single click (for tap tempo)
   */
  public playPreviewClick() {
    if (!this.ctx || !this.outputGain) return;
    this.playOscillatorClick(this.ctx.currentTime, this.clickFreqHigh, 0.5);
  }

  public isEnabled(): boolean {
    return this.settings.enabled;
  }

  public isCurrentlyCountingIn(): boolean {
    return this.isCountingIn;
  }

  public getCountInBeatsRemaining(): number {
    return this.countInBeatsRemaining;
  }
}

export const metronomeService = MetronomeService.getInstance();
