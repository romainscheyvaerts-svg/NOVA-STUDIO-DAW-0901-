/**
 * Réglages du « Compresseur multibande » (MBCOMP) et de l'« EQ dynamique » (DYNEQ) de NOVA :
 * bornes, valeurs par défaut, noms français, réglages automatisables et préréglages.
 * Données pures (aucun React, aucun nœud audio) : moteur, fenêtres, automation et tests s'en servent.
 *
 * Valeurs par défaut NEUTRES : taux 1:1 sur chaque bande du multibande, plage 0 dB sur chaque
 * bande de l'EQ dynamique (l'effet ne change pas le son tant qu'on n'a rien tourné).
 * Préréglages : uniquement des recettes publiées, sources dans engine/mixfx/RECETTES.md. Le
 * seuil n'est jamais imposé (il dépend du niveau de la prise) : le préréglage dit quelle
 * réduction viser en le baissant.
 */

export type MixFxKind = 'MBCOMP' | 'DYNEQ';

export interface MixFxSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
  /** Automatisable (AudioParam k-rate du worklet). */
  auto?: boolean;
  /** Échelle logarithmique (fréquences, temps). */
  log?: boolean;
}

export interface MixFxPreset { id: string; name: string; hint: string; source: string; params: Record<string, number> }

export const MB_BANDS = 4;
export const DYN_BANDS = 4;

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// --- Compresseur multibande --------------------------------------------------------------
export const MB_SPECS: MixFxSpec[] = [
  { id: 'bands', label: 'Nombre de bandes', min: 3, max: 4, step: 1, unit: '', hint: '3 bandes (grave, médium, aigu) ou 4 bandes (grave, bas-médium, haut-médium, aigu).' },
  { id: 'x1', label: 'Coupure 1', min: 30, max: 2000, step: 1, unit: 'Hz', log: true, auto: false,
    hint: 'Fréquence qui sépare la bande 1 (grave) de la bande 2. Filtres Linkwitz-Riley 24 dB/oct : la somme des bandes reste plate.' },
  { id: 'x2', label: 'Coupure 2', min: 150, max: 12000, step: 1, unit: 'Hz', log: true,
    hint: 'Fréquence qui sépare la bande 2 de la bande 3.' },
  { id: 'x3', label: 'Coupure 3', min: 1000, max: 18000, step: 1, unit: 'Hz', log: true,
    hint: 'Fréquence qui sépare la bande 3 de la bande 4 (mode 4 bandes).' },
  { id: 'knee', label: 'Genou', min: 0, max: 18, step: 0.5, unit: 'dB', hint: 'Largeur de la zone où la compression arrive en douceur autour du seuil (0 = net).' },
  { id: 'output', label: 'Sortie', min: -24, max: 24, step: 0.1, unit: 'dB', auto: true, hint: 'Volume en sortie, après toutes les bandes.' },
];
for (const b of range(MB_BANDS)) {
  MB_SPECS.push(
    { id: `b${b}Thr`, label: `Bande ${b} · seuil`, min: -60, max: 0, step: 0.1, unit: 'dB', auto: true,
      hint: `Niveau de crête (dBFS) à partir duquel la bande ${b} est comprimée : un sinus tenu dont la crête dépasse le seuil de 8 dB à 4:1 est réduit de 6 dB. Baisse-le jusqu'à voir la réduction voulue sur le mètre de la bande.` },
    { id: `b${b}Ratio`, label: `Bande ${b} · taux`, min: 1, max: 20, step: 0.1, unit: ':1', auto: true, log: true,
      hint: `Force de la compression de la bande ${b}. 1:1 = la bande ne compresse pas.` },
    { id: `b${b}Att`, label: `Bande ${b} · attaque`, min: 0.1, max: 200, step: 0.1, unit: 'ms', log: true,
      hint: `Vitesse à laquelle la bande ${b} réagit (constante de temps : 63 % de la montée du niveau détecté). Rapide = attrape les crêtes ; lent = laisse passer l'attaque.` },
    { id: `b${b}Rel`, label: `Bande ${b} · relâchement`, min: 5, max: 2000, step: 1, unit: 'ms', log: true,
      hint: `Vitesse de retour de la bande ${b} après la compression (constante de temps : 63 % du retour du niveau détecté).` },
    { id: `b${b}Gain`, label: `Bande ${b} · gain`, min: -24, max: 24, step: 0.1, unit: 'dB', auto: true,
      hint: `Volume de la bande ${b} après sa compression (rattrapage ou correction de timbre).` },
    { id: `b${b}Solo`, label: `Bande ${b} · solo`, min: 0, max: 1, step: 1, unit: '', hint: `N'écouter que la bande ${b} (plusieurs bandes peuvent être en solo).` },
    { id: `b${b}Byp`, label: `Bande ${b} · contournée`, min: 0, max: 1, step: 1, unit: '', hint: `La bande ${b} passe sans compression ni gain.` },
  );
}

