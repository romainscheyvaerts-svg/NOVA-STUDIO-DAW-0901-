import type { Track } from '../types';
import { TrackType } from '../types';
import type { AutomationMode } from '../utils/automationWrite';
import { automationModeOf } from '../utils/automationWrite';
import {
  MASTER_STRIP, STRIPS, SurfaceButton, SurfaceCodec, SurfaceEvent, barsCounter, dbToMeterLevel,
  faderToVolume, fmtDbShort, fmtPanShort, lcdCell, smpteCounter, to14, volumeToFader,
} from '../utils/surfaceProtocol';

/**
 * Logique d'une surface de contrôle (MCU ou HUI), sans Web MIDI ni React :
 * banques de 8, faders motorisés, boutons, transport, molette, afficheurs,
 * vumètres, compteur. L'hôte (hooks/useControlSurface) la relie à NOVA ;
 * services/ControlSurface lui fournit les octets de la surface.
 *
 * Faders sans « combat » :
 * - fader touché (note de toucher) : NOVA n'envoie RIEN à ce fader ; au
 *   relâchement, il reçoit la valeur entendue (en Touch, la courbe d'origine) ;
 * - surface sans capteur de toucher : un fader qui vient de bouger est tenu
 *   pour touché pendant HOLD_MS ;
 * - écho supprimé : la dernière position reçue compte comme envoyée, et on
 *   n'envoie un nouveau message que si l'écart dépasse FADER_DEADBAND.
 *
 * Écriture d'automation : toucher = `automationTouch(on)` (Touch / Latch
 * démarrent comme avec la souris) ; le mouvement passe par `updateTrack`,
 * le même chemin que le fader à l'écran (une seule étape d'annulation par passe).
 *
 * Logique pure : tests/controlSurface.test.ts.
 */

export interface MusicalPos { bar: number; beat: number; frac: number; beatSec: number; barSec: number }

export interface SurfaceHost {
  getTracks(): Track[];
  /** Pistes visibles (les pistes masquées n'ont pas de tranche, comme dans la console). */
  shownIds?(): Set<string>;
  getSelectedTrackId(): string | null;
  /** Temps du projet (s), à jour pendant la lecture. */
  getTime(): number;
  isPlaying(): boolean;
  isRecording(): boolean;
  isLoopActive(): boolean;
  isClickOn?(): boolean;
  /** Position musicale (carte de tempo) d'un instant. */
  position(time: number): MusicalPos;
  /** Début de la mesure `bar` (0 = la première). */
  barTime(bar: number): number;
  /** Valeur entendue pendant la lecture (automation), sinon undefined. */
  liveValue(trackId: string, param: 'volume' | 'pan'): number | undefined;
  /** Crête en dBFS de la piste (null : pas de mesure). */
  meterDb(trackId: string): number | null;
  /** Même chemin qu'un fader à l'écran (groupes, automation, annulation). */
  updateTrack(track: Track): void;
  selectTrack(trackId: string): void;
  /** Appui / relâchement d'un fader (écriture Touch / Latch). */
  automationTouch(trackId: string, param: 'volume' | 'pan', on: boolean): void;
  setAutomationMode(trackId: string, mode: AutomationMode): void;
  play(): void;
  stop(): void;
  record(): void;
  toggleLoop(): void;
  seek(time: number): void;
  undo?(): void;
  save?(): void;
  addMarker?(time: number): void;
  toggleClick?(): void;
  scrub?: { begin(time: number): void; move(time: number): void; end(): void };
  notify?(msg: string): void;
  /** Horloge (ms). */
  now(): number;
}

