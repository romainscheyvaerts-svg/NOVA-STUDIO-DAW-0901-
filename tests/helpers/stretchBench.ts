/**
 * L5 · écart 19 · Banc d'étirement : signaux synthétiques dont on connaît la
 * version « idéalement étirée », et mesures objectives :
 *  - attaques (batterie) : écart de temps à la place attendue (ms), pré-écho
 *    (énergie juste avant l'attaque, dB sous l'attaque), attaque dédoublée ;
 *  - cohérence de phase (« phasiness ») : facteur de crête d'un train
 *    d'impulsions harmonique (une voix) — un son « phasé » perd ses crêtes ;
 *    corrélation gauche / droite d'une stéréo décalée de 0,3 ms ;
 *  - stabilité des partiels : ondulation du niveau de 3 sinusoïdes tenues
 *    (« gargouillis »), écart de hauteur (cents).
 */
export const SR = 48000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

/** Batterie : coups de bruit (chute de 6 ms) toutes les 250 ms ; instants des attaques (s). */
export function drums(seconds = 3): { x: Float32Array; onsets: number[] } {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const r = rng(9);
  const onsets: number[] = [];
  for (let t = 0.25; t < seconds - 0.2; t += 0.25) {
    onsets.push(t);
    const i0 = Math.round(t * SR);
    for (let i = 0; i < Math.round(0.06 * SR); i++) x[i0 + i] += 0.6 * Math.exp(-i / (0.006 * SR)) * r() * 2;
  }
  return { x, onsets };
}

/**
 * Voix synthétique : 24 harmoniques en phase (impulsions de la glotte), avec un
 * vibrato de ±3 % à 5,5 Hz (`vibrato` = 0 : tenue parfaite). Un étirement « phasé »
 * désaligne les harmoniques : les impulsions s'étalent, la crête baisse.
 */
export function pulses(seconds = 2, f0 = 140, vibrato = 0.03): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (2 * Math.PI * f0 * (1 + vibrato * Math.sin((2 * Math.PI * 5.5 * i) / SR))) / SR;
    let v = 0;
    for (let h = 1; h <= 24; h++) v += Math.cos(h * ph) / 24;
    x[i] = 0.5 * v;
  }
  return x;
}

/** Accord tenu : 220, 330 et 550 Hz. */
export function chord(seconds = 2): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.2 * (Math.sin((2 * Math.PI * 220 * i) / SR) + Math.sin((2 * Math.PI * 330 * i) / SR + 1) + Math.sin((2 * Math.PI * 550 * i) / SR + 2));
  return x;
}

/** Stéréo : la même voix, la droite en retard de 0,3 ms. */
export function stereoPulses(seconds = 2): [Float32Array, Float32Array] {
  const L = pulses(seconds, 160);
  const d = Math.round(0.0003 * SR);
  const R = new Float32Array(L.length);
  R.set(L.subarray(0, L.length - d), d);
  return [L, R];
}

/** Enveloppe (valeur absolue lissée sur 0,5 ms). */
function envelope(x: Float32Array): Float32Array {
  const w = Math.round(0.0005 * SR);
  const e = new Float32Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) { acc += Math.abs(x[i]); if (i >= w) acc -= Math.abs(x[i - w]); e[i] = acc / w; }
  return e;
}

export interface OnsetReport { meanErrMs: number; maxErrMs: number; preEchoDb: number; doubled: number }

/**
 * Attaques : pour chaque instant attendu (s), l'attaque mesurée = premier
 * échantillon où l'enveloppe dépasse la moitié du pic de ce coup.
 */
