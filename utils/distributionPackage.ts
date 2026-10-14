/**
 * Lot 12 BandLab · paquet .zip « Livraison » : ce qu'on envoie à un distributeur ou à un
 * label, rangé et nommé proprement.
 *
 *   Artiste - Titre (Livraison)/
 *     Artiste - Titre (Master WAV 24 bits).wav
 *     Artiste - Titre (Master MP3 320).mp3
 *     Artiste - Titre (Instrumental).wav      si les pistes le permettent
 *     Artiste - Titre (A cappella).wav        si les pistes le permettent
 *     Pochette 3000x3000.jpg                  si elle est fournie
 *     Paroles.txt / Paroles synchronisées.lrc si NOVA a les paroles (utils/voiceLyrics.ts)
 *     Crédits et métadonnées.txt / metadonnees.json
 *
 * Module pur (JSZip, aucun DOM) : tests/distributionPackage.test.ts rouvre le paquet.
 * Le DROIT de produire ce paquet n'est pas décidé ici : la fenêtre ne l'appelle que si
 * l'export du mix est débloqué par le serveur (même règle que l'export, services/Billing.ts).
 */
import JSZip from 'jszip';
import { isHeaderLine } from './voiceLyrics';
import type { Check, DistMeta, AudioStats, DistPlatform } from './distributionCheck';
import { normalizeIsrc, isValidIsrc, splitNames, num } from './distributionCheck';

// ---------------------------------------------------------------------------
// Pochette : dimensions lues dans l'en-tête (PNG IHDR, JPEG SOFn)
// ---------------------------------------------------------------------------

export function imageInfo(b: Uint8Array): { width: number; height: number; mime: 'image/png' | 'image/jpeg' } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), mime: 'image/png' };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0..SOF15 sauf DHT (C4), JPG (C8), DAC (CC).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], mime: 'image/jpeg' };
      }
      if (m === 0xda) break; // début des données : pas de SOF trouvé
      i += 2 + len;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paroles
// ---------------------------------------------------------------------------

