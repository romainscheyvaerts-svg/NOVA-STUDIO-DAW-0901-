/**
 * Mastering d'un EP / d'un album (écart 22, 22/10/2026).
 *  - 6 titres au même caractère, masterisés par le moteur du Master express (même style, même
 *    intensité, même cible) : écart de LUFS intégré ≤ 0,5 LU entre titres ;
 *  - blancs exacts à l'échantillon ; fondu enchaîné à puissance constante ; hors fondu, chaque
 *    échantillon est celui du titre ; découpe aux débuts de titre = l'album, sans perte ni ajout ;
 *  - feuille .cue (ISRC, INDEX 01 en mm:ss:ff), fiche JSON, noms de fichiers, ISRC (doublons, invalides).
 */
import { describe, it, expect } from 'vitest';
import {
  albumCue, albumLayout, albumManifest, albumTitleFile, assembleAlbum, concatWavParts, cleanTitle, cueTime, duplicateIsrcs, isrcOf, lufsSpread, moveItem, splitAlbum,
  titleFileName, titleSpec, ALBUM_SPREAD_MAX, type AlbumTitleSpec,
} from '../utils/albumMaster';
import { analyzeTrack, renderQuickMaster, QM_TARGETS } from '../utils/quickMaster';
import { encodeWav } from '../utils/audioFormats';

const SR = 48000;
const tone = (sec: number, f: number, amp: number, seed = 1) => {
  const n = Math.round(sec * SR), L = new Float32Array(n), R = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const nz = (s / 0x7fffffff - 0.5) * 0.3;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * i / SR);
    L[i] = Math.fround(amp * env * (Math.sin(2 * Math.PI * f * i / SR) + 0.5 * Math.sin(2 * Math.PI * 3 * f * i / SR) + nz));
    R[i] = Math.fround(amp * env * (Math.sin(2 * Math.PI * f * i / SR + 0.3) + 0.5 * Math.sin(2 * Math.PI * 2 * f * i / SR) + nz));
  }
  return [L, R];
};

describe('album : enchaînements', () => {
  const t1 = tone(1.0, 110, 0.3, 1), t2 = tone(0.7, 220, 0.2, 2), t3 = tone(0.5, 330, 0.25, 3);

  it('blancs exacts à l’échantillon ; hors fondu chaque échantillon est celui du titre', () => {
    const specs = [titleSpec('a'), { ...titleSpec('b'), gapAfter: 1.5 }, titleSpec('c')];
    const al = assembleAlbum([t1, t2, t3], specs, SR);
    expect(al.starts).toEqual([0, 48000 + 96000, 48000 + 96000 + 33600 + 72000]);
    // Blanc après le titre 1 : 96 000 zéros exactement, puis le titre 2 au bit près.
    for (let i = al.ends[0]; i < al.starts[1]; i++) { if (al.ch[0][i] !== 0 || al.ch[1][i] !== 0) throw new Error(`pas un blanc à ${i}`); }
    expect(al.starts[1] - al.ends[0]).toBe(96000);
    expect(al.starts[2] - al.ends[1]).toBe(72000);
    for (let k = 0; k < t2[0].length; k++) { if (al.ch[0][al.starts[1] + k] !== t2[0][k] || al.ch[1][al.starts[1] + k] !== t2[1][k]) throw new Error(`écart à ${k}`); }
    expect(al.length).toBe(al.starts[2] + t3[0].length);
  });

  it('découpe aux débuts de titre : la somme des fichiers = l’album, sans perte ni ajout', () => {
    const specs = [titleSpec('a'), { ...titleSpec('b'), xfadeNext: 0.2 }, titleSpec('c')];
    const al = assembleAlbum([t1, t2, t3], specs, SR);
    const parts = splitAlbum(al);
    expect(parts.reduce((s, p) => s + p[0].length, 0)).toBe(al.length);
    let pos = 0;
    for (const p of parts) { for (let k = 0; k < p[0].length; k += 997) expect(p[0][k]).toBe(al.ch[0][pos + k]); pos += p[0].length; }
    // Premier fichier : titre 1 + son blanc de 2 s.
    expect(parts[0][0].length).toBe(48000 + 96000);
  });

  it('fichier d’un titre calculé seul = découpe de l’album entier, au bit près (blancs et fondus)', () => {
    const specs = [{ ...titleSpec('a'), xfadeNext: 0.2 }, { ...titleSpec('b'), gapAfter: 0.5 }, { ...titleSpec('c'), xfadeNext: 3 }, titleSpec('d')];
    const titles = [t1, t2, t3, tone(0.4, 440, 0.2, 4)];
    const parts = splitAlbum(assembleAlbum(titles, specs, SR));
    parts.forEach((p, i) => {
      const f = albumTitleFile(i, titles, specs, SR);
      expect(f[0].length).toBe(p[0].length);
      for (let c = 0; c < 2; c++) for (let k = 0; k < p[c].length; k++) if (f[c][k] !== p[c][k]) throw new Error(`titre ${i + 1}, canal ${c}, échantillon ${k}`);
    });
  });

  it('album d’un seul tenant = WAV des titres mis bout à bout, identique octet pour octet au WAV de l’album entier', () => {
    const specs = [{ ...titleSpec('a'), xfadeNext: 0.2 }, { ...titleSpec('b'), gapAfter: 0.5 }, titleSpec('c')];
    const titles = [t1, t2, t3];
    const whole = encodeWav(assembleAlbum(titles, specs, SR).ch, { sampleRate: SR, bits: 24 });
    const parts = titles.map((_, i) => encodeWav(albumTitleFile(i, titles, specs, SR), { sampleRate: SR, bits: 24 }));
    const chunks = concatWavParts(parts);
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of chunks) { joined.set(c, o); o += c.length; }
    expect(joined.length).toBe(whole.length);
    expect(Buffer.from(joined).equals(Buffer.from(whole))).toBe(true);
  });

  it('fondu enchaîné à puissance constante : zone commune = durée du fondu, gains cos / sin', () => {
    const specs = [{ ...titleSpec('a'), xfadeNext: 0.25 }, titleSpec('b'), titleSpec('c')];
    const dc = (sec: number) => { const n = Math.round(sec * SR); return [new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.5)]; };
    const al = assembleAlbum([dc(1), dc(1), t3], specs, SR);
    const x = Math.round(0.25 * SR);
    expect(al.starts[1]).toBe(SR - x);
    // Milieu du fondu : 0,5·(cos + sin) à π/4 ≈ 0,707.
    const mid = al.starts[1] + x / 2;
    expect(al.ch[0][mid]).toBeCloseTo(0.5 * Math.SQRT2, 3);
    expect(al.ch[0][al.starts[1] - 1]).toBe(0.5);
    expect(al.ch[0][al.starts[1] + x + 10]).toBe(0.5);
    const lay = albumLayout([SR, SR], specs, SR);
    expect(lay.xf[0]).toBe(x);
  });
});

