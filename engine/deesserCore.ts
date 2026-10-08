/**
 * Cœur DSP du de-esser NOVA, en JavaScript pur.
 *
 * Il tourne tel quel dans l'AudioWorklet (la fonction est sérialisée par
 * `toString()` : elle ne doit RIEN référencer en dehors d'elle-même) et dans
 * les tests vitest / le labo de mesure (tools/labo/deess, via Node).
 *
 * Principe (mesuré au labo, voir D:\1 WORK\CONTENU\nova-labo\deesser) :
 *
 *   bande  b = F(x)    F = passe-bande à gain unité au centre (mode « Ciblé »)
 *                      ou passe-haut (mode « Tous les aigus »)
 *   sortie y = x + (g − 1)·b
 *
 * Quand le de-esser ne travaille pas (g = 1), y = x À L'ÉCHANTILLON PRÈS :
 * aucune coloration, aucun déphasage (null parfait). Quand il travaille, seule
 * la bande est atténuée : au centre, l'atténuation vaut exactement g.
 *
 * Détection (stéréo couplée : énergie moyenne des deux canaux) :
 *  - RELATIVE (défaut des nouvelles instances) : niveau de la bande RAPPORTÉ
 *    au niveau de toute la voix. Un « s » est un son où la bande domine ; une
 *    voyelle claire ou une voix chantée fort ne déclenchent pas. Indépendante
 *    du niveau d'enregistrement (comme le de-esser de référence mesuré) ;
 *    un plancher absolu évite de travailler sur le souffle des silences.
 *  - ABSOLUE (projets existants) : seuil fixe en dB, comme l'ancien de-esser.
 *
 * Loi : ratio 1 + 19·réduction, réduction max 4 + 14·réduction dB, genou doux
 * de 6 dB (identique à l'ancien de-esser). Enveloppes : montée 0,3 ms
 * (attrape le début du « s »), descente 10 ms ; lissage du gain 0,2 / 8 ms.
 * Mode relatif : la bande est comparée au RESTE de la voix (x − b) ; seuil
 * −6 dB par défaut (calé sur 6 voix réelles : −5 dB sur les « s », −0,6 dB
 * sur les aigus hors « s »).
 * Aucune anticipation : latence nulle.
 *
 * Écoute : 0 = normal, 1 = la bande seule (ce que le détecteur entend),
 * 2 = ce qui est retiré (y = (1 − g)·b).
 */

export interface DeesserCoreParams {
  /** 'BELL' (ciblé) ou 'SHELF' (tous les aigus au-dessus de la fréquence). */
  mode?: string;
  /** Fréquence centrale / de coupure (Hz). */
  frequency?: number;
  /** Largeur de la cloche (Q). */
  q?: number;
  /** 'RELATIVE' ou 'ABSOLUTE'. */
  detection?: string;
  /** Seuil absolu (dB) du mode ABSOLUE. */
  threshold?: number;
  /** Seuil relatif (dB, bande / voix entière) du mode RELATIVE. */
  relThreshold?: number;
  /** 0..1 : ratio et réduction maximale. */
  reduction?: number;
  /** 0 normal, 1 bande seule, 2 ce qui est retiré. */
  listen?: number;
  /** Relâchement (ms) : enveloppe et gain (défaut mesuré au labo). */
  releaseMs?: number;
  /** Montée (ms) du détecteur (défaut : 0,3 ms en relatif, 2,5 ms en absolu comme l'ancien de-esser). */
  attackMs?: number;
  isEnabled?: boolean;
}

export interface DeesserMeters {
  /** Réduction max depuis la dernière lecture (dB, ≥ 0). */
  grDb: number;
  /** Réduction courante (dB, ≥ 0). */
  grNowDb: number;
  /** Niveau détecté (dB) : relatif (bande − voix) ou absolu selon le mode. */
  detDb: number;
}

export interface DeesserCore {
  setParams(p: DeesserCoreParams): void;
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number): void;
  takeMeters(): DeesserMeters;
  reset(): void;
}

