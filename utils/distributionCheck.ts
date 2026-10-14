/**
 * Lot 12 BandLab · « Prêt pour Spotify / Apple / TikTok ? » : contrôle du morceau avant
 * de l'envoyer à un distributeur (DistroKid, TuneCore, CD Baby…).
 *
 * Module PUR (aucun Web Audio, aucun DOM) : il tourne dans le navigateur et sous Node
 * (tests/distributionCheck.test.ts, signaux de test : écrêté, silence, DC, hors phase…).
 *
 *  - `analyzeAudio` mesure le mix rendu en une passe : loudness intégrée (BS.1770,
 *    utils/loudness.ts), crête vraie (×4 par sinus cardinal, utils/audioMeasure.ts :
 *    l'interpolation cubique de loudness.ts lit −1,07 dBTP une crête de 0 dBTP placée entre
 *    deux échantillons), écrêtage, silences, DC, corrélation de phase ;
 *  - chaque `check…` transforme une mesure en feu vert / orange / rouge, avec une phrase
 *    simple et, quand NOVA sait le faire, une correction (`fix`) ;
 *  - les corrections audio (`applyGainDb`, `removeDc`, `applyTrim`, `gainToward`) sont
 *    linéaires et rejouables à l'identique sur l'instrumental et l'a cappella.
 *
 * Seuils et sources : constante SEUILS ci-dessous et rapport du lot 12
 * (D:\1 WORK\CONTENU\nova-bandlab\lot12_distribution\RAPPORT.md).
 */
import { integratedLufs } from './loudness';
import { truePeakOf } from './audioMeasure';
import { PLATFORM_TARGETS } from './masterAssistant';

// ---------------------------------------------------------------------------
// Plateformes et seuils
// ---------------------------------------------------------------------------

export type Level = 'ok' | 'warn' | 'error';

export interface DistPlatform {
  id: string;
  label: string;
  /** Niveau de lecture de la plateforme (LUFS intégrés). */
  lufs: number;
  /** Crête vraie maximale conseillée (dBTP). */
  ceiling: number;
  /** Ce que fait la plateforme d'un morceau plus faible que sa cible. */
  raisesQuiet: boolean;
}

/**
 * Plateformes proposées (cibles de Master Nova, utils/masterAssistant.ts, sans le « club »).
 * Spotify : −14 LUFS, −1 dBTP (−2 dBTP conseillé pour un master plus fort que −14) ; les morceaux
 * plus faibles sont remontés seulement tant que la crête reste sous −1 dB. Apple Music : Son
 * adaptatif vers −16 LUFS. YouTube et Deezer : baissent ce qui dépasse, ne montent pas.
 */
export const DIST_PLATFORMS: DistPlatform[] = PLATFORM_TARGETS.filter(t => t.id !== 'club').map(t => ({
  id: t.id, label: t.label, lufs: t.lufs, ceiling: Math.min(-1, t.ceiling), raisesQuiet: t.id === 'spotify' || t.id === 'apple',
}));
export const platformOf = (id: string): DistPlatform => DIST_PLATFORMS.find(p => p.id === id) || DIST_PLATFORMS[0];

export const SEUILS = {
  /** Écart de loudness toléré autour de la cible (LU) avant le feu orange. */
  loudnessTolerance: 2,
  /** Spotify : crête vraie conseillée pour un master plus fort que −14 LUFS. */
  spotifyLoudCeiling: -2,
  /** Silence = sous −60 dBFS. Plus de 0,5 s au début ou à la fin : orange. */
  silenceDb: -60,
  silenceMax: 0.5,
  /** Plus de 10 s de blanc à la fin : les distributeurs le refusent (« piste cachée », remplissage). */
  silenceTailError: 10,
  /** Silence gardé après une coupe (s) : un souffle avant l'attaque, la fin de la réverbe. */
  keepHead: 0.05,
  keepTail: 0.3,
  /** Composante continue : orange au-delà de −60 dBFS, rouge au-delà de −34 dBFS. */
  dcWarn: 0.001,
  dcError: 0.02,
  /** Corrélation de phase (−1 à +1) : en dessous de 0,2 orange, en dessous de 0 rouge. */
  corrWarn: 0.2,
  corrError: 0,
  /** Perte en mono (dB, somme G+D vs stéréo) : en dessous de −6 dB, des éléments disparaissent. */
  monoLossError: -6,
  /** Part des passages en opposition de phase au-delà de laquelle on prévient. */
  negWindowsWarn: 0.1,
  /** Plateaux d'écrêtage (3 échantillons ou plus collés au maximum). */
  clipRunMin: 3,
  clipRunsWarn: 10,
  /** Durée : moins de 30 s, un stream ne compte pas sur Spotify ; plus de 10 min, Apple en fait un « album ». */
  durationShort: 30,
  durationTooShort: 1,
  durationLong: 600,
  /**
   * Pochette : 3000 × 3000 px conseillé, et maximum chez TuneCore et CD Baby ; 1400 px minimum
   * (Apple, CD Baby ; TuneCore 1600, DistroKid 1000). Agrandir est refusé (Apple, Spotify).
   */
  coverIdeal: 3000,
  coverMin: 1400,
  coverMax: 3000,
  /** TuneCore : 10 Mo au plus. */
  coverMaxBytes: 10 * 1024 * 1024,
  /** TikTok (SoundOn) : single de moins de 60 s refusé (vu dans l'index du moteur de recherche). */
  durationTiktokMin: 60,
};

// ---------------------------------------------------------------------------
// Mesures
// ---------------------------------------------------------------------------

