import { describe, expect, it } from 'vitest';
import { StepInput, STEP_VALUES, stepSeconds } from '../utils/stepInput';
import { MidiLearnStore, ccToVolume, ccToPan, learnValue } from '../utils/midiLearn';

/** R16 : saisie pas à pas (Pro Tools Step Input) et MIDI Learn. */

describe('saisie pas à pas', () => {
  const croche = stepSeconds(STEP_VALUES.find(v => v.id === '1/8')!, 120); // 0,25 s

  it('chaque note avance d’une valeur choisie', () => {
    const s = new StepInput({ step: croche, prefix: 'p' });
    const a = s.noteOn(60, 100); s.noteOff(60);
    const b = s.noteOn(62, 90); s.noteOff(62);
    expect(a.add![0]).toMatchObject({ pitch: 60, start: 0, duration: croche });
    expect(b.add![0]).toMatchObject({ pitch: 62, start: croche });
    expect(s.pos).toBeCloseTo(2 * croche, 9);
  });

  it('accord : les notes enfoncées ensemble tombent au même endroit, on avance au relâchement', () => {
    const s = new StepInput({ step: 0.5 });
    const n1 = s.noteOn(60, 100).add![0];
    const n2 = s.noteOn(64, 100).add![0];
    s.noteOff(60);
    expect(s.pos).toBe(0);
    const n3 = s.noteOn(67, 100).add![0];
    s.noteOff(64); s.noteOff(67);
    expect([n1.start, n2.start, n3.start]).toEqual([0, 0, 0]);
    expect(s.pos).toBe(0.5);
  });

  it('accord tenu : la position ne bouge qu’avec « Suivant »', () => {
    const s = new StepInput({ step: 0.5 });
    s.chordHold = true;
    s.noteOn(60, 100); s.noteOff(60);
    s.noteOn(63, 100); s.noteOff(63);
    expect(s.pos).toBe(0);
    s.next();
    expect(s.pos).toBe(0.5);
  });

  it('silence et retour arrière', () => {
    const s = new StepInput({ step: 0.25 });
    s.noteOn(60, 100); s.noteOff(60);
    s.rest();
    const last = s.noteOn(62, 100).add![0]; s.noteOff(62);
    expect(last.start).toBe(0.5);
    const back = s.back();
    expect(back.remove).toEqual([last.id]);
    expect(s.pos).toBe(0.5);
    expect(s.back().remove).toEqual([]); // le silence
    expect(s.pos).toBe(0.25);
  });

  it('vélocité fixe et durée en fraction du pas (staccato)', () => {
    const s = new StepInput({ step: 0.5, gate: 0.5 });
    s.fixedVelocity = 127;
    const n = s.noteOn(60, 20).add![0];
    expect(n.velocity).toBe(1);
    expect(n.duration).toBe(0.25);
  });
});

describe('MIDI Learn', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

  it('apprend le prochain bouton bougé, puis le bouton pilote le volume', () => {
    const store = new MidiLearnStore(mem());
    store.startLearn({ kind: 'volume', trackId: 'beat', label: 'BEAT · Volume' });
    const first = store.handleCc(1, 7, 100);
    expect(first.learned).toMatchObject({ cc: 7, channel: 1 });
    const h = store.handleCc(1, 7, 64).hits;
    expect(h).toHaveLength(1);
    expect(h[0].value).toBeCloseTo(ccToVolume(64), 9);
    expect(store.handleCc(1, 8, 64).hits).toHaveLength(0);
  });

  it('assignations gardées dans les préférences ; un bouton ne pilote qu’un réglage', () => {
    const storage = mem();
    const a = new MidiLearnStore(storage);
    a.startLearn({ kind: 'volume', trackId: 'beat', label: 'v' }); a.handleCc(1, 20, 0);
    a.startLearn({ kind: 'pan', trackId: 'beat', label: 'p' }); a.handleCc(1, 20, 0);
    const b = new MidiLearnStore(storage);
    expect(b.mappings).toHaveLength(1);
    expect(b.mappings[0].target.kind).toBe('pan');
  });

  it('courbes : volume (CC100 = 0 dB), pan centré à 64, réglage d’effet sur sa plage', () => {
    expect(ccToVolume(100)).toBeCloseTo(1, 9);
    expect(ccToVolume(0)).toBe(0);
    expect(ccToVolume(127)).toBeLessThanOrEqual(1.5);
    expect(ccToPan(64)).toBe(0);
    expect(ccToPan(0)).toBe(-1);
    expect(ccToPan(127)).toBe(1);
    expect(learnValue({ kind: 'param', trackId: 't', pluginId: 'p', paramId: 'mix', min: 0, max: 100, label: '' }, 127)).toBe(100);
  });
});
