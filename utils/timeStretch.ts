/**
 * Étirement temporel (time stretch) préservant la hauteur.
 * ---------------------------------------------------------
 * Algorithme WSOLA (Waveform Similarity Overlap-Add) : on découpe le signal en
 * trames, et pour chaque trame on cherche, dans une petite fenêtre de
 * tolérance, la position dont la forme d'onde prolonge le mieux la trame
 * précédente. On recolle ensuite les trames avec un fondu croisé.
 *
 * C'est ce décalage de recherche qui distingue WSOLA d'un simple overlap-add :
 * sans lui, les raccords tombent à des phases quelconques et le son devient
 * métallique.
 *
 * Qualité correcte entre 0,5x et 2x, ce qui couvre largement les écarts de
 * tempo usuels (un beat à 90 BPM ramené à 140 reste dans la plage).
 */

const TAILLE_TRAME = 2048;      // ~46 ms à 44,1 kHz
const RECOUVREMENT = TAILLE_TRAME / 2;
const TOLERANCE = Math.floor(TAILLE_TRAME / 4);

/** Fenêtre de Hann, pour des raccords sans clic. */
const fenetreHann = (n: number): Float32Array => {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
};

/**
 * Cherche, autour de `positionIdeale`, le décalage dont le début ressemble le
 * plus à `modele` (la continuation attendue de la trame précédente).
 */
const meilleurDecalage = (
  source: Float32Array,
  positionIdeale: number,
  modele: Float32Array | null
): number => {
  if (!modele) return 0;

  let meilleur = 0;
  let meilleurScore = -Infinity;

  for (let d = -TOLERANCE; d <= TOLERANCE; d++) {
    const debut = positionIdeale + d;
    if (debut < 0 || debut + modele.length >= source.length) continue;

    // Corrélation croisée simple : elle suffit et reste rapide.
    let score = 0;
    for (let i = 0; i < modele.length; i += 4) {
      score += source[debut + i] * modele[i];
    }
    if (score > meilleurScore) {
      meilleurScore = score;
      meilleur = d;
    }
  }
  return meilleur;
};

/** Étire un seul canal d'un facteur `facteur` (2 = deux fois plus long). */
const etirerCanal = (source: Float32Array, facteur: number): Float32Array => {
  const longueurSortie = Math.max(1, Math.round(source.length * facteur));
  const sortie = new Float32Array(longueurSortie);
  const sommeFenetres = new Float32Array(longueurSortie);
  const win = fenetreHann(TAILLE_TRAME);

  const pasSynthese = RECOUVREMENT;
  const pasAnalyse = Math.max(1, Math.round(pasSynthese / facteur));

  let posSortie = 0;
  let posEntree = 0;
  let modele: Float32Array | null = null;

  while (posSortie + TAILLE_TRAME < longueurSortie && posEntree + TAILLE_TRAME < source.length) {
    const d = meilleurDecalage(source, posEntree, modele);
    const debut = Math.max(0, Math.min(source.length - TAILLE_TRAME, posEntree + d));

    // Recollage par addition pondérée.
    for (let i = 0; i < TAILLE_TRAME; i++) {
      sortie[posSortie + i] += source[debut + i] * win[i];
      sommeFenetres[posSortie + i] += win[i];
    }

    // Ce qui devrait suivre naturellement cette trame : sert de modèle au tour
    // suivant pour choisir un raccord en phase.
    const debutModele = debut + pasSynthese;
    if (debutModele + RECOUVREMENT < source.length) {
      modele = source.subarray(debutModele, debutModele + RECOUVREMENT);
    } else {
      modele = null;
    }

    posSortie += pasSynthese;
    posEntree += pasAnalyse;
  }

  // On compense la somme des fenêtres pour garder un niveau constant.
  for (let i = 0; i < longueurSortie; i++) {
    if (sommeFenetres[i] > 1e-6) sortie[i] /= sommeFenetres[i];
  }
  return sortie;
};

/** Borne le facteur : au-dela la qualite s'effondre. */
export const bornerFacteur = (facteur: number): number =>
  Math.max(0.25, Math.min(4, facteur));

/**
 * Étire une liste de canaux bruts. Sépare le calcul de l'API Web Audio, ce qui
 * permet de l'exécuter dans un worker (aucun AudioContext n'y est disponible).
 */
export const etirerCanaux = (canaux: Float32Array[], facteur: number): Float32Array[] => {
  const f = bornerFacteur(facteur);
  return canaux.map(c => etirerCanal(c, f));
};

/**
 * Étire un AudioBuffer en préservant la hauteur.
 * @param facteur rapport de durée : 2 = deux fois plus long (donc plus lent).
 */
export const etirerBuffer = (
  ctx: BaseAudioContext,
  source: AudioBuffer,
  facteur: number
): AudioBuffer => {
  // Hors de cette plage la qualité s'effondre ; on borne plutôt que de rendre
  // un résultat inexploitable.
  const f = bornerFacteur(facteur);
  if (Math.abs(f - 1) < 0.001) return source;

  const longueurSortie = Math.max(1, Math.round(source.length * f));
  const resultat = ctx.createBuffer(source.numberOfChannels, longueurSortie, source.sampleRate);

  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const etire = etirerCanal(source.getChannelData(ch), f);
    resultat.getChannelData(ch).set(etire.subarray(0, longueurSortie));
  }
  return resultat;
};

/**
 * Facteur d'étirement pour passer d'un tempo à un autre.
 * Passer de 90 à 180 BPM demande de jouer deux fois plus vite, donc un buffer
 * deux fois plus court : facteur 0,5.
 */
export const facteurPourTempo = (bpmOrigine: number, bpmCible: number): number => {
  if (!bpmOrigine || !bpmCible || bpmOrigine <= 0 || bpmCible <= 0) return 1;
  return bpmOrigine / bpmCible;
};

/** Reconstruit un AudioBuffer a partir de canaux deja etires. */
export const bufferDepuisCanaux = (
  ctx: BaseAudioContext,
  canaux: Float32Array[],
  sampleRate: number
): AudioBuffer => {
  const longueur = canaux[0]?.length || 1;
  const buffer = ctx.createBuffer(canaux.length || 1, longueur, sampleRate);
  canaux.forEach((c, i) => buffer.getChannelData(i).set(c));
  return buffer;
};

/**
 * Étire un AudioBuffer sans bloquer le fil principal.
 * Retombe sur le calcul synchrone si les workers ne sont pas disponibles.
 */
export const etirerBufferAsync = async (
  ctx: BaseAudioContext,
  source: AudioBuffer,
  facteur: number
): Promise<AudioBuffer> => {
  const f = bornerFacteur(facteur);
  if (Math.abs(f - 1) < 0.001) return source;

  const canaux: Float32Array[] = [];
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    // Copie : le tableau est transfere au worker, on ne peut pas donner
    // directement la memoire de l'AudioBuffer.
    canaux.push(new Float32Array(source.getChannelData(ch)));
  }

  try {
    const worker = new Worker(new URL('./timeStretch.worker.ts', import.meta.url), { type: 'module' });
    const canauxEtires = await new Promise<Float32Array[]>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ canaux: Float32Array[] }>) => resolve(e.data.canaux);
      worker.onerror = reject;
      worker.postMessage({ canaux, facteur: f }, canaux.map(c => c.buffer));
    });
    worker.terminate();
    return bufferDepuisCanaux(ctx, canauxEtires, source.sampleRate);
  } catch (e) {
    console.warn('[timeStretch] Worker indisponible, calcul synchrone', e);
    return etirerBuffer(ctx, source, f);
  }
};