export interface AudioStats {
  sampleRate: number;
  channels: number;
  duration: number;
  lufs: number;
  truePeak: number;
  samplePeak: number;
  /** Échantillons au-delà de la pleine échelle (|x| > 1) : coupés à l'écriture du fichier. */
  overs: number;
  /** Plateaux d'écrêtage : suites d'au moins 3 échantillons collés au maximum. */
  clipRuns: number;
  /** Silence au début et à la fin (s). */
  leadSilence: number;
  tailSilence: number;
  /** Tout est sous le seuil de silence. */
  silent: boolean;
  /** Composante continue par canal (pleine échelle = 1). */
  dc: number[];
  /** Corrélation G / D sur tout le morceau (null en mono). */
  correlation: number | null;
  /** Perte de niveau en mono (dB, ≤ 0 ; null en mono). */
  monoLossDb: number | null;
  /** Part des fenêtres de 400 ms audibles en opposition de phase. */
  negWindows: number;
  /** Le fichier est déjà mono (un canal, ou G = D). */
  isMono: boolean;
}

const asBuffer = (ch: Float32Array[], sampleRate: number) => ({
  sampleRate, numberOfChannels: ch.length, length: ch[0]?.length || 0, getChannelData: (c: number) => ch[c],
}) as unknown as AudioBuffer;

export const db = (x: number) => 20 * Math.log10(Math.max(Math.abs(x), 1e-12));

/** Toutes les mesures du contrôle, en une passe par canal (plus la loudness BS.1770). */
export function analyzeAudio(ch: Float32Array[], sampleRate: number): AudioStats {
  const n = ch[0]?.length || 0;
  const nc = ch.length;
  const thr = Math.pow(10, SEUILS.silenceDb / 20);
  let first = n, last = -1, samplePeak = 0, overs = 0;
  const dc: number[] = [];
  for (const c of ch) {
    let sum = 0, pk = 0;
    for (let i = 0; i < n; i++) {
      const v = c[i];
      sum += v;
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      if (a > 1) overs++;
    }
    dc.push(n ? sum / n : 0);
    if (pk > samplePeak) samplePeak = pk;
    for (let i = 0; i < n; i++) { const a = Math.abs(c[i] - dc[dc.length - 1]); if (a > thr) { if (i < first) first = i; break; } }
    for (let i = n - 1; i >= 0; i--) { const a = Math.abs(c[i] - dc[dc.length - 1]); if (a > thr) { if (i > last) last = i; break; } }
  }
  const silent = last < 0;
  // Plateaux : au moins `clipRunMin` échantillons de suite au niveau de la crête (±0,01 dB).
  let clipRuns = 0;
  if (samplePeak >= 0.5) {
    const lim = samplePeak * 0.99885;
    for (const c of ch) {
      let run = 0;
      for (let i = 0; i < n; i++) {
        const a = c[i] < 0 ? -c[i] : c[i];
        if (a >= lim) run++;
        else { if (run >= SEUILS.clipRunMin) clipRuns++; run = 0; }
      }
      if (run >= SEUILS.clipRunMin) clipRuns++;
    }
  }
  // Phase (stéréo seulement).
  let correlation: number | null = null, monoLossDb: number | null = null, negWindows = 0, isMono = nc < 2;
  if (nc >= 2) {
    const L = ch[0], R = ch[1];
    let lr = 0, ll = 0, rr = 0, diff = 0;
    const win = Math.max(1, Math.round(0.4 * sampleRate));
    let wlr = 0, wll = 0, wrr = 0, k = 0, audible = 0, neg = 0;
    const winThr = Math.pow(10, -50 / 20) ** 2 * win;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      lr += l * r; ll += l * l; rr += r * r;
      const d = l - r; diff += d * d;
      wlr += l * r; wll += l * l; wrr += r * r;
      if (++k === win || i === n - 1) {
        if (wll > winThr && wrr > winThr) { audible++; if (wlr / Math.sqrt(wll * wrr) < 0) neg++; }
        wlr = wll = wrr = 0; k = 0;
      }
    }
    isMono = diff <= 1e-9 * Math.max(ll, 1e-12);
    if (!isMono && ll > 0 && rr > 0) {
      correlation = lr / Math.sqrt(ll * rr);
      // ((G + D) / 2)² comparé à la moyenne de G² et D² : 0 dB si G = D, −3 dB si décorrélés, −∞ si opposés.
      const mono = (ll + rr + 2 * lr) / 4, st = (ll + rr) / 2;
      monoLossDb = 10 * Math.log10(Math.max(mono, 1e-20) / st);
      negWindows = audible ? neg / audible : 0;
    }
  }
  const buf = asBuffer(ch, sampleRate);
  return {
    sampleRate, channels: nc, duration: n / sampleRate,
    lufs: silent ? -Infinity : integratedLufs(buf), truePeak: silent ? -Infinity : truePeakOf(ch, 4, 16),
    samplePeak, overs, clipRuns,
    leadSilence: silent ? n / sampleRate : first / sampleRate,
    tailSilence: silent ? n / sampleRate : (n - 1 - last) / sampleRate,
    silent, dc, correlation, monoLossDb, negWindows, isMono,
  };
}

// ---------------------------------------------------------------------------
// Feux
// ---------------------------------------------------------------------------

export type FixId =
  | 'peak' | 'loudness_up' | 'trim_start' | 'trim_end' | 'dc' | 'rate' | 'bits'
  | 'title_feat' | 'title_prod' | 'title_caps' | 'title_emoji' | 'artist_feat' | 'year'
  | 'cover_square' | 'buy_licence' | 'unlock_export' | 'retry_licence' | 'login';

