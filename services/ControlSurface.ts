import { midiManager } from './MidiManager';
import { SurfaceController, SurfaceHost } from './ControlSurfaceController';
import { McuCodec } from '../utils/mcu';
import { HuiCodec } from '../utils/hui';
import type { SurfaceCodec, SurfaceProtocolId } from '../utils/surfaceProtocol';

/**
 * Surfaces de contrôle par Web MIDI (Préférences › Surfaces de contrôle).
 *
 * - accès MIDI avec SysEx (afficheurs LCD) ; si le SysEx est refusé, la
 *   surface marche quand même, sans les noms de pistes ;
 * - ports d'entrée et de sortie choisis par leur NOM (les identifiants
 *   changent d'une machine à l'autre), détection automatique par le nom ;
 * - le port d'entrée de la surface est retiré du MIDI « clavier » (services/
 *   MidiManager) : ses boutons ne jouent pas de notes ;
 * - état : coupée, en attente (ports ouverts, la surface ne s'est pas encore
 *   manifestée), connectée (elle a répondu ou envoyé un message) ;
 * - au démarrage, reconnexion seulement si l'accès MIDI est DÉJÀ accordé
 *   (aucune demande de permission qui surgit).
 */

export type SurfaceStatus =
  | 'off'          // désactivée
  | 'unsupported'  // pas de Web MIDI dans ce navigateur
  | 'denied'       // accès MIDI refusé
  | 'needs-click'  // activée, mais il faut un clic pour demander l'accès
  | 'opening'      // demande d'accès en cours
  | 'no-ports'     // ports choisis absents (surface débranchée)
  | 'waiting'      // ports ouverts, rien reçu de la surface
  | 'connected';   // la surface répond

export interface SurfaceConfig {
  enabled: boolean;
  protocol: SurfaceProtocolId;
  inputName: string | null;
  outputName: string | null;
}

export interface PortInfo { id: string; name: string; manufacturer?: string; state?: string }

export interface SurfaceSnapshot {
  supported: boolean;
  status: SurfaceStatus;
  /** Message clair pour l'interface (français). */
  message: string;
  sysex: boolean | null;
  inputs: PortInfo[];
  outputs: PortInfo[];
  config: SurfaceConfig;
  bank: number;
  trackCount: number;
  received: number;
  sent: number;
}

const KEY = 'nova.controlSurface';
const TICK_MS = 33;
const KEEPALIVE_MS = 1000;

/** Noms de ports des surfaces connues (détection automatique). */
const SURFACE_NAME = /(x-?touch|mackie|\bmcu\b|\bmc\b|faderport|icon|platform|qcon|uf8|uf1|uc1|\bssl\b|\bhui\b|nektar|panorama|avid|artist mix|eucon|control\s?surface|daw control|v-?pot)/i;
const HUI_NAME = /\bhui\b/i;
/** Ports à ne jamais choisir d'office (extensions, ports « MIDI » secondaires). */
const SECONDARY = /(ext\b|extender|\bxt\b|midi\s?2|port\s?2)/i;

const defaults = (): SurfaceConfig => ({ enabled: false, protocol: 'mcu', inputName: null, outputName: null });

const loadConfig = (): SurfaceConfig => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const c = JSON.parse(raw);
    return {
      enabled: !!c.enabled,
      protocol: c.protocol === 'hui' ? 'hui' : 'mcu',
      inputName: typeof c.inputName === 'string' ? c.inputName : null,
      outputName: typeof c.outputName === 'string' ? c.outputName : null,
    };
  } catch { return defaults(); }
};

const portList = (m: any): PortInfo[] => {
  const out: PortInfo[] = [];
  if (!m) return out;
  m.forEach?.((p: any) => out.push({ id: String(p.id), name: String(p.name || p.id), manufacturer: p.manufacturer, state: p.state }));
  return out;
};

