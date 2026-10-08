import { MidiDevice } from '../types';
import { midiInput } from './MidiInput';
import { PB, AT, ccKey } from '../utils/midiCc';

/**
 * Claviers MIDI branchés (Web MIDI). Chaque message est lu avec son
 * horodatage (`event.timeStamp`) et confié au routeur MIDI (services/MidiInput) :
 * écoute sur la piste (Thru), prise armée, saisie pas à pas, MIDI Learn,
 * capture. Par défaut, TOUS les claviers branchés sont écoutés (un clavier et
 * des pads en même temps) ; on peut n'en choisir qu'un dans les réglages.
 */

type MidiMessageCallback = (command: number, note: number, velocity: number) => void;

export const ALL_INPUTS = 'all';

class MidiManager {
  private static instance: MidiManager;
  private access: any = null;
  private inputs: Map<string, any> = new Map();
  private selectedInputId: string = ALL_INPUTS;
  private selectedChannel: number = 0; // 0 = Omni, 1-16
  private initPromise: Promise<boolean> | null = null;
  private deviceListeners = new Set<() => void>();

  // Event listeners for visual feedback
  private noteListeners: Set<MidiMessageCallback> = new Set();
  /** Capture MIDI (V25) : notes jouées au clavier MIDI, même sans piste choisie. */
  private captureListeners: Set<(on: boolean, note: number, velocity: number) => void> = new Set();

  public addCaptureListener(cb: (on: boolean, note: number, velocity: number) => void) {
      this.captureListeners.add(cb);
      return () => { this.captureListeners.delete(cb); };
  }

  private constructor() {
    try { const saved = localStorage.getItem('nova.midiInput'); if (saved) this.selectedInputId = saved; } catch { /* */ }
  }

  public static getInstance(): MidiManager {
    if (!MidiManager.instance) {
      MidiManager.instance = new MidiManager();
    }
    return MidiManager.instance;
  }

  public get isSupported() { return typeof navigator !== 'undefined' && !!(navigator as any).requestMIDIAccess; }
  public get isReady() { return !!this.access; }

  /** Ouvre l'accès MIDI (une seule fois). Vrai si l'accès est accordé. */
  public init(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (!this.isSupported) return false;
      try {
        this.access = await (navigator as any).requestMIDIAccess();
        this.refreshInputs();
        this.access.onstatechange = (e: any) => {
          this.refreshInputs();
          console.log(`[MIDI] ${e.port?.name} -> ${e.port?.state}`);
        };
        return true;
      } catch (err) {
        console.warn('[MIDI] Web MIDI indisponible ou refusé.', err);
        this.initPromise = null;
        return false;
      }
    })();
    return this.initPromise;
  }

  /** Au démarrage : ouvre l'accès seulement s'il est déjà accordé (aucune fenêtre de permission). */
  public async autoInit() {
    if (!this.isSupported) return;
    try {
      const st = await (navigator as any).permissions?.query({ name: 'midi' as any });
      if (st && st.state === 'granted') await this.init();
    } catch { /* navigateur sans permissions.query('midi') */ }
  }

  private refreshInputs() {
    this.inputs.forEach(i => { try { i.onmidimessage = null; } catch { /* */ } });
    this.inputs.clear();
    const iter = this.access.inputs.values();
    for (let input = iter.next(); !input.done; input = iter.next()) {
      this.inputs.set(input.value.id, input.value);
    }
    this.attach();
    this.deviceListeners.forEach(f => { try { f(); } catch { /* */ } });
  }

  private attach() {
    const handler = this.handleMidiMessage.bind(this);
    const want = this.selectedInputId !== ALL_INPUTS && this.inputs.has(this.selectedInputId) ? this.selectedInputId : ALL_INPUTS;
    this.inputs.forEach((input, id) => { input.onmidimessage = want === ALL_INPUTS || id === want ? handler : null; });
  }

  public onDevicesChange(f: () => void) { this.deviceListeners.add(f); return () => { this.deviceListeners.delete(f); }; }

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

  public getSelectedInputId() { return this.selectedInputId; }

  public selectInput(id: string) {
      this.selectedInputId = id || ALL_INPUTS;
      try { localStorage.setItem('nova.midiInput', this.selectedInputId); } catch { /* */ }
      if (this.access) this.attach();
  }

  public setChannel(channel: number) {
      this.selectedChannel = channel; // 0 for Omni
  }

  /** Ancienne API : la piste jouée est choisie par le routeur (piste armée, puis sélectionnée). */
  public setSelectedTrackId(_trackId: string | null) { /* voir services/MidiInput */ }

  public getActiveDeviceName(): string | null {
      if (this.selectedInputId !== ALL_INPUTS && this.inputs.has(this.selectedInputId)) return this.inputs.get(this.selectedInputId).name;
      const names = Array.from(this.inputs.values()).map(i => i.name).filter(Boolean);
      return names.length ? names.join(' + ') : null;
  }

  private handleMidiMessage(event: any) {
    const data: Uint8Array = event.data;
    if (!data || data.length < 1) return;
    const status = data[0];
    if (status >= 0xf0) return; // horloge, sysex : ignorés
    const command = status & 0xF0;
    const channel = (status & 0x0F) + 1;
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;

    // Filter Channel (if not Omni)
    if (this.selectedChannel !== 0 && channel !== this.selectedChannel) return;
    const ts = typeof event.timeStamp === 'number' ? event.timeStamp : undefined;
    const opts = { source: 'hw' as const, timeStamp: ts, channel };

    if (command === 0x90 && d2 > 0) {
      midiInput.noteOn(d1, d2, opts);
      this.captureListeners.forEach(cb => cb(true, d1, d2));
      this.notifyListeners(144, d1, d2);
    } else if (command === 0x80 || (command === 0x90 && d2 === 0)) {
      midiInput.noteOff(d1, opts);
      this.captureListeners.forEach(cb => cb(false, d1, 0));
      this.notifyListeners(128, d1, 0);
    } else if (command === 0xB0) {
      midiInput.control(ccKey(d1), d2, { ...opts, cc: d1 });
    } else if (command === 0xE0) {
      midiInput.control(PB, ((d2 << 7) | d1) - 8192, opts);
    } else if (command === 0xD0) {
      midiInput.control(AT, d1, opts);
    }
  }

  // --- OBSERVER PATTERN FOR VISUALS ---

  public addNoteListener(callback: MidiMessageCallback) {
      this.noteListeners.add(callback);
      return () => { this.noteListeners.delete(callback); };
  }

  private notifyListeners(cmd: number, note: number, vel: number) {
      this.noteListeners.forEach(cb => cb(cmd, note, vel));
  }
}

export const midiManager = MidiManager.getInstance();
