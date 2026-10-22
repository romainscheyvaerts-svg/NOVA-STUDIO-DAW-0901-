/**
 * Mesures de l'égaliseur 12 bandes (chemin classique = filtres natifs, et cœur « pro »), réglages
 * donnés tels que la fenêtre les AFFICHE. Partagé par tests/metrologieEQ.test.ts (assertions)
 * et par la capture avant / après du rapport (METRO_OUT=… : JSON écrit par le test).
 */
import { ProEQ12Node } from '../../plugins/ProEQ12Plugin';
import { fakeAudioContext, graphDb } from './grapheWebAudio';
import { crossing, maxOf } from './outils';

export const RATES = [44100, 48000];
export const FREQS12 = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];

export interface Ligne { effet: string; reglage: string; affiche: string; mesure: number; unite: string; cible: number; tol: number; ok: boolean; sr: number }

/** Égaliseur avec une seule bande active (les autres coupées), réglages « affichés ». */
/** Classe d'égaliseur mesurée (par défaut celle du moteur ; la capture « avant » du rapport passe l'ancienne). */
export let EqClass: any = ProEQ12Node;
export const setEqClass = (c: any) => { EqClass = c; };

export function eqOne(sr: number, band: Record<string, any>, extra: Record<string, any> = {}) {
  const ctx = fakeAudioContext(sr);
  const bands = FREQS12.map((frequency, id) => ({ id, type: 'peaking', frequency, gain: 0, q: 1, isEnabled: false, isSolo: false }));
  bands[4] = { ...bands[4], ...band, isEnabled: true };
  const node = new EqClass(ctx, { isEnabled: true, masterGain: 1, bands, qVersion: 2, ...extra } as any);
  const db = (f: number) => graphDb(node.input as any, node.output as any, f);
  return { node, db, ctx };
}

const qOfBw = (bw: number) => 1 / (2 * Math.sinh((Math.LN2 / 2) * bw));
const fr = (v: number, d = 2) => v.toFixed(d).replace('.', ',');
const hz = (v: number) => (v >= 1000 ? `${fr(v / 1000, v >= 10000 ? 1 : 2)} kHz` : `${fr(v, v < 100 ? 1 : 0)} Hz`);

