import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import path from 'path';
import { DAWState, Track, TrackType, Clip } from '../types';
import { planNovaExport } from '../utils/aaf/novaToAaf';
import { writeAaf } from '../utils/aaf/aafWrite';
import { readAaf } from '../utils/aaf/aafRead';
import { aafToNova } from '../utils/aaf/aafToNova';
import { decodeWav } from '../utils/aaf/aafMedia';

const SR = 48000;
const tone = (n: number, f: number) => Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin((2 * Math.PI * f * i) / SR) + 0.1 * Math.sin(i * 0.37));
const seeded = (seed = 3) => (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; b[i] = seed >>> 24; } return b; };
const clip = (o: Partial<Clip>): Clip => ({ id: Math.random().toString(36), name: 'Clip', color: '#fff', type: TrackType.AUDIO, start: 0, duration: 1, offset: 0, fadeIn: 0, fadeOut: 0, ...o });
const track = (o: Partial<Track>): Track => ({ id: 't', name: 'Piste', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...o });

const audio: Record<string, { channels: Float32Array[]; sampleRate: number }> = {
  voix: { channels: [tone(SR * 6, 220)], sampleRate: SR },
  beat: { channels: [tone(SR * 8, 110), tone(SR * 8, 113)], sampleRate: SR },
  gel: { channels: [tone(SR * 4, 330), tone(SR * 4, 331)], sampleRate: SR },
};
const s = (n: number) => n / SR; // échantillons → secondes

function project(): DAWState {
  return {
    id: 'p', name: 'Séance LENNON', sampleRate: SR, bpm: 120, timeSignature: { numerator: 4, denominator: 4 },
    tracks: [
      track({ id: 'lead', name: 'Lead', volume: 0.7, pan: 0.2, clips: [
        clip({ name: 'Prise 1', bufferId: 'voix', start: s(48_001), duration: s(40_000), offset: s(1_234), fadeIn: s(480), fadeInCurve: 'EQUAL_POWER', fadeOut: s(2_400), fadeOutCurve: 'S_CURVE', gain: 0.8 }),
        // fondu enchaîné : chevauchement de 2 400 = fondus égaux
        clip({ name: 'Prise 2', bufferId: 'voix', start: s(88_001 - 2_400), duration: s(30_000), offset: s(100_000), fadeIn: s(2_400), fadeOut: s(2_400), fadeInCurve: 'S_CURVE', fadeOutCurve: 'LINEAR' }),
        // superposé sans fondu enchaîné : couche « Lead (2) »
        clip({ name: 'Prise 3', bufferId: 'voix', start: s(90_000), duration: s(10_000), offset: s(7), gainPoints: [{ t: s(7), db: 0 }, { t: s(5_007), db: -6 }, { t: s(10_007), db: 0 }] }),
        clip({ name: 'Envers', bufferId: 'voix', start: s(200_000), duration: s(4_800), offset: s(10_000), isReversed: true }),
        clip({ name: 'Coupé', bufferId: 'voix', start: s(250_000), duration: s(4_800), isMuted: true }),
      ] }),
      track({ id: 'beat', name: 'Beat', clips: [clip({ name: 'Beat', bufferId: 'beat', start: 0, duration: s(SR * 8) })] }),
      track({ id: 'synth', name: 'Synth', type: TrackType.MIDI, clips: [clip({ name: 'Notes', type: TrackType.MIDI, notes: [] })] }),
      track({ id: 'pad', name: 'Pad', type: TrackType.MIDI, isFrozen: true, clips: [clip({ name: 'Notes', type: TrackType.MIDI, notes: [] })], frozenClip: clip({ name: 'gel', bufferId: 'gel', start: s(96_000), duration: s(SR * 4) }) }),
      track({ id: 'master', name: 'Master', type: TrackType.BUS }),
    ],
  } as unknown as DAWState;
}