/** Choix automatique : le premier couple entrée / sortie au nom d'une surface connue. */
export const guessPorts = (inputs: PortInfo[], outputs: PortInfo[]): { input: PortInfo | null; output: PortInfo | null; protocol: SurfaceProtocolId } => {
  const pick = (list: PortInfo[]) => list.find(p => SURFACE_NAME.test(p.name) && !SECONDARY.test(p.name)) || list.find(p => SURFACE_NAME.test(p.name)) || null;
  const input = pick(inputs);
  // Sortie : même nom que l'entrée si possible (Windows nomme souvent les deux pareil).
  const output = (input && outputs.find(o => o.name === input.name)) || (input && outputs.find(o => o.name.replace(/\s*\d+$/, '') === input.name.replace(/\s*\d+$/, ''))) || pick(outputs);
  const protocol: SurfaceProtocolId = HUI_NAME.test(`${input?.name || ''} ${output?.name || ''}`) ? 'hui' : 'mcu';
  return { input, output, protocol };
};

export const makeCodec = (p: SurfaceProtocolId): SurfaceCodec => (p === 'hui' ? new HuiCodec() : new McuCodec());

class ControlSurfaceService {
  private config: SurfaceConfig = loadConfig();
  private access: any = null;
  private accessPromise: Promise<any> | null = null;
  private sysex: boolean | null = null;
  private status: SurfaceStatus = 'off';
  private message = '';
  private host: SurfaceHost | null = null;
  private controller: SurfaceController | null = null;
  private input: any = null;
  private output: any = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKeepAlive = 0;
  private listeners = new Set<() => void>();
  private snap: SurfaceSnapshot | null = null;
  private lastSnapKey = '';
  /** Génération de connexion : une connexion plus récente annule celle en cours. */
  private gen = 0;

  get supported() { return typeof navigator !== 'undefined' && !!(navigator as any).requestMIDIAccess; }