/** Paroles en texte simple pour les distributeurs : sans « [Refrain] », une ligne vide entre les parties. */
export function lyricsText(text: string): string {
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(l => !isHeaderLine(l));
  const out: string[] = [];
  for (const l of lines) {
    if (!l && (!out.length || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\r\n');
}

const lrcTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

/**
 * Paroles synchronisées (.lrc) : une ligne par vers, au temps du premier mot chanté.
 * `times[i]` : temps de la ligne i de `text` dans la timeline (null : inconnu, ligne
 * ignorée). `offset` : début du fichier dans la timeline (blanc coupé au début, plage).
 * null s'il n'y a aucune ligne calée.
 */
export function lyricsLrc(text: string, times: (number | null)[], o: { title?: string; artist?: string; offset?: number; duration?: number } = {}): string | null {
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
  const off = o.offset || 0;
  const body: string[] = [];
  let last = -Infinity;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    const t = times[i];
    if (!l || isHeaderLine(l) || t === null || t === undefined || !Number.isFinite(t)) return;
    const at = Math.max(0, t - off);
    if (o.duration && at > o.duration) return;
    // Jamais en arrière (un lecteur LRC lit dans l'ordre).
    const tt = Math.max(at, last);
    last = tt;
    body.push(`[${lrcTime(tt)}]${l}`);
  });
  if (!body.length) return null;
  const head = [
    o.title ? `[ti:${o.title}]` : '', o.artist ? `[ar:${o.artist}]` : '',
    o.duration ? `[length:${lrcTime(o.duration).slice(0, 5)}]` : '', '[re:NOVA Studio]',
  ].filter(Boolean);
  return [...head, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// Noms des fichiers
// ---------------------------------------------------------------------------

/**
 * Nom de fichier accepté partout : CD Baby n'accepte que lettres, chiffres, « - » et « _ » ;
 * DistroKid refuse \ / : * ? " ' < > |. Accents retirés, espaces → « _ ».
 */
export const safeFileName = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'Morceau';

export function deliveryNames(meta: Pick<DistMeta, 'title' | 'artist'>) {
  const base = safeFileName(`${meta.artist.trim() || 'Artiste'}-${meta.title.trim() || 'Titre'}`).slice(0, 100);
  return {
    folder: `${base}_Livraison`,
    zip: `${base}_Livraison.zip`,
    wav: `${base}_Master_WAV24.wav`,
    wav16: `${base}_Master_WAV16.wav`,
    mp3: `${base}_Master_MP3_320.mp3`,
    instru: `${base}_Instrumental.wav`,
    acapella: `${base}_A_cappella.wav`,
    cover: (mime: string) => `Pochette_3000x3000.${mime === 'image/png' ? 'png' : 'jpg'}`,
    lyricsTxt: 'Paroles.txt',
    lyricsLrc: 'Paroles_synchronisees.lrc',
    creditsTxt: 'Credits_et_metadonnees.txt',
    creditsJson: 'metadonnees.json',
  };
}

// ---------------------------------------------------------------------------
// Fiche des crédits et des métadonnées
// ---------------------------------------------------------------------------

export interface CreditsInput {
  meta: DistMeta;
  platform: DistPlatform;
  stats: AudioStats;
  sampleRate: number;
  bits: number;
  bpm?: number;
  key?: string;
  /** Instrus / mélodies du catalogue (titre, licence achetée ?). */
  catalog: { title: string | null; owned: boolean }[];
  checks: Check[];
  /** Corrections appliquées (« Crête baissée de 1,2 dB »). */
  fixes: string[];
  files: string[];
  date?: Date;
}

export function creditsJson(c: CreditsInput): Record<string, unknown> {
  const isrc = c.meta.isrc.trim() && isValidIsrc(c.meta.isrc) ? normalizeIsrc(c.meta.isrc) : null;
  return {
    format: 'nova-livraison/1',
    titre: c.meta.title.trim(),
    artiste: c.meta.artist.trim(),
    invites: splitNames(c.meta.featuring),
    auteurs_compositeurs: splitNames(c.meta.composers),
    producteurs: splitNames(c.meta.producers),
    annee: c.meta.year.trim(),
    copyright: `© ${c.meta.year.trim()} ${c.meta.artist.trim()}`,
    phonogramme: `℗ ${c.meta.year.trim()} ${c.meta.artist.trim()}`,
    isrc,
    explicite: c.meta.explicit,
    tempo_bpm: c.bpm ?? null,
    tonalite: c.key || null,
    duree_secondes: Math.round(c.stats.duration * 1000) / 1000,
    audio: {
      frequence_hz: c.sampleRate, bits: c.bits, canaux: c.stats.channels,
      loudness_lufs: Number.isFinite(c.stats.lufs) ? Math.round(c.stats.lufs * 10) / 10 : null,
      crete_vraie_dbtp: Number.isFinite(c.stats.truePeak) ? Math.round(c.stats.truePeak * 10) / 10 : null,
      correlation_phase: c.stats.correlation === null ? null : Math.round(c.stats.correlation * 100) / 100,
    },
    plateforme_controlee: c.platform.label,
    instrus_catalogue: c.catalog.map(x => ({ titre: x.title, licence_achetee: x.owned })),
    controles: c.checks.map(x => ({ id: x.id, feu: x.level === 'ok' ? 'vert' : x.level === 'warn' ? 'orange' : 'rouge', mesure: x.value ?? null, message: x.message })),
    corrections: c.fixes,
    fichiers: c.files,
    cree_le: (c.date || new Date()).toISOString(),
    logiciel: 'NOVA Studio',
  };
}

export function creditsText(c: CreditsInput): string {
  const j = creditsJson(c) as any;
  const feu = (l: string) => (l === 'ok' ? '[VERT]  ' : l === 'warn' ? '[ORANGE]' : '[ROUGE] ');
  const list = (a: string[]) => (a.length ? a.join(', ') : '—');
  const L = [
    `${j.titre}${j.invites.length ? ` (feat. ${j.invites.join(', ')})` : ''} — ${j.artiste}`,
    '',
    'MÉTADONNÉES (à recopier chez ton distributeur)',
    `  Titre : ${j.titre}`,
    `  Artiste principal : ${j.artiste}`,
    `  Artistes invités (feat.) : ${list(j.invites)}`,
    `  Auteurs-compositeurs (noms légaux) : ${list(j.auteurs_compositeurs)}`,
    `  Producteurs : ${list(j.producteurs)}`,
    `  Année : ${j.annee}   ${j.copyright}   ${j.phonogramme}`,
    `  ISRC : ${j.isrc || 'aucun (le distributeur en attribue un gratuitement)'}`,
    `  Paroles explicites : ${j.explicite === null ? 'à préciser' : j.explicite ? 'oui' : 'non'}`,
    `  Tempo : ${j.tempo_bpm ?? '?'} BPM   Tonalité : ${j.tonalite || '?'}`,
    `  Durée : ${Math.floor(c.stats.duration / 60)} min ${String(Math.round(c.stats.duration % 60)).padStart(2, '0')} s`,
    '',
    'AUDIO',
    `  WAV ${c.bits} bits, ${c.sampleRate} Hz, ${c.stats.channels === 1 ? 'mono' : 'stéréo'}`,
    `  Loudness ${num(c.stats.lufs)} LUFS intégrés, crête vraie ${num(c.stats.truePeak)} dBTP (contrôlé pour ${c.platform.label})`,
    '',
    'LICENCE',
    ...(c.catalog.length
      ? c.catalog.map(x => `  Instru / mélodie du catalogue Make Music : « ${x.title || '?'} » — licence ${x.owned ? 'achetée' : 'NON achetée'}`)
      : ['  Aucune instru du catalogue Make Music dans ce projet.']),
    '  Garde ton contrat de licence : ton distributeur peut le demander.',
    '',
    'CONTRÔLE AVANT DISTRIBUTION',
    ...c.checks.map(x => `  ${feu(x.level)} ${x.label}${x.value ? ` (${x.value})` : ''} : ${x.message}`),
    ...(c.fixes.length ? ['', 'CORRECTIONS FAITES PAR NOVA', ...c.fixes.map(f => `  - ${f}`)] : []),
    '',
    'FICHIERS',
    ...c.files.map(f => `  ${f}`),
    '',
    'BON À SAVOIR',
    '  - Le WAV master ne contient aucune métadonnée intégrée (TuneCore le déconseille) : saisis les infos ci-dessus dans le formulaire du distributeur.',
    '  - Le MP3 320 sert à faire écouter (DistroKid l\'accepte, TuneCore et Apple non) : envoie le WAV.',
    '  - Paroles : Spotify les prend chez Musixmatch (compte gratuit), Apple via ton distributeur. Le .lrc est un format courant, pas un format officiel d\'Apple.',
    '',
    'Préparé avec NOVA Studio.',
  ];
  return L.join('\r\n');
}

// ---------------------------------------------------------------------------
// Le paquet
// ---------------------------------------------------------------------------

export interface PackageFile { name: string; data: Blob | Uint8Array | string }

/** Assemble le .zip (un dossier « … (Livraison) » à l'intérieur). */
export async function buildDeliveryZip(folder: string, files: PackageFile[]): Promise<Blob> {
  const zip = new JSZip();
  const dir = zip.folder(folder)!;
  for (const f of files) dir.file(f.name, f.data);
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}
