import {
  MASTER_STRIP, STRIPS, SurfaceButton, SurfaceCodec, SurfaceEvent, asciiOnly, from14, to14,
} from './surfaceProtocol';

/**
 * Protocole Mackie Control Universal (MCU), tel que le parlent la Mackie MCU
 * Pro, la Behringer X-Touch / X-Touch One (mode MC), la PreSonus FaderPort en
 * mode MCU, les Icon Platform / QCon et la SSL UF8 en mode MCU.
 *
 * - faders : pitch bend 14 bits, canal 1-8 = tranches, canal 9 = master ;
 * - toucher des faders : notes 0x68-0x6F (0x70 = master), vélocité 0x7F / 0 ;
 * - boutons : notes (vélocité 0x7F = appui, 0 = relâché) ; voyants : même note,
 *   0x7F allumé, 0 éteint ;
 * - potards : CC 0x10-0x17, relatifs (bit 6 = sens antihoraire, 6 bits de crans) ;
 *   anneaux : CC 0x30-0x37 ;
 * - molette : CC 0x3C, même codage que les potards ;
 * - compteur 7 segments : CC 0x40-0x49 (0x40 = chiffre de DROITE) ; afficheur
 *   « Assignment » : CC 0x4B (gauche), 0x4A (droite) ;
 * - afficheur LCD 2 × 56 caractères : SysEx F0 00 00 66 14 12 <position> <ASCII…> F7 ;
 * - vumètres : channel pressure 0xD0, (tranche << 4) | niveau 0-12.
 *
 * Logique pure : tests/controlSurface.test.ts.
 */

/** En-tête SysEx Mackie (fabricant 00 00 66) + modèle (0x14 = MCU principale). */
export const MCU_SYSEX = [0xf0, 0x00, 0x00, 0x66, 0x14];
export const MCU_LCD_WIDTH = 56;

/** Notes des boutons par tranche (base + n° de tranche). */
export const MCU_STRIP_NOTES: Partial<Record<SurfaceButton, number>> = {
  rec: 0x00, solo: 0x08, mute: 0x10, select: 0x18, vpotPush: 0x20,
};

/** Notes des boutons globaux. */
export const MCU_NOTES: Partial<Record<SurfaceButton, number>> = {
  bankLeft: 0x2e, bankRight: 0x2f, channelLeft: 0x30, channelRight: 0x31,
  timeMode: 0x35,
  autoRead: 0x4a, autoWrite: 0x4b, autoTrim: 0x4c, autoTouch: 0x4d, autoLatch: 0x4e,
  save: 0x50, undo: 0x51, marker: 0x54, loop: 0x56, click: 0x59,
  rewind: 0x5b, forward: 0x5c, stop: 0x5d, play: 0x5e, record: 0x5f,
  scrub: 0x65,
  smpteLed: 0x71, beatsLed: 0x72,
};

export const MCU_TOUCH_BASE = 0x68;      // 0x68-0x6F tranches, 0x70 master
export const MCU_VPOT_CC = 0x10;         // 0x10-0x17
export const MCU_RING_CC = 0x30;         // 0x30-0x37
export const MCU_JOG_CC = 0x3c;
export const MCU_TIMECODE_CC = 0x40;     // 0x40 (droite) … 0x49 (gauche)
export const MCU_ASSIGN_LEFT_CC = 0x4b;
export const MCU_ASSIGN_RIGHT_CC = 0x4a;

const NOTE_TO_GLOBAL = new Map<number, SurfaceButton>(
  Object.entries(MCU_NOTES).map(([k, v]) => [v as number, k as SurfaceButton]),
);

/** Crans d'un potard / de la molette (bit 6 = sens antihoraire). */
export const decodeRelative = (v: number): number => {
  const n = v & 0x3f;
  return v & 0x40 ? -n : n;
};
export const encodeRelative = (delta: number): number => {
  const n = Math.max(1, Math.min(0x3f, Math.abs(Math.round(delta))));
  return delta < 0 ? 0x40 | n : n;
};