  // --- Abonnement (interface) --------------------------------------------------------

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.snap = null; this.listeners.forEach(f => { try { f(); } catch { /* */ } }); }

  getSnapshot(): SurfaceSnapshot {
    if (this.snap) return this.snap;
    const c = this.controller;
    this.snap = {
      supported: this.supported,
      status: this.status,
      message: this.message,
      sysex: this.sysex,
      inputs: portList(this.access?.inputs),
      outputs: portList(this.access?.outputs),
      config: { ...this.config },
      bank: c ? c.getBank() : 0,
      trackCount: c ? c.tracks().length : 0,
      received: c ? c.stats.received : 0,
      sent: c ? c.stats.sent : 0,
    };
    return this.snap;
  }

  getController() { return this.controller; }
  getConfig() { return { ...this.config }; }

  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.config)); } catch { /* stockage indisponible */ } }

  private setStatus(status: SurfaceStatus, message: string) {
    if (this.status === status && this.message === message) return;
    this.status = status; this.message = message;
    this.emit();
  }

  // --- Hôte (NOVA) -------------------------------------------------------------------

  setHost(host: SurfaceHost | null) {
    this.host = host;
    if (!host) { this.detach(true); return; }
    if (this.config.enabled && this.access && !this.controller) void this.connect();
  }

  // --- Accès Web MIDI -----------------------------------------------------------------

  /** Accès MIDI (SysEx demandé ; repli sans SysEx). Lève une erreur claire si refusé. */
  private async ensureAccess(): Promise<any> {
    if (this.access) return this.access;
    if (this.accessPromise) return this.accessPromise;
    if (!this.supported) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
    this.accessPromise = (async () => {
      const req = (navigator as any).requestMIDIAccess.bind(navigator);
      let access: any = null;
      try {
        access = await req({ sysex: true });
        this.sysex = access?.sysexEnabled !== false;
      } catch (e) {
        try {
          access = await req({ sysex: false });
          this.sysex = false;
        } catch (e2) {
          throw Object.assign(new Error('denied'), { code: 'denied', cause: e2 || e });
        }
      }
      this.access = access;
      const prev = access.onstatechange;
      access.onstatechange = (e: any) => { try { prev?.(e); } catch { /* */ } this.onPortsChanged(); };
      return access;
    })();
    try { return await this.accessPromise; } finally { this.accessPromise = null; }
  }

  private onPortsChanged() {
    if (!this.config.enabled) { this.emit(); return; }
    const inp = this.findPort(this.access?.inputs, this.config.inputName);
    const out = this.findPort(this.access?.outputs, this.config.outputName);
    const gone = !inp || !out || inp.state === 'disconnected' || out.state === 'disconnected';
    if (gone && this.controller) {
      this.detach(false);
      this.setStatus('no-ports', 'Surface débranchée. Rebranche-la : NOVA la reprend tout seul.');
      return;
    }
    if (!gone && !this.controller && this.host) { void this.connect(); return; }
    this.emit();
  }

  private findPort(map: any, name: string | null): any {
    if (!map || !name) return null;
    let found: any = null;
    map.forEach?.((p: any) => { if (!found && p.name === name) found = p; });
    return found;
  }

  // --- Commandes (Préférences) ---------------------------------------------------------

  /** Au démarrage : reprend la surface si elle était activée ET que le MIDI est déjà autorisé. */
  async autoStart() {
    if (!this.config.enabled) return;
    if (!this.supported) { this.setStatus('unsupported', unsupportedMsg()); return; }
    let granted = false;
    try {
      const st = await (navigator as any).permissions?.query({ name: 'midi', sysex: true } as any);
      granted = st?.state === 'granted';
      if (!granted) {
        const st2 = await (navigator as any).permissions?.query({ name: 'midi' } as any);
        granted = st2?.state === 'granted';
      }
    } catch { granted = false; }
    if (!granted) { this.setStatus('needs-click', 'Surface activée : clique sur « Connecter » pour autoriser le MIDI.'); return; }
    await this.connect();
  }

  /** Liste des ports (demande l'accès MIDI si besoin). */
  async refreshPorts(): Promise<boolean> {
    try { await this.ensureAccess(); this.emit(); return true; } catch (e: any) { this.fail(e); return false; }
  }

  async enable() {
    this.config.enabled = true; this.save();
    await this.connect();
  }

  disable() {
    this.gen++;
    this.config.enabled = false; this.save();
    this.detach(true);
    this.setStatus('off', 'Surface désactivée.');
  }

  async setProtocol(p: SurfaceProtocolId) {
    if (this.config.protocol === p) return;
    this.config.protocol = p; this.save();
    if (this.config.enabled) await this.connect(); else this.emit();
  }

  async setPorts(inputName: string | null, outputName: string | null) {
    this.config.inputName = inputName; this.config.outputName = outputName; this.save();
    if (this.config.enabled) await this.connect(); else this.emit();
  }

  /** Détection automatique par le nom des ports. Renvoie le message affiché. */
  async detect(): Promise<string> {
    try { await this.ensureAccess(); } catch (e: any) { this.fail(e); return this.message; }
    const g = guessPorts(portList(this.access.inputs), portList(this.access.outputs));
    if (!g.input || !g.output) {
      const msg = 'Aucune surface reconnue. Branche-la, mets-la en mode Mackie Control (MC) ou HUI, puis choisis ses ports à la main.';
      this.setStatus(this.config.enabled ? this.status : 'off', msg);
      return msg;
    }
    this.config.inputName = g.input.name;
    this.config.outputName = g.output.name;
    this.config.protocol = g.protocol;
    this.config.enabled = true;
    this.save();
    await this.connect();
    return `Surface trouvée : ${g.input.name} (${g.protocol === 'hui' ? 'HUI' : 'Mackie Control'}).`;
  }

  private fail(e: any) {
    if (e?.code === 'unsupported') this.setStatus('unsupported', unsupportedMsg());
    else this.setStatus('denied', "L'accès MIDI a été refusé. Clique sur le cadenas à gauche de l'adresse › MIDI › Autoriser, puis sur « Réessayer ».");
  }

  /** Ouvre les ports choisis et démarre la surface. */
  async connect() {
    const gen = ++this.gen;
    this.detach(false);
    if (!this.supported) { this.setStatus('unsupported', unsupportedMsg()); return; }
    this.setStatus('opening', 'Ouverture des ports MIDI…');
    let access: any;
    try { access = await this.ensureAccess(); } catch (e: any) { if (gen === this.gen) this.fail(e); return; }
    if (gen !== this.gen) return; // une autre connexion a pris la main
    if (!this.config.inputName || !this.config.outputName) {
      const g = guessPorts(portList(access.inputs), portList(access.outputs));
      if (g.input && g.output) {
        this.config.inputName = this.config.inputName || g.input.name;
        this.config.outputName = this.config.outputName || g.output.name;
        this.save();
      }
    }
    const inp = this.findPort(access.inputs, this.config.inputName);
    const out = this.findPort(access.outputs, this.config.outputName);
    if (!inp || !out) {
      this.setStatus('no-ports', !this.config.inputName || !this.config.outputName
        ? 'Choisis le port d’entrée et le port de sortie de la surface (ou clique sur « Détecter »).'
        : `Ports introuvables (${this.config.inputName || '—'} / ${this.config.outputName || '—'}). La surface est-elle branchée et allumée ?`);
      return;
    }
    if (!this.host) { this.setStatus('waiting', 'NOVA démarre…'); return; }
    try { await out.open?.(); } catch { /* port déjà ouvert */ }
    try { await inp.open?.(); } catch { /* */ }
    if (gen !== this.gen || !this.host) return;
    this.input = inp; this.output = out;
    midiManager.reserveInputs([{ id: String(inp.id), name: inp.name }]);
    const codec = makeCodec(this.config.protocol);
    const ctl = new SurfaceController(codec, (m) => this.sendRaw(m), this.host);
    this.controller = ctl;
    inp.onmidimessage = (e: any) => {
      const wasHeard = ctl.lastHeard >= 0;
      try { ctl.handleMidi(e.data); } catch (err) { console.warn('[Surface] message ignoré', err); }
      if (!wasHeard && this.controller === ctl) this.markConnected();
    };
    ctl.invalidate();
    this.sendAll(codec.query());
    this.lastKeepAlive = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.setStatus('waiting', `Ports ouverts (${inp.name}). Touche un fader ou un bouton de la surface pour confirmer.`);
    this.tick();
  }

  private markConnected() {
    const name = this.input?.name || 'surface';
    const proto = this.config.protocol === 'hui' ? 'HUI' : 'Mackie Control';
    this.setStatus('connected', `Connectée : ${name} (${proto})${this.sysex === false ? ' — afficheurs éteints (SysEx refusé).' : '.'}`);
  }

  private tick() {
    const ctl = this.controller;
    if (!ctl) return;
    try { ctl.tick(); } catch (e) { console.warn('[Surface] tick', e); }
    const now = Date.now();
    if (now - this.lastKeepAlive >= KEEPALIVE_MS) {
      this.lastKeepAlive = now;
      this.sendAll(ctl.codec.keepAlive());
    }
    // L'interface suit la banque et les compteurs (sans redessin à chaque tick).
    const key = `${ctl.getBank()}|${ctl.tracks().length}|${Math.floor(ctl.stats.received / 10)}`;
    if (key !== this.lastSnapKey) { this.lastSnapKey = key; this.emit(); }
  }

  private sendAll(msgs: number[][]) { msgs.forEach(m => this.sendRaw(m)); }

  private sendRaw(m: number[]) {
    const out = this.output;
    if (!out) return;
    if (m[0] === 0xf0 && this.sysex === false) return; // afficheurs : SysEx refusé
    try { out.send(m); } catch (e) {
      if (m[0] === 0xf0) this.sysex = false;
      else console.warn('[Surface] envoi impossible', e);
    }
  }

  /** Ferme les ports ; `reset` : surface « éteinte » (faders en bas, afficheurs vides). */
  private detach(reset: boolean) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const ctl = this.controller;
    if (ctl) {
      try { ctl.dispose(); } catch { /* */ }
      if (reset) this.sendAll(ctl.codec.reset());
    }
    if (this.input) { try { this.input.onmidimessage = null; } catch { /* */ } }
    this.controller = null; this.input = null; this.output = null;
    midiManager.reserveInputs([]);
    this.emit();
  }

  /** Fermeture de la page : la surface s'éteint proprement. */
  shutdown() { this.detach(true); }
}

const unsupportedMsg = () => 'Ce navigateur ne gère pas le MIDI (Web MIDI). Utilise Chrome ou Edge, ou l’appli Nova Studio.';

export const controlSurface = new ControlSurfaceService();