export function createDeesserCore(sampleRate: number): DeesserCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  // Filtre de bande (biquad, coefficients normalisés)
  var b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  var z = new Float64Array(8); // par canal : x1, x2, y1, y2
  var envB = 0, envW = 0, gr = 0;
  var mGr = 0, lastDet = -120;
  var enabled = true, listen = 0, relative = true;
  var thrAbs = -25, thrRel = -6, ratioK = 0, maxRange = 0, knee = 6;
  var cAttE = 0, cRelE = 0, cAttG = 0, cRelG = 0;
  var REL_DEF = 10;
  // Plancher : en dessous, la bande est du souffle (silence) -> pas de réduction.
  var floorMs = Math.pow(10, -60 / 10);
  // Mode absolu : référence identique à l'ancien de-esser (suiveur d'enveloppe
  // moyenne lissée : sinus de crête A vu ≈ 4,8 dB plus bas, mesuré au labo sur
  // la courbe statique de l'ancien nœud : −0,8 dB à −30 dBFS, −9,4 dB à −20).
  var absOffset = 10 * Math.log(2) / Math.LN10 - 7.2;

  function coef(ms: number) { return 1 - Math.exp(-1 / (ms * 0.001 * SR)); }

  function design(mode: string, f: number, q: number) {
    var fc = Math.max(500, Math.min(SR * 0.45, f));
    var w0 = 2 * Math.PI * fc / SR, cw = Math.cos(w0), sw = Math.sin(w0);
    var qq = mode === 'SHELF' ? 0.5 : Math.max(0.1, Math.min(10, q));
    var al = sw / (2 * qq), a0 = 1 + al;
    if (mode === 'SHELF') {
      b0 = (1 + cw) / 2 / a0; b1 = -(1 + cw) / a0; b2 = (1 + cw) / 2 / a0;
    } else {
      // passe-bande à gain unité au centre (RBJ « constant 0 dB peak gain »)
      b0 = al / a0; b1 = 0; b2 = -al / a0;
    }
    a1 = -2 * cw / a0; a2 = (1 - al) / a0;
  }

  function setParams(p: DeesserCoreParams) {
    var num = function (v: any, d: number) { var x = +v; return x === x && isFinite(x) ? x : d; };
    var mode = p.mode === 'SHELF' ? 'SHELF' : 'BELL';
    design(mode, num(p.frequency, 8000), num(p.q, 1));
    relative = p.detection !== 'ABSOLUTE';
    thrAbs = num(p.threshold, -25);
    thrRel = num(p.relThreshold, -6);
    var r = Math.max(0, Math.min(1, num(p.reduction, 0.6)));
    var ratio = 1 + r * 19;
    ratioK = 1 - 1 / ratio;
    maxRange = r > 0 ? 4 + 14 * r : 0;
    listen = Math.max(0, Math.min(2, Math.round(num(p.listen, 0))));
    enabled = p.isEnabled !== false;
    var rel = Math.max(1, Math.min(500, num(p.releaseMs, REL_DEF)));
    cRelE = coef(rel); cRelG = coef(rel * 0.8);
    var att = Math.max(0.05, Math.min(50, num(p.attackMs, relative ? 0.3 : 2.5)));
    cAttE = coef(att); cAttG = coef(Math.min(att, 1) * 0.66);
  }

  function reset() {
    z.fill(0); envB = 0; envW = 0; gr = 0; mGr = 0; lastDet = -120;
  }

  setParams({});

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number) {
    var right = inR || inL;
    var stereo = !!inR;
    for (var i = 0; i < n; i++) {
      var xl = inL[i], xr = right[i];
      // bande, canal gauche
      var bl = b0 * xl + b1 * z[0] + b2 * z[1] - a1 * z[2] - a2 * z[3];
      z[1] = z[0]; z[0] = xl; z[3] = z[2]; z[2] = bl;
      var br = bl;
      if (stereo) {
        br = b0 * xr + b1 * z[4] + b2 * z[5] - a1 * z[6] - a2 * z[7];
        z[5] = z[4]; z[4] = xr; z[7] = z[6]; z[6] = br;
      }
      // énergies (stéréo couplée)
      // voix « hors bande » = x − b (tout sauf la bande) : un « s » la domine nettement
      var rl = xl - bl, rr = xr - br;
      var pb = 0.5 * (bl * bl + br * br), pw = 0.5 * (rl * rl + rr * rr);
      envB += (pb - envB) * (pb > envB ? cAttE : cRelE);
      envW += (pw - envW) * (pw > envW ? cAttE : cRelE);
      // niveau détecté et réduction visée (dB)
      var det: number, over: number, target = 0;
      if (relative) {
        det = envB > floorMs ? 10 * Math.log10((envB + 1e-30) / (envW + 1e-30)) : -120;
        over = det - thrRel;
      } else {
        det = 10 * Math.log10(envB + 1e-30) + absOffset;
        over = det - thrAbs;
      }
      if (enabled && maxRange > 0) {
        if (over >= knee / 2) target = ratioK * over;
        else if (over > -knee / 2) target = ratioK * (over + knee / 2) * (over + knee / 2) / (2 * knee);
        if (target > maxRange) target = maxRange;
      }
      gr += (target - gr) * (target > gr ? cAttG : cRelG);
      if (gr < 1e-9) gr = 0;
      if (gr > mGr) mGr = gr;
      lastDet = det;
      var g = gr > 0 ? Math.pow(10, -gr / 20) : 1;
      var yl: number, yr: number;
      if (!enabled) { yl = xl; yr = xr; }
      else if (listen === 1) { yl = bl; yr = br; }
      else if (listen === 2) { yl = (1 - g) * bl; yr = (1 - g) * br; }
      else { yl = xl + (g - 1) * bl; yr = xr + (g - 1) * br; }
      outL[i] = yl;
      if (outR) outR[i] = yr;
    }
    // anti-dénormaux
    if (envB < 1e-30) envB = 0;
    if (envW < 1e-30) envW = 0;
  }

  return {
    setParams: setParams,
    process: process,
    takeMeters: function () {
      var r = { grDb: mGr, grNowDb: gr, detDb: lastDet };
      mGr = gr;
      return r;
    },
    reset: reset,
  };
}