export const MB_DEFAULTS: Record<string, number> = {
  bands: 3, x1: 200, x2: 4000, x3: 10000, knee: 6, output: 0,
  ...Object.fromEntries(range(MB_BANDS).flatMap(b => [[`b${b}Thr`, 0], [`b${b}Ratio`, 1], [`b${b}Att`, 10], [`b${b}Rel`, 200], [`b${b}Gain`, 0], [`b${b}Solo`, 0], [`b${b}Byp`, 0]])),
};

/** Recettes publiées (engine/mixfx/RECETTES.md). Les seuils restent ceux de l'utilisateur. */
export const MB_PRESETS: MixFxPreset[] = [
  { id: 'neutre', name: 'Neutre', source: '—',
    hint: 'Toutes les bandes à 1:1, gains à 0 dB : le son passe sans changement.',
    params: { ...Object.fromEntries(range(MB_BANDS).flatMap(b => [[`b${b}Ratio`, 1], [`b${b}Gain`, 0], [`b${b}Solo`, 0], [`b${b}Byp`, 0]])), output: 0 } },
  { id: 'sifflantes', name: 'Voix : sifflantes', source: 'R1',
    hint: "Recette de sonorisation (S. LaCerra) : coupures 130 Hz et 4 kHz, grave 1:1, médium 3:1 (30 ms / 200 ms, +3 dB), aigu 5:1 (attaque la plus rapide, 200 ms, +2 dB). Baisse le seuil du médium pour 4 à 6 dB de réduction, celui de l'aigu pour 4 à 5 dB sur les « s ».",
    params: { bands: 3, x1: 130, x2: 4000, b1Ratio: 1, b1Gain: 0, b2Ratio: 3, b2Att: 30, b2Rel: 200, b2Gain: 3, b3Ratio: 5, b3Att: 0.1, b3Rel: 200, b3Gain: 2, b1Solo: 0, b2Solo: 0, b3Solo: 0, b1Byp: 0, b2Byp: 0, b3Byp: 0 } },
  { id: 'bus-batterie', name: 'Bus batterie', source: 'R1',
    hint: "Recette (S. LaCerra) : coupures 275 Hz et 4 kHz ; grave 2,5:1 (15 ms / 250 ms, +4 dB), médium 3:1 (15 ms / 250 ms, 0 dB), aigu 1:1 (+3 dB). Baisse le seuil du grave pour ~4 dB de réduction, celui du médium pour 5 à 6 dB.",
    params: { bands: 3, x1: 275, x2: 4000, b1Ratio: 2.5, b1Att: 15, b1Rel: 250, b1Gain: 4, b2Ratio: 3, b2Att: 15, b2Rel: 250, b2Gain: 0, b3Ratio: 1, b3Gain: 3, b1Solo: 0, b2Solo: 0, b3Solo: 0, b1Byp: 0, b2Byp: 0, b3Byp: 0 } },
  { id: 'kick-pompe', name: 'Grave qui pompe', source: 'R1',
    hint: "Recette (S. LaCerra, mix dance) : le grave seul à 5:1 (attaque ~10 ms, relâchement 250 ms) pour que le kick ne fasse plus pomper la voix. Baisse le seuil du grave pour ~5 dB de réduction sur les coups de kick, puis règle la coupure 1 jusqu'à ce que la voix ne soit plus touchée.",
    params: { b1Ratio: 5, b1Att: 10, b1Rel: 250, b1Solo: 0, b1Byp: 0 } },
];