/** Caractère du compteur 7 segments (table Mackie : @A-Z… = 0x00-0x1F, espace et chiffres tels quels). */
export const sevenSegment = (ch: string, dot = false): number => {
  const c = (asciiOnly(ch).toUpperCase().charCodeAt(0) || 0x20);
  let v: number;
  if (c >= 0x40 && c <= 0x60) v = c - 0x40;
  else if (c >= 0x20 && c <= 0x3f) v = c;
  else v = 0x20;
  return v | (dot ? 0x40 : 0);
};

/** Réponse à la poignée de main Logic Control (défi de 4 octets → réponse de 4 octets). */
export const mcuChallengeResponse = (l: number[]): number[] => {
  const [l1, l2, l3, l4] = l;
  return [
    0x7f & (l1 + (l2 ^ 0xa) - l4),
    0x7f & ((l3 >> 4) ^ (l1 + l4)),
    0x7f & ((l4 - (l3 << 2)) ^ (l1 | l2)),
    0x7f & (l2 - l3 + (0xf0 ^ (l4 << 4))),
  ];
};

/** Anneau du potard en mode « point » : −1…1 → positions 1…11 (6 = centre). */
export const panToRing = (pan: number): number => {
  const p = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
  return 1 + Math.round((p + 1) / 2 * 10);
};

export class McuCodec implements SurfaceCodec {
  readonly protocol = 'mcu' as const;
  readonly cellWidth = 7;
  readonly lcdRows = 2;
  readonly timecodeDigits = 10;
  /** Modèle annoncé dans les SysEx (0x14 MCU / X-Touch, 0x15 extension). */
  constructor(private model = 0x14) {}

  private sysex(body: number[]): number[] {
    return [0xf0, 0x00, 0x00, 0x66, this.model, ...body, 0xf7];
  }

  decode(bytes: ArrayLike<number>): SurfaceEvent[] {
    const d = Array.from(bytes || []);
    if (!d.length) return [];
    const status = d[0];
    if (status === 0xf0) return this.decodeSysex(d);
    const type = status & 0xf0;
    const ch = status & 0x0f;
    if (type === 0xe0) {
      if (d.length < 3) return [];
      const strip = ch <= 7 ? ch : ch === 8 ? MASTER_STRIP : -1;
      if (strip < 0) return [];
      return [{ kind: 'fader', strip, value: from14((d[2] << 7) | d[1]) }];
    }
    if (type === 0x90 || type === 0x80) {
      if (d.length < 3) return [];
      const note = d[1];
      const pressed = type === 0x90 && d[2] > 0;
      if (note >= MCU_TOUCH_BASE && note <= MCU_TOUCH_BASE + STRIPS) {
        return [{ kind: 'touch', strip: note - MCU_TOUCH_BASE, on: pressed }];
      }
      if (note < 0x28) {
        const group = Math.floor(note / 8);
        const strip = note % 8;
        const button: SurfaceButton = (['rec', 'solo', 'mute', 'select', 'vpotPush'] as SurfaceButton[])[group];
        return [{ kind: 'button', button, strip, pressed }];
      }
      const g = NOTE_TO_GLOBAL.get(note);
      return g ? [{ kind: 'button', button: g, pressed }] : [];
    }
    if (type === 0xb0) {
      if (d.length < 3) return [];
      const cc = d[1];
      if (cc >= MCU_VPOT_CC && cc < MCU_VPOT_CC + STRIPS) return [{ kind: 'vpot', strip: cc - MCU_VPOT_CC, delta: decodeRelative(d[2]) }];
      if (cc === MCU_JOG_CC) return [{ kind: 'jog', delta: decodeRelative(d[2]) }];
    }
    return [];
  }

  private decodeSysex(d: number[]): SurfaceEvent[] {
    // F0 00 00 66 <modèle> <commande> …
    if (d.length < 7 || d[1] !== 0x00 || d[2] !== 0x00 || d[3] !== 0x66) return [];
    const cmd = d[5];
    const body = d.slice(6, d[d.length - 1] === 0xf7 ? -1 : undefined);
    // 0x01 : Host Connection Query (n° de série 7 octets + défi 4 octets) → 0x02 + réponse.
    if (cmd === 0x01 && body.length >= 11) {
      const serial = body.slice(0, 7);
      const challenge = body.slice(7, 11);
      return [
        { kind: 'reply', messages: [this.sysex([0x02, ...serial, ...mcuChallengeResponse(challenge)])] },
        { kind: 'hello', detail: 'poignée de main' },
      ];
    }
    // 0x03 : connexion confirmée ; 0x14 : réponse de version.
    if (cmd === 0x03 || cmd === 0x14) return [{ kind: 'hello', detail: cmd === 0x03 ? 'confirmée' : 'version' }];
    return [];
  }