export type CheckGroup = 'licence' | 'audio' | 'format' | 'infos';

export interface Check {
  id: string;
  group: CheckGroup;
  level: Level;
  /** Ce qui est contrôlé (« Volume (loudness) »). */
  label: string;
  /** Mesure courte affichée à droite (« −9,1 LUFS »). */
  value?: string;
  /** La phrase simple : ce qui se passe et pourquoi. */
  message: string;
  fix?: { id: FixId; label: string };
  /** Bloque le paquet (licence, infos obligatoires). Un problème audio ne bloque jamais. */
  blocking?: boolean;
}

/** « −9,1 » (virgule, vrai signe moins). */
export const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',').replace('-', '−') : '—');
const sec = (s: number) => `${num(s, s < 10 ? 1 : 0)} s`;

export function checkLoudness(s: AudioStats, p: DistPlatform): Check {
  const base = { id: 'loudness', group: 'audio' as const, label: 'Volume (loudness)' };
  if (s.silent || !Number.isFinite(s.lufs)) return { ...base, level: 'error', value: 'silence', message: 'Le morceau est silencieux : rien à envoyer. Vérifie que tes pistes ne sont pas coupées.' };
  const value = `${num(s.lufs)} LUFS`;
  const d = s.lufs - p.lufs;
  if (d > SEUILS.loudnessTolerance) {
    return { ...base, level: 'warn', value,
      message: `Ton morceau est à ${num(s.lufs)} LUFS : ${p.label} va le baisser de ${num(d)} dB pour le mettre au niveau des autres (${num(p.lufs, 0)} LUFS). Ce n'est pas grave, il ne sonnera pas plus fort, mais un master aussi poussé perd du punch (attaques écrasées). Si c'est voulu, garde-le ; sinon, remasterise plus doucement.` };
  }
  if (d < -SEUILS.loudnessTolerance) {
    const raise = p.raisesQuiet
      ? `${p.label} le remonte seulement si la crête le permet : il risque de paraître plus faible que les morceaux d'à côté.`
      : `${p.label} ne remonte pas les morceaux faibles : il paraîtra moins fort que les autres.`;
    return { ...base, level: 'warn', value, message: `Ton morceau est à ${num(s.lufs)} LUFS, sous le niveau de ${p.label} (${num(p.lufs, 0)} LUFS). ${raise}`,
      fix: { id: 'loudness_up', label: `Monter vers ${num(p.lufs, 0)} LUFS` } };
  }
  return { ...base, level: 'ok', value, message: `Bon niveau pour ${p.label} (${num(p.lufs, 0)} LUFS) : il sera joué presque tel quel.` };
}

/** Crête vraie visée pour cette plateforme et ce niveau (Spotify : −2 dBTP si plus fort que −14 LUFS). */
export const ceilingFor = (s: Pick<AudioStats, 'lufs'>, p: DistPlatform) =>
  p.id === 'spotify' && Number.isFinite(s.lufs) && s.lufs > p.lufs ? SEUILS.spotifyLoudCeiling : p.ceiling;

export function checkTruePeak(s: AudioStats, p: DistPlatform): Check {
  const base = { id: 'truepeak', group: 'audio' as const, label: 'Crête vraie (true peak)' };
  if (s.silent) return { ...base, level: 'ok', value: '—', message: 'Aucune crête (silence).' };
  const c = ceilingFor(s, p);
  const value = `${num(s.truePeak)} dBTP`;
  if (s.truePeak <= c + 0.1) return { ...base, level: 'ok', value, message: `Sous ${num(c, 0)} dBTP : pas de saturation à la conversion en MP3 / AAC des plateformes.` };
  const fix = { id: 'peak' as const, label: `Baisser de ${num(s.truePeak - c)} dB` };
  if (s.truePeak > 0) {
    return { ...base, level: 'error', value, fix,
      message: `Ta crête dépasse 0 dB (${num(s.truePeak)} dBTP) : entre les échantillons, le son sature. Après la conversion en MP3 / AAC des plateformes, ça s'entend (craquements). Vise ${num(c, 0)} dBTP.` };
  }
  return { ...base, level: 'warn', value, fix,
    message: p.id === 'spotify' && c === SEUILS.spotifyLoudCeiling
      ? `Pour un master plus fort que −14 LUFS, Spotify conseille une crête à −2 dBTP au plus (ici ${num(s.truePeak)}) : sa conversion peut légèrement saturer.`
      : `Crête à ${num(s.truePeak)} dBTP : ${p.label} conseille ${num(c, 0)} dBTP au plus, pour que la conversion en MP3 / AAC ne sature pas.` };
}

export function checkClipping(s: AudioStats): Check {
  const base = { id: 'clipping', group: 'audio' as const, label: 'Écrêtage numérique' };
  if (s.overs > 0) {
    return { ...base, level: 'error', value: `${s.overs} éch.`, fix: { id: 'peak', label: 'Baisser sous 0 dB' },
      message: `${s.overs} échantillon${s.overs > 1 ? 's' : ''} dépasse${s.overs > 1 ? 'nt' : ''} 0 dB : dans le fichier WAV, ils seront coupés net (son qui grésille). Baisse le volume : rien ne sera perdu, ton mix est calculé en virgule flottante.` };
  }
  if (s.clipRuns >= SEUILS.clipRunsWarn) {
    return { ...base, level: 'warn', value: `${s.clipRuns} plateaux`,
      message: `Le son touche son maximum à plat ${s.clipRuns} fois (clipper ou saturation dans le mix). Ce n'est pas réparable ici : baisse le gain du limiteur ou du clipper du master, puis revérifie.` };
  }
  return { ...base, level: 'ok', value: s.clipRuns ? `${s.clipRuns} plateau${s.clipRuns > 1 ? 'x' : ''}` : 'aucun', message: 'Aucun échantillon coupé.' };
}