describe('NOVA → AAF → NOVA', () => {
  it("plan d'export : couches, fondu enchaîné, envers, MIDI, gel", () => {
    const plan = planNovaExport(project(), id => audio[id] || null, { embed: false, trackVolumePan: true });
    expect(plan.input.tracks.map(t => [t.name, t.channels, t.clips.length])).toEqual([['Lead', 1, 3], ['Lead (2)', 1, 1], ['Beat', 2, 1], ['Pad', 2, 1]]);
    const lead = plan.input.tracks[0];
    expect(lead.clips[1].crossfadeIn).toEqual({ length: 2400, shape: 'S_CURVE' });
    expect(plan.skipped.join('\n')).toMatch(/« Synth » \(MIDI\) : non exportée\. Gèle la piste/);
    expect(plan.skipped.join('\n')).toMatch(/clip coupé « Coupé »/);
    expect(plan.notes.join('\n')).toMatch(/« Pad » \(MIDI\) : exportée en audio depuis son rendu gelé/);
    expect(plan.notes.join('\n')).toMatch(/clip à l'envers « Envers »/);
  });

  it("aller-retour : 0 échantillon d'écart sur 100 % des clips, gain, fondus, volume, pan", async () => {
    const st = project();
    const plan = planNovaExport(st, id => audio[id] || null, { embed: true, trackVolumePan: true });
    const out = await writeAaf({ ...plan.input, random: seeded() });
    const sess = readAaf(out.aaf);
    const back = aafToNova(sess, m => { const d = m.data?.(); const w = d ? decodeWav(d) : null; return w ? { channels: w.channels, sampleRate: w.sampleRate } : null; }, { projectRate: SR, idPrefix: 'aaf' });
    expect(back.report.missing).toEqual([]);
    const want = plan.input.tracks.flatMap(t => t.clips.map(c => ({ t: t.name, ...c })));
    const got = back.tracks.flatMap(t => t.clips.map(c => ({ t: t.name, c })));
    expect(got.length).toBe(want.length);
    let exact = 0;
    got.forEach((g, i) => {
      const w = want[i];
      if (g.c.start * SR === w.position && g.c.duration * SR === w.length && Math.round(g.c.offset * SR) === w.offset) exact++;
    });
    expect(exact).toBe(want.length);
    const lead = back.tracks.find(t => t.name === 'Lead')!;
    expect(lead.volume).toBeCloseTo(0.7, 6);
    expect(lead.pan).toBeCloseTo(0.2, 6);
    expect(lead.clips[0].gain).toBeCloseTo(0.8, 6);
    expect([lead.clips[0].fadeIn * SR, lead.clips[0].fadeInCurve]).toEqual([480, 'EQUAL_POWER']);
    // fondu enchaîné relu : les deux clips se chevauchent de 2 400, fondus égaux
    expect(Math.round((lead.clips[0].start + lead.clips[0].duration - lead.clips[1].start) * SR)).toBe(2400);
    expect([lead.clips[0].fadeOut * SR, lead.clips[1].fadeIn * SR, lead.clips[1].fadeInCurve]).toEqual([2400, 2400, 'S_CURVE']);
    const l2 = back.tracks.find(t => t.name === 'Lead (2)')!.clips[0];
    expect(l2.gainPoints?.map(p => [Math.round((p.t - l2.offset) * SR), Math.round(p.db * 10) / 10])).toEqual([[0, 0], [5000, -6], [10000, 0]]);
    // le son relu est celui d'origine (24 bits)
    const buf = back.buffers.find(b => b.id === lead.clips[0].bufferId)!;
    const o = Math.round(lead.clips[0].offset * SR);
    expect(Math.abs(buf.channels[0][o + 100] - audio.voix.channels[0][o + 100])).toBeLessThan(1e-6);
    const beat = back.tracks.find(t => t.name === 'Beat')!;
    expect(back.buffers.find(b => b.id === beat.clips[0].bufferId)!.channels.length).toBe(2);
    expect(back.report.summary).toMatch(/^6 clips importés, 4 pistes/);
  });

  it('AAF de référence (pyaaf2) → pistes NOVA, fichier lié manquant signalé', () => {
    const sess = readAaf(new Uint8Array(gunzipSync(readFileSync(path.join(__dirname, 'fixtures', 'aaf', 'ref_lie_petit.aaf.gz')))));
    const silent = (m: { channels: number; length: number; sampleRate: number }) => ({ channels: Array.from({ length: m.channels }, () => new Float32Array(m.length)), sampleRate: m.sampleRate });
    const r = aafToNova(sess, m => (m.fileName === 'Adlibs_01.wav' ? null : silent(m)), { projectRate: 44100, idPrefix: 'x' });
    expect(r.report.missing).toEqual(['Adlibs_01.wav']);
    expect(r.report.offlineClips).toBe(8);
    expect(r.report.lines[0]).toBe("47 clips importés sur 6 pistes, à l'échantillon près.");
    expect(r.report.lines.join('\n')).toMatch(/le projet est à 44,1 kHz/);
    expect(r.report.summary).toMatch(/^47 clips importés, 6 pistes, \d fondus approchés, 1 son introuvable$/);
  });
});