describe('album : niveaux homogènes (moteur du Master express)', () => {
  it('6 titres au même caractère, niveaux de départ différents : écart ≤ 0,5 LU après mastering', async () => {
    const amps = [0.05, 0.12, 0.3, 0.08, 0.2, 0.4];
    const target = QM_TARGETS.find(t => t.id === 'spotify')!;
    const lufs: number[] = [];
    const before: number[] = [];
    for (let i = 0; i < amps.length; i++) {
      const ch = tone(4, 90 + 15 * i, amps[i], 10 + i);
      const a = analyzeTrack(ch, SR);
      before.push(a.lufs);
      const r = await renderQuickMaster(ch, SR, a, { style: 'rap', intensity: 'moyen', target });
      lufs.push(r.after.lufs);
      expect(r.after.truePeak).toBeLessThanOrEqual(target.ceiling + 0.05);
    }
    expect(lufsSpread(before)).toBeGreaterThan(10);
    expect(lufsSpread(lufs)).toBeLessThanOrEqual(ALBUM_SPREAD_MAX);
  }, 240_000);

  it('décalage relatif (interlude plus doux) retiré du calcul de l’écart', () => {
    expect(lufsSpread([-14, -14.2, -17.1], [0, 0, -3])).toBeCloseTo(0.2, 6);
    expect(lufsSpread([-14])).toBe(0);
  });
});

describe('album : livraison', () => {
  const specs: AlbumTitleSpec[] = [
    { ...titleSpec('Intro'), isrc: 'fr-z03-26-00001' },
    { ...titleSpec('Nuit "blanche"'), isrc: 'FRZ032600002' },
    { ...titleSpec('Outro'), isrc: '' },
  ];

  it('ISRC : normalisé, vide accepté, invalide refusé, doublons trouvés', () => {
    expect(isrcOf('fr-z03-26-00001')).toBe('FRZ032600001');
    expect(isrcOf('')).toBe('');
    expect(isrcOf('ABC')).toBeNull();
    expect(duplicateIsrcs([...specs, { ...titleSpec('x'), isrc: 'FRZ03 2600002' }])).toEqual(['FRZ032600002']);
  });

  it('feuille .cue : un TRACK par titre, ISRC, INDEX 01 en mm:ss:ff (75 trames / s)', () => {
    expect(cueTime(0, SR)).toBe('00:00:00');
    expect(cueTime(SR * 61 + SR / 75 * 10, SR)).toBe('01:01:10');
    const cue = albumCue({ album: 'Mon EP', artist: 'Nina', file: 'Mon EP.wav', specs, starts: [0, SR * 125, SR * 300], sampleRate: SR });
    expect(cue).toContain('FILE "Mon EP.wav" WAVE');
    expect(cue.match(/TRACK \d\d AUDIO/g)!.length).toBe(3);
    expect(cue).toContain('ISRC FRZ032600001');
    expect(cue).toContain("TITLE \"Nuit 'blanche'\"");
    expect(cue).toContain('INDEX 01 02:05:00');
    expect(cue.match(/ISRC/g)!.length).toBe(2);
  });

  it('noms de fichiers, fiche JSON, titre depuis un nom de fichier, ordre', () => {
    expect(titleFileName(0, 'Intro')).toBe('01 - Intro.wav');
    expect(titleFileName(11, 'a/b:c')).toBe('12 - a b c.wav');
    expect(cleanTitle('03_Mon_son (mix final).wav')).toBe('Mon son (mix final)');
    const m = albumManifest({ album: 'EP', artist: 'Nina', specs, results: [{ lufs: -14.1, truePeak: -1.2, duration: 60 }, { lufs: -13.9, truePeak: -1.1, duration: 90 }, { lufs: -14, truePeak: -1.3, duration: 30 }],
      starts: [0, SR * 62, SR * 154], sampleRate: SR, target: { label: 'Spotify', lufs: -14, ceiling: -1 }, files: ['01 - Intro.wav', '02 - Nuit.wav', '03 - Outro.wav'] });
    expect(m.titres.map(t => t.isrc)).toEqual(['FRZ032600001', 'FRZ032600002', null]);
    expect(m.ecart_lufs_entre_titres).toBe(0.2);
    expect(m.titres[1].debut_s).toBe(62);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  });
});
