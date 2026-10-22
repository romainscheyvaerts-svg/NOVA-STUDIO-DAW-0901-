import { describe, expect, it } from 'vitest';
import { dropEntries, expandDropped, isAudioFile, MAX_DROPPED_FILES, type DropEntry } from '../utils/droppedFiles';
import { isMidiFile } from '../utils/midiBus';

/**
 * Dossier glissé depuis l'Explorateur sur les pistes : ses sons et ses .mid, dans l'ordre naturel des
 * noms (01, 02, … 10), sous-dossiers compris, fichiers cachés et autres ignorés. Avant : le dossier
 * arrivait comme un « fichier » vide, « 1 fichier ignoré (pas de l'audio…) ».
 */
const file = (name: string, type = ''): DropEntry => ({
  isFile: true, isDirectory: false, name,
  file: ok => ok(new File([new Uint8Array(8)], name, { type })),
});
const dir = (name: string, kids: DropEntry[], batch = 2): DropEntry => ({
  isFile: false, isDirectory: true, name,
  createReader: () => {
    let i = 0;
    // comme Chromium : les entrées arrivent par paquets, puis un paquet vide
    return { readEntries: ok => { const b = kids.slice(i, i + batch); i += batch; setTimeout(() => ok(b), 0); } };
  },
});
const keep = (f: File) => isMidiFile(f) || isAudioFile(f);

describe('Dossiers glissés depuis l’Explorateur', () => {
  it('dossier de stems : une piste par son, ordre naturel, sous-dossier MIDI, rien d’autre', async () => {
    const stems = dir('Stems', [
      file('10 Voix.wav'), file('02 Snare.wav'), file('.DS_Store'), file('01 Kick.WAV'), file('notes.txt', 'text/plain'),
      file('03 Basse.aif'), dir('Midi', [file('beat.mid', 'audio/midi')]),
    ]);
    const { files, truncated } = await expandDropped([stems], keep);
    expect(files.map(f => f.name)).toEqual(['01 Kick.WAV', '02 Snare.wav', '03 Basse.aif', '10 Voix.wav', 'beat.mid']);
    expect(truncated).toBe(false);
  });

  it('fichiers et dossier mélangés', async () => {
    const { files } = await expandDropped([file('Lead.flac'), dir('Prises', [file('Prise 2.wav'), file('Prise 1.wav')])], keep);
    expect(files.map(f => f.name)).toEqual(['Lead.flac', 'Prise 1.wav', 'Prise 2.wav']);
  });

  it('dossier énorme : plafonné', async () => {
    const many = Array.from({ length: MAX_DROPPED_FILES + 40 }, (_, i) => file(`son ${i}.wav`));
    const { files, truncated } = await expandDropped([dir('Banque', many, 100)], keep);
    expect(files.length).toBe(MAX_DROPPED_FILES);
    expect(truncated).toBe(true);
  });

  it('dropEntries : seulement quand un dossier est lâché (fichiers seuls : chemin habituel)', () => {
    const dt = (entries: DropEntry[]) => ({ items: entries.map(e => ({ kind: 'file', webkitGetAsEntry: () => e })) }) as unknown as DataTransfer;
    expect(dropEntries(dt([file('a.wav'), file('b.wav')]))).toBeNull();
    expect(dropEntries(dt([file('a.wav'), dir('Stems', [])]))?.length).toBe(2);
    expect(dropEntries(null)).toBeNull();
    expect(dropEntries({ items: [{ kind: 'file' }] } as unknown as DataTransfer)).toBeNull();
  });

  it('isAudioFile : extension sans type MIME (Windows)', () => {
    expect(isAudioFile({ name: 'x.AIFF', type: '' })).toBe(true);
    expect(isAudioFile({ name: 'x.txt', type: '' })).toBe(false);
    expect(isAudioFile({ name: 'x', type: 'audio/wav' })).toBe(true);
  });
});