export function checkSilenceStart(s: AudioStats): Check {
  const base = { id: 'silence_start', group: 'audio' as const, label: 'Silence au début' };
  if (s.silent) return { ...base, level: 'error', value: '—', message: 'Tout le morceau est silencieux.' };
  if (s.leadSilence <= SEUILS.silenceMax) return { ...base, level: 'ok', value: sec(s.leadSilence), message: 'Le son démarre tout de suite.' };
  return { ...base, level: 'warn', value: sec(s.leadSilence), fix: { id: 'trim_start', label: 'Couper le blanc du début' },
    message: `${sec(s.leadSilence)} de blanc avant le premier son : sur Spotify ou en playlist, on croit que le morceau ne marche pas. Conseillé : 0,5 s au plus.` };
}

export function checkSilenceEnd(s: AudioStats): Check {
  const base = { id: 'silence_end', group: 'audio' as const, label: 'Silence à la fin' };
  if (s.silent) return { ...base, level: 'error', value: '—', message: 'Tout le morceau est silencieux.' };
  if (s.tailSilence <= SEUILS.silenceMax) return { ...base, level: 'ok', value: sec(s.tailSilence), message: 'Le morceau se termine sans blanc inutile.' };
  const fix = { id: 'trim_end' as const, label: 'Couper le blanc de la fin' };
  if (s.tailSilence > SEUILS.silenceTailError) {
    return { ...base, level: 'error', value: sec(s.tailSilence), fix,
      message: `${sec(s.tailSilence)} de blanc à la fin : une piste cachée doit être signalée (Apple) et les silences de remplissage sont refusés (CD Baby / Downtown). Coupe-le.` };
  }
  return { ...base, level: 'warn', value: sec(s.tailSilence), fix,
    message: `${sec(s.tailSilence)} de blanc après la dernière note : en lecture enchaînée, ça fait un trou. Conseillé : 0,5 s au plus (la fin de la réverbe est gardée).` };
}

export function checkDc(s: AudioStats): Check {
  const base = { id: 'dc', group: 'audio' as const, label: 'Décalage continu (DC offset)' };
  const worst = s.dc.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const value = worst > 0 ? `${num(db(worst), 0)} dBFS` : 'aucun';
  if (worst <= SEUILS.dcWarn) return { ...base, level: 'ok', value, message: 'Ton son est bien centré sur zéro.' };
  const fix = { id: 'dc' as const, label: 'Recentrer sur zéro' };
  return { ...base, level: worst > SEUILS.dcError ? 'error' : 'warn', value, fix,
    message: `Ton son est décalé au-dessus ou en dessous de zéro (${value}) : il perd de la marge avant saturation et peut faire un « clic » au début et à la fin. Souvent un micro ou une carte son. La correction ne change pas le son.` };
}

export function checkMono(s: AudioStats): Check {
  const base = { id: 'mono', group: 'audio' as const, label: 'Compatibilité mono' };
  if (s.silent) return { ...base, level: 'ok', value: '—', message: 'Rien à mesurer (silence).' };
  if (s.isMono || s.correlation === null) return { ...base, level: 'ok', value: 'mono', message: 'Ton morceau est en mono : il sonne pareil partout. Il est livré en deux canaux identiques (Apple refuse les fichiers à un seul canal).' };
  const value = `corrélation ${num(s.correlation, 2)}`;
  const loss = s.monoLossDb ?? 0;
  if (s.correlation < SEUILS.corrError || loss < SEUILS.monoLossError) {
    return { ...base, level: 'error', value,
      message: `Ta gauche et ta droite sont en opposition de phase : sur une enceinte Bluetooth, un téléphone ou en club (mono), des éléments disparaissent (−${num(-loss)} dB en mono). Cherche un effet d'élargissement stéréo ou une piste à la polarité inversée (Ø).` };
  }
  if (s.correlation < SEUILS.corrWarn || s.negWindows > SEUILS.negWindowsWarn) {
    return { ...base, level: 'warn', value,
      message: s.negWindows > SEUILS.negWindowsWarn
        ? `${num(s.negWindows * 100, 0)} % du morceau est en opposition de phase : sur un téléphone ou une enceinte mono, ces passages s'affaiblissent. Écoute en mono (bouton Mono de la console) pour repérer la piste.`
        : `Stéréo très large : en mono (téléphone, enceinte Bluetooth), le morceau perd ${num(-loss)} dB et certains sons s'affaiblissent. Écoute-le en mono pour vérifier.` };
  }
  return { ...base, level: 'ok', value, message: 'Il sonne bien aussi en mono (téléphone, enceinte Bluetooth).' };
}

export interface FormatSpec { sampleRate: number; bits: number; channels: number; projectRate?: number }

