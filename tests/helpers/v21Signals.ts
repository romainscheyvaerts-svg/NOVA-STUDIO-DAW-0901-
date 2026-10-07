/** Signaux de test des effets V21 (voix synthétique, mesure de hauteur). */
const SR = 48000;

/** Voyelle « a » synthétique : impulsions glottiques filtrées par 3 formants (700, 1220, 2600 Hz). */
export function vowel(f0: number, seconds: number, sr = SR, formants = [700, 1220, 2600]) {
  const n = Math.round(seconds * sr);
  const src = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += f0 / sr;
    if (ph >= 1) ph -= 1;
    // Onde glottique de Rosenberg simplifiée (ouverture 0..0,6, fermeture brusque).
    src[i] = ph < 0.4 ? 0.5 * (1 - Math.cos(Math.PI * ph / 0.4)) : ph < 0.6 ? Math.cos(Math.PI * (ph - 0.4) / 0.4) : 0;
  }
  // Dérivée (rayonnement aux lèvres) puis résonateurs en parallèle.
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = src[i] - src[i - 1];
  const out = new Float32Array(n);
  formants.forEach((fc, k) => {
    const bw = 130 + 60 * k;
    const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * fc / sr;
    const a1 = -2 * r * Math.cos(th), a2 = r * r;
    let y1 = 0, y2 = 0;
    const g = [1, 0.6, 0.3][k];
    for (let i = 0; i < n; i++) { const y = d[i] - a1 * y1 - a2 * y2; y2 = y1; y1 = y; out[i] += g * y; }
  });
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= 0.5 / pk;
  return out;
}

/** Fréquence fondamentale d'un segment : autocorrélation normalisée + interpolation parabolique. */
export function f0Of(x: Float32Array, sr = SR, fmin = 40, fmax = 1200): number {
  const n = x.length;
  const lagMin = Math.floor(sr / fmax), lagMax = Math.ceil(sr / fmin);
  const W = n - lagMax;
  const nsdf = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let ac = 0, e1 = 0, e2 = 0;
    for (let j = 0; j < W; j++) { ac += x[j] * x[j + lag]; e1 += x[j] * x[j]; e2 += x[j + lag] * x[j + lag]; }
    nsdf[lag] = (2 * ac) / (e1 + e2 + 1e-20);
  }
  // Premier pic au-dessus de 0,97 × le maximum (méthode McLeod).
  let max = 0; for (let l = lagMin; l <= lagMax; l++) max = Math.max(max, nsdf[l]);
  let best = -1;
  for (let l = lagMin; l <= lagMax; l++) {
    if (nsdf[l] >= 0.97 * max && nsdf[l] >= nsdf[l - 1] && nsdf[l] >= nsdf[l + 1]) { best = l; break; }
  }
  if (best < 0) return 0;
  const a = nsdf[best - 1], b = nsdf[best], c = nsdf[best + 1];
  const den = a - 2 * b + c;
  const t = best + (Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0);
  return sr / t;
}