/** Fader tenu pour « touché » après un mouvement, sur une surface sans capteur de toucher. */
export const HOLD_MS = 350;
/** Écart minimal (sur 16383) avant de renvoyer une position de fader. */
export const FADER_DEADBAND = 12;
/** Vumètres : renvoi au plus tous les… (ms) ; la surface fait retomber l'aiguille d'elle-même. */
export const METER_EVERY_MS = 90;
/** Afficheurs : rafraîchis au plus tous les… (ms). */
export const LCD_EVERY_MS = 100;
/** Valeur (dB / pan) affichée en bas de l'afficheur après un geste. */
export const VALUE_SHOW_MS = 1500;
/** Pas du potard de panoramique par cran. */
export const PAN_STEP = 0.02;
/** Retour / avance maintenu : premier saut, puis répétition. */
const REPEAT_FIRST_MS = 450;
const REPEAT_EVERY_MS = 160;
/** Scrub à la molette : relâché après ce délai sans cran. */
const SCRUB_IDLE_MS = 250;

/**
 * Tranches de la surface, dans l'ordre de la console : pistes audio / MIDI,
 * puis bus, puis retours d'effets ; ni le master (fader master à part), ni les
 * VCA, ni les pistes masquées.
 */
export const surfaceTracks = (tracks: Track[], shown?: Set<string>): Track[] => {
  const vis = (t: Track) => !shown || shown.has(t.id);
  const audio = tracks.filter(t => vis(t) && (t.type === TrackType.AUDIO || t.type === TrackType.SAMPLER || t.type === TrackType.MIDI));
  const bus = tracks.filter(t => vis(t) && t.type === TrackType.BUS && t.id !== 'master' && !t.isVca && t.folder?.kind !== 'basic');
  const sends = tracks.filter(t => vis(t) && t.type === TrackType.SEND);
  return [...audio, ...bus, ...sends];
};

type StripKey = number; // 0-7, 8 = master

export class SurfaceController {
  private bank = 0;
  private touched = new Set<StripKey>();
  private lastIncoming = new Map<StripKey, number>();
  private sentFader = new Map<StripKey, number>();
  private sentLed = new Map<string, boolean>();
  private sentRing = new Map<number, number>();
  private sentLcd = new Map<string, string>();
  private sentMeter = new Map<number, { level: number; at: number }>();
  private sentTc: { text: string; dots: boolean[] } | null = null;
  private sentAssign: string | null = null;
  private lastLcdAt = -Infinity;
  private lastMeterAt = -Infinity;
  private showValueUntil = new Map<number, { until: number; what: 'volume' | 'pan' }>();
  private held: { button: 'rewind' | 'forward'; next: number } | null = null;
  private scrubMode = false;
  private scrubbing: { pos: number; last: number } | null = null;
  private timeMode: 'beats' | 'smpte' = 'beats';
  /** Dernier message reçu de la surface (ms) ; -1 : jamais. */
  lastHeard = -1;
  hello = false;
  /** Compteurs (preuves, réglages) : messages reçus / envoyés. */
  stats = { received: 0, sent: 0, events: 0 };

  constructor(public codec: SurfaceCodec, private send: (msg: number[]) => void, private host: SurfaceHost) {}

  // --- Accès -------------------------------------------------------------------------

  getBank() { return this.bank; }
  isScrubMode() { return this.scrubMode; }
  getTimeMode() { return this.timeMode; }
  isTouched(strip: number) { return this.touched.has(strip); }

  tracks(): Track[] { return surfaceTracks(this.host.getTracks(), this.host.shownIds?.()); }
  masterTrack(): Track | undefined { return this.host.getTracks().find(t => t.id === 'master'); }

  stripTrack(strip: number): Track | undefined {
    if (strip === MASTER_STRIP) return this.masterTrack();
    if (strip < 0 || strip >= STRIPS) return undefined;
    return this.tracks()[this.bank + strip];
  }

  /** Nouvelle banque (première piste affichée, 0 = piste 1). */
  setBank(offset: number) {
    const n = this.tracks().length;
    const next = Math.max(0, Math.min(Math.max(0, n - 1), Math.round(offset)));
    if (next === this.bank) return;
    // Un fader tenu pendant le changement de banque : on rend la main à l'automation.
    for (const s of [...this.touched]) if (s !== MASTER_STRIP) this.releaseTouch(s);
    this.bank = next;
    this.invalidate(true);
    const last = Math.min(n, next + STRIPS);
    this.host.notify?.(`🎚️ Surface : pistes ${next + 1} à ${last}${n ? ` (sur ${n})` : ''}.`);
  }

