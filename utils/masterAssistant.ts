/**
 * « Master Nova » (V15) : logique pure de l'assistant de mastering, comme le
 * Mastering Assistant de Logic Pro.
 *
 *  - cibles de loudness par plateforme ;
 *  - analyse du mix : loudness, crête vraie, dynamique, équilibre spectral ;
 *  - chaîne proposée : EQ légère (dosable), compression de bus, limiteur ;
 *  - réglage itératif du gain du limiteur pour tomber sur la cible LUFS.
 *
 * Tout ce qui touche à l'audio du navigateur est dans services/masterNova.ts.
 */
import { loudnessReport, LoudnessReport } from './audioMeasure';

export interface PlatformTarget { id: string; label: string; lufs: number; ceiling: number; hint: string }

export const PLATFORM_TARGETS: PlatformTarget[] = [
  { id: 'spotify', label: 'Spotify', lufs: -14, ceiling: -1, hint: 'Spotify ramène tout à −14 LUFS : plus fort ne sert à rien, ça écrase seulement.' },
  { id: 'apple', label: 'Apple Music', lufs: -16, ceiling: -1, hint: 'Apple Music normalise à −16 LUFS (Son adaptatif).' },
  { id: 'youtube', label: 'YouTube', lufs: -14, ceiling: -1, hint: 'YouTube baisse ce qui dépasse −14 LUFS.' },
  { id: 'deezer', label: 'Deezer', lufs: -15, ceiling: -1, hint: 'Deezer normalise vers −15 LUFS.' },
  { id: 'tiktok', label: 'TikTok / Insta', lufs: -14, ceiling: -1, hint: 'Réseaux : −14 LUFS, crête à −1 dBTP pour survivre à la compression du réseau.' },
  { id: 'club', label: 'SoundCloud / club', lufs: -9, ceiling: -0.5, hint: 'Fort et dense, pour SoundCloud, les DJ et les sound systems (−9 LUFS).' },
];

export type MasterCharacter = 'propre' | 'punch' | 'chaud';
export const CHARACTERS: { id: MasterCharacter; label: string; hint: string }[] = [
  { id: 'propre', label: 'Propre', hint: 'Transparent : le mix tel quel, plus fort (comme « Clean » / « Transparent » dans Logic).' },
  { id: 'punch', label: 'Punch', hint: 'Kick et 808 qui claquent, compression plus franche (comme « Punch » dans Logic).' },
  { id: 'chaud', label: 'Chaud', hint: 'Bas-médiums ronds, aigus adoucis, compression douce façon opto (comme « Valve » dans Logic).' },
];

// ---------------------------------------------------------------------------
// Équilibre spectral
// ---------------------------------------------------------------------------

export interface SpectralBand { id: string; label: string; lo: number; hi: number; freq: number }

export const BANDS: SpectralBand[] = [
  { id: 'sub', label: 'sub (808)', lo: 25, hi: 60, freq: 45 },
  { id: 'bass', label: 'basses', lo: 60, hi: 200, freq: 110 },
  { id: 'lowmid', label: 'bas-médiums', lo: 200, hi: 800, freq: 400 },
  { id: 'mid', label: 'médiums', lo: 800, hi: 3000, freq: 1600 },
  { id: 'presence', label: 'présence', lo: 3000, hi: 8000, freq: 5000 },
  { id: 'air', label: 'air', lo: 8000, hi: 16000, freq: 11000 },
];

/**
 * Courbe cible (dB par octave, relatifs aux médiums) d'un master rap / trap /
 * R&B actuel : sub et basses en avant, aigus en pente douce.
 */
export const TARGET_CURVE: Record<string, number> = { sub: 3, bass: 4, lowmid: 1, mid: 0, presence: -3.5, air: -8 };

