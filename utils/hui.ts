import { STRIPS, SurfaceButton, SurfaceCodec, SurfaceEvent, asciiOnly, from14, to14 } from './surfaceProtocol';

/**
 * Protocole Mackie HUI (Pro Tools), parlé par la HUI d'origine et, en mode
 * « HUI », par les PreSonus FaderPort, Icon, QCon, SSL UF8 / UC1, X-Touch…
 *
 * Tout passe par des « zones » et des « ports » :
 * - boutons (surface → hôte) : B0 0F <zone>, puis B0 2F <port | 0x40 si appui> ;
 * - voyants (hôte → surface) : B0 0C <zone>, puis B0 2C <port | 0x40 si allumé> ;
 * - faders : B0 0n <poids fort>, B0 2n <poids faible> (14 bits) dans les deux sens ;
 *   toucher d'un fader : zone n, port 0 ;
 * - potards : B0 4n <crans> (0x41-0x7F horaire, 0x01-0x3F antihoraire) ; anneaux : B0 1n <position 1-11> ;
 * - molette : B0 0D <crans>, même codage ;
 * - vumètres : A0 0n <côté << 4 | niveau 0-12> (côté 0 = gauche, 1 = droite) ;
 * - afficheurs de tranche (4 caractères) : F0 00 00 66 05 00 10 <tranche> c c c c F7 ;
 * - compteur (8 chiffres, de droite à gauche) : F0 00 00 66 05 00 11 <chiffres> F7 ;
 * - ping : l'hôte envoie 90 00 00 chaque seconde, la surface répond 90 00 7F.
 *   Sans ping, la surface se met hors ligne.
 *
 * Zones utilisées (d'après la documentation du protocole HUI) :
 *   0x00-0x07 tranches : port 0 toucher, 1 select, 2 mute, 3 solo, 4 auto, 5 v-sel, 6 insert, 7 rec ;
 *   0x0A défilement : 0 canal ←, 1 banque ←, 2 canal →, 3 banque → ;
 *   0x0D curseur : 5 scrub ; 0x0E transport : 1 retour, 2 avance, 3 stop, 4 lecture, 5 enregistrement ;
 *   0x0F transport : 3 boucle ; 0x13 édition : 1 undo ; 0x17 sélection d'automation : 0 read, 1 latch,
 *   2 trim, 3 touch, 4 write.
 * Le codage exact de certaines zones varie selon les surfaces « compatibles HUI » :
 * l'essai réel (procédure dans CONTENU/nova-surfaces) le confirmera.
 *
 * Logique pure : tests/controlSurface.test.ts.
 */

export const HUI_SYSEX = [0xf0, 0x00, 0x00, 0x66, 0x05, 0x00];
export const HUI_CELL = 4;
export const HUI_TIMECODE_DIGITS = 8;

/** Boutons par tranche : port dans la zone de la tranche. */
export const HUI_STRIP_PORTS: Partial<Record<SurfaceButton, number>> = {
  select: 1, mute: 2, solo: 3, vpotPush: 5, rec: 7,
};

/** Boutons globaux : [zone, port]. */
export const HUI_BUTTONS: Partial<Record<SurfaceButton, [number, number]>> = {
  channelLeft: [0x0a, 0], bankLeft: [0x0a, 1], channelRight: [0x0a, 2], bankRight: [0x0a, 3],
  scrub: [0x0d, 5],
  rewind: [0x0e, 1], forward: [0x0e, 2], stop: [0x0e, 3], play: [0x0e, 4], record: [0x0e, 5],
  loop: [0x0f, 3],
  undo: [0x13, 1],
  autoRead: [0x17, 0], autoLatch: [0x17, 1], autoTrim: [0x17, 2], autoTouch: [0x17, 3], autoWrite: [0x17, 4],
};

const GLOBAL_BY_ZONE = new Map<string, SurfaceButton>(
  Object.entries(HUI_BUTTONS).map(([k, v]) => [`${v![0]}:${v![1]}`, k as SurfaceButton]),
);
const STRIP_BY_PORT = new Map<number, SurfaceButton>(
  Object.entries(HUI_STRIP_PORTS).map(([k, v]) => [v as number, k as SurfaceButton]),
);

/** Crans HUI (bit 6 = sens horaire). */
export const huiRelative = (v: number): number => {
  const n = v & 0x3f;
  return v & 0x40 ? n : -n;
};
export const huiEncodeRelative = (delta: number): number => {
  const n = Math.max(1, Math.min(0x3f, Math.abs(Math.round(delta))));
  return delta > 0 ? 0x40 | n : n;
};

export class HuiCodec implements SurfaceCodec {
  readonly protocol = 'hui' as const;
  readonly cellWidth = HUI_CELL;
  readonly lcdRows = 1;
  readonly timecodeDigits = HUI_TIMECODE_DIGITS;
  /** Dernière zone annoncée par la surface (B0 0F zz). */
  private zone = -1;
  /** Poids forts des faders en attente de leur poids faible. */
  private faderHi = new Map<number, number>();