  /** Tout sera renvoyé au prochain tick (connexion, banque, reprise). */
  invalidate(stripsOnly = false) {
    for (let s = 0; s < STRIPS; s++) this.sentFader.delete(s);
    if (!stripsOnly) this.sentFader.delete(MASTER_STRIP);
    for (const k of [...this.sentLed.keys()]) if (!stripsOnly || k.includes(':')) this.sentLed.delete(k);
    this.sentRing.clear();
    this.sentLcd.clear();
    this.sentMeter.clear();
    if (!stripsOnly) { this.sentTc = null; }
    this.sentAssign = null;
    this.lastLcdAt = -Infinity;
    this.lastMeterAt = -Infinity;
  }

  private out(msgs: number[][] | null | undefined) {
    if (!msgs) return;
    for (const m of msgs) { this.send(m); this.stats.sent++; }
  }

  // --- Entrées de la surface ---------------------------------------------------------

  handleMidi(bytes: ArrayLike<number>) {
    this.stats.received++;
    this.lastHeard = this.host.now();
    for (const ev of this.codec.decode(bytes)) this.handleEvent(ev);
  }

  handleEvent(ev: SurfaceEvent) {
    this.stats.events++;
    switch (ev.kind) {
      case 'reply': this.out(ev.messages); return;
      case 'hello': this.hello = true; return;
      case 'fader': this.onFader(ev.strip, ev.value); return;
      case 'touch': if (ev.on) this.touch(ev.strip); else this.releaseTouch(ev.strip); return;
      case 'vpot': this.onVpot(ev.strip, ev.delta); return;
      case 'jog': this.onJog(ev.delta); return;
      case 'button': this.onButton(ev.button, ev.strip, ev.pressed); return;
    }
  }

  private touch(strip: number) {
    this.touched.add(strip);
    const t = this.stripTrack(strip);
    if (t) this.host.automationTouch(t.id, 'volume', true);
    this.showValue(strip, 'volume');
  }

  private releaseTouch(strip: number) {
    if (!this.touched.delete(strip)) return;
    const t = this.stripTrack(strip);
    if (t) this.host.automationTouch(t.id, 'volume', false);
    // Au relâchement, le moteur reçoit la valeur entendue (retour à la courbe en Touch).
    this.sentFader.delete(strip);
    this.lastIncoming.delete(strip);
  }

  private onFader(strip: number, pos: number) {
    const now = this.host.now();
    this.lastIncoming.set(strip, now);
    this.sentFader.set(strip, to14(pos));
    const t = this.stripTrack(strip);
    if (!t) return;
    const volume = faderToVolume(pos);
    if (Math.abs(volume - t.volume) < 1e-6) return;
    this.host.updateTrack({ ...t, volume });
    this.showValue(strip, 'volume');
  }

  private onVpot(strip: number, delta: number) {
    const t = this.stripTrack(strip);
    if (!t || !delta) return;
    // Accélération : un tour rapide (plusieurs crans par message) va plus loin.
    const step = PAN_STEP * delta * (Math.abs(delta) > 2 ? 2 : 1);
    const cur = this.host.liveValue(t.id, 'pan') ?? t.pan ?? 0;
    const pan = Math.max(-1, Math.min(1, Math.round((cur + step) * 100) / 100));
    if (pan === t.pan) return;
    this.host.updateTrack({ ...t, pan });
    this.showValue(strip, 'pan');
  }

