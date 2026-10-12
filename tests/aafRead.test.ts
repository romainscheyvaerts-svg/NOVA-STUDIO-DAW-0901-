import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import path from 'path';
import { readAaf, aafSummary } from '../utils/aaf/aafRead';

const fx = (n: string) => path.join(__dirname, 'fixtures', 'aaf', n);

describe('readAaf · AAF de référence (pyaaf2, médias liés)', () => {
  const bytes = new Uint8Array(gunzipSync(readFileSync(fx('ref_lie_petit.aaf.gz'))));
  const want = JSON.parse(readFileSync(fx('attendu_petit.json'), 'utf8')).lie;
  const s = readAaf(bytes);

  it('pistes, fréquence, nombre de clips', () => {
    expect(s.sampleRate).toBe(48000);
    expect(s.tracks.map(t => t.name)).toEqual(want.tracks.map((t: any) => t.name));
    expect(s.stats.clips).toBe(want.clips);
  });

  it('positions, décalages, longueurs : écart 0 échantillon sur 100 % des clips', () => {
    let exact = 0, total = 0;
    s.tracks.forEach((t, i) => {
      const wt = want.tracks[i];
      expect(t.clips.length).toBe(wt.clips.length);
      t.clips.forEach((c, k) => {
        const w = wt.clips[k];
        total++;
        if (c.position === w.pos && c.length === w.len && c.sources.every(x => x.offset === w.offset)) exact++;
        else console.log('écart', t.name, k, c.position, w.pos, c.length, w.len, c.sources.map(x => x.offset), w.offset);
      });
    });
    expect(exact).toBe(total);
  });
});

describe('readAaf · gain, fondus, volume, pan, stéréo', () => {
  const s = readAaf(new Uint8Array(gunzipSync(readFileSync(fx('ref_lie_petit.aaf.gz')))));
  const want = JSON.parse(readFileSync(fx('attendu_petit.json'), 'utf8')).lie;

  it('gain de clip et fondus (longueur exacte, forme connue ou approchée)', () => {
    s.tracks.forEach((t, i) => t.clips.forEach((c, k) => {
      const w = want.tracks[i].clips[k];
      expect(c.gain).toBeCloseTo(w.gain, 6);
      for (const side of ['fadeIn', 'fadeOut'] as const) {
        const f = c[side], wf = w[side];
        if (!wf) { expect(f).toBeUndefined(); continue; }
        expect(f?.length).toBe(wf.len);
        expect(f?.shape).toBe(wf.shape);
        expect(f?.approx).toBe(wf.approx);
      }
    }));
    expect(s.stats.renderedFades).toBe(2);
    expect(s.stats.fadesApprox).toBe(want.tracks.flatMap((t: any) => t.clips).flatMap((c: any) => [c.fadeIn, c.fadeOut]).filter((f: any) => f?.approx).length);
  });

  it('volume et panoramique des pistes', () => {
    s.tracks.forEach((t, i) => {
      const w = want.tracks[i];
      if (w.volume === null) expect(t.volume).toBeNull(); else expect(t.volume).toBeCloseTo(w.volume, 6);
      if (w.pan === null) expect(t.pan).toBeNull(); else expect(t.pan).toBeCloseTo(w.pan * 2 - 1, 6);
    });
  });

  it('stéréo : fichier entrelacé et double mono « Guitare.L/.R » regroupé', () => {
    const beat = s.tracks.find(t => t.name === 'Beat')!;
    expect(beat.channels).toBe(2);
    expect(beat.clips[0].sources.map(x => x.channel)).toEqual([0, 1]);
    const gt = s.tracks.find(t => t.name === 'Guitare')!;
    expect(gt.channels).toBe(2);
    expect(new Set(gt.clips[0].sources.map(x => x.media.fileName))).toEqual(new Set(['Guitare_01.L.wav', 'Guitare_01.R.wav']));
    expect(s.stats.stereoPairs).toBe(1);
  });

  it('médias liés : nom de fichier tiré du localisateur', () => {
    const linked = s.media.filter(m => m.storage === 'lie');
    expect(linked.map(m => m.fileName)).toContain('Adlibs_01.wav');
    expect(linked.every(m => m.sampleRate === 48000)).toBe(true);
  });

  it('rapport lisible', () => {
    expect(aafSummary(s, { missingMedia: 1 })).toMatch(/^47 clips importés, 6 pistes, \d+ fondus? approchés?, 1 son introuvable$/);
  });
});

describe('readAaf · bouts « Sample accurate edit » de Pro Tools', () => {
  it('recollés au clip suivant (position, décalage et longueur à l’échantillon)', async () => {
    const { writeAaf } = await import('../utils/aaf/aafWrite');
    const tone = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.3);
    const out = await writeAaf({
      name: 'SAE', sampleRate: 48000, embed: false, trackVolumePan: false, random: (() => { let x = 5; return (n: number) => Uint8Array.from({ length: n }, () => (x = (x * 1103515245 + 12345) >>> 0) >>> 24); })(),
      media: [
        { id: 'sae', name: 'Sample accurate edit', channels: [tone(920)], sampleRate: 48000, timeReference: 0 },
        { id: 'v', name: 'Voix', channels: [tone(96000)], sampleRate: 48000, timeReference: 0 },
      ],
      tracks: [{ name: 'Voix', channels: 1, clips: [
        { name: 'SAE', position: 1000, length: 920, mediaId: 'sae', offset: 0, gain: 1 },
        { name: 'Voix', position: 1920, length: 48000, mediaId: 'v', offset: 5000, gain: 1 },
      ] }],
    });
    const s = readAaf(out.aaf);
    const c = s.tracks[0].clips;
    expect(c.length).toBe(1);
    expect([c[0].position, c[0].length, c[0].sources[0].offset]).toEqual([1000, 48920, 4080]);
    expect(s.stats.sampleAccurateMerged).toBe(1);
  });
});
