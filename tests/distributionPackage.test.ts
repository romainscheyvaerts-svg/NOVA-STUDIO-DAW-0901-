import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { imageInfo, lyricsText, lyricsLrc, deliveryNames, safeFileName, creditsJson, creditsText, buildDeliveryZip } from '../utils/distributionPackage';
import { analyzeAudio, runChecks, platformOf, type DistMeta } from '../utils/distributionCheck';
import { encodeWav } from '../utils/audioFormats';

/** Lot 12 · paquet « Livraison » : il se rouvre et reste conforme (WAV PCM 24 bits, noms, fiche). */

const meta: DistMeta = { title: 'Nuit blanche', artist: 'Léa & Zoé', featuring: 'Kalia', composers: 'Romain Dupont, Lina Haddad', producers: 'Zed', year: '2026', isrc: 'FR-Z03-26-00001', explicit: true };

const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, // APP0 (4 octets)
  0xff, 0xc4, 0x00, 0x03, 0x00, // DHT ignoré
  0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

describe('pochette : dimensions lues dans le fichier', () => {
  it('PNG (IHDR) et JPEG (SOF2, après un DHT)', () => {
    expect(imageInfo(png(3000, 3000))).toEqual({ width: 3000, height: 3000, mime: 'image/png' });
    expect(imageInfo(jpeg(2400, 1600))).toEqual({ width: 2400, height: 1600, mime: 'image/jpeg' });
    expect(imageInfo(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });
});

describe('paroles', () => {
  const text = '[Couplet 1]\nJe marche dans la nuit\n\n\nSous les lumières\n[Refrain]\nNuit blanche\nLigne pas encore chantée';
  it('.txt : sans les titres de section, une seule ligne vide entre les parties', () => {
    expect(lyricsText(text)).toBe('Je marche dans la nuit\r\n\r\nSous les lumières\r\nNuit blanche\r\nLigne pas encore chantée');
  });
  it('.lrc : temps du premier mot, décalé du blanc coupé, lignes sans temps ignorées, jamais en arrière', () => {
    const times = [null, 12.34, null, null, 15.0, null, 14.9, null];
    const lrc = lyricsLrc(text, times, { title: 'Nuit blanche', artist: 'Léa', offset: 2, duration: 180 })!;
    const lines = lrc.split('\r\n');
    expect(lines.slice(0, 4)).toEqual(['[ti:Nuit blanche]', '[ar:Léa]', '[length:03:00]', '[re:NOVA Studio]']);
    expect(lines.slice(4)).toEqual(['[00:10.34]Je marche dans la nuit', '[00:13.00]Sous les lumières', '[00:13.00]Nuit blanche']);
    expect(lyricsLrc('Bla', [null])).toBeNull();
  });
});

describe('noms de fichiers (CD Baby : lettres, chiffres, - et _ ; DistroKid : pas de \\ / : * ? " \' < > |)', () => {
  it('accents retirés, espaces et signes remplacés', () => {
    expect(safeFileName('Léa & Zoé - Nuit blanche (feat. "K")')).toBe('Lea_Zoe_-_Nuit_blanche_feat_K');
    const n = deliveryNames(meta);
    for (const f of [n.wav, n.mp3, n.instru, n.acapella, n.zip, n.cover('image/jpeg'), n.lyricsLrc, n.creditsTxt]) expect(f).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(n.wav).toBe('Lea_Zoe-Nuit_blanche_Master_WAV24.wav');
  });
});

describe('paquet .zip', () => {
  it('se rouvre : dossier, WAV PCM 24 bits 44,1 kHz stéréo sans métadonnées, fiche .txt et .json', async () => {
    const SR = 44100, n = SR * 2;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR); R[i] = 0.28 * Math.sin(2 * Math.PI * 440 * i / SR + 0.1); }
    const stats = analyzeAudio([L, R], SR);
    const platform = platformOf('spotify');
    const checks = runChecks({ stats, platform, format: { sampleRate: SR, bits: 24, channels: 2 }, meta, cover: null,
      licence: { admin: false, hasCatalog: true, access: { unlocked: true, via: 'licence', reason: null, missing: [], login_required: false } } });
    const names = deliveryNames(meta);
    const wav = encodeWav([L, R], { sampleRate: SR, bits: 24 });
    const files = [names.wav, names.lyricsTxt, names.creditsTxt, names.creditsJson];
    const credits = { meta, platform, stats, sampleRate: SR, bits: 24, bpm: 140, key: 'Do mineur', catalog: [{ title: 'NOCTAMBULE', owned: true }], checks, fixes: ['Blanc du début coupé (1,20 s)'], files };
    const zipBlob = await buildDeliveryZip(names.folder, [
      { name: names.wav, data: wav }, { name: names.lyricsTxt, data: 'Je marche' },
      { name: names.creditsTxt, data: creditsText(credits) }, { name: names.creditsJson, data: JSON.stringify(creditsJson(credits)) },
    ]);
    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
    expect(Object.keys(zip.files).filter(k => !k.endsWith('/')).sort()).toEqual(files.map(f => `${names.folder}/${f}`).sort());

    const w = await zip.file(`${names.folder}/${names.wav}`)!.async('uint8array');
    const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
    const ascii = (o: number, l: number) => String.fromCharCode(...w.subarray(o, o + l));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    // Spotify : PCM entier (code 1, pas WAVE_FORMAT_EXTENSIBLE), 2 canaux, 44,1 kHz, 24 bits.
    expect(ascii(12, 4)).toBe('fmt ');
    expect(dv.getUint16(20, true)).toBe(1);
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(24, true)).toBe(44100);
    expect(dv.getUint16(34, true)).toBe(24);
    // TuneCore : aucune métadonnée intégrée (pas de LIST / id3 / bext).
    expect(ascii(36, 4)).toBe('data');
    expect(dv.getUint32(40, true)).toBe(n * 2 * 3);

    const j = JSON.parse(await zip.file(`${names.folder}/${names.creditsJson}`)!.async('string'));
    expect(j.titre).toBe('Nuit blanche');
    expect(j.invites).toEqual(['Kalia']);
    expect(j.auteurs_compositeurs).toEqual(['Romain Dupont', 'Lina Haddad']);
    expect(j.isrc).toBe('FRZ032600001');
    expect(j.explicite).toBe(true);
    expect(j.copyright).toBe('© 2026 Léa & Zoé');
    expect(j.audio.bits).toBe(24);
    expect(j.instrus_catalogue).toEqual([{ titre: 'NOCTAMBULE', licence_achetee: true }]);
    expect(j.controles.find((c: any) => c.id === 'licence').feu).toBe('vert');
    const t = await zip.file(`${names.folder}/${names.creditsTxt}`)!.async('string');
    expect(t).toMatch(/Auteurs-compositeurs \(noms légaux\) : Romain Dupont, Lina Haddad/);
    expect(t).toMatch(/licence achetée/);
    expect(t).toMatch(/CORRECTIONS FAITES PAR NOVA\r\n {2}- Blanc du début coupé/);
  });
});