/** Mesures (chemin classique). Chaque ligne : valeur mesurée, cible (= affichée) et tolérance. */
export function mesurerEQClassique(): Ligne[] {
  const out: Ligne[] = [];
  const push = (l: Omit<Ligne, 'ok'>) => { out.push({ ...l, ok: Math.abs(l.mesure - l.cible) <= l.tol }); };
  for (const sr of RATES) {
    const nyq = sr / 2;
    // 1) Coupe-bas / coupe-haut : fréquence à −3 dB, réglage d'usine de la bande (Q 0,71 en v2) et Q 1.
    for (const type of ['highpass', 'lowpass'] as const) {
      const nom = type === 'highpass' ? 'Coupe-bas' : 'Coupe-haut';
      for (const f0 of [20, 50, 80, 100, 200, 500, 1000, 5000, 10000, 16000, 20000]) {
        for (const q of [Math.SQRT1_2, 1]) {
          const { db } = eqOne(sr, { type, frequency: f0, q });
          const f3 = type === 'highpass' ? crossing(db, -3.0103, 2, Math.min(nyq * 0.999, f0 * 1.6)) : crossing(db, -3.0103, f0 / 1.6, nyq * 0.9999);
          if (q < 0.8) push({ effet: 'EQ 12 bandes', reglage: `${nom} ${hz(f0)} · Q 0,71 · fréquence à −3 dB`, affiche: hz(f0), mesure: f3, unite: 'Hz', cible: f0, tol: Math.max(0.01 * f0, f0 < 100 ? 1 : 0), sr });
          // Gain au point de coupure : Q linéaire (v2) → 20·log10(Q).
          push({ effet: 'EQ 12 bandes', reglage: `${nom} ${hz(f0)} · Q ${fr(q)} · gain à la fréquence`, affiche: `${fr(20 * Math.log10(q))} dB`, mesure: db(f0), unite: 'dB', cible: 20 * Math.log10(q), tol: 0.1, sr });
        }
        // Pente : 2 à 3 octaves loin de la coupure (12 dB/oct annoncés).
        // (Coupe-haut : seulement loin de Nyquist ; plus haut, le zéro de la transformée bilinéaire à Nyquist le rend PLUS raide.)
        if (type === 'highpass' ? f0 >= 200 && f0 <= 5000 : f0 === 200) {
          const { db } = eqOne(sr, { type, frequency: f0, q: Math.SQRT1_2 });
          const s = type === 'highpass' ? db(f0 / 4) - db(f0 / 8) : db(f0 * 4) - db(f0 * 8);
          push({ effet: 'EQ 12 bandes', reglage: `${nom} ${hz(f0)} · pente (2→3 octaves)`, affiche: '12 dB/oct', mesure: s, unite: 'dB/oct', cible: 12, tol: 0.25, sr });
        }
      }
      // Bosse du réglage d'usine (doit être nulle à Q 0,71).
      const { db } = eqOne(sr, { type, frequency: 1000, q: Math.SQRT1_2 });
      const pk = maxOf(db, 20, nyq * 0.99);
      push({ effet: 'EQ 12 bandes', reglage: `${nom} 1 kHz · Q 0,71 · bosse maximale`, affiche: '0 dB (aucune bosse)', mesure: Math.max(0, pk.db), unite: 'dB', cible: 0, tol: 0.05, sr });
    }
    // 2) Cloches : fréquence centrale, gain, Q (largeur à mi-gain en dB).
    for (const f0 of [20, 50, 100, 1000, 3000, 5000, 8000, 10000, 12000, 16000, 20000]) for (const g of [-30, -12, 3, 12, 30]) for (const q of [0.1, 0.5, 1, 4, 10]) {
      const { db } = eqOne(sr, { type: 'peaking', frequency: f0, gain: g, q });
      const s = Math.sign(g);
      const fn = (f: number) => s * db(f);
      const pk = maxOf(fn, f0 / 4, Math.min(nyq * 0.9999, f0 * 4));
      push({ effet: 'EQ 12 bandes', reglage: `Cloche ${hz(f0)} ${g > 0 ? '+' : ''}${g} dB Q ${fr(q)} · fréquence centrale`, affiche: hz(f0), mesure: pk.f, unite: 'Hz', cible: f0, tol: Math.max(0.01 * f0, f0 < 100 ? 1 : 0), sr });
      push({ effet: 'EQ 12 bandes', reglage: `Cloche ${hz(f0)} ${g > 0 ? '+' : ''}${g} dB Q ${fr(q)} · gain`, affiche: `${g} dB`, mesure: s * pk.db, unite: 'dB', cible: g, tol: 0.1, sr });
      // Q mesuré : seulement si la cloche (analogique) tient sous 0,75 × Nyquist (au-delà : limite physique, voir eqQ.ts).
      const ol = Math.sqrt(1 + 1 / (4 * q * q)) - 1 / (2 * q);
      if (f0 / ol <= 0.75 * nyq && Math.abs(g) >= 3) {
        const lo = crossing(fn, Math.abs(g) / 2, 1, pk.f), hi = crossing(fn, Math.abs(g) / 2, pk.f, nyq * 0.99999);
        const qm = qOfBw(Math.log2(hi / lo));
        push({ effet: 'EQ 12 bandes', reglage: `Cloche ${hz(f0)} ${g > 0 ? '+' : ''}${g} dB Q ${fr(q)} · Q (largeur à mi-gain)`, affiche: `Q ${fr(q)}`, mesure: qm, unite: 'Q', cible: q, tol: 0.025 * q, sr });
      }
    }
    // 3) Étagères : gain du plateau (loin de la fréquence) et mi-gain à la fréquence.
    for (const type of ['lowshelf', 'highshelf'] as const) for (const f0 of [100, 1000, 5000]) for (const g of [-12, 6, 18]) {
      const { db } = eqOne(sr, { type, frequency: f0, gain: g, q: 1 });
      const far = type === 'lowshelf' ? db(Math.max(10, f0 / 64)) : db(Math.min(nyq * 0.999, f0 * 64 > nyq ? nyq * 0.999 : f0 * 64));
      const nom = type === 'lowshelf' ? 'Étagère grave' : 'Étagère aiguë';
      push({ effet: 'EQ 12 bandes', reglage: `${nom} ${hz(f0)} ${g > 0 ? '+' : ''}${g} dB · gain du plateau`, affiche: `${g} dB`, mesure: far, unite: 'dB', cible: g, tol: 0.1, sr });
      push({ effet: 'EQ 12 bandes', reglage: `${nom} ${hz(f0)} ${g > 0 ? '+' : ''}${g} dB · mi-gain à la fréquence`, affiche: `${fr(g / 2)} dB`, mesure: db(f0), unite: 'dB', cible: g / 2, tol: 0.1, sr });
    }
    // 4) Encoche : centre (creux) et Q à −3 dB.
    for (const f0 of [60, 1000, 5000]) for (const q of [2, 10]) {
      const { db } = eqOne(sr, { type: 'notch', frequency: f0, q });
      const fn = (f: number) => -db(f);
      const pk = maxOf(fn, f0 / 2, f0 * 2);
      push({ effet: 'EQ 12 bandes', reglage: `Encoche ${hz(f0)} Q ${fr(q)} · fréquence du creux`, affiche: hz(f0), mesure: pk.f, unite: 'Hz', cible: f0, tol: Math.max(0.01 * f0, 1), sr });
      const lo = crossing(fn, 3.0103, 1, f0 * 0.99999), hi = crossing(fn, 3.0103, f0 * 1.00001, nyq * 0.9999);
      push({ effet: 'EQ 12 bandes', reglage: `Encoche ${hz(f0)} Q ${fr(q)} · Q (largeur à −3 dB)`, affiche: `Q ${fr(q)}`, mesure: Math.sqrt(lo * hi) / (hi - lo), unite: 'Q', cible: q, tol: 0.025 * q, sr });
    }
    // 5) Neutre : toutes les bandes à 0 dB (coupe-bas / coupe-haut coupés) → 0 dB partout.
    {
      const ctx = fakeAudioContext(sr);
      const bands = FREQS12.map((frequency, id) => ({ id, type: id === 0 ? 'highpass' : id === 11 ? 'lowpass' : 'peaking', frequency, gain: 0, q: 1, isEnabled: id !== 0 && id !== 11, isSolo: false }));
      const node = new EqClass(ctx, { isEnabled: true, masterGain: 1, bands, qVersion: 2 } as any);
      let m = 0;
      for (let i = 0; i <= 200; i++) { const f = 20 * Math.pow(1000, i / 200); m = Math.max(m, Math.abs(graphDb(node.input as any, node.output as any, f))); }
      push({ effet: 'EQ 12 bandes', reglage: 'Égaliseur neutre (bandes à 0 dB, coupe-bas / haut coupés) · écart max 20 Hz–20 kHz', affiche: '0 dB', mesure: m, unite: 'dB', cible: 0, tol: 1e-6, sr });
    }
    // 6) Volume de sortie : 0,25 → 4 (−12 → +12 dB).
    for (const mg of [0.25, 0.5, 1, 2, 4]) {
      const { db } = eqOne(sr, { type: 'peaking', frequency: 1000, gain: 0, q: 1 }, { masterGain: mg });
      push({ effet: 'EQ 12 bandes', reglage: `Volume de sortie ${fr(20 * Math.log10(mg), 1)} dB`, affiche: `${fr(20 * Math.log10(mg), 2)} dB`, mesure: db(1000), unite: 'dB', cible: 20 * Math.log10(mg), tol: 0.01, sr });
    }
  }
  return out;
}

/** Réglages d'usine d'une bande ajoutée par la fenêtre, avant et après (pour le rapport). */
export const fmtHz = hz;
export const fmtNum = fr;
