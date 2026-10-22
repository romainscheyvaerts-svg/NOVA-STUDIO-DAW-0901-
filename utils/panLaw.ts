/**
 * Loi de pan et double pan des pistes stéréo (22/10/2026) — module pur.
 *
 * LOI DE PAN (pistes mono) : position p de −1 (gauche) à +1 (droite), angle θ = (p + 1)·π/4.
 *  - −3 dB (défaut)  : G = cos θ, D = sin θ — puissance constante (G² + D² = 1) ; centre −3,01 dB.
 *  - −4,5 dB         : G = cos^1,5 θ, D = sin^1,5 θ — compromis à mi-chemin (centre −4,52 dB).
 *  - −6 dB           : G = cos² θ, D = sin² θ — gain constant (G + D = 1, juste en mono) ; centre −6,02 dB.
 *  - 0 dB            : balance — G = min(1, 1 − p), D = min(1, 1 + p) ; centre 0 dB.
 * Toutes les lois donnent 0 dB / −∞ aux bords (G 100 : gauche 0 dB, droite rien).
 *
 * DOUBLE PAN (pistes stéréo) : le canal gauche est placé en `l`, le droit en `r`, chacun par la
 * loi : sortie G = gG(l)·entrée G + gG(r)·entrée D ; sortie D = gD(l)·entrée G + gD(r)·entrée D.
 * Défaut l = −1, r = +1 : gains exactement 1 et 0, le son est rendu bit à bit.
 *
 * ANCIENS PROJETS (pan unique b d'une piste stéréo, ancienne « balance » qui ramenait un canal
 * sur l'autre) : b ≤ 0 → G = −1, D = 2b + 1 ; b ≥ 0 → G = 2b − 1, D = +1. Avec la loi −3 dB
 * (défaut), c'est EXACTEMENT le son d'avant (même matrice cos / sin). Le pan d'une piste mono
 * garde sa position ; seul son niveau suit la loi pro (−3 dB au centre au lieu de 0 dB).
 *
 * Une piste mono qui porte du son stéréo (effet stéréo en insert) garde son image au centre
 * (matrice « pan mono » ci-dessous) : sur une source mono (G = D), elle donne exactement la loi.
 */
import type { AutomationLane, AutomationPoint, Track } from '../types';
import { TrackType } from '../types';
import { audioBufferRegistry } from './audioBufferRegistry';

export type PanLaw = -3 | -4.5 | -6 | 0;
export const DEFAULT_PAN_LAW: PanLaw = -3;

export const PAN_LAWS: { law: PanLaw; label: string; hint: string }[] = [
  { law: -3, label: '−3 dB (puissance constante)', hint: 'Recommandé pour une écoute en stéréo : un son garde le même volume perçu d’un bord à l’autre. 0 dB aux bords, −3 dB au centre.' },
  { law: -4.5, label: '−4,5 dB (compromis)', hint: 'À mi-chemin entre −3 et −6 dB : peu d’écart de niveau, en stéréo comme en mono.' },
  { law: -6, label: '−6 dB (gain constant)', hint: 'Juste quand le mix est écouté en mono (radio, téléphone, club) : la somme gauche + droite reste constante.' },
  { law: 0, label: '0 dB (balance)', hint: 'Aucune atténuation au centre : un son centré paraît plus fort (+3 dB perçus), attention au grave.' },
];

export const sanitizePanLaw = (v: unknown): PanLaw => {
  const n = Number(v);
  return n === -3 || n === -4.5 || n === -6 || n === 0 ? (n as PanLaw) : DEFAULT_PAN_LAW;
};

/** Exposant de la loi (cos^e θ) ; null = loi de balance (0 dB). */
const lawExp = (law: PanLaw): number | null => (law === 0 ? null : law === -6 ? 2 : law === -4.5 ? 1.5 : 1);

const clampPan = (p: number): number => (Number.isFinite(p) ? Math.max(-1, Math.min(1, p)) : 0);