export function checkFormat(f: FormatSpec): Check {
  const base = { id: 'format', group: 'format' as const, label: 'Format du fichier' };
  const khz = `${num(f.sampleRate / 1000, f.sampleRate % 1000 ? 1 : 0)} kHz`;
  const value = `WAV ${f.bits} bits · ${khz}`;
  if (f.bits !== 16 && f.bits !== 24) {
    return { ...base, level: 'warn', value, fix: { id: 'bits', label: 'Passer en 24 bits' },
      message: `Les distributeurs demandent un WAV 16 ou 24 bits ; ${f.bits} bits flottant est souvent refusé.` };
  }
  if (f.sampleRate !== 44100 && f.sampleRate !== 48000) {
    return { ...base, level: 'warn', value, fix: { id: 'rate', label: 'Passer en 44,1 kHz' },
      message: `${khz} : Apple Music, Spotify et DistroKid l'acceptent (Hi-Res), mais CD Baby demande 44,1 kHz. 44,1 ou 48 kHz passent partout.` };
  }
  const conv = f.projectRate && f.projectRate !== f.sampleRate ? ` (converti depuis ${num(f.projectRate / 1000, f.projectRate % 1000 ? 1 : 0)} kHz, qualité studio)` : '';
  const b = f.bits === 24
    ? ' Le 24 bits est ce que préfèrent Spotify et TuneCore (CD Baby le convertit en 16 bits).'
    : ' Le 16 bits est demandé par CD Baby ; Spotify et TuneCore préfèrent le 24 bits.';
  return { ...base, level: 'ok', value, message: `WAV PCM ${f.bits} bits, ${khz}, stéréo : accepté par DistroKid, TuneCore, CD Baby, Spotify et Apple${conv}.${b}` };
}

export function checkDuration(s: AudioStats, p: DistPlatform): Check {
  const base = { id: 'duration', group: 'format' as const, label: 'Durée' };
  const m = Math.floor(s.duration / 60), r = Math.round(s.duration % 60);
  const value = `${m} min ${String(r).padStart(2, '0')}`;
  if (s.duration < SEUILS.durationTooShort) return { ...base, level: 'error', value, message: 'Moins d\'une seconde : il n\'y a pas de morceau à envoyer.' };
  if (s.duration < SEUILS.durationShort) {
    return { ...base, level: 'warn', value, message: `Moins de 30 s : sur Spotify, une écoute ne compte (et ne paie) qu'après 30 s. Certains distributeurs refusent aussi les pistes très courtes.` };
  }
  if (p.id === 'tiktok' && s.duration < SEUILS.durationTiktokMin) {
    return { ...base, level: 'warn', value, message: 'Moins d\'une minute : SoundOn (le distributeur de TikTok) refuse les singles de moins de 60 s et les simples extraits.' };
  }
  if (s.duration >= SEUILS.durationLong) {
    return { ...base, level: 'warn', value, message: 'Plus de 10 min : sur Apple Music (iTunes), une piste de 10 min ou plus ne se vend plus à l\'unité (« album seulement »). Elle reste en streaming.' };
  }
  const tiktok = p.id === 'tiktok' ? ' TikTok en prendra un extrait : tu choisiras le passage (souvent le refrain) au moment de la mise en ligne.' : '';
  return { ...base, level: 'ok', value, message: `Durée normale pour un single.${tiktok}` };
}

// ---------------------------------------------------------------------------
// Métadonnées
// ---------------------------------------------------------------------------

export interface DistMeta {
  title: string;
  artist: string;
  /** Artistes invités (« feat. »), séparés par des virgules. */
  featuring: string;
  /** Auteurs-compositeurs : noms légaux complets, séparés par des virgules. */
  composers: string;
  producers: string;
  year: string;
  isrc: string;
  /** null : pas encore répondu (obligatoire). */
  explicit: boolean | null;
}

/** ISRC : 2 lettres pays, 3 caractères, 2 chiffres d'année, 5 chiffres (tirets et espaces tolérés). */
export const normalizeIsrc = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isValidIsrc = (s: string): boolean => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalizeIsrc(s));

const FEAT_RX = /\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^)\]]+?)\s*[)\]]?\s*$/i;
const PROD_RX = /\s*[([]?\s*\b(?:prod\.?|produced)\s*(?:by|par)?\s+([^)\]]+?)\s*[)\]]?\s*$/i;
const EMOJI_RX = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;
const EMOJI_ALL = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const PROMO_RX = /\b(explicit|clean|official( audio| video)?|audio officiel|clip officiel|lyrics?|free download|out now|link in bio|type beat|\d{2,3} ?bpm)\b|https?:|www\./i;

/** Titre tout en majuscules (au moins 4 lettres) ? */
export const isAllCaps = (s: string) => { const letters = s.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, ''); return letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase(); };
/** « MON TITRE » → « Mon titre » (casse de phrase, comme en français). */
export const sentenceCase = (s: string) => { const l = s.toLocaleLowerCase('fr'); return l.charAt(0).toLocaleUpperCase('fr') + l.slice(1); };
export const stripEmoji = (s: string) => s.replace(EMOJI_ALL, '').replace(/\s{2,}/g, ' ').trim();

/** Sort « feat. X » (ou « prod. X ») du titre : [titre propre, noms]. */
export function splitTitle(title: string, kind: 'feat' | 'prod'): [string, string] {
  const m = title.match(kind === 'feat' ? FEAT_RX : PROD_RX);
  if (!m) return [title, ''];
  return [title.slice(0, m.index).trim(), m[1].trim()];
}