export function onsetReport(y: Float32Array, expected: number[]): OnsetReport {
  const e = envelope(y);
  const errs: number[] = [];
  let pre = 0, post = 0, doubled = 0;
  for (const t of expected) {
    const c = Math.round(t * SR);
    const a = Math.max(0, c - Math.round(0.03 * SR)), b = Math.min(e.length, c + Math.round(0.03 * SR));
    let pk = 0, pki = c;
    for (let i = a; i < b; i++) if (e[i] > pk) { pk = e[i]; pki = i; }
    let on = pki;
    while (on > a && e[on - 1] >= pk / 2) on--;
    errs.push(((on - c) / SR) * 1000);
    // Pré-écho : 2 à 20 ms avant l'attaque attendue, rapporté aux 20 ms qui suivent.
    for (let i = c - Math.round(0.02 * SR); i < c - Math.round(0.002 * SR); i++) if (i >= 0) pre += y[i] * y[i];
    for (let i = c; i < c + Math.round(0.02 * SR) && i < y.length; i++) post += y[i] * y[i];
    // Attaque dédoublée : un 2e pic d'enveloppe à plus de la moitié du premier, 8 à 40 ms après.
    let second = 0;
    for (let i = pki + Math.round(0.008 * SR); i < Math.min(e.length, pki + Math.round(0.04 * SR)); i++) second = Math.max(second, e[i]);
    if (second > 0.5 * pk) doubled++;
  }
  const abs = errs.map(Math.abs);
  return { meanErrMs: abs.reduce((s, v) => s + v, 0) / abs.length, maxErrMs: Math.max(...abs), preEchoDb: 10 * Math.log10((pre + 1e-20) / (post + 1e-20)), doubled };
}

/** Facteur de crête (dB) sur la partie centrale. */
export function crestDb(y: Float32Array): number {
  const a = Math.round(y.length * 0.2), b = Math.round(y.length * 0.8);
  let pk = 0, e = 0;
  for (let i = a; i < b; i++) { pk = Math.max(pk, Math.abs(y[i])); e += y[i] * y[i]; }
  return 20 * Math.log10(pk / Math.sqrt(e / (b - a)));
}

/** Ondulation (écart-type en dB) du niveau de chaque partiel, trames de 40 ms, et écart de hauteur (cents). */
export function partialReport(y: Float32Array, freqs: number[]): { wobbleDb: number; centsErr: number } {
  const frame = Math.round(0.04 * SR);
  let worst = 0, cents = 0;
  for (const f of freqs) {
    const lv: number[] = [];
    for (let s = Math.round(y.length * 0.15); s + frame < y.length * 0.85; s += frame / 2) {
      let c = 0, q = 0, ws = 0;
      for (let i = 0; i < frame; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame); // Hann : les autres partiels ne fuient pas
        const ph = (2 * Math.PI * f * (s + i)) / SR; c += w * y[s + i] * Math.cos(ph); q += w * y[s + i] * Math.sin(ph); ws += w;
      }
      lv.push(20 * Math.log10((2 * Math.hypot(c, q)) / ws + 1e-12));
    }
    const m = lv.reduce((s, v) => s + v, 0) / lv.length;
    worst = Math.max(worst, Math.sqrt(lv.reduce((s, v) => s + (v - m) ** 2, 0) / lv.length));
    // Hauteur : pic fin autour de f (±3 %).
    let best = f, bp = 0;
    for (let g = f * 0.97; g <= f * 1.03; g += f * 0.0005) {
      let c = 0, q = 0;
      const a = Math.round(y.length * 0.3), n = Math.round(y.length * 0.4);
      for (let i = a; i < a + n; i += 2) { const ph = (2 * Math.PI * g * i) / SR; c += y[i] * Math.cos(ph); q += y[i] * Math.sin(ph); }
      const p = c * c + q * q;
      if (p > bp) { bp = p; best = g; }
    }
    cents = Math.max(cents, Math.abs(1200 * Math.log2(best / f)));
  }
  return { wobbleDb: worst, centsErr: cents };
}

/** Corrélation gauche / droite au retard d'origine (0,3 ms) : 1 = image stéréo intacte. */
export function stereoCoherence(L: Float32Array, R: Float32Array): number {
  const d = Math.round(0.0003 * SR);
  const a = Math.round(L.length * 0.2), b = Math.round(L.length * 0.8);
  let lr = 0, ll = 0, rr = 0;
  for (let i = a; i < b; i++) { lr += L[i] * R[i + d]; ll += L[i] * L[i]; rr += R[i + d] * R[i + d]; }
  return lr / Math.sqrt(ll * rr + 1e-20);
}