/** Gains [gauche, droite] d'une source MONO placée en p par la loi. Bords exacts (1 et 0). */
export function panGains(p: number, law: PanLaw = DEFAULT_PAN_LAW): [number, number] {
  const x = clampPan(p);
  if (x <= -1) return [1, 0];
  if (x >= 1) return [0, 1];
  const e = lawExp(law);
  if (e === null) return [Math.min(1, 1 - x), Math.min(1, 1 + x)];
  if (x === 0) { const c = Math.pow(Math.SQRT1_2, e); return [c, c]; }
  const th = (x + 1) * Math.PI / 4;
  return [Math.pow(Math.cos(th), e), Math.pow(Math.sin(th), e)];
}

/** Matrice 2×2 : ll = entrée G → sortie G, rl = entrée D → sortie G, lr = entrée G → sortie D, rr = entrée D → sortie D. */
export interface PanMatrix { ll: number; rl: number; lr: number; rr: number }

/** Double pan : canal gauche placé en l, canal droit en r. */
export function stereoMatrix(l: number, r: number, law: PanLaw = DEFAULT_PAN_LAW): PanMatrix {
  const [ll, lr] = panGains(l, law);
  const [rl, rr] = panGains(r, law);
  return { ll, rl, lr, rr };
}

/**
 * Pan d'une piste MONO : sur une source mono (entrée G = entrée D = x), sortie = loi exacte
 * (G·x, D·x). Si un insert a rendu le son stéréo, l'image est gardée au centre (−3 dB par canal)
 * et se replie sur le côté visé quand on panoramique (sans jamais dépasser la loi).
 */
export function monoMatrix(p: number, law: PanLaw = DEFAULT_PAN_LAW): PanMatrix {
  const [gl, gr] = panGains(p, law);
  const left = gl >= gr;
  const a = left ? gl : gr, b = left ? gr : gl;   // a = côté fort, b = côté faible
  if (a <= 0) return { ll: 0, rl: 0, lr: 0, rr: 0 };
  const c = 1 - b / a;                            // part du canal opposé replié sur le côté fort
  const k = a / (1 + c);
  const s = b / k;
  return left ? { ll: k, rl: k * c, lr: 0, rr: k * s } : { ll: k * s, rl: 0, lr: k * c, rr: k };
}

// ─── Pistes stéréo : G / D ────────────────────────────────────────────────────────────

export interface StereoPan { l: number; r: number }
export const STEREO_PAN_DEFAULT: StereoPan = { l: -1, r: 1 };

/** Ancien pan unique (−1…1) d'une piste stéréo → G / D équivalents (identique avec la loi −3 dB). */
export function legacyPanToStereo(b: number): StereoPan {
  const x = clampPan(b);
  return x <= 0 ? { l: -1, r: 2 * x + 1 } : { l: 2 * x - 1, r: 1 };
}

/** G / D → pan unique « équivalent » (affichage simple, surfaces, anciens clients ; réciproque exacte de legacyPanToStereo). */
export function stereoToLegacyPan(l: number, r: number): number {
  const L = clampPan(l), R = clampPan(r);
  if (L === -1) return (R - 1) / 2;
  if (R === 1) return (L + 1) / 2;
  return clampPan((L + R) / 2);
}

/** G / D d'une piste stéréo : réglage écrit (s'il correspond encore au pan), sinon ancien pan converti. */
export function stereoPanOf(track: Pick<Track, 'pan' | 'stereoPan'>): StereoPan {
  const sp = track.stereoPan;
  const b = Number.isFinite(track.pan) ? track.pan : 0;
  // `at` = pan unique écrit en même temps : si un autre chemin (ancienne version, surface, mix auto)
  // a changé le pan depuis, c'est lui qui compte (converti).
  if (sp && Number.isFinite(sp.l) && Number.isFinite(sp.r) && sp.at === b) return { l: clampPan(sp.l), r: clampPan(sp.r) };
  return legacyPanToStereo(b);
}

/** Piste avec un nouveau G / D (le pan unique suit : anciens clients, mode simple). */
export function withStereoPan<T extends Pick<Track, 'pan' | 'stereoPan'>>(track: T, l: number, r: number): T {
  const L = clampPan(l), R = clampPan(r);
  const at = stereoToLegacyPan(L, R);
  return { ...track, pan: at, stereoPan: { l: L, r: R, at } };
}