/** Noms d'une liste « A, B & C » (virgules, « & », « et », « / »). */
export const splitNames = (s: string) => s.split(/\s*(?:,|;|&|\/|\bet\b|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);

export function checkMetadata(m: DistMeta, now = new Date()): Check[] {
  const out: Check[] = [];
  const t = m.title.trim();
  const tBase = { id: 'title', group: 'infos' as const, label: 'Titre' };
  if (!t) out.push({ ...tBase, level: 'error', blocking: true, message: 'Donne un titre à ton morceau : c\'est ce qui s\'affichera sur Spotify et Apple Music.' });
  else if (splitTitle(t, 'feat')[1]) out.push({ ...tBase, level: 'warn', value: t, fix: { id: 'title_feat', label: 'Mettre l\'invité dans « Invités »' }, message: 'Le « feat. » ne s\'écrit pas à la main dans le titre : Spotify l\'interdit, et chaque distributeur a un champ « artiste invité » (Apple et DistroKid l\'ajoutent eux-mêmes au titre).' });
  else if (splitTitle(t, 'prod')[1]) out.push({ ...tBase, level: 'warn', value: t, fix: { id: 'title_prod', label: 'Mettre le beatmaker dans « Producteurs »' }, message: 'Le « prod. by » ne va pas dans le titre : le producteur se déclare dans les crédits.' });
  else if (EMOJI_RX.test(t)) out.push({ ...tBase, level: 'warn', value: t, fix: { id: 'title_emoji', label: 'Retirer les emojis' }, message: 'Les emojis sont refusés dans les titres par Apple Music et la plupart des distributeurs.' });
  else if (isAllCaps(t)) out.push({ ...tBase, level: 'warn', value: t, fix: { id: 'title_caps', label: 'Écrire en minuscules' }, message: 'Un titre tout en MAJUSCULES est refusé par Apple Music (sauf sigle). Écris-le normalement.' });
  else if (PROMO_RX.test(t)) out.push({ ...tBase, level: 'warn', value: t, message: 'Pas de « Official », « (Explicit) », « Type Beat », BPM ni lien dans le titre (Apple, Spotify, DistroKid) : la version explicite se déclare avec la case « Paroles explicites ».' });
  else out.push({ ...tBase, level: 'ok', value: t, message: 'Titre propre, sans « feat. » ni mention promotionnelle.' });

  const a = m.artist.trim();
  const aBase = { id: 'artist', group: 'infos' as const, label: 'Artiste' };
  if (!a) out.push({ ...aBase, level: 'error', blocking: true, message: 'Ton nom d\'artiste est obligatoire : c\'est lui qui relie le morceau à ta page Spotify.' });
  else if (/\b(feat\.?|ft\.?|featuring)\s/i.test(a)) out.push({ ...aBase, level: 'warn', value: a, fix: { id: 'artist_feat', label: 'Mettre l\'invité dans « Invités »' }, message: 'Un seul artiste principal ici : l\'invité va dans « Invités », sinon Spotify crée une fausse page d\'artiste.' });
  else out.push({ ...aBase, level: 'ok', value: a, message: 'Artiste principal renseigné.' });

  const isrc = m.isrc.trim();
  const iBase = { id: 'isrc', group: 'infos' as const, label: 'ISRC (facultatif)' };
  if (!isrc) out.push({ ...iBase, level: 'ok', value: 'aucun', message: 'Pas d\'ISRC : ton distributeur t\'en donne un gratuitement à l\'envoi. Mets-le ici seulement si le morceau en a déjà un (réédition).' });
  else if (!isValidIsrc(isrc)) out.push({ ...iBase, level: 'error', blocking: true, value: isrc, message: 'ISRC invalide : 12 caractères, par exemple FR-Z03-26-00001 (pays, code, année, numéro). Laisse vide si tu n\'en as pas.' });
  else out.push({ ...iBase, level: 'ok', value: normalizeIsrc(isrc), message: 'ISRC au bon format.' });

  const y = m.year.trim();
  const yNum = Number(y);
  const yBase = { id: 'year', group: 'infos' as const, label: 'Année' };
  const maxYear = now.getFullYear() + 1;
  if (!/^\d{4}$/.test(y) || yNum < 1900 || yNum > maxYear) out.push({ ...yBase, level: 'error', blocking: true, value: y || '—', fix: { id: 'year', label: `Mettre ${now.getFullYear()}` }, message: `L'année de sortie (4 chiffres, ${maxYear} au plus) sert au copyright (© et ℗).` });
  else out.push({ ...yBase, level: 'ok', value: y, message: `© et ℗ ${y}.` });

  const names = splitNames(m.composers);
  const cBase = { id: 'composers', group: 'infos' as const, label: 'Auteurs-compositeurs' };
  if (!names.length) out.push({ ...cBase, level: 'warn', message: 'Indique qui a écrit et composé le morceau, avec les vrais noms (prénom et nom) : Spotify et Apple Music les affichent, et la SACEM / la SABAM s\'en servent pour te payer.' });
  else if (names.some(n => n.split(/\s+/).length < 2)) out.push({ ...cBase, level: 'warn', value: names.join(', '), message: `Prénom ET nom légal pour chacun (pas un pseudo) : ${names.filter(n => n.split(/\s+/).length < 2).join(', ')}. Les distributeurs refusent les noms incomplets.` });
  else out.push({ ...cBase, level: 'ok', value: names.join(', '), message: 'Noms complets renseignés.' });

  const eBase = { id: 'explicit', group: 'infos' as const, label: 'Paroles explicites' };
  if (m.explicit === null) out.push({ ...eBase, level: 'error', blocking: true, message: 'Dis si les paroles sont explicites (gros mots, violence, drogue) : c\'est obligatoire chez tous les distributeurs. Mentir peut faire retirer le morceau.' });
  else out.push({ ...eBase, level: 'ok', value: m.explicit ? 'oui (E)' : 'non', message: m.explicit ? 'Le morceau portera le badge « E ».' : 'Morceau tous publics.' });
  return out;
}

// ---------------------------------------------------------------------------
// Pochette
// ---------------------------------------------------------------------------

export interface CoverInfo { width: number; height: number; mime: string; bytes: number }

export function checkCover(c: CoverInfo | null): Check {
  const base = { id: 'cover', group: 'format' as const, label: 'Pochette' };
  if (!c) return { ...base, level: 'warn', value: 'aucune', message: 'Pas de pochette dans le paquet : ton distributeur t\'en demandera une (carrée, 3000 × 3000 px, JPG ou PNG, sans texte promotionnel ni logo de plateforme).' };
  const value = `${c.width} × ${c.height} px`;
  if (!/^image\/(jpeg|png)$/.test(c.mime)) return { ...base, level: 'error', value, message: 'JPG ou PNG seulement.' };
  if (c.width !== c.height) {
    return { ...base, level: 'error', value, fix: { id: 'cover_square', label: 'Recadrer en carré' },
      message: 'La pochette doit être parfaitement carrée. NOVA peut la recadrer au centre (3000 × 3000 px au plus, jamais agrandie).' };
  }
  if (c.width < SEUILS.coverMin) {
    return { ...base, level: 'error', value,
      message: `Trop petite (${c.width} px) : Apple Music et CD Baby refusent en dessous de ${SEUILS.coverMin} px, et 3000 px est conseillé. NOVA ne l'agrandit pas : une image agrandie est refusée (floue). Repars de l'image d'origine.` };
  }
  if (c.width < SEUILS.coverIdeal) {
    return { ...base, level: 'warn', value,
      message: `${c.width} px : accepté par Apple et DistroKid, mais 3000 × 3000 px est conseillé partout (TuneCore demande 1600 px au moins). Si tu as l'image d'origine en plus grand, prends-la.` };
  }
  if (c.width > SEUILS.coverMax) {
    return { ...base, level: 'warn', value, fix: { id: 'cover_square', label: 'Réduire à 3000 × 3000' },
      message: `${c.width} px : TuneCore et CD Baby refusent au-delà de 3000 px. NOVA peut la réduire sans perte visible.` };
  }
  if (c.bytes > SEUILS.coverMaxBytes) {
    return { ...base, level: 'warn', value, fix: { id: 'cover_square', label: 'Réenregistrer en JPEG' },
      message: `Fichier lourd (${num(c.bytes / 1024 / 1024, 1)} Mo) : TuneCore refuse au-delà de 10 Mo.` };
  }
  return { ...base, level: 'ok', value, message: 'Carrée, 3000 × 3000 px : parfait. Vérifie le contenu : aucun texte sauf ton nom et le titre (identiques aux infos), pas d\'URL, de QR code, de prix ni de logo de plateforme ou de réseau social, en couleurs RVB.' };
}

// ---------------------------------------------------------------------------
// Licence (même décision que l'export : services/Billing.ts exportAccess)
// ---------------------------------------------------------------------------

export interface LicenceInput {
  admin: boolean;
  /** Réponse du serveur (null : vérification en cours). */
  access: { unlocked: boolean; via: string | null; reason: string | null; missing: { id: string; title: string | null }[]; login_required: boolean; message?: string; items?: { title: string | null; owned: boolean }[] } | null;
  /** Le projet contient-il une instru / mélodie du catalogue ? */
  hasCatalog: boolean;
}

export function checkLicence(l: LicenceInput): Check {
  const base = { id: 'licence', group: 'licence' as const, label: 'Licence de l\'instru' };
  if (l.admin) return { ...base, level: 'ok', value: 'admin', message: 'Compte admin du studio : export libre.' };
  const a = l.access;
  if (!a) return { ...base, level: 'warn', blocking: true, value: '…', message: 'Vérification de ta licence et de l\'export de ce projet…' };
  if (a.login_required) return { ...base, level: 'error', blocking: true, fix: { id: 'login', label: 'Se connecter' }, message: 'Connecte-toi : la licence de l\'instru est rattachée à ton compte.' };
  if (a.reason === 'catalogue_non_achete') {
    const names = a.missing.map(m => m.title).filter(Boolean);
    return { ...base, level: 'error', blocking: true, value: 'non achetée', fix: { id: 'buy_licence', label: 'Acheter la licence' },
      message: `${names.length ? `« ${names.join(' », « ')} » n'est pas encore achetée` : 'L\'instru ou la mélodie du catalogue n\'est pas encore achetée'} : on ne distribue pas un morceau sans la licence de son instru (Spotify, Apple et YouTube Content ID le détectent, le morceau est retiré). Achète la licence, puis reviens ici.` };
  }
  if (a.reason === 'erreur') return { ...base, level: 'warn', blocking: true, fix: { id: 'retry_licence', label: 'Réessayer' }, message: a.message || 'Vérification impossible (connexion ?). Réessaie dans un instant.' };
  if (!a.unlocked) {
    return { ...base, level: 'error', blocking: true, value: 'export à débloquer', fix: { id: 'unlock_export', label: 'Débloquer l\'export' },
      message: 'L\'export de ce projet n\'est pas encore débloqué : le paquet Livraison contient ton morceau en WAV, il suit les mêmes règles que l\'export.' };
  }
  const via = a.via === 'licence' ? 'Licence de l\'instru achetée : tu peux distribuer ce morceau. Garde ton contrat (CD Baby peut le demander) et n\'inscris pas le morceau à YouTube Content ID : avec une licence non exclusive, c\'est refusé.'
    : !l.hasCatalog ? 'Pas d\'instru du catalogue dans ce projet : assure-toi d\'avoir les droits sur tous les sons (samples, instru d\'un autre beatmaker).'
    : a.via === 'pro' ? 'Export débloqué (Nova Pro) et licence de l\'instru reconnue.'
    : 'Export débloqué pour ce projet.';
  return { ...base, level: 'ok', value: a.via === 'licence' ? 'achetée' : 'ok', message: via };
}

// ---------------------------------------------------------------------------
// Ensemble
// ---------------------------------------------------------------------------

export interface DistInput {
  stats: AudioStats | null;
  platform: DistPlatform;
  format: FormatSpec;
  meta: DistMeta;
  cover: CoverInfo | null;
  licence: LicenceInput;
  now?: Date;
}

/** Tous les feux, dans l'ordre de l'écran : licence, son, format, infos. */
export function runChecks(i: DistInput): Check[] {
  const out: Check[] = [checkLicence(i.licence)];
  if (i.stats) {
    out.push(checkLoudness(i.stats, i.platform), checkTruePeak(i.stats, i.platform), checkClipping(i.stats),
      checkSilenceStart(i.stats), checkSilenceEnd(i.stats), checkDc(i.stats), checkMono(i.stats));
  }
  out.push(checkFormat(i.format));
  if (i.stats) out.push(checkDuration(i.stats, i.platform));
  out.push(checkCover(i.cover), ...checkMetadata(i.meta, i.now));
  return out;
}

export interface DistSummary { ok: number; warn: number; error: number; blocking: Check[]; ready: boolean }
export function summarize(checks: Check[]): DistSummary {
  const blocking = checks.filter(c => c.blocking && c.level !== 'ok');
  return {
    ok: checks.filter(c => c.level === 'ok').length,
    warn: checks.filter(c => c.level === 'warn').length,
    error: checks.filter(c => c.level === 'error').length,
    blocking, ready: !blocking.length,
  };
}

// ---------------------------------------------------------------------------
// Corrections audio (linéaires : rejouables sur l'instrumental et l'a cappella)
// ---------------------------------------------------------------------------

export function applyGainDb(ch: Float32Array[], gainDb: number): void {
  if (!gainDb) return;
  const g = Math.pow(10, gainDb / 20);
  for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= g;
}

/** Retire la composante continue de chaque canal. Renvoie les valeurs retirées. */
export function removeDc(ch: Float32Array[]): number[] {
  return ch.map(c => {
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i];
    const m = c.length ? s / c.length : 0;
    for (let i = 0; i < c.length; i++) c[i] -= m;
    return m;
  });
}

export interface Trim { start: number; end: number }

/**
 * Où couper le blanc : on garde `keepHead` s avant le premier son et `keepTail` s après
 * le dernier (fin de réverbe). Indices en échantillons ([start, end[).
 */
export function trimPoints(stats: AudioStats, sampleRate: number, length: number, which: { start: boolean; end: boolean }): Trim {
  let start = 0, end = length;
  if (which.start && stats.leadSilence > SEUILS.silenceMax) start = Math.max(0, Math.floor((stats.leadSilence - SEUILS.keepHead) * sampleRate));
  if (which.end && stats.tailSilence > SEUILS.silenceMax) end = Math.min(length, Math.ceil(length - (stats.tailSilence - SEUILS.keepTail) * sampleRate));
  return { start, end: Math.max(start + 1, end) };
}

/** Coupe [start, end[ avec un fondu de 5 ms aux bords coupés (pas de clic). */
export function applyTrim(ch: Float32Array[], t: Trim, sampleRate: number): Float32Array[] {
  const fade = Math.max(1, Math.round(0.005 * sampleRate));
  const n0 = ch[0]?.length || 0;
  return ch.map(c => {
    const o = c.slice(t.start, t.end);
    if (t.start > 0) for (let i = 0; i < Math.min(fade, o.length); i++) o[i] *= i / fade;
    if (t.end < n0) for (let i = 0; i < Math.min(fade, o.length); i++) o[o.length - 1 - i] *= i / fade;
    return o;
  });
}

/**
 * Gain pour viser `targetLufs` sans dépasser `ceilingDbtp` (aucun limiteur : le gain est
 * plafonné par la crête, et on le dit).
 */
export function gainToward(stats: Pick<AudioStats, 'lufs' | 'truePeak'>, targetLufs: number, ceilingDbtp: number): { gainDb: number; limitedByPeak: boolean } {
  if (!Number.isFinite(stats.lufs)) return { gainDb: 0, limitedByPeak: false };
  let g = targetLufs - stats.lufs;
  let limited = false;
  if (stats.truePeak + g > ceilingDbtp) { g = ceilingDbtp - stats.truePeak; limited = true; }
  return { gainDb: g, limitedByPeak: limited };
}

/** Gain qui ramène la crête vraie (et les dépassements) sous le plafond ; jamais positif. */
export function gainForPeak(stats: Pick<AudioStats, 'truePeak' | 'samplePeak'>, ceilingDbtp: number): number {
  const tp = Math.max(stats.truePeak, db(stats.samplePeak));
  return tp > ceilingDbtp ? ceilingDbtp - 0.05 - tp : 0;
}

/** Copie profonde de canaux (pour « Annuler les corrections »). */
export const cloneChannels = (ch: Float32Array[]) => ch.map(c => new Float32Array(c));