  private onJog(delta: number) {
    if (!delta) return;
    const h = this.host;
    const now = h.now();
    const time = h.getTime();
    const pos = h.position(time);
    if (this.scrubMode && h.scrub && !h.isPlaying() && !h.isRecording()) {
      // Scrub : un cran = un 1/32 de temps, la tête suit en douceur (utils/scrubControl).
      const step = pos.beatSec / 8;
      if (!this.scrubbing) { h.scrub.begin(time); this.scrubbing = { pos: time, last: now }; }
      this.scrubbing.pos = Math.max(0, this.scrubbing.pos + delta * step);
      this.scrubbing.last = now;
      h.scrub.move(this.scrubbing.pos);
      return;
    }
    // Déplacement : à l'arrêt, une double-croche par cran ; en lecture, un temps par cran.
    const step = h.isPlaying() ? pos.beatSec : pos.beatSec / 4;
    h.seek(Math.max(0, time + delta * step));
  }

  private stepBar(dir: 1 | -1) {
    const h = this.host;
    const t = h.getTime();
    const p = h.position(t);
    const start = h.barTime(p.bar);
    const target = dir > 0 ? h.barTime(p.bar + 1) : (t - start > 0.02 ? start : h.barTime(Math.max(0, p.bar - 1)));
    h.seek(Math.max(0, target));
  }

  private onButton(button: SurfaceButton, strip: number | undefined, pressed: boolean) {
    const h = this.host;
    if (button === 'rewind' || button === 'forward') {
      if (pressed) {
        this.stepBar(button === 'forward' ? 1 : -1);
        this.held = { button, next: h.now() + REPEAT_FIRST_MS };
      } else if (this.held?.button === button) this.held = null;
      return;
    }
    if (!pressed) return;
    if (strip !== undefined) {
      const t = this.stripTrack(strip);
      if (!t) return;
      switch (button) {
        case 'mute': h.updateTrack({ ...t, isMuted: !t.isMuted }); return;
        case 'solo': h.updateTrack({ ...t, isSolo: !t.isSolo }); return;
        case 'rec':
          if (t.type === TrackType.BUS || t.type === TrackType.SEND) { h.notify?.(`« ${t.name} » est un bus : rien à enregistrer.`); return; }
          h.updateTrack({ ...t, isTrackArmed: !t.isTrackArmed }); return;
        case 'select': h.selectTrack(t.id); return;
        case 'vpotPush': h.updateTrack({ ...t, pan: 0 }); this.showValue(strip, 'pan'); return;
        default: return;
      }
    }
    switch (button) {
      case 'bankLeft': this.setBank(this.bank - STRIPS); return;
      case 'bankRight': { const n = this.tracks().length; if (this.bank + STRIPS < n) this.setBank(this.bank + STRIPS); return; }
      case 'channelLeft': this.setBank(this.bank - 1); return;
      case 'channelRight': { const n = this.tracks().length; if (this.bank + 1 < n) this.setBank(this.bank + 1); return; }
      case 'play': if (!h.isPlaying()) h.play(); return;
      case 'stop': if (h.isPlaying() || h.isRecording()) h.stop(); else if (this.scrubbing) this.endScrub(); return;
      case 'record': h.record(); return;
      case 'loop': h.toggleLoop(); return;
      case 'scrub':
        this.scrubMode = !this.scrubMode;
        if (!this.scrubMode) this.endScrub();
        h.notify?.(this.scrubMode ? '🎛️ Molette : scrub (on entend le son).' : '🎛️ Molette : déplacement de la tête de lecture.');
        return;
      case 'timeMode':
        this.timeMode = this.timeMode === 'beats' ? 'smpte' : 'beats';
        this.sentTc = null;
        return;
      case 'undo': h.undo?.(); return;
      case 'save': h.save?.(); return;
      case 'marker': h.addMarker?.(h.getTime()); return;
      case 'click': h.toggleClick?.(); return;
      case 'autoRead': case 'autoWrite': case 'autoTrim': case 'autoTouch': case 'autoLatch': {
        const id = h.getSelectedTrackId();
        const t = id ? h.getTracks().find(x => x.id === id) : undefined;
        if (!t) { h.notify?.('Sélectionne d’abord une piste (bouton SELECT de la surface).'); return; }
        const want = ({ autoRead: 'read', autoWrite: 'write', autoTrim: 'trim', autoTouch: 'touch', autoLatch: 'latch' } as const)[button];
        // READ/OFF (MCU) : Read ↔ Off.
        const mode: AutomationMode = button === 'autoRead' && automationModeOf(t) === 'read' ? 'off' : want;
        h.setAutomationMode(t.id, mode);
        return;
      }
      default: return;
    }
  }