export const isDefaultStereoPan = (sp: StereoPan) => sp.l === -1 && sp.r === 1;

// ─── Format de la piste (mono / stéréo) ───────────────────────────────────────────────

const dualMonoCache = new WeakMap<object, boolean>();

/** Buffer à deux canaux réellement différents (une prise mono copiée sur deux canaux reste mono). */
export function bufferIsStereo(buf: { numberOfChannels: number; length: number; getChannelData(c: number): Float32Array } | null | undefined): boolean {
  if (!buf || !(buf.numberOfChannels >= 2)) return false;
  const hit = dualMonoCache.get(buf);
  if (hit !== undefined) return hit;
  let stereo = false;
  try {
    const a = buf.getChannelData(0), b = buf.getChannelData(1);
    const n = Math.min(a.length, b.length);
    const step = Math.max(1, Math.floor(n / 16384));
    for (let i = 0; i < n; i += step) if (Math.abs(a[i] - b[i]) > 1e-6) { stereo = true; break; }
  } catch { stereo = true; }
  dualMonoCache.set(buf, stereo);
  return stereo;
}

type FormatTrack = Pick<Track, 'type'> & Partial<Pick<Track, 'id' | 'clips' | 'frozenClip' | 'recordInput' | 'panFormat' | 'isVca'>>;

/**
 * Piste stéréo (double pan G / D) ou mono (un pan). Choix de l'utilisateur (`panFormat`), sinon :
 * instruments, bus, retours et master = stéréo ; piste audio = stéréo si une entrée stéréo est
 * enregistrée ou si un de ses sons a deux canaux différents.
 */
export function isStereoTrack(track: FormatTrack | null | undefined): boolean {
  if (!track) return false;
  if (track.panFormat === 'stereo') return true;
  if (track.panFormat === 'mono') return false;
  if (track.isVca) return false;
  if (track.type !== TrackType.AUDIO) return true;
  if (track.recordInput?.stereo) return true;
  // Son du clip : sur le clip, ou dans le registre des sons (clé bufferId, sinon id du clip).
  const bufOf = (c: { id?: string; buffer?: unknown; bufferId?: string }) =>
    (c.buffer || (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined) || (c.id ? audioBufferRegistry.get(c.id) : undefined)) as any;
  if (track.frozenClip && bufferIsStereo(bufOf(track.frozenClip))) return true;
  for (const c of track.clips || []) if (bufferIsStereo(bufOf(c))) return true;
  return false;
}

// ─── Saisie et affichage ──────────────────────────────────────────────────────────────

/** Position → « C », « 30G », « 100D » (court, pour les petits boutons G / D). */
export function panShort(p: number): string {
  const v = Math.round(clampPan(p) * 100);
  return v === 0 ? 'C' : v < 0 ? `${-v}G` : `${v}D`;
}

/** Saisie « 100G », « G 30 », « 30D », « D30 », « L20 », « R 20 », « C », « -30 », « 25 » → position, ou null. */
export function parsePanText(typed: string): number | null {
  const t = String(typed ?? '').trim().replace(/−/g, '-').replace(/\s+/g, '').replace(',', '.').toUpperCase();
  if (!t) return null;
  if (/^C(ENTRE|ENTER)?$/.test(t) || t === '0') return 0;
  let m = /^([GLDR])(\d+(?:\.\d+)?)%?$/.exec(t) || null;
  let side = 0, num = NaN;
  if (m) { side = /[GL]/.test(m[1]) ? -1 : 1; num = parseFloat(m[2]); }
  else if ((m = /^(\d+(?:\.\d+)?)%?([GLDR])$/.exec(t))) { side = /[GL]/.test(m[2]) ? -1 : 1; num = parseFloat(m[1]); }
  else if ((m = /^([-+]?\d+(?:\.\d+)?)%?$/.exec(t))) { side = 1; num = parseFloat(m[1]); }
  if (!Number.isFinite(num)) return null;
  return clampPan((side * num) / 100);
}

