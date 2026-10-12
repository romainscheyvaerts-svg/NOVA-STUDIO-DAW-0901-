import { describe, expect, it } from 'vitest';
import { writeAaf, MEDIA_FOLDER } from '../utils/aaf/aafWrite';
import { sampleInput } from './aafFixtures';
import { readAaf } from '../utils/aaf/aafRead';
import { CfbReader } from '../utils/aaf/cfb';
import { parseBwf } from '../utils/bwf';

describe('writeAaf · NOVA → AAF → NOVA (lecteur NOVA)', () => {
  it('conteneur AAF valide (signature, secteurs de 4096) et BWF horodatés', async () => {
    const r = await writeAaf(sampleInput());
    const cfb = new CfbReader(r.aaf);
    expect(cfb.sectorSize).toBe(4096);
    expect(cfb.headerClsid).toBe('0d010201-0200-0000-060e-2b3403020101');
    expect(cfb.find('/MetaDictionary-1')).not.toBeNull();
    expect(r.files.map(f => f.path)).toEqual([`${MEDIA_FOLDER}/Lead prise 3.wav`, `${MEDIA_FOLDER}/Beat.L.wav`, `${MEDIA_FOLDER}/Beat.R.wav`]);
    const bwf = parseBwf(r.files[0].bytes);
    expect(bwf.timeReference).toBe(12345);
    expect(bwf.frames).toBe(96000);
  });

  for (const embed of [false, true]) {
    it(`relu à l'échantillon près (${embed ? 'médias intégrés' : 'médias liés'})`, async () => {
      const inp = sampleInput(embed);
      const r = await writeAaf(inp);
      const s = readAaf(r.aaf);
      expect(s.sampleRate).toBe(48000);
      expect(s.tracks.map(t => [t.name, t.channels])).toEqual([['Lead', 1], ['Beat', 2]]);
      inp.tracks.forEach((t, i) => t.clips.forEach((c, k) => {
        const got = s.tracks[i].clips[k];
        expect([got.position, got.length, got.sources[0].offset]).toEqual([c.position, c.length, c.offset]);
        expect(got.gain).toBeCloseTo(c.gainPoints ? 1 : c.gain, 6);
        expect(got.fadeIn ? [got.fadeIn.length, got.fadeIn.shape, got.fadeIn.approx] : null).toEqual(c.fadeIn ? [c.fadeIn.length, c.fadeIn.shape, false] : null);
        expect(got.fadeOut ? [got.fadeOut.length, got.fadeOut.shape] : null).toEqual(c.fadeOut ? [c.fadeOut.length, c.fadeOut.shape] : null);
      }));
      const lead = s.tracks[0];
      expect(lead.volume).toBeCloseTo(0.5, 6);
      expect(lead.pan).toBeCloseTo(-0.25, 6);
      const beat = s.tracks[1].clips[0];
      expect(beat.gainPoints?.map(p => [p.t, p.gain])).toEqual([[0, 1], [72000, 0.25], [144000, 1]]);
      expect(s.media.every(m => m.storage === (embed ? 'integre' : 'lie'))).toBe(true);
      if (embed) {
        const m = s.media.find(x => x.fileName.startsWith('Lead'))!;
        expect(m.data!()!.length).toBe(r.files[0].bytes.length);
      } else {
        expect(s.media.map(m => m.fileName).sort()).toEqual(['Beat.L.wav', 'Beat.R.wav', 'Lead prise 3.wav']);
      }
    });
  }
});
