

import { MidiDevice } from '../types';
import { audioEngine } from '../engine/AudioEngine';

type MidiMessageCallback = (command: number, note: number, velocity: number) => void;

class MidiManager {
  private static instance: MidiManager;
  private access: any = null;
  private inputs: Map<string, any> = new Map();
  private selectedInputId: string | null = null;
  private selectedChannel: number = 0; // 0 = Omni, 1-16
  private selectedTrackId: string | null = null;
  
  // Event listeners for visual feedback
  private noteListeners: Set<MidiMessageCallback> = new Set();

  private constructor() {}

  public static getInstance(): MidiManager {
    if (!MidiManager.instance) {
      MidiManager.instance = new MidiManager();
    }
    return MidiManager.instance;
  }

  public async init() {
    if (navigator.requestMIDIAccess) {
      try {
        this.access = await navigator.requestMIDIAccess();
        this.refreshInputs();
        
        this.access.onstatechange = (e: any) => {
          this.refreshInputs();
          console.log(`[MIDI] State Change: ${e.port.name} -> ${e.port.state}`);
        };
        
      } catch (err) {
        console.warn("[MIDI] Web MIDI API not supported or access denied.", err);
      }
    }
  }

  private refreshInputs() {
    this.inputs.clear();
    const iter = this.access.inputs.values();
    for (let input = iter.next(); !input.done; input = iter.next()) {
      this.inputs.set(input.value.id, input.value);
      
      // Auto-select first available if none selected
      if (!this.selectedInputId) {
          this.selectInput(input.value.id);
      }
      
      // Re-attach handler if reconnected
      if (this.selectedInputId === input.value.id) {
          input.value.onmidimessage = this.handleMidiMessage.bind(this);
      }
    }
  }

  public getInputs(): MidiDevice[] {
      const list: MidiDevice[] = [];
      this.inputs.forEach((input) => {
          list.push({
              id: input.id,
              name: input.name,
              manufacturer: input.manufacturer,
              state: input.state,
              type: 'input'
          });
      });
      return list;
  }

  public selectInput(id: string) {
      // Detach old
      if (this.selectedInputId && this.inputs.has(this.selectedInputId)) {
          this.inputs.get(this.selectedInputId).onmidimessage = null;
      }
      
      this.selectedInputId = id;
      
      // Attach new
      if (this.inputs.has(id)) {
          this.inputs.get(id).onmidimessage = this.handleMidiMessage.bind(this);
          console.log(`[MIDI] Input Selected: ${this.inputs.get(id).name}`);
      }
  }

  public setChannel(channel: number) {
      this.selectedChannel = channel; // 0 for Omni
  }

  public setSelectedTrackId(trackId: string | null) {
      this.selectedTrackId = trackId;
  }

  public getActiveDeviceName(): string | null {
      if (this.selectedInputId && this.inputs.has(this.selectedInputId)) {
          return this.inputs.get(this.selectedInputId).name;
      }
      return null;
  }

  private handleMidiMessage(event: any) {
    const [status, data1, data2] = event.data;
    const command = status & 0xF0;
    const channel = (status & 0x0F) + 1;
    const note = data1;
    const velocity = data2;

    // Filter Channel (if not Omni)
    if (this.selectedChannel !== 0 && channel !== this.selectedChannel) return;

    // Routing to Audio Engine
    if (this.selectedTrackId) {
        // Note On (144)
        if (command === 144 && velocity > 0) {
            audioEngine.triggerTrackAttack(this.selectedTrackId, note, velocity / 127);
            this.notifyListeners(144, note, velocity);
        }
        // Note Off (128) OR Note On with 0 velocity
        else if (command === 128 || (command === 144 && velocity === 0)) {
            audioEngine.triggerTrackRelease(this.selectedTrackId, note);
            this.notifyListeners(128, note, 0);
        }
    }
  }

  // --- OBSERVER PATTERN FOR VISUALS ---
  
  public addNoteListener(callback: MidiMessageCallback) {
      this.noteListeners.add(callback);
      // FIX: Return a cleanup function to allow `useEffect` to properly unsubscribe the listener when the component unmounts, preventing memory leaks.
      return () => { this.noteListeners.delete(callback); };
  }

  private notifyListeners(cmd: number, note: number, vel: number) {
      this.noteListeners.forEach(cb => cb(cmd, note, vel));
  }
}

export const midiManager = MidiManager.getInstance();