  private endScrub() {
    if (!this.scrubbing) return;
    this.scrubbing = null;
    this.host.scrub?.end();
  }

  private showValue(strip: number, what: 'volume' | 'pan') {
    if (strip < 0 || strip >= STRIPS) return;
    this.showValueUntil.set(strip, { until: this.host.now() + VALUE_SHOW_MS, what });
  }

  // --- Retour vers la surface --------------------------------------------------------

  /** Valeur de fader entendue (automation en lecture, sinon réglage). */
  shownVolume(t: Track): number {
    return this.host.liveValue(t.id, 'volume') ?? t.volume;
  }

  /** Envoie ce qui a changé (appelé ~30 fois par seconde). */
  tick() {
    const h = this.host;
    const now = h.now();
    // Retour / avance maintenus.
    if (this.held && now >= this.held.next) {
      this.stepBar(this.held.button === 'forward' ? 1 : -1);
      this.held.next = now + REPEAT_EVERY_MS;
    }
    if (this.scrubbing && now - this.scrubbing.last > SCRUB_IDLE_MS) this.endScrub();

    const tracks = this.tracks();
    const selected = h.getSelectedTrackId();

    // Faders (tranches + master).
    for (let s = 0; s <= MASTER_STRIP; s++) {
      const t = s === MASTER_STRIP ? this.masterTrack() : tracks[this.bank + s];
      if (this.touched.has(s)) continue;
      const lastIn = this.lastIncoming.get(s);
      if (lastIn !== undefined && now - lastIn < HOLD_MS) continue;
      const v14 = to14(t ? volumeToFader(this.shownVolume(t)) : 0);
      const prev = this.sentFader.get(s);
      if (prev !== undefined && Math.abs(prev - v14) < FADER_DEADBAND && !(v14 === 0 && prev !== 0)) continue;
      this.sentFader.set(s, v14);
      this.out(this.codec.fader(s, v14 / 16383));
    }

    // Voyants des tranches.
    for (let s = 0; s < STRIPS; s++) {
      const t = tracks[this.bank + s];
      this.setLed('mute', s, !!t?.isMuted);
      this.setLed('solo', s, !!t?.isSolo);
      this.setLed('rec', s, !!t?.isTrackArmed);
      this.setLed('select', s, !!t && t.id === selected);
      const ring = t ? Math.round(((h.liveValue(t.id, 'pan') ?? t.pan ?? 0) + 1) * 500) : -1;
      if (this.sentRing.get(s) !== ring) {
        this.sentRing.set(s, ring);
        this.out(t ? this.codec.vpotPan(s, ring / 500 - 1) : (this.codec.protocol === 'mcu' ? [[0xb0, 0x30 + s, 0]] : [[0xb0, 0x10 + s, 0]]));
      }
    }

    // Voyants globaux.
    const playing = h.isPlaying(), recording = h.isRecording();
    this.setLed('play', undefined, playing);
    this.setLed('stop', undefined, !playing && !recording);
    this.setLed('record', undefined, recording);
    this.setLed('loop', undefined, h.isLoopActive());
    this.setLed('scrub', undefined, this.scrubMode);
    if (h.isClickOn) this.setLed('click', undefined, !!h.isClickOn());
    this.setLed('smpteLed', undefined, this.timeMode === 'smpte');
    this.setLed('beatsLed', undefined, this.timeMode === 'beats');
    const sel = selected ? h.getTracks().find(t => t.id === selected) : undefined;
    const mode = sel ? automationModeOf(sel) : null;
    this.setLed('autoRead', undefined, mode === 'read');
    this.setLed('autoWrite', undefined, mode === 'write');
    this.setLed('autoTrim', undefined, mode === 'trim');
    this.setLed('autoTouch', undefined, mode === 'touch');
    this.setLed('autoLatch', undefined, mode === 'latch');

    // Afficheurs.
    if (now - this.lastLcdAt >= LCD_EVERY_MS) {
      this.lastLcdAt = now;
      const w = this.codec.cellWidth;
      const sep = w > 4;
      for (let s = 0; s < STRIPS; s++) {
        const t = tracks[this.bank + s];
        const show = this.showValueUntil.get(s);
        const showing = !!show && show.until > now;
        // HUI (une seule ligne de 4 caractères) : le nom, ou la valeur pendant un geste.
        const rows: string[] = [];
        if (this.codec.lcdRows >= 2) {
          rows.push(t ? lcdCell(t.name, w, sep) : ' '.repeat(w));
          let val = '';
          if (t) {
            if ((showing && show!.what === 'volume') || this.touched.has(s)) val = fmtDbShort(this.shownVolume(t));
            else val = fmtPanShort(h.liveValue(t.id, 'pan') ?? t.pan ?? 0);
          }
          rows.push(t ? lcdCell(val, w, sep) : ' '.repeat(w));
        } else {
          let txt = t ? t.name : '';
          if (t && ((showing && show!.what === 'volume') || this.touched.has(s))) txt = fmtDbShort(this.shownVolume(t));
          else if (t && showing && show!.what === 'pan') txt = fmtPanShort(t.pan ?? 0);
          rows.push(t ? lcdCell(txt, w, sep) : ' '.repeat(w));
        }
        rows.forEach((text, row) => {
          const key = `${s}:${row}`;
          if (this.sentLcd.get(key) === text) return;
          this.sentLcd.set(key, text);
          this.out(this.codec.lcd(s, row, text));
        });
      }
      // Assignment (MCU) : numéro de la première piste de la banque.
      const assign = String((this.bank + 1) % 100).padStart(2, ' ');
      if (assign !== this.sentAssign) { this.sentAssign = assign; this.out(this.codec.assignment(assign)); }
    }

    // Compteur.
    const time = h.getTime();
    const tc = this.timeMode === 'beats'
      ? (() => { const p = h.position(time + 1e-6); return barsCounter(p.bar, p.beat, p.frac, this.codec.timecodeDigits); })()
      : smpteCounter(time, this.codec.timecodeDigits);
    if (!this.sentTc || this.sentTc.text !== tc.text || this.sentTc.dots.join() !== tc.dots.join()) {
      this.out(this.codec.timecode(tc.text, tc.dots, this.sentTc?.text ?? null, this.sentTc?.dots ?? null));
      this.sentTc = tc;
    }

    // Vumètres.
    if (now - this.lastMeterAt >= METER_EVERY_MS) {
      this.lastMeterAt = now;
      for (let s = 0; s < STRIPS; s++) {
        const t = tracks[this.bank + s];
        const level = t ? dbToMeterLevel(h.meterDb(t.id)) : 0;
        const prev = this.sentMeter.get(s);
        // La surface fait retomber l'aiguille : on renvoie le niveau tant qu'il y a du signal.
        if (prev && prev.level === level && level === 0) continue;
        if (prev && prev.level === level && now - prev.at < METER_EVERY_MS * 2 && level > 0) continue;
        this.sentMeter.set(s, { level, at: now });
        this.out(this.codec.meter(s, level));
      }
    }
  }

  private setLed(button: SurfaceButton, strip: number | undefined, on: boolean) {
    const key = strip === undefined ? button : `${button}:${strip}`;
    if (this.sentLed.get(key) === on) return;
    const msgs = this.codec.led(button, strip, on);
    this.sentLed.set(key, on);
    if (msgs) this.out(msgs);
  }

  /** Fin : on rend la main (toucher relâché, scrub arrêté). */
  dispose() {
    for (const s of [...this.touched]) this.releaseTouch(s);
    this.endScrub();
  }
}
