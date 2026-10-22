import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tour « beatmaking » (22/10/2026) : aucun nom de logiciel concurrent dans le texte VISIBLE
 * (libellés, infobulles, aides) des écrans de beat, de MIDI et d'instruments. Les commentaires
 * du code peuvent les citer (sources des gestes), pas l'interface.
 */
const FICHIERS = [
  'components/PianoRoll.tsx', 'components/DrumPatternBar.tsx', 'components/MidiInputHost.tsx', 'components/DrumMachinePanel.tsx',
  'components/DrumStepTools.tsx', 'components/GroovePanel.tsx', 'components/MidiCcLanes.tsx', 'components/ChordLane.tsx',
  'components/MetronomeDialog.tsx', 'components/TrackCreationBar.tsx', 'components/SamplerPanel.tsx', 'components/PadSampleTools.tsx',
  'components/ChopPanel.tsx', 'components/ChopClipDialog.tsx', 'components/AudioToMidiDialog.tsx', 'components/TransposeDialog.tsx',
  'components/VstInstrumentPicker.tsx', 'utils/midiTools.ts', 'utils/drumPatterns.ts', 'utils/groove.ts', 'utils/audioToMidi.ts', 'utils/beatRecipes.ts',
];
const NOMS = /\b(FL Studio|FL|Ableton|Live( 12)?|Logic|MPC|Pro Tools|Avid|AudioSuite|Elastic Audio|Cubase|Bitwig|Studio One|Simpler|Slicex|Fruity|DirectWave)\b/;

/** Lignes de code (pas de commentaire), commentaires de fin de ligne retirés. */
const lignesVisibles = (src: string) => src.split('\n').map((l, i) => ({ n: i + 1, l }))
  .filter(({ l }) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
  .map(({ n, l }) => ({ n, l: l.replace(/\s\/\/ .*$/, '').replace(/\{\/\*.*?\*\/\}/g, '') }));

describe('textes visibles du beatmaking', () => {
  it.each(FICHIERS)('%s ne cite aucun logiciel concurrent', f => {
    const src = readFileSync(join(__dirname, '..', f), 'utf-8');
    const fautes = lignesVisibles(src).filter(({ l }) => NOMS.test(l)).map(({ n, l }) => `${n}: ${l.trim().slice(0, 120)}`);
    expect(fautes).toEqual([]);
  });
});