// --- EQ dynamique ------------------------------------------------------------------------
export const DYN_SPECS: MixFxSpec[] = [
  { id: 'listen', label: 'Écoute', min: 0, max: DYN_BANDS, step: 1, unit: '', hint: "0 = normal ; 1 à 4 = n'entendre que la bande surveillée (pour placer la fréquence sur la résonance)." },
  { id: 'output', label: 'Sortie', min: -24, max: 24, step: 0.1, unit: 'dB', auto: true, hint: "Volume en sortie de l'égaliseur." },
];
for (const b of range(DYN_BANDS)) {
  DYN_SPECS.push(
    { id: `d${b}On`, label: `Bande ${b} · active`, min: 0, max: 1, step: 1, unit: '', hint: `Met la bande ${b} en service.` },
    { id: `d${b}Freq`, label: `Bande ${b} · fréquence`, min: 20, max: 20000, step: 1, unit: 'Hz', auto: true, log: true,
      hint: `Centre de la cloche de la bande ${b}. Astuce : « Écouter » la bande et balaie la fréquence jusqu'à entendre la résonance.` },
    { id: `d${b}Q`, label: `Bande ${b} · Q`, min: 0.3, max: 12, step: 0.01, unit: '', log: true,
      hint: `Largeur de la bande ${b} : Q élevé = étroit (une résonance précise), Q bas = large. C'est le Q de la bande écoutée (−3 dB) ; la cloche se resserre quand elle creuse (à −6 dB, Q × 1,4) et s'élargit quand elle renforce.` },
    { id: `d${b}Thr`, label: `Bande ${b} · seuil`, min: -60, max: 0, step: 0.1, unit: 'dB', auto: true,
      hint: `Niveau de crête (dBFS) de la bande ${b} au-delà duquel le gain bouge (1 dB de dépassement = 1 dB de gain, genou de 3 dB). Sous le seuil, la bande ne change rien.` },
    { id: `d${b}Range`, label: `Bande ${b} · plage`, min: -24, max: 24, step: 0.1, unit: 'dB', auto: true,
      hint: `Gain maximal appliqué quand la bande dépasse le seuil : négatif = la résonance est baissée (au plus de cette valeur), positif = renforcée. 0 = la bande ne fait rien.` },
    { id: `d${b}Att`, label: `Bande ${b} · attaque`, min: 0.1, max: 200, step: 0.1, unit: 'ms', log: true, hint: `Vitesse à laquelle le gain de la bande ${b} réagit (constante de temps : 63 % de la montée du niveau détecté).` },
    { id: `d${b}Rel`, label: `Bande ${b} · relâchement`, min: 5, max: 2000, step: 1, unit: 'ms', log: true, hint: `Vitesse de retour du gain de la bande ${b} (constante de temps : 63 % du retour du niveau détecté).` },
  );
}

const DYN_FREQS = [250, 1000, 3500, 8000];
export const DYN_DEFAULTS: Record<string, number> = {
  listen: 0, output: 0,
  ...Object.fromEntries(range(DYN_BANDS).flatMap(b => [[`d${b}On`, 1], [`d${b}Freq`, DYN_FREQS[b - 1]], [`d${b}Q`, 2], [`d${b}Thr`, -20], [`d${b}Range`, 0], [`d${b}Att`, 5], [`d${b}Rel`, 100]])),
};

export const DYN_PRESETS: MixFxPreset[] = [
  { id: 'neutre', name: 'Neutre', source: '—',
    hint: 'Plage 0 dB sur les 4 bandes : le son passe sans changement.',
    params: { ...Object.fromEntries(range(DYN_BANDS).map(b => [`d${b}Range`, 0])), listen: 0, output: 0 } },
  { id: 'voix-dure', name: 'Voix dure (2 à 5 kHz)', source: 'R2',
    hint: "Recette publiée : cloche étroite (Q 5) dans 2 à 5 kHz, qui baisse de 2 à 4 dB seulement quand la voix ressort (plage −3 dB). Écoute la bande 3 et balaie 2 à 5 kHz jusqu'à entendre la dureté, puis baisse le seuil jusqu'à ce qu'elle ne réagisse que sur les passages durs.",
    params: { d3On: 1, d3Freq: 3500, d3Q: 5, d3Range: -3 } },
];