  fader(strip: number, value: number): number[][] {
    const ch = strip === MASTER_STRIP ? 8 : strip;
    if (ch < 0 || ch > 8) return [];
    const v = to14(value);
    return [[0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f]];
  }

  led(button: SurfaceButton, strip: number | undefined, on: boolean): number[][] | null {
    let note: number | undefined;
    const base = MCU_STRIP_NOTES[button];
    if (base !== undefined) {
      if (strip === undefined || strip < 0 || strip >= STRIPS) return null;
      note = base + strip;
    } else note = MCU_NOTES[button];
    if (note === undefined) return null;
    return [[0x90, note, on ? 0x7f : 0x00]];
  }

  vpotPan(strip: number, pan: number): number[][] {
    if (strip < 0 || strip >= STRIPS) return [];
    // Mode 0 (point), voyant du bas éteint.
    return [[0xb0, MCU_RING_CC + strip, panToRing(pan)]];
  }

  lcd(strip: number, row: number, text: string): number[][] {
    if (strip < 0 || strip >= STRIPS || row < 0 || row > 1) return [];
    const t = asciiOnly(text).padEnd(this.cellWidth, ' ').slice(0, this.cellWidth);
    const offset = row * MCU_LCD_WIDTH + strip * this.cellWidth;
    return [this.sysex([0x12, offset, ...Array.from(t, c => c.charCodeAt(0) & 0x7f)])];
  }

  meter(strip: number, level: number): number[][] {
    if (strip < 0 || strip >= STRIPS) return [];
    const l = Math.max(0, Math.min(12, Math.round(level)));
    return [[0xd0, (strip << 4) | l]];
  }

  timecode(text: string, dots: boolean[], prev: string | null, prevDots: boolean[] | null): number[][] {
    const n = this.timecodeDigits;
    const t = text.padStart(n, ' ').slice(-n);
    const pt = prev === null ? null : prev.padStart(n, ' ').slice(-n);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      const fromRight = n - 1 - i;
      const dot = !!dots[i];
      if (pt !== null && pt[i] === t[i] && !!prevDots?.[i] === dot) continue;
      out.push([0xb0, MCU_TIMECODE_CC + fromRight, sevenSegment(t[i], dot)]);
    }
    return out;
  }

  assignment(text: string): number[][] {
    const t = text.padStart(2, ' ').slice(-2);
    return [[0xb0, MCU_ASSIGN_LEFT_CC, sevenSegment(t[0])], [0xb0, MCU_ASSIGN_RIGHT_CC, sevenSegment(t[1])]];
  }

  query(): number[][] {
    // Device Query : une vraie MCU répond par la poignée de main ; X-Touch et autres répondent ou non.
    return [this.sysex([0x00])];
  }

  keepAlive(): number[][] { return []; }

  reset(): number[][] {
    const out: number[][] = [];
    for (let s = 0; s <= MASTER_STRIP; s++) out.push(...this.fader(s, 0));
    for (let note = 0; note < 0x28; note++) out.push([0x90, note, 0]);
    for (const n of Object.values(MCU_NOTES)) out.push([0x90, n as number, 0]);
    for (let s = 0; s < STRIPS; s++) { out.push([0xb0, MCU_RING_CC + s, 0]); out.push(...this.meter(s, 0)); }
    out.push(this.sysex([0x12, 0, ...Array(MCU_LCD_WIDTH * 2).fill(0x20)]));
    for (let i = 0; i < this.timecodeDigits; i++) out.push([0xb0, MCU_TIMECODE_CC + i, 0x20]);
    out.push(...this.assignment('  '));
    return out;
  }
}
