/**
 * Morceau synthétique « réaliste » pour les tests du master express : kick,
 * 808 avec notes, caisse claire, charleys, nappe d'accords et une « voix »
 * (impulsions filtrées par des formants, phrases et respirations), mixé vers
 * −20 LUFS avec des crêtes autour de −6 dBFS, comme un mix non masterisé.
 * Déterministe (graine fixe).
 */
export function syntheticSong(seconds = 20, sr = 44100, opts: { bright?: number; seed?: number } = {}): Float32Array[] {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  let s = opts.seed ?? 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
  const bpm = 140, beat = 60 / bpm, bar = beat * 4;
  const bright = opts.bright ?? 1;
  // Charleys : bruit passe-haut (différence première, deux fois).
  let h1 = 0, h2 = 0;
  // Nappe : 3 dents de scie filtrées (passe-bas à un pôle).
  let lpL = 0, lpR = 0;
  const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 311.1]];
  const bassNotes = [55, 49, 43.65, 49];
  // Voix : impulsions à 180 Hz filtrées par 3 formants (résonateurs).
  const formants = [[700, 0.06], [1200, 0.08], [2600, 0.1]].map(([f, bw]) => {
    const r = Math.exp(-Math.PI * f * bw / sr), w = 2 * Math.PI * f / sr;
    return { a1: -2 * r * Math.cos(w), a2: r * r, y1: 0, y2: 0 };
  });
  let phaseV = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tb = t % beat, tbar = t % bar, barIdx = Math.floor(t / bar) % 4;
    // Kick sur 1 et 3 (et la double), balayage 120 → 45 Hz.
    const kickT = (tbar % (beat * 2));
    const kick = Math.sin(2 * Math.PI * (45 * kickT + 75 * (1 - Math.exp(-kickT * 30)) / 30)) * Math.exp(-kickT * 9) * 0.55;
    // 808 tenue.
    const f808 = bassNotes[barIdx];
    const env808 = Math.exp(-(tbar % (bar / 2)) * 1.2);
    const b808 = Math.tanh(1.4 * Math.sin(2 * Math.PI * f808 * t)) * env808 * 0.32;
    // Caisse claire sur 2 et 4.
    const sn = (Math.floor(t / beat) % 2 === 1) ? (rnd() * 0.35 + Math.sin(2 * Math.PI * 185 * tb) * 0.25) * Math.exp(-tb * 18) : 0;
    // Charleys en croches.
    const th = t % (beat / 2);
    const hn = rnd();
    const hp = hn - h1; h1 = hn; const hp2 = hp - h2; h2 = hp;
    const hat = hp2 * Math.exp(-th * 60) * 0.07 * bright;
    // Nappe.
    const ch = chords[barIdx];
    let saw = 0;
    for (const f of ch) saw += ((t * f) % 1) * 2 - 1;
    lpL += 0.04 * (saw - lpL); lpR += 0.035 * (saw * 0.9 - lpR);
    const pad = 0.035;
    // Voix : phrases de 1,5 s, silences de 0,5 s.
    const ph = t % 2;
    const vEnv = ph < 1.5 ? Math.min(1, ph * 12) * Math.min(1, (1.5 - ph) * 12) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.7 * t)) : 0;
    phaseV += (180 + 4 * Math.sin(2 * Math.PI * 5.5 * t)) / sr;
    let pulse = 0;
    if (phaseV >= 1) { phaseV -= 1; pulse = 1; }
    let v = 0;
    for (const fm of formants) { const y = pulse - fm.a1 * fm.y1 - fm.a2 * fm.y2; fm.y2 = fm.y1; fm.y1 = y; v += y; }
    const voice = v * vEnv * 0.02 + (ph > 1.6 && ph < 1.9 ? rnd() * 0.01 : 0);
    const mono = kick + b808 + sn + voice;
    L[i] = (mono + hat * 0.8 + lpL * pad) * 0.45;
    R[i] = (mono + hat * 1.1 + lpR * pad) * 0.45;
  }
  return [L, R];
}