// ─── Automation : « Pan G » / « Pan D » ───────────────────────────────────────────────

export const PAN_L = 'panL';
export const PAN_R = 'panR';
export const isPanParam = (name: string) => name === 'pan' || name === PAN_L || name === PAN_R;

/**
 * Ancienne voie « pan » d'une piste stéréo → voies « Pan G » et « Pan D ». Les courbes sont
 * de la forme a + (b − a)·φ(t) : la conversion (affine de chaque côté du centre) est exacte ;
 * un segment qui traverse le centre est coupé au passage (sous-segments linéaires si besoin).
 */
export function convertPanLane(lane: AutomationLane, interp: (a: number, b: number, t: number, c: AutomationPoint['curveType']) => number): { l: AutomationLane; r: AutomationLane } {
  const pts = [...(lane.points || [])].sort((a, b) => a.time - b.time);
  const crosses = (p: AutomationPoint, q: AutomationPoint) => (p.value < 0 && q.value > 0) || (p.value > 0 && q.value < 0);
  const split: AutomationPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (!b || a.curveType === 'HOLD' || !crosses(a, b)) { split.push(a); continue; }
    const curve = a.curveType || 'LINEAR';
    // Courbe : 16 sous-segments linéaires (écart < 0,2 % de la course), puis le passage au centre.
    const n = curve === 'LINEAR' ? 1 : 16;
    const sub: AutomationPoint[] = Array.from({ length: n }, (_, k) => (k === 0
      ? { ...a, curveType: 'LINEAR' as const }
      : { id: `${a.id}~${k}`, time: a.time + (k / n) * (b.time - a.time), value: interp(a.value, b.value, k / n, curve), curveType: 'LINEAR' as const }));
    sub.forEach((p, k) => {
      split.push(p);
      const q = sub[k + 1] || b;
      if (crosses(p, q)) {
        const t = p.value / (p.value - q.value);
        split.push({ id: `${p.id}~c`, time: p.time + t * (q.time - p.time), value: 0, curveType: 'LINEAR' });
      }
    });
  }
  const mk = (suffix: string, name: string, f: (v: number) => number): AutomationLane => ({
    ...lane, id: `${lane.id}-${suffix}`, parameterName: name, min: -1, max: 1,
    points: split.map(p => ({ ...p, id: `${p.id}-${suffix}`, value: f(p.value) })),
  });
  return { l: mk('g', PAN_L, v => legacyPanToStereo(v).l), r: mk('d', PAN_R, v => legacyPanToStereo(v).r) };
}

const laneCache = new WeakMap<AutomationLane[], { stereo: boolean; out: AutomationLane[] }>();

/**
 * Voies jouées selon le format de la piste : piste stéréo = « Pan G » / « Pan D » (une ancienne
 * voie « pan » sans G / D est convertie) ; piste mono = « pan » (les voies G / D sont ignorées).
 */
export function lanesForFormat(lanes: AutomationLane[], stereo: boolean, interp: Parameters<typeof convertPanLane>[1]): AutomationLane[] {
  if (!lanes.length) return lanes;
  const hit = laneCache.get(lanes);
  if (hit && hit.stereo === stereo) return hit.out;
  let out = lanes;
  if (stereo) {
    const hasLR = lanes.some(l => (l.parameterName === PAN_L || l.parameterName === PAN_R) && l.points.length);
    const old = lanes.find(l => l.parameterName === 'pan' && l.points.length);
    if (old || lanes.some(l => l.parameterName === 'pan')) {
      out = lanes.filter(l => l.parameterName !== 'pan');
      if (old && !hasLR) { const c = convertPanLane(old, interp); out = [...out.filter(l => l.parameterName !== PAN_L && l.parameterName !== PAN_R), c.l, c.r]; }
    }
  } else if (lanes.some(l => l.parameterName === PAN_L || l.parameterName === PAN_R)) {
    out = lanes.filter(l => l.parameterName !== PAN_L && l.parameterName !== PAN_R);
  }
  laneCache.set(lanes, { stereo, out });
  return out;
}