export const MIXFX_SPECS: Record<MixFxKind, MixFxSpec[]> = { MBCOMP: MB_SPECS, DYNEQ: DYN_SPECS };
export const MIXFX_DEFAULTS: Record<MixFxKind, Record<string, number>> = { MBCOMP: MB_DEFAULTS, DYNEQ: DYN_DEFAULTS };
export const MIXFX_PRESETS: Record<MixFxKind, MixFxPreset[]> = { MBCOMP: MB_PRESETS, DYNEQ: DYN_PRESETS };

export const isMixFxKind = (t: string): t is MixFxKind => t === 'MBCOMP' || t === 'DYNEQ';

/** Réglages connus, bornés et numériques (le reste est ignoré). */
export function sanitizeMixFx(kind: MixFxKind, p: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of MIXFX_SPECS[kind]) {
    if (!(s.id in (p || {}))) continue;
    const v = Number(p[s.id]);
    if (!Number.isFinite(v)) continue;
    out[s.id] = Math.max(s.min, Math.min(s.max, s.step >= 1 ? Math.round(v) : v));
  }
  return out;
}

/** Réglages automatisables (éditeur d'automation, AudioParam du worklet). */
export const mixFxAutomatable = (kind: MixFxKind) =>
  MIXFX_SPECS[kind].filter(s => s.auto).map(s => ({ id: s.id, label: s.label, min: s.min, max: s.max, unit: s.unit }));

/** Nom français d'un réglage (automation). */
export const mixFxParamLabel = (kind: string, key: string): string | null =>
  isMixFxKind(kind) ? MIXFX_SPECS[kind].find(s => s.id === key)?.label ?? null : null;

/**
 * Coupures RÉELLES du multibande (Hz), telles que le cœur les applique (engine/mixfx/multibandCore.ts) :
 * bornées à 20 Hz – 20 kHz et à 0,45 × fréquence d'échantillonnage, et écartées d'au moins 1/3
 * d'octave (×1,26). La fenêtre affiche ces valeurs (avant le 22/10/2026 elle affichait le réglage
 * brut : « 220 Hz » quand le son coupait à 252 Hz).
 */
export function mbEffectiveCrossovers(p: Record<string, any>, sampleRate = 48000): [number, number, number] {
  const num = (v: any, d: number) => { const x = +v; return Number.isFinite(x) ? x : d; };
  const cl = (x: number) => Math.max(20, Math.min(20000, x));
  const xs = [cl(num(p.x1, 200)), cl(num(p.x2, 4000)), cl(num(p.x3, 10000))];
  if (xs[1] < xs[0] * 1.26) xs[1] = xs[0] * 1.26;
  if (xs[2] < xs[1] * 1.26) xs[2] = xs[1] * 1.26;
  return xs.map(f => Math.min(f, sampleRate * 0.45)) as [number, number, number];
}

/**
 * Réponse (dB) d'une bande de l'EQ dynamique à la fréquence f : cloche y = x + (g − 1)·passe-bande,
 * passe-bande de Q donné avec largeur préwarpée — EXACTEMENT le filtre du cœur (engine/mixfx/dynEqCore.ts).
 */
export function dynBandDb(f: number, fc: number, q: number, gDb: number, sampleRate = 48000): number {
  if (!gDb) return 0;
  const sr = sampleRate;
  const f0 = Math.max(20, Math.min(fc, sr * 0.45));
  const w0 = 2 * Math.PI * f0 / sr, sw = Math.sin(w0);
  const Q = Math.max(0.1, Math.min(40, q));
  const xq = 1 / (2 * Q), bwOct = 2 / Math.LN2 * Math.log(xq + Math.sqrt(xq * xq + 1));
  const al = sw * Math.sinh(Math.LN2 / 2 * bwOct * w0 / sw), a0 = 1 + al;
  const b0 = al / a0, a1 = -2 * Math.cos(w0) / a0, a2 = (1 - al) / a0;
  const w = 2 * Math.PI * f / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  // BP = b0 (1 − z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²)
  const nr = b0 * (1 - c2), ni = b0 * s2;
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  const den = dr * dr + di * di;
  const br = (nr * dr + ni * di) / den, bi = (ni * dr - nr * di) / den;
  const gm1 = Math.pow(10, gDb / 20) - 1;
  const hr = 1 + gm1 * br, hi = gm1 * bi;
  return 10 * Math.log10(hr * hr + hi * hi + 1e-30);
}