/** FFT réelle (radix 2, en place) ; renvoie les puissances |X|² des bins 0..N/2. */
function powerSpectrum(frame: Float64Array): Float64Array {
  const n = frame.length;
  const re = frame, im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

/**
 * Niveau par bande en dB PAR OCTAVE (puissance de la bande divisée par sa
 * largeur en octaves), relatif à la bande « médiums ». Moyenne sur des trames
 * de 4096 points (fenêtre de Hann) prises dans tout le morceau.
 */
export function spectralBalance(ch: Float32Array[], sampleRate: number, maxFrames = 400): Record<string, number> {
  const N = 4096, n = ch[0]?.length || 0;
  const acc = new Float64Array(N / 2 + 1);
  const hop = Math.max(N, Math.floor((n - N) / maxFrames));
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  let frames = 0;
  for (let s = 0; s + N <= n; s += hop) {
    const f = new Float64Array(N);
    for (let i = 0; i < N; i++) { let v = 0; for (const c of ch) v += c[s + i]; f[i] = (v / ch.length) * win[i]; }
    const p = powerSpectrum(f);
    for (let k = 0; k < p.length; k++) acc[k] += p[k];
    frames++;
  }
  const out: Record<string, number> = {};
  if (!frames) { BANDS.forEach(b => (out[b.id] = 0)); return out; }
  const binHz = sampleRate / N;
  const raw: Record<string, number> = {};
  for (const b of BANDS) {
    let sum = 0;
    for (let k = Math.max(1, Math.floor(b.lo / binHz)); k <= Math.min(N / 2, Math.ceil(b.hi / binHz)); k++) sum += acc[k];
    const octaves = Math.log2(b.hi / b.lo);
    raw[b.id] = 10 * Math.log10(Math.max(1e-20, sum / frames / octaves));
  }
  for (const b of BANDS) out[b.id] = raw[b.id] - raw.mid;
  return out;
}

// ---------------------------------------------------------------------------
// Analyse et chaîne proposée
// ---------------------------------------------------------------------------

export interface MixAnalysis extends LoudnessReport { balance: Record<string, number>; duration: number }

export function analyzeMix(ch: Float32Array[], sampleRate: number): MixAnalysis {
  return { ...loudnessReport(ch, sampleRate), balance: spectralBalance(ch, sampleRate), duration: (ch[0]?.length || 0) / sampleRate };
}

export interface EqMove { band: string; label: string; freq: number; gainDb: number }

export interface MasterChainProposal {
  eqMoves: EqMove[];
  eqParams: Record<string, any>;
  compParams: Record<string, any>;
  limiterParams: Record<string, any>;
  target: PlatformTarget;
  character: MasterCharacter;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Corrections d'EQ (dB) : écart à la courbe cible × dosage, limité à ±3 dB, plus la couleur du caractère. */
export function eqCorrections(balance: Record<string, number>, amount: number, character: MasterCharacter): EqMove[] {
  const a = clamp(amount, 0, 1);
  const color: Record<string, number> = character === 'punch' ? { bass: 1, presence: 0.5 } : character === 'chaud' ? { lowmid: 0.8, air: -1 } : {};
  return BANDS.map(b => {
    const diff = (TARGET_CURVE[b.id] ?? 0) - (balance[b.id] ?? 0);
    const corr = b.id === 'mid' ? 0 : clamp(diff * 0.5 * a, -3, 3);
    return { band: b.id, label: b.label, freq: b.freq, gainDb: round1(clamp(corr + (color[b.id] || 0), -3.5, 3.5)) };
  });
}

/** Réglages du Pro-EQ 12 de NOVA pour ces corrections (bandes inutilisées coupées). */
export function eqParamsFor(moves: EqMove[]): Record<string, any> {
  const g = (id: string) => moves.find(m => m.band === id)?.gainDb || 0;
  const bands = [
    { id: 0, type: 'highpass', frequency: 22, gain: 0, q: 0.7, isEnabled: true, isSolo: false },
    { id: 1, type: 'lowshelf', frequency: 55, gain: g('sub'), q: 0.7, isEnabled: true, isSolo: false },
    { id: 2, type: 'peaking', frequency: 110, gain: g('bass'), q: 0.8, isEnabled: true, isSolo: false },
    { id: 3, type: 'peaking', frequency: 400, gain: g('lowmid'), q: 0.7, isEnabled: true, isSolo: false },
    { id: 4, type: 'peaking', frequency: 1600, gain: g('mid'), q: 0.7, isEnabled: true, isSolo: false },
    { id: 5, type: 'peaking', frequency: 5000, gain: g('presence'), q: 0.8, isEnabled: true, isSolo: false },
    { id: 6, type: 'highshelf', frequency: 10000, gain: g('air'), q: 0.7, isEnabled: true, isSolo: false },
  ];
  for (let i = 7; i < 12; i++) bands.push({ id: i, type: i === 11 ? 'lowpass' : 'peaking', frequency: [6000, 8000, 10000, 12000, 18000][i - 7] || 18000, gain: 0, q: 1, isEnabled: false, isSolo: false });
  return { isEnabled: true, masterGain: 1, bands };
}

export function compParamsFor(a: MixAnalysis, character: MasterCharacter): Record<string, any> {
  // Seuil vers le haut du programme : 1 à 3 dB de réduction sur les passages forts.
  const threshold = round1(clamp((Number.isFinite(a.lufs) ? a.lufs : -20) + 5, -30, -4));
  const base = { threshold, knee: 8, makeupGain: 1, mix: 1, scHpFreq: 90, lookahead: 0, autoMakeup: false, isEnabled: true };
  if (character === 'punch') return { ...base, ratio: 2, attack: 0.03, release: 0.12, mode: 'VCA' };
  if (character === 'chaud') return { ...base, ratio: 1.8, attack: 0.02, release: 0.3, mode: 'OPTO' };
  return { ...base, ratio: 1.5, attack: 0.03, release: 0.2, mode: 'CLEAN' };
}

export function limiterParamsFor(target: PlatformTarget, character: MasterCharacter, inputGain: number): Record<string, any> {
  return {
    ceiling: target.ceiling,
    inputGain: round1(clamp(inputGain, 0, 24)),
    release: character === 'punch' ? 60 : character === 'chaud' ? 150 : 100,
    lookahead: 3,
    oversample: 4,
    isEnabled: true,
  };
}

export function proposeChain(a: MixAnalysis, target: PlatformTarget, character: MasterCharacter, eqAmount = 0.6): MasterChainProposal {
  const eqMoves = eqCorrections(a.balance, eqAmount, character);
  const first = Number.isFinite(a.lufs) ? target.lufs - a.lufs : 0;
  return {
    eqMoves,
    eqParams: eqParamsFor(eqMoves),
    compParams: compParamsFor(a, character),
    limiterParams: limiterParamsFor(target, character, first),
    target,
    character,
  };
}

/**
 * Gain suivant du limiteur pour atteindre la cible (méthode de la sécante :
 * plus le limiteur travaille, moins 1 dB de gain donne 1 dB de loudness).
 */
export function nextLimiterGain(history: { gain: number; lufs: number }[], target: number): number {
  const last = history[history.length - 1];
  if (!last) return 0;
  const err = target - last.lufs;
  if (history.length < 2) return clamp(last.gain + err, 0, 24);
  const prev = history[history.length - 2];
  const slope = (last.lufs - prev.lufs) / ((last.gain - prev.gain) || 1e-6);
  const s = clamp(Number.isFinite(slope) ? slope : 1, 0.15, 1.2);
  return clamp(last.gain + err / s, 0, 24);
}

/** Morceau de référence : Gain (dB) qui amène la référence au niveau du mix, sans dépasser −1 dBTP. */
export function referenceMatchGainDb(refLufs: number, refTruePeak: number, mixLufs: number, ceiling = -1): { gainDb: number; limited: boolean } {
  if (!Number.isFinite(refLufs) || !Number.isFinite(mixLufs)) return { gainDb: 0, limited: false };
  let g = mixLufs - refLufs;
  let limited = false;
  if (Number.isFinite(refTruePeak) && refTruePeak + g > ceiling) { g = ceiling - refTruePeak; limited = true; }
  return { gainDb: g, limited };
}

/** Phrase lisible pour une correction d'EQ (« +1,5 dB sur le sub (808) vers 45 Hz »). */
export const eqMoveLabel = (m: EqMove) =>
  `${m.gainDb > 0 ? '+' : m.gainDb < 0 ? '−' : ''}${Math.abs(m.gainDb).toFixed(1).replace('.', ',')} dB sur ${m.label} (${m.freq >= 1000 ? `${(m.freq / 1000).toString().replace('.', ',')} kHz` : `${m.freq} Hz`})`;

/** Format français d'une mesure (−14,0) ; « — » si inconnue. */
export const fmtDb = (v: number, digits = 1) => (Number.isFinite(v) ? (v < 0 ? '−' : '') + Math.abs(v).toFixed(digits).replace('.', ',') : '—');