  decode(bytes: ArrayLike<number>): SurfaceEvent[] {
    const d = Array.from(bytes || []);
    if (d.length < 2) return [];
    const status = d[0];
    // Réponse au ping : 90 00 7F.
    if ((status & 0xf0) === 0x90 && d[1] === 0x00) return d[2] ? [{ kind: 'hello', detail: 'ping' }] : [];
    if ((status & 0xf0) !== 0xb0 || d.length < 3) return [];
    const cc = d[1], v = d[2];
    if (cc <= 0x07) { this.faderHi.set(cc, v); return []; }
    if (cc >= 0x20 && cc <= 0x27) {
      const s = cc - 0x20;
      const hi = this.faderHi.get(s);
      if (hi === undefined) return [];
      return [{ kind: 'fader', strip: s, value: from14((hi << 7) | v) }];
    }
    if (cc === 0x0f) { this.zone = v; return []; }
    if (cc === 0x2f) {
      const zone = this.zone;
      if (zone < 0) return [];
      const port = v & 0x0f;
      const pressed = !!(v & 0x40);
      if (zone < STRIPS) {
        if (port === 0) return [{ kind: 'touch', strip: zone, on: pressed }];
        const b = STRIP_BY_PORT.get(port);
        return b ? [{ kind: 'button', button: b, strip: zone, pressed }] : [];
      }
      const b = GLOBAL_BY_ZONE.get(`${zone}:${port}`);
      return b ? [{ kind: 'button', button: b, pressed }] : [];
    }
    if (cc >= 0x40 && cc <= 0x47) return [{ kind: 'vpot', strip: cc - 0x40, delta: huiRelative(v) }];
    if (cc === 0x0d) return [{ kind: 'jog', delta: huiRelative(v) }];
    return [];
  }

  fader(strip: number, value: number): number[][] {
    if (strip < 0 || strip >= STRIPS) return []; // la HUI n'a pas de fader master
    const v = to14(value);
    return [[0xb0, strip, (v >> 7) & 0x7f], [0xb0, 0x20 + strip, v & 0x7f]];
  }

  led(button: SurfaceButton, strip: number | undefined, on: boolean): number[][] | null {
    let zone: number, port: number;
    const sp = HUI_STRIP_PORTS[button];
    if (sp !== undefined) {
      if (strip === undefined || strip < 0 || strip >= STRIPS) return null;
      zone = strip; port = sp;
    } else {
      const g = HUI_BUTTONS[button];
      if (!g) return null;
      [zone, port] = g;
    }
    return [[0xb0, 0x0c, zone], [0xb0, 0x2c, port | (on ? 0x40 : 0)]];
  }

  vpotPan(strip: number, pan: number): number[][] {
    if (strip < 0 || strip >= STRIPS) return [];
    const p = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
    return [[0xb0, 0x10 + strip, 1 + Math.round((p + 1) / 2 * 10)]];
  }

  lcd(strip: number, row: number, text: string): number[][] {
    if (strip < 0 || strip >= STRIPS || row !== 0) return [];
    const t = asciiOnly(text).padEnd(HUI_CELL, ' ').slice(0, HUI_CELL);
    return [[...HUI_SYSEX, 0x10, strip, ...Array.from(t, c => c.charCodeAt(0) & 0x7f), 0xf7]];
  }

  meter(strip: number, level: number): number[][] {
    if (strip < 0 || strip >= STRIPS) return [];
    const l = Math.max(0, Math.min(12, Math.round(level)));
    return [[0xa0, strip, l], [0xa0, strip, 0x10 | l]];
  }

  timecode(text: string, dots: boolean[], prev: string | null, prevDots: boolean[] | null): number[][] {
    const n = HUI_TIMECODE_DIGITS;
    const t = text.padStart(n, ' ').slice(-n);
    if (prev !== null && prev.padStart(n, ' ').slice(-n) === t && (prevDots || []).join() === dots.join()) return [];
    // De droite à gauche ; chiffre 0-9, 0x10 = point. Un espace s'affiche comme un 0 éteint (pas d'équivalent).
    const digits: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const c = t[i];
      const v = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : 0;
      digits.push(v | (dots[i] ? 0x10 : 0));
    }
    return [[...HUI_SYSEX, 0x11, ...digits, 0xf7]];
  }

  assignment(): number[][] { return []; }

  query(): number[][] { return [[0x90, 0x00, 0x00]]; }

  keepAlive(): number[][] { return [[0x90, 0x00, 0x00]]; }

  reset(): number[][] {
    const out: number[][] = [];
    for (let s = 0; s < STRIPS; s++) {
      out.push(...this.fader(s, 0));
      for (const port of Object.values(HUI_STRIP_PORTS)) out.push([0xb0, 0x0c, s], [0xb0, 0x2c, port as number]);
      out.push([0xb0, 0x10 + s, 0]);
      out.push(...this.meter(s, 0));
      out.push(...this.lcd(s, 0, '    '));
    }
    for (const g of Object.values(HUI_BUTTONS)) out.push([0xb0, 0x0c, g![0]], [0xb0, 0x2c, g![1]]);
    return out;
  }
}
